'use strict';

/**
 * 审核即排期（时段容量机制）验证脚本（可重复跑）
 *
 *   用法： node scripts/verify-slot-schedule.js
 *   环境： 自动切到 SQLite 内存库，不需要 MySQL、不需要 Docker
 *
 * 覆盖四块：
 *   A. sweepFullSlots：时段排满 → 该时段剩余待审自动驳回（幂等 / 容量 0 不 sweep / 不占周次数）
 *   B. scheduleMatrix：approved / pending 分开统计、full / willAutoReject 标记、totalPending
 *   C. approve 集成：时段已满时通过被拒（40906），未满时正常通过并触发 sweep
 *   D. 路由顺序：/submit/schedule 必须注册在 /submit/:id 之前
 *
 * 结果同时写到 stdout 与同目录的 verify-slot-output.txt。
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

/** 构造假 req/res 调 controller */
function mockRes() {
  const r = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return r;
}

(async () => {
  try {
    const { sequelize, Submit, SystemSetting } = require('../src/models');
    const slot = require('../src/services/broadcastSlotService');
    const submitRule = require('../src/services/submitRuleService');
    const adminSubmit = require('../src/controllers/admin/submitController');

    await sequelize.sync({ force: true });
    say('sync ok（SQLite 内存库自动建表）');

    const now = Date.now();

    /* 公共准备：发布固定时段 + 设容量 2 */
    await slot.setSlotTimes([{ time: '07:20', label: '早间' }, { time: '12:20', label: '午间' }]);
    await slot.setCapacity(2);
    const slots = await slot.getSlots(now);
    const monNoon = slots.list.find((s) => s.weekday === '周一' && s.period === '午间');
    const monMorn = slots.list.find((s) => s.weekday === '周一' && s.period === '早间');
    check('时段列表里有周一午间/早间', !!monNoon && !!monMorn);

    /* ══════════ A. sweepFullSlots ══════════ */
    say('');
    say('--- A. sweepFullSlots ---');

    // 造数据：周一午间 2 首已通过 + 2 首待审；周一早间 1 首已通过 + 1 首待审
    for (let i = 1; i <= 2; i++) {
      await Submit.create({ openid: 'u' + i, type: 1, songName: 'pass' + i, singer: 's', wantBroadcastTime: monNoon.value, status: 1, reviewerId: 1, reviewTime: new Date() });
    }
    for (let i = 3; i <= 4; i++) {
      await Submit.create({ openid: 'u' + i, type: 1, songName: 'pend' + i, singer: 's', wantBroadcastTime: monNoon.value, status: 0 });
    }
    await Submit.create({ openid: 'u5', type: 1, songName: 'morn-pass', singer: 's', wantBroadcastTime: monMorn.value, status: 1, reviewerId: 1, reviewTime: new Date() });
    await Submit.create({ openid: 'u6', type: 1, songName: 'morn-pend', singer: 's', wantBroadcastTime: monMorn.value, status: 0 });

    const swept1 = await slot.sweepFullSlots(now);
    check('满格时段待审被自动驳回（2 条）', swept1 === 2, 'swept=' + swept1);
    const noonPending = await Submit.count({ where: { wantBroadcastTime: monNoon.value, status: 0 } });
    check('周一午间待审清零', noonPending === 0, String(noonPending));
    const mornPending = await Submit.count({ where: { wantBroadcastTime: monMorn.value, status: 0 } });
    check('未满时段待审不动（早间还剩 1 条待审）', mornPending === 1, String(mornPending));
    const autoRows = await Submit.findAll({ where: { wantBroadcastTime: monNoon.value, status: 2 } });
    check('驳回标记 auto_rejected=1', autoRows.length === 2 && autoRows.every((r) => Number(r.autoRejected) === 1));
    check('驳回理由为时段满文案', autoRows.every((r) => r.rejectReason === slot.SLOT_FULL_REASON), autoRows[0] && autoRows[0].rejectReason);
    check('重复 sweep 幂等（第二次 0 条）', (await slot.sweepFullSlots(now)) === 0);

    // 自动驳回不占学生周次数（周次数实时 COUNT 且排除 auto_rejected）
    const lim = await submitRule.checkUserWeeklyLimit('u3', now);
    check('被自动驳回的学生周次数不占用', lim.used === 0, JSON.stringify(lim));

    // 容量 0（不限）时不 sweep
    await slot.setCapacity(0);
    await Submit.create({ openid: 'u7', type: 1, songName: 'zero-pend', singer: 's', wantBroadcastTime: monMorn.value, status: 0 });
    check('容量 0（不限）不触发 sweep', (await slot.sweepFullSlots(now)) === 0);
    const mornPending2 = await Submit.count({ where: { wantBroadcastTime: monMorn.value, status: 0 } });
    check('不限时段待审保留（2 条）', mornPending2 === 2, String(mornPending2));
    await slot.setCapacity(2);

    /* ══════════ B. scheduleMatrix ══════════ */
    say('');
    say('--- B. scheduleMatrix ---');
    const matrix = await slot.scheduleMatrix(now);
    check('矩阵有 5 天', matrix.days.length === 5, String(matrix.days.length));
    check('第一天的日期 = 下周一', matrix.days[0].date === slots.list[0].date, matrix.days[0].date);
    const mNoon = matrix.days[0].slots.find((s) => s.period === '午间');
    const mMorn = matrix.days[0].slots.find((s) => s.period === '早间');
    check('午间格 approved=2 / full=true', mNoon.approved === 2 && mNoon.full === true, JSON.stringify({ a: mNoon.approved, f: mNoon.full }));
    check('午间格 pending=0（已被 sweep）', mNoon.pending === 0, String(mNoon.pending));
    check('早间格 approved=1 / pending=2 / 未满', mMorn.approved === 1 && mMorn.pending === 2 && !mMorn.full);
    check('totalPending = 2', matrix.totalPending === 2, String(matrix.totalPending));
    check('capacity 透传 = 2', matrix.capacity === 2, String(matrix.capacity));

    /* ══════════ C. approve 集成（时段满拒绝通过） ══════════ */
    say('');
    say('--- C. approve 集成 ---');

    // C1：往未满的早间再投 1 首待审（早间 approved=1 < 2）→ 通过应成功，之后早间满 → sweep 把早间 2 条待审驳回
    const c1 = await Submit.create({ openid: 'u8', type: 1, songName: 'morn-pass2', singer: 's', wantBroadcastTime: monMorn.value, status: 0 });
    let res1 = mockRes();
    await adminSubmit.approve({ params: { id: String(c1.id) }, admin: { id: 1 } }, res1, (e) => { res1.body = { code: 50001, message: e.message }; });
    check('早间第 2 首通过成功', res1.body && res1.body.code === 0, JSON.stringify(res1.body && res1.body.message));
    // 等 setImmediate 的 sweep 跑完
    await new Promise((r) => setImmediate(() => setTimeout(r, 20)));
    const mornPending3 = await Submit.count({ where: { wantBroadcastTime: monMorn.value, status: 0 } });
    check('通过后早间满格，剩余待审被自动驳回（2 条）', mornPending3 === 0, String(mornPending3));

    // C2：往已满的午间投 1 首待审 → 通过应被 40906 拒绝
    const c2 = await Submit.create({ openid: 'u9', type: 1, songName: 'noon-extra', singer: 's', wantBroadcastTime: monNoon.value, status: 0 });
    let res2 = mockRes();
    await adminSubmit.approve({ params: { id: String(c2.id) }, admin: { id: 1 } }, res2, (e) => { res2.body = { code: 50001, message: e.message }; });
    check('时段已满时通过被拒（40906）', res2.body && res2.body.code === 40906, JSON.stringify(res2.body));
    const c2Row = await Submit.findByPk(c2.id);
    check('被拒的投稿保持待审状态', Number(c2Row.status) === 0, String(c2Row.status));

    // C3：文稿不受时段约束（wantBroadcastTime 为空 / type=2 直接走名额路径）
    const c3 = await Submit.create({ openid: 'u10', type: 2, articleTitle: 'art', articleContent: 'x', status: 0 });
    let res3 = mockRes();
    await adminSubmit.approve({ params: { id: String(c3.id) }, admin: { id: 1 } }, res3, (e) => { res3.body = { code: 50001, message: e.message }; });
    check('文稿通过不受时段约束', res3.body && res3.body.code === 0, JSON.stringify(res3.body && res3.body.message));

    /* ══════════ D. 路由顺序 ══════════ */
    say('');
    say('--- D. 路由顺序 ---');
    const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
    const idxSchedule = routesSrc.indexOf("router.get('/submit/schedule'");
    const idxDetail = routesSrc.indexOf("router.get('/submit/:id'");
    check('/submit/schedule 注册在 /submit/:id 之前', idxSchedule > -1 && idxDetail > -1 && idxSchedule < idxDetail);

  } catch (e) {
    bad.push('脚本异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
    detail.push(e && e.stack ? e.stack : String(e));
  }

  const lines = [];
  lines.push('');
  lines.push('══════════ verify-slot-schedule ══════════');
  lines.push('通过 ' + ok.length + ' 项' + (bad.length ? '，失败 ' + bad.length + ' 项' : '，全部通过 ✅'));
  ok.forEach((s) => lines.push('  ✓ ' + s));
  bad.forEach((s) => lines.push('  ✗ ' + s));
  const out = detail.join('\n') + '\n' + lines.join('\n') + '\n';
  console.log(out);
  try {
    fs.writeFileSync(path.join(__dirname, 'verify-slot-output.txt'), out, 'utf8');
  } catch (e) { /* 写不进就算了 */ }
  process.exit(bad.length ? 1 : 0);
})();
