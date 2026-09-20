'use strict';

/**
 * 点歌提交相关功能的验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-song-submit.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖三块：
 *   A. 点歌名额（songQuotaService）：占位、自动驳回、幂等、并发不超发
 *   B. 注意事项（songNoticeService）：版本号、确认、改内容后重新确认、停用
 *   C. 播出时段（broadcastSlotService）：下一周周一到周五、服务端校验
 *   D. 路由挂载与顺序（字面量路由必须在 /submit/:id 之前）
 *
 * 结果同时写到 stdout 与同目录的 verify-output.txt（方便在 PowerShell 里读）。
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';

const fs = require('fs');
const path = require('path');

const ok = [];
const bad = [];
const detail = [];
function check(name, cond, extra) {
  (cond ? ok : bad).push(name + (extra !== undefined ? '  [' + extra + ']' : ''));
}
const say = (s) => detail.push(s);

(async () => {
  try {
    const { sequelize, Submit, SongQuota, SystemSetting, NoticeAck } = require('../src/models');
    const quota = require('../src/services/songQuotaService');
    const notice = require('../src/services/songNoticeService');
    const slot = require('../src/services/broadcastSlotService');

    await sequelize.sync({ force: true });
    say('sync ok（自动建表：submit / song_quota / notice_ack / system_setting …）');

    /* ══════════ A. 点歌名额 ══════════ */
    say('');
    say('--- A. 点歌名额 ---');
    const now = Date.now();
    say('periodKey  day=' + quota.dayKey(now) + '  week=' + quota.weekKey(now));
    say('dayRange   ' + quota.dayRange(now).start.toISOString() + ' → ' + quota.dayRange(now).end.toISOString());
    check('周 key 形如 YYYY-Www', /^\d{4}-W\d{2}$/.test(quota.weekKey(now)), quota.weekKey(now));

    await quota.setLimits({ daily: 3, weekly: 5 });
    const limits = await quota.getLimits();
    check('上限写入并读出', limits.daily === 3 && limits.weekly === 5, JSON.stringify(limits));

    for (let i = 1; i <= 10; i++) {
      await Submit.create({ openid: 'u' + i, type: 1, songName: 'song' + i, singer: 's', status: 0 });
    }
    for (let i = 1; i <= 2; i++) {
      await Submit.create({ openid: 'a' + i, type: 2, articleTitle: 'art' + i, articleContent: 'b', status: 0 });
    }
    const st0 = await quota.status();
    check('初始快照 daily 0/3', st0.daily.used === 0 && st0.daily.remaining === 3 && !st0.daily.exhausted, JSON.stringify(st0.daily));

    const r1 = await quota.claim();
    const r2 = await quota.claim();
    const r3 = await quota.claim();
    const r4 = await quota.claim();
    check('前 3 次占位成功', r1.ok && r2.ok && r3.ok);
    check('第 4 次被拒（日名额已满）', r4.ok === false && r4.scope === 'daily', JSON.stringify(r4));
    const dayRow = await SongQuota.findOne({ where: { period: 1 } });
    const weekRow = await SongQuota.findOne({ where: { period: 2 } });
    check('日计数器 used=3', Number(dayRow.used) === 3, String(dayRow.used));
    check('周计数器 used=3（同步计入）', Number(weekRow.used) === 3, String(weekRow.used));

    // 真实链路里占位与「改成已通过」同事务，这里补上动作再 sweep
    const three = await Submit.findAll({ where: { type: 1, status: 0 }, order: [['id', 'ASC']], limit: 3 });
    for (const s of three) await s.update({ status: 1, reviewerId: 1, reviewTime: new Date() });
    const swept = await quota.sweep('daily');
    check('自动驳回命中 7 条', swept === 7, 'swept=' + swept);
    check('重复 sweep 幂等（第二次 0 条）', (await quota.sweep('daily')) === 0);

    const all = await Submit.findAll();
    const auto = all.filter((s) => s.type === 1 && Number(s.autoRejected) === 1);
    check('已被系统驳回 7 条', auto.length === 7 && auto.every((s) => s.status === 2), 'auto=' + auto.length);
    check('驳回理由含「名额已满」', auto.every((s) => /名额已满/.test(s.rejectReason)), auto[0] && auto[0].rejectReason);
    check('文稿完全不受影响', all.filter((s) => s.type === 2 && s.status === 0).length === 2);

    await quota.release();
    check('删除已通过的点歌后名额归还（3→2）',
      Number((await SongQuota.findOne({ where: { period: 1 } })).used) === 2);

    await sequelize.query('DELETE FROM song_quota');
    quota.clearLimitCache();
    await quota.setLimits({ daily: 2, weekly: 0 });
    const results = await Promise.all(Array.from({ length: 10 }, () => quota.claim().catch((e) => ({ ok: false, err: e.message }))));
    const success = results.filter((r) => r.ok).length;
    const errs = results.filter((r) => r.err).length;
    const finalRow = await SongQuota.findOne({ where: { period: 1 } });
    say('并发 10 次 claim（上限 2）→ 成功 ' + success + ' 异常 ' + errs + ' 计数器 ' + (finalRow ? finalRow.used : 'n/a'));
    check('并发下不超发（成功 ≤ 2）', success <= 2, 'success=' + success);
    check('并发下无未预期异常', errs === 0, 'err=' + errs);
    check('计数器不超上限', !finalRow || Number(finalRow.used) <= 2, finalRow ? String(finalRow.used) : 'n/a');
    check('weekly=0 时不建行、不占用', !(await SongQuota.findOne({ where: { period: 2 } })));

    /* ══════════ B. 点歌注意事项 ══════════ */
    say('');
    say('--- B. 点歌注意事项 ---');
    const u = 'openid-abc';
    let st = await notice.getForUser(u);
    check('未配置内容时不弹窗、不拦人', st.configured === false && st.needAck === false);
    check('未配置时 assertAcked 通过', (await notice.assertAcked(u)).ok === true);

    const saved1 = await notice.save('一、点歌前请确认歌曲信息正确。\n二、同一周内不要重复点同一首歌。');
    check('保存后版本号变 1', saved1.version === 1 && saved1.bumped === true, 'v=' + saved1.version);
    st = await notice.getForUser(u);
    check('用户需要确认', st.needAck === true && st.version === 1);
    check('assertAcked 拦住', (await notice.assertAcked(u)).ok === false);

    await notice.ack(u, 1);
    st = await notice.getForUser(u);
    check('确认后 needAck=false', st.needAck === false, JSON.stringify({ ackedVersion: st.ackedVersion, version: st.version }));
    check('确认后 assertAcked 放行', (await notice.assertAcked(u)).ok === true);

    const again = await notice.ack(u, 1);
    check('重复确认幂等', again.needAck === false && (await NoticeAck.count()) === 1, 'rows=' + (await NoticeAck.count()));

    const same = await notice.save('一、点歌前请确认歌曲信息正确。\n二、同一周内不要重复点同一首歌。');
    check('内容没变 → 版本号不动（不打扰用户）', same.version === 1 && same.bumped === false, 'v=' + same.version);
    check('内容没变 → 用户仍不需重新确认', (await notice.getForUser(u)).needAck === false);

    const saved2 = await notice.save('一、点歌前请确认歌曲信息正确。\n二、同一周内不要重复点同一首歌。\n三、播出时段不可指定到下周之外。');
    check('内容改了 → 版本号 +1', saved2.version === 2 && saved2.bumped === true, 'v=' + saved2.version);
    check('内容改了 → 老确认失效，需重新确认', (await notice.getForUser(u)).needAck === true);

    const savedAdmin = await notice.getForAdmin();
    check('后台能读到版本与已确认人数', savedAdmin.version === 2 && savedAdmin.ackedCount === 0, JSON.stringify({ v: savedAdmin.version, acked: savedAdmin.ackedCount }));
    await notice.ack(u, 2);
    check('重新确认后 ackedCount=1', (await notice.getForAdmin()).ackedCount === 1);

    const emptied = await notice.save('');
    check('清空内容 = 停用（用户端不弹也不拦）',
      emptied.configured === false && (await notice.assertAcked(u)).ok === true, 'v=' + emptied.version);

    /* ══════════ C. 播出时段 ══════════ */
    say('');
    say('--- C. 播出时段（下周一到周五） ---');
    const kv = require('../src/services/kvService');
    await kv.set('broadcast_schedule', '07:20 / 12:20 / 17:30');
    slot.clearCache();
    const slots = await slot.getSlots(now);
    say('范围 ' + slots.rangeText + '  共 ' + slots.list.length + ' 个时段；首个 = ' + (slots.list[0] || {}).label);
    check('5 天 × 3 时段 = 15 个可选', slots.list.length === 15, 'n=' + slots.list.length);
    check('日期都在下一周的周一到周五',
      slots.list.every((s) => {
        const dow = new Date(s.date + 'T00:00:00Z').getUTCDay();
        return dow >= 1 && dow <= 5;
      }), slots.list.map((s) => s.weekday).filter((v, i, a) => a.indexOf(v) === i).join('/'));
    const next = require('../src/utils/bjTime').nextWeekRange(now);
    check('第一天 = 下一周的周一', slots.list[0].date === require('../src/utils/bjTime').ymd(require('../src/utils/bjTime').shifted(next.start.getTime())), slots.list[0].date);
    check('slot.value 格式规范', /^\d{4}-\d{2}-\d{2} (早间|午间|晚间) \d{2}:\d{2}$/.test(slots.list[0].value), slots.list[0].value);
    check('每天时段顺序为早/午/晚', slots.list.slice(0, 3).map((s) => s.period).join(',') === '早间,午间,晚间');

    const good = slots.list[7].value;
    check('合法值通过校验', (await slot.isValidSlot(good, now)) === true, good);
    check('超出下周范围的日期被拒', (await slot.isValidSlot('2099-01-01 午间 12:20', now)) === false);
    check('同周但周末被拒（若是周六）', (await slot.isValidSlot(slots.list[0].date.replace(/-(\d\d)$/, (m, d) => '-' + String(Math.min(99, parseInt(d, 10) + 5)).padStart(2, '0')) + ' 午间 12:20', now)) === false);
    check('自由文本被拒', (await slot.isValidSlot('明天中午', now)) === false);
    check('空值被拒', (await slot.isValidSlot('', now)) === false);

    const periodsDefault = await (async () => {
      await kv.set('broadcast_schedule', '乱七八糟没有时间');
      slot.clearCache();
      return slot.getPeriods();
    })();
    check('设置解析不出时退回默认 3 个时段', periodsDefault.length === 3, periodsDefault.map((p) => p.time).join('/'));

    /* ══════════ B2. 两份注意事项互不干扰 ══════════ */
    say('');
    say('--- B2. 文稿注意事项（独立一份） ---');
    const ruleSvc = require('../src/services/submitRuleService');
    const nt = require('../src/services/songNoticeService');
    await nt.clearCache();
    const noticeMap = await nt.getAllForAdmin();
    check('后台一次拿到两份', !!noticeMap.song && !!noticeMap.article, Object.keys(noticeMap).join(','));
    const artSaved = await nt.save('一、文稿需为原创，禁止抄袭。\n二、篇幅 300~1500 字。', 'article');
    check('文稿注意事项保存成功且版本独立（v1）', artSaved.type === 'article' && artSaved.version === 1, 'v=' + artSaved.version);
    const songNow = await nt.getForAdmin('song');
    check('保存文稿不影响点歌那份的版本', songNow.version === 3, 'song v=' + songNow.version);
    check('文稿 needAck=true', (await nt.getForUser(u, 'article')).needAck === true);
    check('点歌那份不受牵连', (await nt.getForUser(u, 'song')).needAck === false);
    await nt.ack(u, 1, 'article');
    check('确认文稿后文稿放行', (await nt.assertAcked(u, 'article')).ok === true);
    check('两份确认记录各自一行', (await NoticeAck.count()) === 2, 'rows=' + (await NoticeAck.count()));
    check('assertAcked 默认走点歌', (await nt.assertAcked(u)).type === 'song');

    /* ══════════ B3. 提交规则（每人每周 2 次 + 同曲一周不可重复） ══════════ */
    say('');
    say('--- B3. 提交规则 ---');
    await ruleSvc.clearCache();
    const def = await ruleSvc.getRules();
    check('默认每人每周 2 次、同曲去重开', def.weeklyUserLimit === 2 && def.dupBlock === 1, JSON.stringify(def));

    const stu = 'weekly-user';
    const mk = (name, extra) => Submit.create({
      openid: stu, type: 1, songName: name, singer: 's', status: 0, ...extra,
    });

    check('第一首可提交', (await ruleSvc.checkSubmit({ openid: stu, songName: 'song-a' })).ok === true);
    await mk('song-a');
    const dupRes = await ruleSvc.checkSubmit({ openid: stu, songName: 'song-a' });
    check('同一首歌本周不可重复（被拦）', dupRes.ok === false && dupRes.code === 'SONG_DUPLICATED', dupRes.message);
    check('换一首可以', (await ruleSvc.checkSubmit({ openid: stu, songName: 'song-b' })).ok === true);
    await mk('song-b');
    const limRes = await ruleSvc.checkSubmit({ openid: stu, songName: 'song-c' });
    check('第 3 次被每周上限拦下', limRes.ok === false && limRes.code === 'USER_WEEKLY_LIMIT', limRes.message);
    const mine = await ruleSvc.checkUserWeeklyLimit(stu);
    check('用量统计正确（2/2）', mine.used === 2 && mine.limit === 2 && mine.remaining === 0, JSON.stringify(mine));

    // 因名额已满被系统自动驳回的，不占个人次数
    await Submit.create({
      openid: 'quota-victim', type: 1, songName: 'song-x', singer: 's',
      status: 2, autoRejected: 1, rejectReason: '今日点歌名额已满，系统自动驳回',
    });
    const victim = await ruleSvc.checkUserWeeklyLimit('quota-victim');
    check('系统自动驳回的不占个人次数', victim.used === 0, JSON.stringify(victim));

    // 已驳回的歌不锁死一周
    const rej = await Submit.create({ openid: 'other', type: 1, songName: 'song-r', singer: 's', status: 0 });
    check('待审的会锁住', (await ruleSvc.checkSongDuplicate('song-r')).ok === false);
    await rej.update({ status: 2, rejectReason: '内容不合适' });
    check('人工驳回后这首歌可以再点', (await ruleSvc.checkSongDuplicate('song-r')).ok === true);

    // 归一化比较：全角半角 / 空白 / 大小写视为同一首
    // （用独立 openid 建行，别污染 stu 的每周次数统计）
    const nrm = ruleSvc.normalizeSongName;
    check('归一化：全角折半角', nrm('ＳＯＮＧ-Ａ') === 'song-a', nrm('ＳＯＮＧ-Ａ'));
    check('归一化：去空白（含全角空格）', nrm('  song　a  ') === 'songa', nrm('  song　a  '));
    check('归一化：忽略大小写', nrm('Song.A') === 'song.a', nrm('Song.A'));
    await Submit.create({ openid: 'norm-user', type: 1, songName: '晴天', singer: 's', status: 0 });
    check('《晴天》锁住「晴 天 」', (await ruleSvc.checkSongDuplicate('晴 天 ')).ok === false);
    check('空格+大小写变体也锁住（SONG-A vs song-a）', (await ruleSvc.checkSongDuplicate(' SONG-a ')).ok === false);
    check('queen 还没被点过（全角写法先放行）', (await ruleSvc.checkSongDuplicate('ＱＵＥＥＮ')).ok === true);
    await Submit.create({ openid: 'norm-user', type: 1, songName: 'queen', singer: 's', status: 0 });
    check('queen 落库后全角 ＱＵＥＥＮ 被锁', (await ruleSvc.checkSongDuplicate('ＱＵＥＥＮ')).ok === false);
    check('不同歌不受影响', (await ruleSvc.checkSongDuplicate('晴天.alt')).ok === true, '晴天.alt 是不同字符串');

    // 管理员改规则立刻生效
    await ruleSvc.setRules({ weeklyUserLimit: 5, dupBlock: 0 });
    const loose = await ruleSvc.getRules();
    check('改成 5 次且关闭去重后立即生效', loose.weeklyUserLimit === 5 && loose.dupBlock === 0, JSON.stringify(loose));
    check('关掉去重后同曲可以再点', (await ruleSvc.checkSongDuplicate('song-a')).ok === true);
    const more = await ruleSvc.checkUserWeeklyLimit(stu);
    check('上限放宽后额度跟着变（2/5）', more.limit === 5 && more.remaining === 3, JSON.stringify(more));
    await ruleSvc.setRules({ weeklyUserLimit: 2, dupBlock: 1 });

    /* ══════════ B4. 一键清空点歌数据（仅超管） ══════════ */
    say('');
    say('--- B4. 一键清空点歌数据（仅超管） ---');
    const perm = require('../src/middlewares/permission');
    const fakeRes = () => {
      const r = {};
      r.status = (c) => { r._status = c; return r; };
      r.json = (b) => { r._json = b; return r; };
      return r;
    };
    let nextCalled = false;
    perm.requireSuperAdmin({ admin: { role: 1 } }, fakeRes(), () => { nextCalled = true; });
    check('普通管理员进不来（不调 next）', nextCalled === false);
    nextCalled = false;
    perm.requireSuperAdmin({ admin: { role: 0 } }, fakeRes(), () => { nextCalled = true; });
    check('超级管理员放行', nextCalled === true);

    const beforeSongs = await Submit.count({ where: { type: 1 } });
    const beforeArts = await Submit.count({ where: { type: 2 } });
    check('清空前既有点歌也有文稿', beforeSongs > 0 && beforeArts > 0, beforeSongs + ' / ' + beforeArts);

    const adminSubmit = require('../src/controllers/admin/submitController');
    let guardErr = null;
    try {
      await adminSubmit.purgeSongs({ body: {} }, fakeRes(), (e) => { throw e; });
    } catch (e) { guardErr = e; }
    check('不带 confirm 被拒（40001）', !!guardErr && guardErr.code === 40001, guardErr && guardErr.message);

    let purgeRes = null;
    await adminSubmit.purgeSongs(
      { body: { confirm: 'DELETE' } },
      { json: (b) => { purgeRes = b; } },
      (e) => { throw e; }
    );
    check('清空成功且返回条数', !!purgeRes && purgeRes.code === 0 && purgeRes.data.deletedSongs === beforeSongs,
      purgeRes && purgeRes.data && purgeRes.data.deletedSongs);
    check('点歌全部删除', (await Submit.count({ where: { type: 1 } })) === 0);
    check('文稿一条不动', (await Submit.count({ where: { type: 2 } })) === beforeArts, String(beforeArts));
    // v2 起没有独立的名额计数器了（song_quota 退役）：容量与用量直接数 submit 行，
    // 所以「清空数据」与「计数归零」是同一件事，物理上不可能再出现两本账。
    const songQueue = require('../src/services/songQueueService');
    const slotSvc2 = require('../src/services/broadcastSlotService');
    const v0 = (await slotSvc2.getSlots(now)).list[0].value;
    check('占用计数按 submit 行实时统计 → 清空后归零',
      (await songQueue.countSeated(v0)) === 0 && (await songQueue.countQueued()) === 0);
    const snapAfter = await songQueue.snapshot(now);
    check('候补队列快照同步归零', snapAfter.total === 0 && snapAfter.full === false,
      JSON.stringify({ total: snapAfter.total }));
    check('清空后可立刻重新落座（没有残留计数器挡路）',
      (await songQueue.decideSeat({ slotValue: v0 })).outcome === 'seated');
    check('个人每周次数跟着清零', (await ruleSvc.checkUserWeeklyLimit('weekly-user')).used === 0);

    /* ══════════ C2. 后台发布时段 ══════════ */
    say('');
    say('--- C2. 后台发布 / 修改播出时段 ---');
    // 先把 broadcast_schedule 恢复成正常值：上一节故意写坏过它
    await kv.set('broadcast_schedule', '07:20 / 12:20 / 17:30');
    slot.clearCache();
    const cfg0 = await slot.getAdminConfig(now);
    check('未发布时来源是台词解析', cfg0.source === 'schedule', cfg0.source);
    const pub = await slot.setSlotTimes([{ time: '12:20', label: '午间' }, { time: '20:00', label: '晚间' }, { time: '07:20', label: '早间' }]);
    check('发布后来源变 custom 且按时间排序', pub.source === 'custom' && pub.times.map((t) => t.time).join(',') === '07:20,12:20,20:00', JSON.stringify(pub.times));
    check('每天时段数跟着变为 3 个 → 5 天 15 个', pub.count === 15, 'count=' + pub.count);
    const slots2 = await slot.getSlots(now);
    check('新时段进入可选列表', slots2.list.some((s) => s.time === '20:00' && s.period === '晚间'), slots2.list[3].value);
    /* ⚠️ 不要硬编码日期：目标周 = nextWeekRange(now)，周一之后会整体往后跳一周，
       写死 '2026-09-21 …' 的断言会在跨周后集体失败。一律从 slots2.list 取真实值。 */
    const newEven = slots2.list.find((s) => s.time === '20:00');
    const keepNoon = slots2.list.find((s) => s.time === '12:20');
    check('按新列表校验合法值（新加的 20:00）', (await slot.isValidSlot(newEven.value, now)) === true, newEven.value);
    check('仍在新列表里的旧时段（12:20）继续合法', (await slot.isValidSlot(keepNoon.value, now)) === true, keepNoon.value);
    check('不在列表里的时间被拒', (await slot.isValidSlot(`${keepNoon.date} 午间 13:00`, now)) === false, keepNoon.date);
    let slotErr = null;
    try { await slot.setSlotTimes([{ time: '25:99' }]); } catch (e) { slotErr = e; }
    check('非法格式被拒（40001）', !!slotErr && slotErr.code === 40001, slotErr && slotErr.message);
    slotErr = null;
    try { await slot.setSlotTimes([]); } catch (e) { slotErr = e; }
    check('空列表被拒', !!slotErr && slotErr.code === 40001);
    const capped = await slot.setSlotTimes([1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ time: '0' + i + ':00' })));
    check('超过 6 个自动截断', capped.times.length === 6, 'n=' + capped.times.length);
    await slot.setSlotTimes([{ time: '07:20', label: '早间' }, { time: '12:20', label: '午间' }, { time: '17:30', label: '晚间' }]);

    /* ══════════ D. 路由 ══════════ */
    say('');
    say('--- D. 路由挂载与顺序 ---');
    const list = (r) => r.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path);
    const a = list(require('../src/routes/admin'));
    const uu = list(require('../src/routes/user'));
    const want = ['GET /submit/notice', 'POST /submit/notice/ack', 'GET /submit/timeslots'];
    want.forEach((w) => check('用户端已挂载 ' + w, uu.includes(w)));
    ['GET /submit/notice', 'PUT /submit/notice', 'GET /submit/timeslots', 'PUT /submit/slots',
     'GET /submit/rules', 'PUT /submit/rules', 'DELETE /submit/songs'].forEach((w) => check('管理端已挂载 ' + w, a.includes(w)));
    const ds = a.indexOf('DELETE /submit/songs');
    const di = a.indexOf('DELETE /submit/:id');
    check('DELETE /submit/songs 排在 /submit/:id 之前', ds !== -1 && di !== -1 && ds < di, ds + '<' + di);
    ['/submit/quota', '/submit/notice', '/submit/timeslots'].forEach((seg) => {
      const i = uu.indexOf('GET ' + seg);
      const j = uu.indexOf('GET /submit/:id');
      check('用户端 ' + seg + ' 排在 /submit/:id 之前', i !== -1 && j !== -1 && i < j, i + '<' + j);
    });
    const ai = a.indexOf('GET /submit/quota');
    const aj = a.indexOf('GET /submit/:id');
    check('管理端字面量路由排在 /submit/:id 之前', ai !== -1 && aj !== -1 && ai < aj, ai + '<' + aj);
  } catch (e) {
    bad.push('FATAL ' + e.message);
    detail.push(String(e.stack).split('\n').slice(0, 8).join('\n'));
  }

  const lines = [];
  lines.push('=== 通过 ' + ok.length + ' 项 ===');
  ok.forEach((s) => lines.push('  ok   ' + s));
  if (bad.length) {
    lines.push('=== 失败 ' + bad.length + ' 项 ===');
    bad.forEach((s) => lines.push('  FAIL ' + s));
  }
  lines.push('');
  lines.push(...detail);
  const text = lines.join('\n');
  console.log(text);
  try {
    fs.writeFileSync(path.join(__dirname, 'verify-output.txt'), text, 'utf8');
  } catch (e) { /* 只读目录就算了 */ }
  process.exit(bad.length ? 1 : 0);
})();
