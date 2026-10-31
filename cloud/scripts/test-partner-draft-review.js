'use strict';

/**
 * 内部稿件 · 审核处理台（2026-11-01）
 *
 * 用法（仓库根目录）：node cloud/scripts/test-partner-draft-review.js
 *
 * 陛下原话：「内部稿件审核，也要做审核处理台，不能马虎了」。
 * 界面层加了处理台（全文 + 理由 + 队列可翻），这个脚本守的是**它背后的三个接口契约**：
 *
 *   ① 详情 GET /partner/draft/:id —— 作者本人能看；不是作者就必须有审核权限。
 *      ⚠️ 不能为了"审稿要能看全文"就干脆不鉴权：站员拿个 id 就能读别人没发布的稿 = 越权读。
 *   ② 队列 GET /partner/draft/review —— 待审按「先交先审」排，**列表不带正文**
 *      （带正文等于一次拉几十篇几千字，手机端直接卡）。
 *   ③ 处理 PUT /partner/draft/:id/review —— 驳回必须带理由；乐观锁抢晚了 40901；
 *      被关掉审核权限的社干连这个动作都不许发生（40301，文案统一「暂无权限」）。
 */

const assert = require('assert');
const path = require('path');
const H = require('./harness');

const API = path.join(__dirname, '..', 'cloudfunctions', 'api');
const { sign } = require(path.join(API, 'lib/auth'));

const T = {
  1: sign({ id: 1, username: 'root', role: 0 }),    // 超管
  2: sign({ id: 2, username: 'mgr', role: 1 }),     // 社干
  3: sign({ id: 3, username: 'member', role: 2 }),  // 站员
};
const call = (method, url, body, id = 1) => H.call(H.req(method, url, body || {}, T[id] || ''));

let checks = 0;
const eq = (name, got, want) => { assert.deepStrictEqual(got, want, name); checks++; };
const yes = (name, cond) => { assert.ok(cond, name); checks++; };

const NOW = '2026-11-01T02:00:00.000Z';
const BODY = '各位老师、同学，早上好。这里是菁悠广播站，本期校园之声为你播报运动会筹备进度。';

function seed() {
  const admin = [
    { id: 1, role: 0, nickname: '老师', department: '播音部', dutyRoles: ['播音'] },
    { id: 2, role: 1, nickname: '社干', department: '播音部', dutyRoles: ['播音'] },
    { id: 3, role: 2, nickname: '站员甲', department: '编辑部', dutyRoles: ['编辑'] },
  ].map((a) => ({ _id: `a${a.id}`, username: `p${a.id}`, status: 1, ...a }));

  const draft = (id, personId, status, title) => ({
    _id: `d${id}`,
    id,
    personId,
    personName: personId === 3 ? '站员甲' : '社干',
    title,
    columnName: '校园',
    body: BODY,
    wordCount: BODY.replace(/\s/g, '').length,
    seconds: 12,
    rate: 240,
    version: 1,
    status,
    rejectReason: '',
    submittedAt: status === 1 ? new Date(NOW) : null,
    createTime: new Date(NOW),
    updateTime: new Date(NOW),
  });

  return {
    admin,
    partner_draft: [
      draft(10, 3, 1, '运动会加油稿'),
      draft(11, 2, 1, '晨读推荐'),
      draft(12, 3, 0, '还没写完的稿'),
    ],
    // 权限表：先给一条全开，测试中途再改成关审核
    partner_permissions: [{ _id: 'global', schedule: true, review: true, proxy: true }],
  };
}

