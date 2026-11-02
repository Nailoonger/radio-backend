'use strict';

/**
 * 管理端「实时角色」—— 直连（src）侧，与 `cloud/cloudfunctions/api/services/adminLive.js` 同源同口径。
 *
 * 修的是 2026-11-02 陛下报的「账号管理里切角色不实时同步、权限错乱」：
 * 管理端 JWT 里的 `role` 是签发那一刻的快照，改角色不会改它 ⇒
 *   降权的人旧 token 还能调 requireSuperAdmin 的接口；
 *   升权的人要等 7 天 token 过期或重新登录才生效。
 *
 * 口径（与云端逐条一致）：
 *   · 每个管理端请求查一次 `admin` 行（主键），role / status **以库为准**；
 *   · 查不到行 → 返回 null，`adminAuth` 保持**既有行为**（沿用 token 里的 role），
 *     与 studentAccountService 的「存量 admin token 例外」同口径；
 *   · **停用不在这里拦**：停用账号原本按 40301 处理（业务层），改成 401 属于改契约，本次不动。
 *
 * ⚠️ 不做缓存：缓存多久，权限就有多久是旧的。
 */

const { Admin } = require('../models');

/**
 * @param {number|string} id
 * @returns {Promise<null|{id:number, username:string|null, nickname:string|null, role:number, status:number}>}
 */
async function load(id) {
  const n = Number(id);
  if (!n) return null;
  const row = await Admin.findByPk(n);
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
 * 鉴权用：这个人**现在**是什么角色。
 * ⚠️ 只覆盖角色，不管停用（停用原本由业务层按 40301 拦，改成 401 属于改契约，本次不动）。
 * @param {{id:number}} payload 已验签的 admin token
 */
async function resolve(payload) {
  return load(payload && payload.id);          // null = 查不到行，交给 adminAuth 保持原逻辑
}

module.exports = { load, resolve };
