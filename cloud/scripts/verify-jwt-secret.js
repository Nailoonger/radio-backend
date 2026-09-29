#!/usr/bin/env node
/**
 * verify-jwt-secret.js —— 云函数 JWT_SECRET 补配的「反向验证」
 *
 * 为什么不能只验「能登录」：
 *   兜底密钥 `radio-station-default-secret` 写在公开仓库里（cloud/cloudfunctions/api/lib/auth.js:21）。
 *   若 JWT_SECRET 没配上，用兜底值自签的 token 照样能调管理端接口 —— 那时「能登录」也是真的。
 *   ⇒ 唯一可靠的判据是 **反向**：兜底值必须失效（40101），新值必须有效（200）。
 *
 * 判据（⚠️ 本项目 HTTP 恒 200，业务结果全在响应体的 `code` 里，别拿 HTTP 状态码判）
 *   A. 兜底密钥自签 → GET /admin/profile  必须 `code=40101`  （配上了才会这样）
 *   B. 新密钥自签   → GET /admin/profile  必须 `code=0` + 真实数据（证明新值生效、签发/校验自洽）
 *
 * 用法
 *   # 只跑 A（陛下还没告我新值时）
 *   node cloud/scripts/verify-jwt-secret.js
 *
 *   # A + B
 *   NEW_JWT_SECRET='xwDjdgggi_...' node cloud/scripts/verify-jwt-secret.js
 *
 *   # 覆盖端点
 *   CLOUD_API_URL='https://xxx.tcloudbase.com/api' node cloud/scripts/verify-jwt-secret.js
 *
 * 退出码：0 = 全部符合预期；1 = 有不符合（说明还没生效或配错了）。
 */

const crypto = require('crypto');

const API = (process.env.CLOUD_API_URL ||
  'https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api').replace(/\/+$/, '');

const FALLBACK_SECRET = process.env.FALLBACK_SECRET || 'radio-station-default-secret';
const NEW_SECRET = process.env.NEW_JWT_SECRET || process.env.NEW_SECRET || '';

// 与 src/config、cloud lib/auth.js 里的管理端 payload 形状一致
const ADMIN_PAYLOAD = { id: 1, username: 'teacher', role: 0 };

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** 纯 Node 手写 HS256 签名，避免依赖 jsonwebtoken */
function signHS256(payload, secret, expiresInSec = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(body));
  const data = `${h}.${p}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

async function probe(label, token) {
  const url = `${API}/admin/profile`;
  let res, text;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    text = await res.text();
  } catch (e) {
    return { label, http: 0, errcode: null, ok: false, note: `请求失败：${e.message}` };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }

  const http = res.status;
  const code = json && (json.code !== undefined ? json.code : json.errcode);
  const msg = json && (json.msg || json.message || json.errmsg);

  // ⚠️ 判据只看 `code`，不能看 `data` 有没有值：
  //    被拒时响应是 `{"code":40101,...,"data":null}` —— `null !== undefined` 为真，
  //    用 `data !== undefined` 判断会把「拒绝」误判成「通过」（本脚本初版就踩了）。
  //    本项目约定 HTTP 恒 200，业务结果全在 `code` 里（0 = ok）。
  const accepted = (code !== undefined && code !== null) ? Number(code) === 0 : http === 200;
  return { label, http, errcode: code, msg, accepted, note: '' };
}

(async () => {
  console.log(`端点: ${API}/admin/profile`);
  console.log('');

  const fb = await probe('A. 兜底密钥', signHS256(ADMIN_PAYLOAD, FALLBACK_SECRET));
  console.log(`[A] 兜底密钥 radio-station-default-secret → HTTP ${fb.http}  code=${fb.errcode}  ${fb.msg || ''} ${fb.note}`);
  console.log(`    期望：被拒（code=40101）。实际：${fb.accepted ? '❌ 竟然通过了 —— JWT_SECRET 还没生效！' : '✅ 已被拒绝'}`);
  console.log('');

  let allOk = !fb.accepted;

  if (NEW_SECRET) {
    const nw = await probe('B. 新密钥', signHS256(ADMIN_PAYLOAD, NEW_SECRET));
    console.log(`[B] 新密钥（前 8 位 ${NEW_SECRET.slice(0, 8)}…）→ HTTP ${nw.http}  code=${nw.errcode}  ${nw.msg || ''} ${nw.note}`);
    console.log(`    期望：通过（HTTP 200 + 数据）。实际：${nw.accepted ? '✅ 已通过' : '❌ 被拒 —— 新值没配上，或值不一致'}`);
    console.log('');
    allOk = allOk && nw.accepted;
  } else {
    console.log('[B] 跳过（未提供 NEW_JWT_SECRET）。想连正验一起跑：');
    console.log("    NEW_JWT_SECRET='<你填的那串>' node cloud/scripts/verify-jwt-secret.js");
    console.log('');
  }

  console.log(allOk ? '结论：✅ 符合预期' : '结论：❌ 不符合预期，见上面 ❌ 项');
  console.log('补充：A 通过只说明「兜底值失效了」；要完全确认，还需要一次真实的账号密码登录。');
  process.exit(allOk ? 0 : 1);
})();
