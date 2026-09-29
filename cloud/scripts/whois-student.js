#!/usr/bin/env node
/**
 * whois-student.js —— 「某个学号登不上」的一站式排查
 *
 * 回答三件事：
 *   1. 云端库里有没有这个账号、什么状态（启用 / 停用 / 仍是初始密码 / 已改密 / 最近登录时间）
 *   2. 默认密码（user+学号）能不能登进去
 *   3. 顺带告诉你「该学生是不是改过密码」—— 改过的话任何人都推不出原密码，只能重置
 *
 * 用法（需要一个超管密钥来调管理端接口；就是你配到云函数的那串 JWT_SECRET）：
 *   JWT_SECRET='<你的 JWT_SECRET>' node cloud/scripts/whois-student.js 20240201
 *   JWT_SECRET='<...>' CLOUD_API_URL='https://xxx.tcloudbase.com/api' node cloud/scripts/whois-student.js 20240201
 *   一次查多个：node cloud/scripts/whois-student.js 20240201 20230101
 *
 * 说明：只做**只读**查询 + 一次登录尝试（登录成功会 +1 loginCount，介意的话别跑第 2 步）。
 */

const crypto = require('crypto');

const API = (process.env.CLOUD_API_URL ||
  'https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api').replace(/\/+$/, '');
const SECRET = process.env.JWT_SECRET || '';
const INIT_PREFIX = 'user'; // 初始密码 = 'user' + 学号（src/services/studentAccountService.js）

const usernames = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!usernames.length) {
  console.error('用法: JWT_SECRET=<你的密钥> node cloud/scripts/whois-student.js <学号> [学号...]');
  process.exit(2);
}
if (!SECRET) {
  console.error('缺少 JWT_SECRET 环境变量（用来签一个超管 token 调管理端接口）。');
  process.exit(2);
}

const b64 = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function signHS256(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ ...payload, iat: now, exp: now + 600 }));
  return `${h}.${p}.${b64(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}
const adminToken = signHS256({ id: 1, username: 'teacher', role: 0 }, SECRET);

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { code: -1, message: text.slice(0, 200) }; }
}

const fmtTime = (v) => {
  if (!v) return '—';
  const d = new Date(v && v.$date ? v.$date : v);
  if (isNaN(d)) return String(v);
  // 转北京时间
  return new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
};

(async () => {
  console.log(`端点: ${API}\n`);
  for (const u of usernames) {
    console.log(`══════ ${u} ══════`);

    // ── 1. 管理端查账号状态 ─────────────────────────────
    const listed = await api(`/admin/student/list?keyword=${encodeURIComponent(u)}&pageSize=20`, { token: adminToken });
    if (listed.code !== 0) {
      console.log(`  管理端查询失败: code=${listed.code} ${listed.message || ''}`);
      if (String(listed.code) === '40101') console.log('  → 多半是 JWT_SECRET 传错了（要填云函数里那个真实值）。');
    } else {
      const rows = (listed.data && listed.data.list) || [];
      const hit = rows.filter((r) => String(r.username) === String(u));
      if (!hit.length) {
        console.log(`  ❌ 云端库里**没有**这个账号（共 ${listed.data.total} 条匹配，无精确命中）`);
        console.log('     → 说明该学号从未被导入过，或者导入到了别的学号上。');
      } else {
        for (const r of hit) {
          const status = Number(r.status);
          // ⚠️ 管理端 DTO 的字段是 `activated`（= 已改过密码），**不是** isDefaultPwd —— 别读错。
          const activated = r.activated === true;
          console.log(`  姓名: ${r.name || r.remark || '—'}  班级: ${r.className || '—'}`);
          console.log(`  状态: ${status === 1 ? '✅ 启用' : '⛔ 已停用'}  (status=${r.status})`);
          console.log(`  密码: ${activated
            ? `⚠️ 已改过密码（${fmtTime(r.pwdChangedAt)}）→ 不可逆，谁也推不出来，只能重置`
            : '仍是初始密码（= user + 学号）'}`);
          console.log(`  登录次数: ${r.loginCount ?? '—'}   最近登录: ${fmtTime(r.lastLoginAt)}`);
        }
      }
    }

    // ── 2. 用初始密码试登 ───────────────────────────────
    const pwd = INIT_PREFIX + u;
    const login = await api('/user/login/account', { method: 'POST', body: { username: u, password: pwd } });
    if (login.code === 0) {
      console.log(`  ✅ 初始密码 \`${pwd}\` 可登录（姓名 ${login.data.user.name}）`);
    } else {
      console.log(`  ❌ 初始密码 \`${pwd}\` 登录被拒: code=${login.code} ${login.message || ''}`);
      console.log('     → 若上面显示「已改过密码」，这是正常的；只能去管理后台重置。');
    }
    console.log('');
  }
})();
