#!/usr/bin/env node
'use strict';

/**
 * 前后端接口对齐检查（静态）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/check-contract.js
 *   node cloud/scripts/check-contract.js --json     # 机器可读，给 CI 用
 *
 * ═══════════ 为什么需要这个脚本 ═══════════
 * 这个项目的前后端是**两套独立代码**：
 *   后端 → cloud/cloudfunctions/api/router.js 的 RAW_ROUTES（'METHOD /path' → handlerKey）
 *   前端 → miniprogram 里散落的 41 处 `request('/xxx', 'GET', ...)` / `adminRequest(...)`
 * 两者之间**没有任何编译期约束**。写错一个路径的后果是：
 *   运行时返回 `40401 接口不存在: GET /partner/xxx`，而这个错误
 *   **只在用户点到那一页时才暴露**，测试覆盖不到就是线上才发现。
 *
 * 今晚就踩过同构的坑：`me.js` 里 `people: '/pages-partner/people/people'` 是死链
 * （页面从没建过），一直靠 navigateTo 的 fail 兜底弹「这一页还没做」——
 * 页面路径和接口路径一样，都是**字符串，拼错了没人管**。
 *
 * 所以这里把「前端调了什么」和「后端注册了什么」对撞一次，
 * 把字符串层面的不一致变成一条能跑的红灯。
 *
 * ═══════════ 检查项 ═══════════
 *  E1 前端调了路由表里没有的接口（**最严重**：一定 404）
 *  E2 前端用的 METHOD 与该路径注册的 METHOD 不一致
 *  E3 契约文件里声明了、但路由表里没有的接口
 *  E4 契约文件里声明了、但前端从没调过的接口（提示，不算错 —— 可能只给 admin-web 用）
 *
 * ⚠️ 刻意**不做**的两件事：
 *   ① 不校验请求体字段：cloud 模式下 body 是普通对象，静态分析拿不到真实形状，
 *      硬猜只会产生假警报。字段级对齐交给运行时校验（test-*.js + harness）。
 *   ② 不把「路由有、前端没调」当错误：admin-web 电脑端大量在用 /admin/*，
 *      小程序没调是正常的。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');
const MP_DIR = path.join(ROOT, 'miniprogram');
const CONTRACT_DIR = path.join(ROOT, 'cloud', 'contracts');

const JSON_OUT = process.argv.includes('--json');

// ─────────────────────────── 路由表 ───────────────────────────

const { RAW_ROUTES } = require(path.join(API_DIR, 'router'));

/** 'GET /user/submit/:id' → { method:'GET', segs:[...], handlerKey } */
const ROUTES = RAW_ROUTES.map(([key, handlerKey]) => {
  const sp = key.indexOf(' ');
  return {
    raw: key,
    method: key.slice(0, sp).toUpperCase(),
    segs: key.slice(sp + 1).split('/').filter(Boolean),
    handlerKey,
  };
});

/** 路径 → 命中的路由（参数段按 :name 通配） */
function matchRoute(method, pathname) {
  const segs = String(pathname).split('/').filter(Boolean);
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (r.segs.length !== segs.length) continue;
    let hit = true;
    for (let i = 0; i < r.segs.length; i++) {
      if (r.segs[i].charCodeAt(0) !== 58 && r.segs[i] !== segs[i]) { hit = false; break; }
    }
    if (hit) return r;
  }
  return null;
}

/** 同一路径（忽略 method）注册过哪些 method —— 用于 E2 的诊断 */
function methodsOf(pathname) {
  const segs = String(pathname).split('/').filter(Boolean);
  return ROUTES.filter((r) => {
    if (r.segs.length !== segs.length) return false;
    for (let i = 0; i < r.segs.length; i++) {
      if (r.segs[i].charCodeAt(0) !== 58 && r.segs[i] !== segs[i]) return false;
    }
    return true;
  }).map((r) => r.method);
}

// ─────────────────────────── 扫描前端 ───────────────────────────

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 从一行里抽调用。
 *
 * 只认**字面量路径**：
 *   request('/user/submit/week', 'GET', {...})
 *   adminRequest('/admin/submit/list', 'GET', {...})
 *   adminRequest('/partner/availability', 'PUT', body)
 *
 * 动态拼接（`'/user/program/' + id`、模板字符串）**跳过并单独统计** ——
 * 静态分析看不到运行时的值，硬报会全是假警报。
 */
