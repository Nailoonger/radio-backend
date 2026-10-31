// utils/partnerTodo.js · 伙伴端「待办」唯一事实源（2026-11-01）
//
// 底部导航的角标只能从这里算：五张 tab 页（工作台 / 审核 / 稿件 / 班表 / 我的）
// 原来各写一份 `badges: { desk: 0, home: 0, ... }`，工作台那个数**永远是 0**，
// 于是「有几个站内协作等着处理」这件事在任何一页都看不见（陛下 2026-11-01 报的「角标是不是坏了」）。
//
// ⚠️ 口径（原话）：「有要处理的站内协作你都要亮红点，其他不管」
//   · 工作台角标 = 站内协作区右上那句「N 项待处理」
//     = 内部稿件待审 + 请假待批 + 考勤未录入
//     **必须与工作台页面上的数字相等** —— 页面上写 8、角标写 3 就是一处在撒谎。
//   · 审核 tab 角标仍按自己的口径（投稿待审 + 留言待审），不受这里影响。
//   · 站员没有「站内协作」这一区 ⇒ 工作台角标恒 0（member 分支直接返回 0，不发请求）。
//   · 归零即隐由 tabbar 组件负责（badge <= 0 不渲染），这里只管数字。
const { adminRequest } = require('./request.js');

const one = (url, q) => adminRequest(url, 'GET', Object.assign({ page: 1, pageSize: 1 }, q))
  .then((d) => Number((d && d.total) || 0))
  .catch(() => 0);

/** 取值失败一律 0：角标少一个数不疼，整页红一片才疼 */
const pick = (promise, fn) => Promise.resolve(promise).then(fn).catch(() => 0);

/** 全 0 的角标对象（权限被关、请求全挂时用它兜底） */
function emptyBadges() {
  return { desk: 0, home: 0, submissions: 0, 'my-drafts': 0, scheduling: 0, schedule: 0, me: 0 };
}

/**
 * 站内协作三件套（与 desk.js#fetchModules 同源：同样三个接口）
 * @param {string} roleKey member | manager | super
 */
function fetchCoop(roleKey) {
  if (roleKey === 'member') return Promise.resolve({ drafts: 0, leaves: 0, unmarked: 0, total: 0 });
  return Promise.all([
    one('/partner/draft/review', { status: 0 }),
    pick(adminRequest('/partner/leave/pending', 'GET', {}),
      (d) => Number((d && d.counts && d.counts.pending) || 0)),
    pick(adminRequest('/partner/attendance/overview', 'GET', {}),
      (d) => Number((d && d.summary && d.summary.unmarked) || 0)),
  ]).then(([drafts, leaves, unmarked]) => ({
    drafts, leaves, unmarked, total: drafts + leaves + unmarked,
  }));
}

/**
 * 整份角标（七个 key 全给，缺一个 tabbar 上就是空白）
 * @param {string} [roleKey] 不传按 manager 算（社干/超管口径一样）
 */
function fetchBadges(roleKey) {
  const key = roleKey || 'manager';
  return Promise.all([
    one('/admin/submit/list', { reviewStatus: 0 }),
    one('/admin/message/list', { status: 0 }),
    fetchCoop(key),
  ]).then(([submit, message, coop]) => Object.assign(emptyBadges(), {
    desk: coop.total,
    home: coop.total,
    submissions: submit + message,
  }));
}

module.exports = { fetchBadges, fetchCoop, emptyBadges };