(async () => {
  H.reset(seed());

  /* ① 详情：作者能看，别人要有审核权限 */
  let r = await call('GET', '/partner/draft/10', {}, 3);
  eq('作者读自己的稿', r.code, 0);
  eq('详情带回整段正文（处理台要看全文）', r.data.body, BODY);
  eq('详情带字数 / 时长 / 版本', [r.data.wordCount > 0, r.data.seconds, r.data.version], [true, 12, 1]);

  r = await call('GET', '/partner/draft/11', {}, 3);
  eq('站员读别人的稿被拒（越权读）', r.code, 40301);

  r = await call('GET', '/partner/draft/10', {}, 2);
  eq('社干能读别人的待审稿（审稿要用）', r.code, 0);
  eq('社干读到的正文完整', r.data.body, BODY);
  eq('社干读到作者名（处理台显示"谁写的"）', r.data.authorName, '站员甲');

  eq('超管恒放行', (await call('GET', '/partner/draft/11', {}, 1)).code, 0);
  eq('不存在的稿', (await call('GET', '/partner/draft/999', {}, 2)).code, 40401);

  /* ② 队列：先交先审，不带正文 */
  r = await call('GET', '/partner/draft/review', { status: 1, page: 1, pageSize: 20 }, 2);
  eq('待审队列可读', r.code, 0);
  eq('队列里两条待审（草稿不进队列）', r.data.list.map((x) => x.id), [10, 11]);
  yes('队列行不带正文（一次拉几十篇几千字会卡）', r.data.list.every((x) => x.body === undefined));
  yes('队列行带字数与栏目（列表要显示）', r.data.list.every((x) => Number(x.wordCount) > 0 && !!x.columnName));

  eq('站员读不到审稿队列', (await call('GET', '/partner/draft/review', {}, 3)).code, 40301);

  /* ③ 处理：通过 / 驳回 / 乐观锁 / 权限 */
  eq('驳回落库后会出现在已驳回队列', (await call('PUT', '/partner/draft/11/review', { approve: false, reason: '篇幅超时，需压缩' }, 2)).code, 0);
  r = await call('GET', '/partner/draft/11', {}, 2);
  eq('驳回后状态 = 3', r.data.status, 3);
  eq('驳回理由原样落库（作者能看到）', r.data.rejectReason, '篇幅超时，需压缩');
  eq('记下是谁驳的', r.data.reviewedByName, '社干');

  eq('通过', (await call('PUT', '/partner/draft/10/review', { approve: true }, 2)).code, 0);
  r = await call('GET', '/partner/draft/10', {}, 3);
  eq('通过后作者看到状态 = 2', r.data.status, 2);
  eq('通过不留驳回理由', r.data.rejectReason, '');

  eq('重复处理同一条 → 40901（乐观锁）', (await call('PUT', '/partner/draft/10/review', { approve: true }, 2)).code, 40901);
  eq('站员不能审稿', (await call('PUT', '/partner/draft/12/review', { approve: true }, 3)).code, 40301);

  /* 驳回必须带理由：拿一条新的待审来试 */
  H.store.get('partner_draft').set('d20', Object.assign({}, H.store.get('partner_draft').get('d10'), {
    _id: 'd20', id: 20, status: 1, rejectReason: '', submittedAt: new Date(NOW),
  }));
  eq('驳回不带理由 → 40001', (await call('PUT', '/partner/draft/20/review', { approve: false }, 2)).code, 40001);
  eq('空白理由也不算', (await call('PUT', '/partner/draft/20/review', { approve: false, reason: '   ' }, 2)).code, 40001);

  /* ④ 审核权限被超管关掉：读别人的稿与处理动作一起 40301，文案统一四个字 */
  H.store.get('partner_permissions').set('global', { _id: 'global', schedule: true, review: false, proxy: true });
  r = await call('GET', '/partner/draft/20', {}, 2);
  eq('审核权限关掉后读别人的稿 → 40301', r.code, 40301);
  eq('拒绝文案只有四个字', r.message, '暂无权限');
  eq('审核权限关掉后不能通过', (await call('PUT', '/partner/draft/20/review', { approve: true }, 2)).code, 40301);
  eq('审核权限关掉后不能驳', (await call('PUT', '/partner/draft/20/review', { approve: false, reason: '不行' }, 2)).code, 40301);
  eq('审核权限关掉后队列也读不到', (await call('GET', '/partner/draft/review', {}, 2)).code, 40301);
  eq('作者看自己的稿不受影响', (await call('GET', '/partner/draft/12', {}, 3)).code, 0);
  eq('超管不受开关影响', (await call('GET', '/partner/draft/20', {}, 1)).code, 0);

  console.log('内部稿件审核处理台：详情鉴权 / 队列先交先审 / 驳回必填理由 / 权限开关');
  console.log(`结论：断言 ${checks} 项 / 失败 0 项`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