const CALL_RE = /\b(adminRequest|request)\s*\(\s*(['"`])([^'"`]*)\2\s*(?:,\s*(['"`])([A-Za-z]+)\4)?/g;

function scanCalls() {
  const files = walk(MP_DIR, []);
  const calls = [];
  const dynamic = [];

  for (const f of files) {
    // utils/request.js 是封装本身，它的 'path' 是形参，不是调用点
    if (/utils[\\/]request\.js$/.test(f)) continue;

    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, i) => {
      CALL_RE.lastIndex = 0;
      let m;
      while ((m = CALL_RE.exec(line))) {
        const raw = m[3];
        const method = (m[5] || 'GET').toUpperCase();
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');

        /**
         * ⚠️ 字面量后面紧跟 `+` ⇒ 这是拼接的第一段，不是完整路径。
         *    例：`request('/user/recruitment/' + path, method, ...)`
         *    正则只能看到 `'/user/recruitment/'`，把它当完整路径就会报一条假的 E1。
         *    （第一版就是这么误报的，被 miniprogram/utils/recruitment.js:38 抓到。）
         */
        const tail = line.slice(m.index + m[0].length);
        if (/^\s*\+/.test(tail)) {
          dynamic.push({ file: rel, line: i + 1, raw: raw + ' + …', reason: '路径为动态拼接' });
          continue;
        }

        if (!raw.startsWith('/')) {
          dynamic.push({ file: rel, line: i + 1, raw, reason: '路径不是以 / 开头' });
          continue;
        }
        // 去掉自带 querystring：'/user/submit/notice?type=song' → '/user/submit/notice'
        const pathname = raw.split('?')[0];
        calls.push({ file: rel, line: i + 1, raw, pathname, method });
      }

      // 模板字符串拼接：request(`/user/program/${id}`)
      if (/\b(adminRequest|request)\s*\(\s*`[^`]*\$\{/.test(line)) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        dynamic.push({ file: rel, line: i + 1, raw: line.trim().slice(0, 80), reason: '路径为模板字符串' });
      }
    });
  }
  return { calls, dynamic };
}

// ─────────────────────────── 契约文件 ───────────────────────────

function loadContracts() {
  const out = [];
  if (!fs.existsSync(CONTRACT_DIR)) return out;
  for (const f of fs.readdirSync(CONTRACT_DIR)) {
    if (!f.endsWith('.js')) continue;
    const mod = require(path.join(CONTRACT_DIR, f));
    Object.keys(mod).forEach((key) => out.push(Object.assign({ key, source: f }, mod[key])));
  }
  return out;
}

// ─────────────────────────── 主流程 ───────────────────────────

const errors = [];
const warns = [];
const infos = [];

const { calls, dynamic } = scanCalls();

// E1 / E2
const seen = new Set();
for (const c of calls) {
  const id = `${c.method} ${c.pathname}`;
  if (seen.has(id)) continue;
  seen.add(id);

  const hit = matchRoute(c.method, c.pathname);
  if (!hit) {
    const others = methodsOf(c.pathname);
    if (others.length) {
      // E2：路径存在但方法不对 —— 比 E1 更隐蔽（会返回 40401 而不是 405）
      errors.push({
        code: 'E2',
        msg: `METHOD 不匹配：前端用 ${c.method}，路由只注册了 ${others.join('/')}`,
        at: `${c.file}:${c.line}`,
        path: c.pathname,
      });
    } else {
      errors.push({
        code: 'E1',
        msg: '前端调用了不存在的接口（运行时必然 40401）',
        at: `${c.file}:${c.line}`,
        path: c.pathname,
        method: c.method,
      });
    }
  }
}

// E3 / E4
const contracts = loadContracts();
const calledIds = new Set(calls.map((c) => `${c.method} ${c.pathname}`));
for (const ct of contracts) {
  const hit = matchRoute(ct.method, ct.path);
  if (!hit) {
    errors.push({
      code: 'E3',
      msg: '契约声明了、但路由表里没有这个接口',
      at: `contracts/${ct.source}`,
      path: ct.path,
      method: ct.method,
    });
    continue;
  }
  if (!calledIds.has(`${ct.method} ${ct.path}`)) {
    infos.push({
      code: 'E4',
      msg: '契约声明了、但小程序端没有调用点（可能只给 admin-web 用）',
      at: `contracts/${ct.source}`,
      path: ct.path,
      method: ct.method,
    });
  }
}

// 前端调用点里，有多少落在 /partner/* 上（观察伙伴端的接口面）
const partnerCalls = calls.filter((c) => c.pathname.startsWith('/partner/'));

// ─────────────────────────── 输出 ───────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: errors.length === 0,
    summary: {
      routes: ROUTES.length,
      calls: calls.length,
      uniqueCalls: seen.size,
      partnerCalls: partnerCalls.length,
      dynamicSkipped: dynamic.length,
      contracts: contracts.length,
      errors: errors.length,
      warns: warns.length,
      infos: infos.length,
    },
    errors, warns, infos, dynamic,
  }, null, 2));
  process.exit(errors.length ? 1 : 0);
}

const line = (s) => console.log(s);

line('');
line('═══ 前后端接口对齐检查 ═══');
line('');
line(`路由表      ${ROUTES.length} 条`);
line(`前端调用点  ${calls.length} 处（去重 ${seen.size} 个 METHOD+path）`);
line(`其中 /partner/*  ${partnerCalls.length} 处`);
line(`契约声明    ${contracts.length} 条`);
line(`动态路径     ${dynamic.length} 处（静态分析跳过）`);
line('');

if (errors.length) {
  line(`✗ 错误 ${errors.length} 条`);
  errors.forEach((e) => {
    line(`  [${e.code}] ${e.method || ''} ${e.path || ''}`);
    line(`        ${e.msg}`);
    line(`        at ${e.at}`);
  });
} else {
  line('✓ 无错误：前端调用的每个接口都在路由表里，METHOD 也一致');
}

if (infos.length) {
  line('');
  line(`· 提示 ${infos.length} 条`);
  infos.forEach((e) => line(`  [${e.code}] ${e.method} ${e.path}  (${e.at})`));
}

if (dynamic.length) {
  line('');
  line(`· 动态路径 ${dynamic.length} 处（需人工确认，静态分析看不到运行时值）`);
  dynamic.slice(0, 10).forEach((d) => line(`  ${d.file}:${d.line}  ${d.reason}`));
  if (dynamic.length > 10) line(`  …还有 ${dynamic.length - 10} 处`);
}

line('');
process.exit(errors.length ? 1 : 0);
