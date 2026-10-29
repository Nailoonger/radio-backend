'use strict';

/**
 * 路由表（Express 路由的等价物）
 *
 * 格式：'METHOD /path' → 'handlerKey'
 *  - handlerKey 形如 'user.submit.create'，由 handlers/index.js 解析到 handlers/user/submit.js 的 create 方法
 *  - 路径参数用 :name，匹配后放进 ctx.params
 *
 * ⚠️ 顺序即优先级：**字面量段必须排在参数段之前**。
 *    原 Express 里 `/submit/quota` 必须在 `/submit/:id` 之前注册，否则被 :id 吞掉。
 *    这里靠数组顺序保证同一语义 —— 新增路由时**不要**把字面量段追加到数组末尾。
 */

// ---- 用户端 /user ----
const USER_ROUTES = [
  ['GET /user/recruitment/current', 'user.recruitment.current'],
  ['POST /user/recruitment/apply', 'user.recruitment.apply'],
  ['POST /user/recruitment/query', 'user.recruitment.query'],
  ['PUT /user/recruitment/application', 'user.recruitment.update'],
  ['POST /user/recruitment/withdraw', 'user.recruitment.withdraw'],
  ['POST /user/recruitment/resubmit', 'user.recruitment.resubmit'],
  ['POST /user/login', 'user.auth.login'],
  ['POST /user/login/account', 'user.auth.loginByAccount'],
  ['PUT /user/change-password', 'user.auth.changePassword'],
  ['GET /user/me', 'user.auth.me'],

  // 字面量段优先于 /user/submit/:id
  ['POST /user/submit', 'user.submit.create'],
  ['GET /user/submit/my', 'user.submit.myList'],
  ['GET /user/submit/quota', 'user.submit.quota'],
  ['GET /user/submit/window', 'user.submit.windowStatus'],
  ['GET /user/submit/week', 'user.submit.weekSchedule'],
  ['GET /user/submit/notice', 'user.submit.notice'],
  ['POST /user/submit/notice/ack', 'user.submit.ackNotice'],
  ['GET /user/submit/timeslots', 'user.submit.timeslots'],
  ['GET /user/submit/:id', 'user.submit.detail'],
  ['DELETE /user/submit/:id', 'user.submit.cancel'],
  ['POST /user/submit/:id/leave-queue', 'user.submit.leaveQueue'],

  ['POST /user/message', 'user.message.create'],
  ['GET /user/message/my', 'user.message.myList'],

  ['GET /user/program/current', 'user.program.current'],
  ['GET /user/program/weekly', 'user.program.weekly'],
  ['GET /user/program/schedule', 'user.program.schedule'],
  ['GET /user/program/:id', 'user.program.detail'],

  ['GET /user/notice/list', 'user.notice.list'],
  ['GET /user/notice/:id', 'user.notice.detail'],

  ['GET /user/profile', 'user.profile.profile'],
  ['GET /user/station/intro', 'user.profile.stationIntro'],
  ['GET /user/station/schedule', 'user.profile.stationSchedule'],
  ['GET /user/station/contact', 'user.profile.stationContact'],

  ['GET /user/showcase', 'user.showcase.showcase'],
  ['GET /user/cadre/:id', 'user.cadre.detail'],
  ['GET /user/staff/:id', 'user.staff.detail'],

  ['GET /user/switch/list', 'user.switch.list'],
  ['GET /user/switch/:key', 'user.switch.get'],
];

