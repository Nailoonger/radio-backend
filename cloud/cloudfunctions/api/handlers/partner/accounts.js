'use strict';

/**
 * 伙伴端 · 账号管理（超管）
 *
 *   GET  /partner/accounts/candidates?kw=   学生名册里**还没进后台**的人
 *   POST /partner/accounts/import           批量从名册建号（role=0 超管 / 1 社干 / 2 站员）
 *
 * ═══════════ 为什么要有这个 ═══════════
 *   人在 `user` 表（学号登录），伙伴端的排班/请假/考勤/互评却都按 `admin.id` 记 personId。
 *   两边没有桥 ⇒ 人根本进不来，member 那 12 屏在真机上看不到。
 *   这里补的就是那座桥：从学生档案里挑人，在 admin 表建一行，
 *   并用 `admin.userId` 指回 `user.id` —— 人的身份只有一份（user），伙伴身份是它的第二角色。
 *
 * ═══════════ 三档都从名册来（2026-10-31 第二版口径）═══════════
 *   超管 / 社干 / 站员只是**权限不同**，不是三种人。所以三个角色都从这里建，
 *   账号 = 学号、密码 = 学生自己那份 ⇒「一个账号登录两端」成立。
 *   手打工号那条线已经撇下（陛下原话），别再往回加。
 *
 * ═══════════ 初始密码 ═══════════
 *   与学生账号同一口径：`user` + 学号。首次登录由登录页引导改密。
 *   实现在 `services/adminAccount.createFromStudent()`，本文件不再自己算。
 */

const { C, findAllPaged } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asSuperPartner } = require('./_kit');
/** 建号唯一实现（超管/社干/站员三档同一套），见 services/adminAccount 头注 */
const appAccount = require('../../services/adminAccount');

/** GET /partner/accounts/candidates?kw= —— 学生名册里还没进后台的人 */
async function candidates(ctx) {
  await asSuperPartner(ctx);
  const q = ctx.query || {};
  const kw = String(q.keyword || q.kw || '').trim().toLowerCase();

  const [users, admins] = await Promise.all([
    findAllPaged(C.USER, {}),
    findAllPaged(C.ADMIN, {}),
  ]);
  // 已经进伙伴端的：按 username（学号）与 userId 两条线都排除
  const takenName = {};
  const takenUid = {};
  admins.forEach((a) => {
    if (a && a.username) takenName[String(a.username)] = 1;
    if (a && a.userId) takenUid[Number(a.userId)] = 1;
  });

  let rows = users
    .filter((u) => u && u.username)
    .filter((u) => !takenName[String(u.username)] && !takenUid[Number(u.id)])
    .map((u) => ({
      userId: Number(u.id),
      username: String(u.username),
      name: u.name || u.nickname || String(u.username),
      grade: u.grade || '',
      className: u.className || u.class_name || '',
      status: Number(u.status) === 0 ? 0 : 1,
      /**
       * 是否已有密码 —— 界面据此决定「密码 = 他自己的学生密码」还是
       * 「会给他落初始密码 user+学号」。**只回布尔，绝不回哈希**。
       */
      hasPwd: Boolean(u.password),
    }));

  if (kw) {
    rows = rows.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0
      || x.username.indexOf(kw) >= 0);
  }
  rows.sort((a, b) => String(a.username).localeCompare(String(b.username), 'zh'));
  return { list: rows.slice(0, 200), total: rows.length };
}

/**
 * POST /partner/accounts/import  body: { userIds: [1,2,3], role?: 0|1|2 }
 * 批量建后台账号（默认 role=2 站员）。已存在的跳过并回报，不整体失败。
 *
 * ⚠️ 2026-10-31 第二版口径：超管(0) / 社干(1) / 站员(2) **三档都走这里**，
 *    与 `POST /admin/admin/create` 共用 `services/adminAccount.createFromStudent()`，
 *    字段口径只有一份。原来写在本函数里的建号细节全部搬进那个服务了 ——
 *    改规则请改服务，别在这里补第二份。
 */
async function importAccounts(ctx) {
  const p = await asSuperPartner(ctx);
  const b = ctx.body || {};
  const ids = Array.isArray(b.userIds) ? b.userIds.map(Number).filter((x) => x > 0) : [];
  const role = [0, 1, 2].includes(Number(b.role)) ? Number(b.role) : 2;
  if (!ids.length) throw new ApiError(Codes.PARAM_ERROR, '没有选中任何人');
  if (ids.length > 200) throw new ApiError(Codes.PARAM_ERROR, '一次最多 200 人');

  const created = [];
  const skipped = [];

  for (const uid of ids) {
    try {
      const r = await appAccount.createFromStudent({ userId: uid, role });
      created.push({
        id: r.id,
        userId: r.userId,
        username: r.username,
        name: r.name,
        role: r.role,
        // 非空 = 刚给他落了初始密码（学生档案原本没有密码），界面要显示
        initPassword: r.initPlain || '',
      });
    } catch (e) {
      // 单人失败不影响整批：按 skipped 回报，前端逐条提示
      skipped.push({ userId: uid, reason: (e && e.message) || '建号失败' });
    }
  }

  return {
    created,
    skipped,
    createdCount: created.length,
    // ⚠️ 不在这里回明文密码：账号用的就是他自己的学生密码，界面直接讲这个规则即可
    passwordRule: '用他自己的学生密码（一个学号一份密码，两个入口）',
    by: (p.admin && (p.admin.nickname || p.admin.username)) || '',
  };
}

module.exports = { candidates, importAccounts };
