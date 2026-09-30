'use strict';
/**
 * 复验：Express 后端（不是云函数）的 JWT_SECRET 是不是还在用**公开的默认值**。
 *
 * 为什么需要它：adminAuth 中间件只验签名、不查库（见 src/middlewares/auth.js），
 * 所以只要密钥是公开的，任何人都能自签一个 { id, username, role } 冒充超级管理员，
 * **完全绕过密码**。
 *
 * 手法：拿仓库里几个「公开的候选串」各自签一个 token，打 GET /api/admin/profile。
 *   code === 0     -> 🔴 命中，该串就是真密钥（等于后台没锁）
 *   code === 40101 -> ✅ 不是它
 *
 * ⚠️ 只发 GET，不写任何数据，可以安全地对自家环境跑。
 *
 * 用法：
 *   node scripts/verify-backend-jwt.js                       # 默认打线上
 *   node scripts/verify-backend-jwt.js http://127.0.0.1      # 打本机
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const jwt = require('jsonwebtoken');

const BASE = process.argv[2] || 'https://129.28.26.180';
const PROBE_PATH = '/api/admin/profile';

// 这几串都写在公开仓库里，谁读到都能拿来试
const CANDIDATES = [
  ['代码兜底值（src/config）', 'radio-station-default-secret'],
  ['compose 历史兜底值', 'please-change-me-in-production'],
  ['.env.example 历史示例值', 'please-change-me-to-a-long-random-string'],
];

function get(target, token) {
  return new Promise((resolve) => {
    const u = new URL(target);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'GET',
        rejectUnauthorized: false, // 线上是纯 IP + 自签证书
        timeout: 12000,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.end();
  });
}

const parse = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };

(async () => {
  console.log(`目标: ${BASE}${PROBE_PATH}\n`);

  // 基线：不带 token 应该是 40101。若这里就返回 0，说明有更奇怪的问题，先别下结论。
  const anon = await get(BASE + PROBE_PATH, null);
  const anonJson = parse(anon.body);
  if (anon.status === 0) {
    console.log('❌ 目标不可达：' + anon.body);
    console.log('   （后端可能已停，或本机代理在拦 —— 换台机器/关代理再试）');
    process.exit(2);
  }
  console.log(`基线（不带 token）: code=${anonJson ? anonJson.code : 'HTTP' + anon.status}`);
  if (anonJson && anonJson.code === 0) {
    console.log('⚠️ 不带 token 竟然通过了 —— 路径或鉴权逻辑与我们预期不符，结论不可信。');
    process.exit(2);
  }

  console.log('\n用公开候选串自签 token 试探：');
  const hit = [];
  for (const [label, secret] of CANDIDATES) {
    const token = jwt.sign({ id: 1, username: 'teacher', role: 0 }, secret, { expiresIn: '5m' });
    const r = await get(BASE + PROBE_PATH, token);
    const j = parse(r.body);
    const code = j ? j.code : 'HTTP' + r.status;
    const ok = j && j.code === 0;
    if (ok) hit.push({ label, secret });
    console.log(`  ${ok ? '🔴 命中  ' : '✅ 未命中'}  ${label}  ->  code=${code}`);
  }

  console.log('\n=== 结论 ===');
  if (hit.length) {
    console.log('🔴🔴 后端在用公开的默认 JWT 密钥，后台等于没锁：');
    for (const h of hit) console.log(`     ${h.label}  secret=${h.secret}`);
    console.log('\n修法（在服务器 ~/radio 下）：');
    console.log('  1) .env 里加/改：JWT_SECRET=<openssl rand -hex 32 的输出>');
    console.log('     （也可以直接抄学生端云函数里那个真实值，让两边一致）');
    console.log('  2) docker compose up -d --force-recreate radio-backend');
    console.log('  3) 重跑本脚本复验；之后 admin-web 要重登一次（旧 token 全失效，预期行为）');
    process.exit(1);
  }
  console.log('✅ 三个公开候选串都没通过 —— 密钥已配置成非公开值。');
})().catch((e) => { console.error('崩了:', e); process.exit(2); });