// ---- 管理端 /admin ----
const ADMIN_ROUTES = [
  ['GET /admin/recruitment/batches', 'admin.recruitment.batches'],
  ['POST /admin/recruitment/batches', 'admin.recruitment.createBatch'],
  ['GET /admin/recruitment/batches/:id', 'admin.recruitment.batchDetail'],
  ['PUT /admin/recruitment/batches/:id', 'admin.recruitment.updateBatch'],
  ['POST /admin/recruitment/batches/:id/publish', 'admin.recruitment.publishBatch'],
  ['POST /admin/recruitment/batches/:id/close', 'admin.recruitment.closeBatch'],
  ['PUT /admin/recruitment/batches/:id/interview', 'admin.recruitment.interviewPlan'],
  ['DELETE /admin/recruitment/batches/:id', 'admin.recruitment.deleteBatch'],
  ['POST /admin/recruitment/batches/:id/interview-order', 'admin.recruitment.generateInterviewOrder'],
  ['GET /admin/recruitment/batches/:id/interview-order/export', 'admin.recruitment.exportInterviewOrder'],
  ['GET /admin/recruitment/batches/:id/interview-order', 'admin.recruitment.interviewOrder'],
  ['POST /admin/recruitment/batches/:id/results', 'admin.recruitment.publishResults'],
  ['POST /admin/recruitment/batches/:id/archive', 'admin.recruitment.archiveBatch'],
  ['GET /admin/recruitment/applications', 'admin.recruitment.applications'],
  ['GET /admin/recruitment/applications/:id', 'admin.recruitment.applicationDetail'],
  ['PUT /admin/recruitment/applications/:id/review', 'admin.recruitment.review'],
  ['PUT /admin/recruitment/applications/:id/interview', 'admin.recruitment.interview'],
  ['POST /admin/login', 'admin.auth.login'],
  ['GET /admin/profile', 'admin.auth.profile'],
  ['PUT /admin/change-password', 'admin.auth.changePassword'],
  ['POST /admin/logout', 'admin.auth.logout'],

  // ---- 点歌：字面量段全部排在 /admin/submit/:id 之前（与原 routes/admin.js 顺序一致）----
  ['GET /admin/submit/list', 'admin.submit.list'],
  ['GET /admin/submit/quota', 'admin.submit.capacity'],
  ['PUT /admin/submit/quota', 'admin.submit.setQuota'],
  ['POST /admin/submit/quota/sweep', 'admin.submit.sweepQueue'],
  ['GET /admin/submit/capacity', 'admin.submit.capacity'],
  ['POST /admin/submit/queue/sweep', 'admin.submit.sweepQueue'],
  ['GET /admin/submit/window', 'admin.submit.window'],
  ['PUT /admin/submit/window', 'admin.submit.saveWindow'],
  ['GET /admin/submit/notice', 'admin.submit.notice'],
  ['PUT /admin/submit/notice', 'admin.submit.saveNotice'],
  ['GET /admin/submit/timeslots', 'admin.submit.timeslots'],
  ['PUT /admin/submit/slots', 'admin.submit.saveSlots'],
  ['PUT /admin/submit/slot-dates', 'admin.submit.saveSlotDates'],
  ['GET /admin/submit/schedule', 'admin.submit.schedule'],
  ['GET /admin/submit/week', 'admin.submit.week'],
  ['POST /admin/submit/schedule/preview', 'admin.submit.previewSchedule'],
  ['POST /admin/submit/schedule/run', 'admin.submit.runSchedule'],
  ['POST /admin/submit/schedule/lock', 'admin.submit.lock'],
  ['POST /admin/submit/schedule/unlock', 'admin.submit.unlock'],
  ['GET /admin/submit/rules', 'admin.submit.rules'],
  ['PUT /admin/submit/rules', 'admin.submit.saveRules'],
  ['DELETE /admin/submit/songs', 'admin.submit.purgeSongs'],
  ['POST /admin/submit/batch', 'admin.submit.batch'],
  ['GET /admin/submit/:id', 'admin.submit.detail'],
  ['PUT /admin/submit/:id/approve', 'admin.submit.approve'],
  ['PUT /admin/submit/:id/revoke', 'admin.submit.revoke'],
  ['POST /admin/submit/:id/assign', 'admin.submit.assign'],
  ['PUT /admin/submit/:id/played', 'admin.submit.played'],
  ['GET /admin/submit/:id/status-logs', 'admin.submit.statusLogs'],
  ['PUT /admin/submit/:id/reject', 'admin.submit.reject'],
  ['DELETE /admin/submit/:id', 'admin.submit.remove'],

  // ---- 节目 / 公告 / 留言 / 统计 ----
  ['GET /admin/program/list', 'admin.program.list'],
  ['POST /admin/program/create', 'admin.program.create'],
  ['PUT /admin/program/:id', 'admin.program.update'],
  ['DELETE /admin/program/:id', 'admin.program.remove'],
  ['PUT /admin/program/:id/live', 'admin.program.setLive'],

  ['GET /admin/notice/list', 'admin.notice.list'],
  ['POST /admin/notice/create', 'admin.notice.create'],
  ['PUT /admin/notice/:id', 'admin.notice.update'],
  ['DELETE /admin/notice/:id', 'admin.notice.remove'],
  ['PUT /admin/notice/:id/toggle', 'admin.notice.toggle'],

  ['GET /admin/message/list', 'admin.message.list'],
  ['PUT /admin/message/:id/approve', 'admin.message.approve'],
  ['PUT /admin/message/:id/reject', 'admin.message.reject'],
  ['DELETE /admin/message/:id', 'admin.message.remove'],

  ['GET /admin/stats/overview', 'admin.stats.overview'],
  ['GET /admin/stats/submit-trend', 'admin.stats.submitTrend'],
  ['GET /admin/stats/top-songs', 'admin.stats.topSongs'],

  // ---- 系统设置 / 开关 / 社干 / 部员 / 风采 / 管理员账号 ----
  ['GET /admin/setting/list', 'admin.setting.list'],
  ['GET /admin/setting/:key', 'admin.setting.get'],
  ['PUT /admin/setting/:key', 'admin.setting.upsert'],

  ['GET /admin/switch/list', 'admin.switch.list'],
  ['PUT /admin/switch/:key', 'admin.switch.update'],

  ['GET /admin/cadre/list', 'admin.cadre.list'],
  ['POST /admin/cadre/create', 'admin.cadre.create'],
  ['GET /admin/cadre/:id', 'admin.cadre.detail'],
  ['PUT /admin/cadre/:id', 'admin.cadre.update'],
  ['DELETE /admin/cadre/:id', 'admin.cadre.remove'],
  ['PUT /admin/cadre/:id/toggle', 'admin.cadre.toggle'],

  ['GET /admin/staff/list', 'admin.staff.list'],
  ['POST /admin/staff/create', 'admin.staff.create'],
  ['GET /admin/staff/:id', 'admin.staff.detail'],
  ['PUT /admin/staff/:id', 'admin.staff.update'],
  ['DELETE /admin/staff/:id', 'admin.staff.remove'],
  ['PUT /admin/staff/:id/toggle', 'admin.staff.toggle'],

  ['GET /admin/showcase/list', 'admin.showcase.list'],
  ['PUT /admin/showcase/:type/:id/toggle', 'admin.showcase.toggle'],

  // ---- 文件上传（2026-10-08 补：原作者实现的控制器从未挂过路由）----
  // admin-web 两条通道都走这里：cloud 收 `{filename, fileBase64}`（见 handlers/admin/upload.js 文件头）
  ['POST /admin/upload/avatar', 'admin.upload.avatar'],

  ['GET /admin/admin/list', 'admin.adminMgr.list'],
  ['POST /admin/admin/create', 'admin.adminMgr.create'],
  // ⚠️ 字面量段必须排在 `/admin/admin/:id` 之前（同方法不会被吃掉，但按全站规矩一律如此）
  ['POST /admin/admin/reset-password/batch', 'admin.adminMgr.resetPasswordBatch'],
  ['PUT /admin/admin/:id', 'admin.adminMgr.update'],
  ['DELETE /admin/admin/:id', 'admin.adminMgr.remove'],

  // ---- 学生账号 ----
  ['POST /admin/student/import/preview', 'admin.student.importPreview'],
  ['POST /admin/student/import/commit', 'admin.student.importCommit'],
  ['GET /admin/student/template', 'admin.student.template'],
  ['GET /admin/student/list', 'admin.student.list'],
  ['GET /admin/student/stats', 'admin.student.stats'],
  ['GET /admin/student/export', 'admin.student.exportXlsx'],
  ['GET /admin/student/grades', 'admin.student.grades'],
  ['GET /admin/student/grade/:grade', 'admin.student.gradeDetail'],
  ['DELETE /admin/student/grade/:grade', 'admin.student.removeGrade'],
  ['GET /admin/student/cleanup/last', 'admin.student.cleanupLast'],
  ['GET /admin/student/batches', 'admin.student.batches'],
  ['POST /admin/student/reset-password/batch', 'admin.student.resetPasswordBatch'],
  ['POST /admin/student/status/batch', 'admin.student.setStatusBatch'],
  ['POST /admin/student/batch/:id/rollback', 'admin.student.rollback'],
  ['POST /admin/student/delete/batch', 'admin.student.removeBatch'],
  ['PUT /admin/student/:id', 'admin.student.update'],
  ['PUT /admin/student/:id/status', 'admin.student.setStatus'],
  ['PUT /admin/student/:id/reset-password', 'admin.student.resetPassword'],
  ['DELETE /admin/student/:id', 'admin.student.remove'],
];

