'use strict';

/**
 * 伙伴端本地实测 · P0 身份 + P1 值班时段 / 可排时间
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/test-partner-duty.js
 *
 * 覆盖：
 *   - 身份：/partner/me 的资格与能力位；未登录 / 禁用账号 / 社干越权
 *   - 时段：草稿 → 发布 → 版本递增；模板校验（越界 / 重叠 / 空发布）
 *   - 可排时间：未发布不能填；自填 / 代录（必须留原因）/ 撤销边界；汇总计数
 *   - 周锚点：week 必须是真实存在的周一
 *
 * ⚠️ 为什么权限矩阵要单独扫一遍：伙伴端的鉴权同样散落在每个 handler 第一行，
 *    漏写一处的后果是「没登录也能调」，接口照样返回 200、不报错（静默漂移 #2）。
 */

const path = require('path');
const H = require('./harness');

const API_DIR = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));

const lines = [];
let failed = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}\n      got  = ${JSON.stringify(got)}\n      want = ${JSON.stringify(want)}`);
}
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

// 超管 id=1 / 社干 id=2 / 停用 id=3 / 另一个社干 id=4
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });
const MGR_TOKEN = sign({ id: 2, username: 'mgr', role: 1 });
const MGR2_TOKEN = sign({ id: 4, username: 'mgr2', role: 1 });
const BANNED_TOKEN = sign({ id: 3, username: 'banned', role: 1 });

const WEEK = '2026-11-02'; // 周一
const WEEK2 = '2026-11-09'; // 下一个周一

function baseSeed() {
  const t = new Date('2026-01-01T00:00:00+08:00');
  return {
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: 'x', nickname: '老师', role: 0, status: 1, department: '', dutyRoles: [], createTime: t, updateTime: t },
      { _id: 'ad2', id: 2, username: 'mgr', password: 'x', nickname: '小周', role: 1, status: 1, department: '播音部', dutyRoles: ['播音'], createTime: t, updateTime: t },
      { _id: 'ad3', id: 3, username: 'banned', password: 'x', nickname: '停用', role: 1, status: 0, department: '', dutyRoles: [], createTime: t, updateTime: t },
      { _id: 'ad4', id: 4, username: 'mgr2', password: 'x', nickname: '小吴', role: 1, status: 1, department: '主持部', dutyRoles: ['主持'], createTime: t, updateTime: t },
    ],
  };
}

function reset() {
  H.reset(baseSeed());
}

const call = (method, p, body, token) => H.call(H.req(method, p, body || {}, token || ''));

/** 造一份合法时段：周一到周三各一段 */
const TPL = [
  { day: 0, title: '早间开台', start: 410, end: 440, dept: '播音部', role: '播音', count: 1 },
  { day: 0, title: '午间漫游', start: 720, end: 750, dept: '主持部', role: '主持', count: 2 },
  { day: 2, title: '晚间点歌', start: 1140, end: 1170, dept: '播音部', role: '播音', count: 1 },
];

(async () => {
  /* ══════════ 1. 身份 ══════════ */
  section('1. 身份 /partner/me');

  reset();
  {
    const r = await call('GET', '/partner/me', {}, '');
    eq('未登录 → 40101', r.code, 40101);
  }
  {
    const r = await call('GET', '/partner/me', {}, BANNED_TOKEN);
    eq('禁用账号 → 40301', r.code, 40301);
  }
  {
    const r = await call('GET', '/partner/me', {}, SUPER_TOKEN);
    eq('超管 me 成功', r.code, 0);
    eq('超管 roleKey', r.data.roleKey, 'super');
    eq('超管 canEditSlots', r.data.abilities.canEditSlots, true);
    eq('超管 canManageAccounts', r.data.abilities.canManageAccounts, true);
    eq('超管未填资格 → qualified=false', r.data.qualified, false);
  }
  {
    const r = await call('GET', '/partner/me', {}, MGR_TOKEN);
    eq('社干 roleKey', r.data.roleKey, 'manager');
    eq('社干 canEditSlots=false（时段是超管独有）', r.data.abilities.canEditSlots, false);
    eq('社干 canProxyAvailability=true', r.data.abilities.canProxyAvailability, true);
    eq('社干已有资格 qualified=true', r.data.qualified, true);
    eq('社干部门', r.data.department, '播音部');
    eq('社干岗位', r.data.dutyRoles, ['播音']);
  }

  section('2. 资格维护 PUT /partner/me/duty');
  {
    const r = await call('PUT', '/partner/me/duty', { department: '外星部', dutyRoles: [] }, SUPER_TOKEN);
    eq('非法部门 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/duty', { department: '播音部', dutyRoles: ['说唱'] }, SUPER_TOKEN);
    eq('非法岗位 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/me/duty', { department: '播音部', dutyRoles: ['播音', '播音', '编辑'] }, SUPER_TOKEN);
    eq('保存成功', r.code, 0);
    eq('岗位去重', r.data.dutyRoles, ['播音', '编辑']);
    eq('保存后 qualified=true', r.data.qualified, true);
    const me = await call('GET', '/partner/me', {}, SUPER_TOKEN);
    eq('回读部门', me.data.department, '播音部');
  }

  section('3. 人员池 GET /partner/people');
  {
    const r = await call('GET', '/partner/people', {}, MGR_TOKEN);
    eq('人员池成功', r.code, 0);
    eq('人员池只含 status=1（3 人，禁用账号被排除）', r.data.total, 3);
    ok('人员池不含 password', r.data.list.every((p) => p.password === undefined));
    eq('超管排在最后', r.data.list[r.data.list.length - 1].isSuper, true);
    const one = await call('GET', '/partner/people/4', {}, MGR_TOKEN);
    eq('单个成员', one.data.name, '小吴');
  }

  /* ══════════ 4. 时段 ══════════ */
  section('4. 值班时段 GET/PUT/POST /partner/slots');

  reset();
  {
    const r = await call('GET', '/partner/slots', {}, MGR_TOKEN);
    eq('空库可读', r.code, 0);
    eq('无已发布版本', r.data.hasPublished, false);
    eq('社干 canEdit=false', r.data.canEdit, false);
    eq('editing.version 从 1 起', r.data.editing.version, 1);
  }
  {
    const r = await call('PUT', '/partner/slots/draft', { templates: TPL }, MGR_TOKEN);
    eq('社干存草稿 → 40301（超管独有）', r.code, 40301);
  }
  {
    const r = await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
    eq('超管存草稿成功', r.code, 0);
    eq('新建草稿 version=1', r.data.draft.version, 1);
    eq('时段条数', r.data.draft.slotCount, 3);
    eq('覆盖天数（周一 + 周三）', r.data.draft.dayCount, 2);
    eq('slotKey 生成', r.data.draft.slots.map((s) => s.slotKey), ['0-1', '0-2', '2-1']);
    eq('时段按天/时间排序后第一条', r.data.draft.slots[0].title, '早间开台');
  }
  {
    const r = await call('PUT', '/partner/slots/draft', { templates: TPL.slice(0, 2) }, SUPER_TOKEN);
    eq('重复存草稿是覆盖不是新建', r.data.created, false);
    eq('覆盖后条数', r.data.draft.slotCount, 2);
    eq('覆盖后版本不变', r.data.draft.version, 1);
  }

  section('5. 时段模板校验');
  {
    const bad = [
      [{ day: 5, title: 'x', start: 600, end: 660, count: 1 }, 'day=5 越界'],
      [{ day: 0, title: '', start: 600, end: 660, count: 1 }, '缺名称'],
      [{ day: 0, title: 'x', start: 660, end: 600, count: 1 }, 'end<=start'],
      [{ day: 0, title: 'x', start: 600, end: 660, count: 0 }, 'count=0'],
      [{ day: 0, title: 'x', start: 600, end: 660, count: 1, dept: '后勤部' }, '非法部门'],
      [
        { day: 0, title: 'A', start: 600, end: 700, count: 1 },
        { day: 0, title: 'B', start: 650, end: 750, count: 1 },
        '同日时间重叠',
      ],
    ];
    for (const [templates, label] of bad) {
      const r = await call('PUT', '/partner/slots/draft', { templates }, SUPER_TOKEN);
      eq(`${label} → 40001`, r.code, 40001);
    }
    const overlap = await call('PUT', '/partner/slots/draft', {
      templates: [
        { day: 0, title: 'A', start: 600, end: 700, count: 1 },
        { day: 0, title: 'B', start: 650, end: 750, count: 1 },
      ],
    }, SUPER_TOKEN);
    ok('重叠报错里带两个时段名', /A/.test(overlap.message) && /B/.test(overlap.message), overlap.message);
  }

  section('6. 发布 POST /partner/slots/publish');
  {
    const r = await call('POST', '/partner/slots/publish', {}, MGR_TOKEN);
    eq('社干发布 → 40301', r.code, 40301);
  }
  {
    // 上一步把草稿覆盖成了 2 条，先补回 3 条再发布
    await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
    const r = await call('POST', '/partner/slots/publish', { reason: '十一周起用' }, SUPER_TOKEN);
    eq('超管发布成功', r.code, 0);
    eq('发布后 state', r.data.published.state, 'published');
    eq('发布后版本', r.data.published.version, 1);
    eq('发布人记录', r.data.published.publishedByName, '老师');
    eq('发布说明', r.data.published.reason, '十一周起用');
  }
  {
    const r = await call('POST', '/partner/slots/publish', {}, SUPER_TOKEN);
    eq('无草稿再发布 → 40001', r.code, 40001);
  }
  {
    const r = await call('GET', '/partner/slots', {}, MGR_TOKEN);
    eq('社干能读到已发布', r.data.hasPublished, true);
    eq('已发布版本号', r.data.published.version, 1);
    eq('草稿已消失', r.data.draft, null);
    eq('editing 是已发布版的副本、版本 +1', r.data.editing.version, 2);
  }
  {
    const r = await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
    eq('发布后再存草稿 → 版本 +1', r.data.draft.version, 2);
  }
  {
    const r = await call('PUT', '/partner/slots/draft', { templates: [] }, SUPER_TOKEN);
    eq('允许存空草稿（配置到一半退出）', r.code, 0);
    const p = await call('POST', '/partner/slots/publish', {}, SUPER_TOKEN);
    eq('空草稿不能发布 → 40001', p.code, 40001);
    // 恢复内容：后面的用例依赖「有一份 3 条时段的草稿」
    await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
  }
  {
    const r = await call('GET', '/partner/slots/published', {}, MGR_TOKEN);
    eq('只读生效版 ready', r.data.ready, true);
    eq('只读生效版条数', r.data.published.slotCount, 3);
  }

  /* ══════════ 7. 可排时间 ══════════ */
  section('7. 可排时间 GET/PUT/DELETE /partner/availability');

  reset();
  {
    const r = await call('GET', '/partner/availability', { week: WEEK }, MGR_TOKEN);
    eq('读成功', r.code, 0);
    eq('时段未发布 → ready=false', r.data.ready, false);
    eq('周锚点回显', r.data.weekStart, WEEK);
    eq('展开 5 天', r.data.weekDates.length, 5);
    eq('第一天是周一', r.data.weekDates[0], '2026-11-02');
    eq('最后一天是周五', r.data.weekDates[4], '2026-11-06');
    eq('未填报 me=null', r.data.me, null);
    // ⚠️ 契约：0 = 自己。曾经无条件回自己的 id，前端 `isProxy = !!targetId` 恒真，
    //    导致「自己填自己」被当成代录（说明强制必填、还回填上次的原因）。
    eq('本人时 targetId=0（不是自己的 id）', r.data.targetId, 0);
    eq('汇总总数=人员池', r.data.summary.total, 3);
    eq('已确认 0', r.data.summary.confirmed, 0);
  }
  {
    const r = await call('PUT', '/partner/availability', { week: WEEK, picks: [{ slotKey: '0-1', can: true }] }, MGR_TOKEN);
    eq('时段未发布时不能填 → 40001', r.code, 40001);
  }

  // 发布时段
  await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
  await call('POST', '/partner/slots/publish', {}, SUPER_TOKEN);

  {
    const r = await call('GET', '/partner/availability', { week: WEEK }, MGR_TOKEN);
    eq('发布后 ready=true', r.data.ready, true);
    eq('可选项数', r.data.slots.length, 3);
    eq('slotVersion 跟着发布版本', r.data.slotVersion, 1);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK,
      picks: [{ slotKey: '0-1', can: true }, { slotKey: '0-2', can: false }, { slotKey: '2-1', can: true }],
    }, MGR_TOKEN);
    eq('有不能来的时段但不填说明 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK,
      picks: [{ slotKey: '0-1', can: true }, { slotKey: '0-2', can: false }, { slotKey: '2-1', can: true }],
      reason: '周三下午有课',
    }, MGR_TOKEN);
    eq('自填成功', r.code, 0);
    eq('source=self', r.data.availability.source, 'self');
    eq('能来 2 个', r.data.availability.canCount, 2);
    eq('isProxy=false', r.data.isProxy, false);
    eq('自填说明落库', r.data.availability.reason, '周三下午有课');
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, picks: [{ slotKey: '0-1', can: true }],
    }, MGR_TOKEN);
    eq('全部能来时说明可不填', r.code, 0);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, picks: [{ slotKey: '0-1', can: true }],
    }, MGR_TOKEN);
    eq('全部能来时说明可不填', r.code, 0);
  }
  {
    const r = await call('GET', '/partner/availability', { week: WEEK }, MGR_TOKEN);
    eq('回读 me 能来数', r.data.me.canCount, 1);
    eq('回读 picks 带时段信息', r.data.me.picks[0].slot.title, '早间开台');
    eq('stale=false（时段版本一致）', r.data.me.stale, false);
    eq('汇总已确认 1', r.data.summary.confirmed, 1);
    eq('汇总待确认 2', r.data.summary.pending, 2);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, picks: [{ slotKey: '9-9', can: true }],
    }, MGR_TOKEN);
    eq('不存在的 slotKey → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, picks: [{ slotKey: '0-1', can: true }, { slotKey: '0-1', can: false }],
    }, MGR_TOKEN);
    eq('重复 slotKey → 40001', r.code, 40001);
  }

  section('8. 代录');
  {
    // 代录态：读别人的记录时 targetId 必须是那个人的 id，前端据此判 isProxy
    const r = await call('GET', '/partner/availability', { week: WEEK, personId: 4 }, MGR_TOKEN);
    eq('代录读别人 targetId=4', r.data.targetId, 4);
    eq('对方还没填 → target=null', r.data.target, null);
  }
  {
    // 显式传自己的 id，后端也要归一成 0（前端永远按「0=自己」判）
    const r = await call('GET', '/partner/availability', { week: WEEK, personId: 2 }, MGR_TOKEN);
    eq('传自己的 id 也归一成 targetId=0', r.data.targetId, 0);
    eq('传自己的 id 时 target=null', r.data.target, null);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, personId: 4, picks: [{ slotKey: '0-1', can: true }],
    }, MGR_TOKEN);
    eq('代录不填原因 → 40001', r.code, 40001);
  }
  {
    const r = await call('PUT', '/partner/availability', {
      week: WEEK, personId: 4, picks: [{ slotKey: '0-1', can: true }, { slotKey: '2-1', can: true }], reason: '他手机坏了让我代填',
    }, MGR_TOKEN);
    eq('代录成功', r.code, 0);
    eq('source=proxy', r.data.availability.source, 'proxy');
    eq('原因落库', r.data.availability.reason, '他手机坏了让我代填');
    eq('代录人', r.data.availability.confirmedBy, 2);
    const logs = H.dump().duty_logs || [];
    eq('代录留痕 1 条', logs.length, 1);
    eq('留痕 action', logs[0].action, 'availability.proxy');
    eq('留痕 target', logs[0].target, 4);
  }
  {
    const r = await call('GET', '/partner/availability', { week: WEEK, personId: 4 }, MGR_TOKEN);
    eq('代录后 target 有数据', r.data.target.canCount, 2);
    eq('代录后 targetId 仍是 4', r.data.targetId, 4);
    eq('汇总已确认 2', r.data.summary.confirmed, 2);
  }

  section('9. 撤销');
  {
    // 社干 2 想撤掉 4 的自填记录 —— 但 4 的是 2 代录的，所以允许
    const r = await call('DELETE', '/partner/availability?week=' + WEEK + '&personId=4', {}, MGR_TOKEN);
    eq('撤自己代录的 → 成功', r.code, 0);
    eq('删除 1 条', r.data.removed, 1);
  }
  {
    // 4 自己填一条，2 试图撤销 → 应被拒
    await call('PUT', '/partner/availability', { week: WEEK, picks: [{ slotKey: '0-1', can: true }] }, MGR2_TOKEN);
    const r = await call('DELETE', '/partner/availability?week=' + WEEK + '&personId=4', {}, MGR_TOKEN);
    eq('撤别人的自填 → 40301', r.code, 40301);
  }
  {
    const r = await call('DELETE', '/partner/availability?week=' + WEEK, {}, MGR_TOKEN);
    eq('撤自己的 → 成功', r.code, 0);
  }

  section('10. 时段重发后 stale 提示');
  {
    // 第 7 节开头 reset 过，当前生效版是 version=1、没有草稿。
    // ① 先发一版 version=2
    await call('PUT', '/partner/slots/draft', { templates: TPL }, SUPER_TOKEN);
    await call('POST', '/partner/slots/publish', {}, SUPER_TOKEN);

    // ② 在 version=2 生效期间填一份可排时间
    await call('PUT', '/partner/availability', { week: WEEK2, picks: [{ slotKey: '0-1', can: true }] }, MGR2_TOKEN);
    const before = await call('GET', '/partner/availability', { week: WEEK2 }, MGR2_TOKEN);
    eq('填报时依据的版本', before.data.me.slotVersion, 2);

    // ③ 追加一个时段 → 新草稿 version=3 → 发布
    await call('PUT', '/partner/slots/draft', {
      templates: TPL.concat([{ day: 4, title: '周五收台', start: 1260, end: 1290, dept: '播音部', role: '播音', count: 1 }]),
    }, SUPER_TOKEN);
    const pub = await call('POST', '/partner/slots/publish', {}, SUPER_TOKEN);
    eq('重发后已发布版本', pub.data.published.version, 3);

    const r = await call('GET', '/partner/availability', { week: WEEK2 }, MGR2_TOKEN);
    eq('重发后 slotVersion 前进', r.data.slotVersion, 3);
    eq('旧填报标 stale', r.data.me.stale, true);
    eq('stale 不计入已确认', r.data.summary.confirmed, 0);
  }

  /* ══════════ 11. 周锚点校验 ══════════ */
  section('11. week 参数校验');
  {
    const cases = [
      ['2026-11-03', '周二不是周一'],
      ['2026-02-31', '不存在的日期'],
      ['2026-11', '格式不对'],
      ['', '空串（回落到本周，应成功）'],
    ];
    for (const [week, label] of cases) {
      const r = await call('GET', '/partner/availability', { week }, MGR_TOKEN);
      if (week === '') eq(`${label} → 成功`, r.code, 0);
      else eq(`${label} → 40001`, r.code, 40001);
    }
  }

  /* ══════════ 12. 权限矩阵（全量 partner 路由）══════════ */
  section('12. 权限矩阵');
  {
    const { PARTNER_ROUTES } = require(path.join(API_DIR, 'router'));
    // ⚠️ 这两个是「改全局配置」的动作，按设计只给超管（asSuperPartner）：
    //    时段会钉死在已发布的班表里，规则决定全站排班上限 —— 社干改错了影响面太大。
    const superOnly = new Set([
      'PUT /partner/slots/draft',
      'POST /partner/slots/publish',
      // 重置全部时段（删库级）—— 与保存/发布同类，社干不能碰
      'DELETE /partner/slots',
      'POST /partner/schedule/withdraw',
      'PUT /partner/rules',
      'GET /partner/accounts/candidates',
      'POST /partner/accounts/import',
    ]);

    for (const [key] of PARTNER_ROUTES) {
      const sp = key.indexOf(' ');
      const method = key.slice(0, sp);
      const p = key.slice(sp + 1).replace(':id', '4');
      const body = method === 'GET' || method === 'DELETE' ? {} : { templates: [], picks: [] };

      const anon = await H.call(H.req(method, p, body, ''));
      ok(`未登录拦截 ${key}`, anon.code === 40101 || anon.code === 40301, `code=${anon.code}`);

      const mgr = await H.call(H.req(method, p, body, MGR_TOKEN));
      if (superOnly.has(key)) {
        ok(`社干被拒 ${key}`, mgr.code === 40301, `code=${mgr.code}`);
      } else {
        ok(`社干可调 ${key}`, mgr.code !== 40101 && mgr.code !== 40301, `code=${mgr.code}`);
      }
    }
  }

  /* ══════════ 输出 ══════════ */
  console.log(lines.join('\n'));
  console.log(`\n${failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'}（共 ${lines.filter((l) => l.startsWith('OK  ') || l.startsWith('FAIL')).length} 项断言）`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身异常：', e);
  process.exit(1);
});
