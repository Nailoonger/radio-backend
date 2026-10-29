'use strict';

/**
 * 伙伴端 · 账号管理（超管）
 *
 *   GET  /partner/accounts/candidates?kw=   学生名册里**还没进伙伴端**的人
 *   POST /partner/accounts/import           批量拉人进伙伴端（建 admin 行 role=2）
 *
 * ═══════════ 为什么要有这个 ═══════════
 *   站员在 `user` 表（学号登录），伙伴端的排班/请假/考勤/互评却都按 `admin.id` 记 personId。
 *   两边没有桥 ⇒ 站员根本进不来，member 那 12 屏在真机上看不到。
 *   这里补的就是那座桥：从学生档案里挑人，在 admin 表建一行 `role=2`（站员），
 *   并用 `admin.userId` 指回 `user.id` —— 人的身份只有一份（user），伙伴身份是它的第二角色。
 *
 * ═══════════ 为什么不用「把学号填进 admin.username」手动建 ═══════════
 *   能建，但容易建重、容易打错学号、也看不出这人是不是还在读。
 *   走这条通道：学号从 user 表取（不会错）、已进伙伴端的会被排除（不会重）、
 *   姓名一次带过来（不用再问）。
 *
 * ═══════════ 初始密码 ═══════════
 *   与学生账号同一口径：`user` + 学号（`studentAccountService.initPasswordFor` 的唯一出口，
 *   云函数侧这里直接算，cost 8 保性能）。首次登录由登录页引导改密。
 */

const bcrypt = require('bcryptjs');
const { C, findOne, findMany, insertOne, findAllPaged, reserveUnique } = require('../../lib/db');
const { ApiError, Codes } = require('../../lib/response');
const { asSuperPartner } = require('./_kit');
const { nextId } = require('../../lib/db');

const BCRYPT_COST = 8;      // 初始密码用 8；用户改密后由改密接口升到 10

/** 初始密码 = user + 学号（唯一口径，别在这里改规则） */
function initPasswordFor(username) {
  return `user${String(username || '').trim()}`;
}

/** GET /partner/accounts/candidates?kw= —— 学生名册里还没进伙伴端的人 */
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
    }));

  if (kw) {
    rows = rows.filter((x) => x.name.toLowerCase().indexOf(kw) >= 0
      || x.username.indexOf(kw) >= 0);
  }
  rows.sort((a, b) => String(a.username).localeCompare(String(b.username), 'zh'));
  return { list: rows.slice(0, 200), total: rows.length };
}

/**
 * POST /partner/accounts/import  body: { userIds: [1,2,3], role?: 2 }
 * 批量建伙伴账号（默认 role=2 站员）。已存在的跳过并回报，不整体失败。
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
  const now = new Date();

  for (const uid of ids) {
    const user = await findOne(C.USER, { id: uid });
    if (!user || !user.username) {
      skipped.push({ userId: uid, reason: '学生档案不存在' });
      continue;
    }
    const username = String(user.username);
    const dup = await findOne(C.ADMIN, { username });
    if (dup) {
      skipped.push({ userId: uid, username, reason: '这个学号已经是伙伴账号' });
      continue;
    }

    const id = await nextId(C.ADMIN);
    const got = await reserveUnique('admin', username, id);
    if (!got) {
      skipped.push({ userId: uid, username, reason: '学号被占用（并发）' });
      continue;
    }
    const plain = initPasswordFor(username);
    await insertOne(C.ADMIN, {
      id,
      username,
      password: await bcrypt.hash(plain, BCRYPT_COST),
      nickname: user.name || user.nickname || username,
      role,
      userId: Number(user.id),
      department: '',
      dutyRoles: [],
      status: 1,
      lastLoginAt: null,
      // 标记初始密码，登录页可以据此引导改密
      initPwd: true,
      createTime: now,
      updateTime: now,
    });
    created.push({ id, userId: uid, username, name: user.name || username, role });
  }

  return {
    created,
    skipped,
    createdCount: created.length,
    // ⚠️ 不在这里回明文密码：统一是「user + 学号」，界面上直接告诉用户这个规则即可
    passwordRule: '初始密码 = user + 学号（首次登录会引导改密）',
    by: (p.admin && (p.admin.nickname || p.admin.username)) || '',
  };
}

module.exports = { candidates, importAccounts };