// ---- 伙伴端 /partner（2026-10-27：身份 + 值班时段 / 可排时间）----
//
// ⚠️ 与 /admin 是**两套命名空间**，不是别名：伙伴端 handler 会多查一次 admin 文档拿
//    资格字段（dutyRoles / department），且人员值班线后续会扩到请假 / 考勤 / 轮值。
//    小程序 pages-partner 走 /partner/*，admin-web 电脑端走 /admin/*，互不串。
const PARTNER_ROUTES = [
  ['GET /partner/me', 'partner.me.profile'],
  ['PUT /partner/me/duty', 'partner.me.saveDuty'],

  ['GET /partner/people', 'partner.me.people'],
  ['GET /partner/people/:id', 'partner.me.personDetail'],
  // 超管替别人配值班岗位（2026-10-30）。⚠️ 必须排在 GET /partner/people/:id 之后无所谓
  //   —— 方法不同（PUT vs GET），但路径段同样两段，靠 method + 最后一段区分，不会串。
  ['PUT /partner/people/:id/duty', 'partner.me.saveDutyFor'],

  ['GET /partner/slots', 'partner.slots.get'],
  ['GET /partner/slots/published', 'partner.slots.publishedOnly'],
  ['PUT /partner/slots/draft', 'partner.slots.saveDraft'],
  ['POST /partner/slots/publish', 'partner.slots.publish'],
  ['DELETE /partner/slots', 'partner.slots.reset'],

  ['GET /partner/availability', 'partner.availability.get'],
  ['PUT /partner/availability', 'partner.availability.save'],
  ['DELETE /partner/availability', 'partner.availability.reset'],

  // ⚠️ 字面量段（/list、/review）必须排在 /:id 之前，否则 /list 会被当成 id
  ['GET /partner/draft/list', 'partner.draft.list'],
  ['GET /partner/draft/review', 'partner.draft.reviewList'],
  ['GET /partner/draft/:id/versions', 'partner.draft.versions'],
  ['GET /partner/draft/:id', 'partner.draft.detail'],
  ['POST /partner/draft', 'partner.draft.create'],
  ['PUT /partner/draft/:id/submit', 'partner.draft.submit'],
  ['PUT /partner/draft/:id/review', 'partner.draft.review'],
  ['PUT /partner/draft/:id', 'partner.draft.save'],
  ['POST /partner/draft/:id/restore', 'partner.draft.restore'],

  // 排班规则（两条硬约束）
  ['GET /partner/rules', 'partner.rule.get'],
  ['PUT /partner/rules', 'partner.rule.save'],

  // 请假：站员申请、社干批
  ['GET /partner/leave/mine', 'partner.leave.mine'],
  ['GET /partner/leave/pending', 'partner.leave.pending'],
  ['POST /partner/leave', 'partner.leave.create'],
  ['PUT /partner/leave/:id/review', 'partner.leave.review'],
  ['DELETE /partner/leave/:id', 'partner.leave.remove'],
  ['GET /partner/leave/:id/impact', 'partner.leave.impact'],

  // 考勤：按场点名 / 我的 / 总览
  ['GET /partner/attendance/week', 'partner.attendance.week'],
  ['GET /partner/attendance/mine', 'partner.attendance.mine'],
  ['GET /partner/attendance/overview', 'partner.attendance.overview'],
  ['PUT /partner/attendance', 'partner.attendance.mark'],

  // 班表：读 / 我的班次 / 生成草稿 / 发布
  ['GET /partner/schedule/mine', 'partner.schedule.mine'],
  ['GET /partner/schedule/month', 'partner.schedule.month'],
  ['GET /partner/schedule/check', 'partner.schedule.check'],
  ['GET /partner/schedule/candidates', 'partner.schedule.candidates'],
  ['GET /partner/schedule/history', 'partner.schedule.history'],
  ['GET /partner/schedule', 'partner.schedule.get'],
  ['PUT /partner/schedule/generate', 'partner.schedule.generate'],
  ['POST /partner/schedule/publish', 'partner.schedule.publish'],
  ['POST /partner/schedule/withdraw', 'partner.schedule.withdraw'],
  ['PUT /partner/schedule/cell', 'partner.schedule.setCell'],
  ['DELETE /partner/schedule/draft', 'partner.schedule.clear'],

  // 账号管理（超管）：从学生名册拉人进伙伴端
  ['GET /partner/accounts/candidates', 'partner.accounts.candidates'],
  ['POST /partner/accounts/import', 'partner.accounts.importAccounts'],

  // 互评：当场说一句，匿名聚合
  ['GET /partner/feedback/pending', 'partner.feedback.pending'],
  ['GET /partner/feedback/mine', 'partner.feedback.mine'],
  ['GET /partner/feedback/overview', 'partner.feedback.overview'],
  ['POST /partner/feedback', 'partner.feedback.create'],
];

