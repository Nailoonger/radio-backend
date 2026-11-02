'use strict';

/**
 * 管理端「实时角色」—— 修 2026-11-02 陛下报的「切换账号角色不实时同步、权限错乱」
 *
 * ── 病根 ──────────────────────────────────────────────────────────────
 * 管理端 JWT 里带 `{ id, username, role }`，`role` 是**签发那一刻的快照**。
 * `requireAdmin` 直接信这份快照，于是：
 *   · 超管把某人从「超管」改成「社干」→ 那人手里的旧 token 里 role 还是 0，
 *     还能继续调 asSuper 的接口（改账号 / 改开关 / 删数据）——**降权不生效**；
 *   · 把「社干」升成「超管」→ 他那边一直按 role=1 跑，系统管理那组菜单和接口都不放行，
 *     必须等 7 天 token 过期或手动重新登录才生效——**升权也不同步**。
 *
 * ── 口径 ──────────────────────────────────────────────────────────────
 *   · 每个管理端请求查一次 `admin` 表（主键命中，几十行的小表），**role / status 以库为准**；
 *   · 查不到行 → 返回 null，由 `lib/auth.requireAdmin` 保持**既有行为**（沿用 token 里的 role）；
 *     这是刻意留的口子：与 `studentAccount.assertTokenFreshStrict` 的「存量 admin token 例外」同口径，
 *     避免「老师还没登录过就被锁在门外」那类死锁，也避免测试里手造的 token 全变 40101。
 *   · **停用不在这里拦**：停用账号原本按 40301 处理（业务层），改成 40101 属于改契约，本次不动。
 *
 * ⚠️ 不做实例内缓存：缓存多久，权限就有多久是旧的。这个代价比「超管被降权后还能改账号」小得多。
 * ⚠️ 与 `src/services/adminLiveService.js` 同源同口径，改一处要一起改。
 */

const { C, findOne } = require('../lib/db');

/**
 * 按 token 里的 id 取当前管理端行（返回统一形状，绝不带 password）
 * @param {number|string} id
 * @returns {Promise<null|{id:number, username:string|null, nickname:string|null, role:number, status:number}>}
 */
async function load(id) {
  const n = Number(id);
  if (!n) return null;
  const row = await findOne(C.ADMIN, { id: n });
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username === undefined ? null : row.username,
    nickname: row.nickname === undefined ? null : row.nickname,
    role: Number(row.role),
    status: Number(row.status),
  };
}

/**
 * 鉴权用：拿到「这个人现在是什么角色」。
 *
 * ⚠️ 这里**只覆盖角色，不管停用**（2026-11-02 定）：停用账号原本由各接口按 40301 拦
 *    （见 test-partner-roster-phone「停用账号 → 40301」）。如果在入口抛 40101，
 *    等于把「业务上不让干」改成「登录失效」—— 那是改契约，不是修 bug，前端分支也要跟着重写。
 *    本次只解决「角色不同步」，「停用踢下线」留作单独一件事。
 *
 * @param {{id:number}} payload 已验签的 admin token
 */
async function resolve(payload) {
  return load(payload && payload.id);          // null = 查不到行，交给鉴权层保持原逻辑
}

module.exports = { load, resolve };
