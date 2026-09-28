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

  ['GET /admin/admin/list', 'admin.adminMgr.list'],
  ['POST /admin/admin/create', 'admin.adminMgr.create'],
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

// 系统自检 / 初始化（不属于业务接口，但用同一套网关）
const SYSTEM_ROUTES = [
  ['GET /health', 'system.health'],
  // 一次性建齐所有集合（幂等，可重复调用）；替代「去云开发控制台手点新建集合」
  ['POST /system/init-collections', 'system.initCollections'],
];

const RAW_ROUTES = [...SYSTEM_ROUTES, ...USER_ROUTES, ...ADMIN_ROUTES];

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

module.exports = { match, RAW_ROUTES, USER_ROUTES, ADMIN_ROUTES };