// 系统自检 / 初始化（不属于业务接口，但用同一套网关）
const SYSTEM_ROUTES = [
  ['GET /health', 'system.health'],
  // 一次性建齐所有集合（幂等，可重复调用）；替代「去云开发控制台手点新建集合」
  ['POST /system/init-collections', 'system.initCollections'],
];

const RAW_ROUTES = [...SYSTEM_ROUTES, ...USER_ROUTES, ...ADMIN_ROUTES, ...PARTNER_ROUTES];

// 预编译：拆成 method + 段数组，避免每次请求都做字符串切割
const COMPILED = RAW_ROUTES.map(([key, handlerKey]) => {
  const sp = key.indexOf(' ');
  const method = key.slice(0, sp).toUpperCase();
  const path = key.slice(sp + 1);
  return { method, segs: path.split('/').filter(Boolean), handlerKey };
});

function match(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const segs = String(path || '').split('/').filter(Boolean);

  for (const route of COMPILED) {
    if (route.method !== m) continue;
    if (route.segs.length !== segs.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < route.segs.length; i++) {
      const rs = route.segs[i];
      if (rs.charCodeAt(0) === 58 /* ':' */) {
        params[rs.slice(1)] = decodeURIComponent(segs[i]);
      } else if (rs !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // 惰性载入 handler：把「已移植」的判断留到真正命中时，未移植的返回明确提示
    const { resolveHandler } = require('./handlers');
    return { params, handlerKey: route.handlerKey, handler: resolveHandler(route.handlerKey) };
  }
  return null;
}

module.exports = { match, RAW_ROUTES, USER_ROUTES, ADMIN_ROUTES, PARTNER_ROUTES };
