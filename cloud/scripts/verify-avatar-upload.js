'use strict';

/**
 * 头像上传链路验证（2026-10-08 新增）
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/verify-avatar-upload.js
 *
 * ═══════════ 为什么要有这一条 ═══════════
 * 起因是陛下报「检查一下上传头像的地方」，查出来的根因不是配置错，而是**路由从没挂过**：
 *   · 本地 `src/routes/admin.js` require 了 uploadController，却**没有 router.post**
 *     （控制器 + multer 中间件一直是写好的）
 *   · 云函数 `api/router.js` 里同样没有这条路由，`handlers/admin/` 下也没有 upload.js
 * 这类「代码都在、就是没接上」的故障**不会报错**，只在用户点上传时给一个 404 ——
 * 所以这里把「接上了没有」当成一等判据钉死（A 段），而不是只测成功路径。
 *
 * 覆盖：
 *   A. 接线（两处路由 + handler 登记）—— 防本次 bug 复发
 *   B. 权限（未登录 40101 / 普管 40301 / 超管放行）
 *   C. 成功路径（fileID 契约、云存储落盘、**逐字节一致**）
 *   D. 校验（空文件 / 非图片 / 伪造扩展名走魔数 / data URL 前缀 / 超 2MB）
 *   E. admin-web 的 cloud:// → https 换算（跑**真实源码**，不抄一份）
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const H = require('./harness');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');
const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
const { match, RAW_ROUTES } = require(path.join(API_DIR, 'router'));

let failed = 0;
let total = 0;
const lines = [];

function ok(name, cond, extra = '') {
  total += 1;
  if (!cond) failed += 1;
  lines.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(name, same, same ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function section(t) { lines.push(`\n---- ${t} ----`); }

const HASH = bcrypt.hashSync('password123', 4);
const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });
const PLAIN_TOKEN = sign({ id: 2, username: 'reviewer', role: 1 });

function seed() {
  H.reset({
    admin: [
      { _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, lastLoginAt: null, createTime: new Date('2026-01-01T00:00:00+08:00'), updateTime: new Date('2026-01-01T00:00:00+08:00') },
      { _id: 'ad2', id: 2, username: 'reviewer', password: HASH, nickname: '普管', role: 1, status: 1, lastLoginAt: null, createTime: new Date('2026-01-02T00:00:00+08:00'), updateTime: new Date('2026-01-02T00:00:00+08:00') },
    ],
  });
}

/* ── 造字节：校验只认文件头，所以只需魔数正确 + 一点内容（断言逐字节一致要靠它） ── */
const b64 = (buf) => buf.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x41), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 0x42)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(64, 0x43)]);
const NOT_IMAGE = Buffer.from('this is definitely not an image file');

const upload = (token, body) => H.call({ method: 'POST', path: '/admin/upload/avatar', body, token });

/** 从 ESM 源码里抠出一个具名函数（按括号配平），用于跑真实实现而非抄一份 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`没找到函数 ${name}`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 括号不配平`);
}

(async () => {
  /* ══════════════════ A. 接线（本次 bug 的根本，必须单独立判据） ══════════════════ */
  section('A. 接线：路由真的挂上了吗');

  const cloudHit = match('POST', '/admin/upload/avatar');
  ok('云函数路由表命中 admin.upload.avatar',
    !!(cloudHit && cloudHit.handlerKey === 'admin.upload.avatar'),
    cloudHit ? cloudHit.handlerKey : '未命中');
  ok('该路由已进 RAW_ROUTES（会被权限矩阵自动覆盖）',
    RAW_ROUTES.some((r) => r[0] === 'POST /admin/upload/avatar'));

  // ⚠️ 产物是**单文件**、没有 handlers/ 目录，这条只能对源码目录做；
  //    产物侧改抓「模块登记字符串 + 实现特征」，由 test-bundle.js 的同款思路覆盖。
  const isBundle = !fs.existsSync(path.join(API_DIR, 'handlers', 'index.js'));
  if (isBundle) {
    const bundleSrc = fs.readFileSync(path.join(API_DIR, 'index.js'), 'utf8');
    ok('[产物] 单文件里已带上 admin.upload 模块登记', /admin\.upload/.test(bundleSrc));
    ok('[产物] 单文件里含 upload.js 的实现（抓文件头特有说明）',
      /所有用户可读，仅创建者可写/.test(bundleSrc));
  } else {
    const indexSrc = fs.readFileSync(path.join(API_DIR, 'handlers', 'index.js'), 'utf8');
    ok('handlers/index.js 已登记 admin.upload（漏登记 = 打包器不收该文件）',
      /['"]admin\.upload['"]\s*:\s*\(\)\s*=>\s*require\(['"]\.\/admin\/upload['"]\)/.test(indexSrc));
  }

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'admin.js'), 'utf8');
  ok('本地 Express 已挂 router.post(\'/upload/avatar\'…（这就是原先缺的那一行）',
    /router\.post\(\s*['"]\/upload\/avatar['"]/.test(routesSrc));
  ok('本地路由带 requireSuperAdmin（与云端 asSuper 对齐）',
    /router\.post\(\s*['"]\/upload\/avatar['"]\s*,\s*adminAuth\s*,\s*requireSuperAdmin/.test(routesSrc));

  /* ══════════════════ B. 权限 ══════════════════ */
  section('B. 权限（云端 asSuper）');
  seed();

  let r = await upload('', { filename: 'a.jpg', fileBase64: b64(JPEG) });
  eq('未登录 → 40101', r.code, 40101);

  r = await upload(PLAIN_TOKEN, { filename: 'a.jpg', fileBase64: b64(JPEG) });
  eq('普通管理员 → 40301', r.code, 40301);

  seed();
  r = await upload(SUPER_TOKEN, { filename: 'a.jpg', fileBase64: b64(JPEG) });
  eq('超管 → 成功', r.code, 0);

  /* ══════════════════ C. 成功路径与契约 ══════════════════ */
  section('C. 成功路径（fileID 契约 + 云存储落盘）');

  const fileID = r.data && r.data.url;
  ok('返回 url 是云存储 fileID（cloud:// 开头）—— 存库就用它',
    typeof fileID === 'string' && fileID.startsWith('cloud://'), String(fileID));
  eq('返回 url 与 fileID 同源（占同一个字段，两条通道调用方零分支）', r.data && r.data.filename,
    String(fileID || '').replace(/^cloud:\/\/[^/]+\//, ''));
  ok('filename 形如 avatars/YYYY-MM/<ts>-<rand>.jpg',
    /^avatars\/\d{4}-\d{2}\/\d+-[0-9a-f]+\.jpg$/.test(String(r.data && r.data.filename)),
    String(r.data && r.data.filename));
  eq('mimetype 由魔数识别为 image/jpeg', r.data && r.data.mimetype, 'image/jpeg');
  eq('size 与上传字节数一致', r.data && r.data.size, JPEG.length);

  const stored = H.storage.get(fileID);
  ok('云存储里确实有该文件', Buffer.isBuffer(stored));
  ok('取回内容与上传内容**逐字节一致**',
    Buffer.isBuffer(stored) && Buffer.compare(stored, JPEG) === 0,
    stored ? `len ${stored.length} vs ${JPEG.length}` : 'not found');

  /* ══════════════════ D. 校验路径 ══════════════════ */
  section('D. 校验');

  seed();
  r = await upload(SUPER_TOKEN, { filename: 'a.jpg' });
  eq('缺 fileBase64 → 40001 未收到文件', r.code, 40001);

  r = await upload(SUPER_TOKEN, { filename: 'a.jpg', fileBase64: '' });
  eq('空字符串 fileBase64 → 40001', r.code, 40001);

  r = await upload(SUPER_TOKEN, { filename: 'fake.jpg', fileBase64: b64(NOT_IMAGE) });
  eq('内容不是图片（仅文件名像）→ 40001', r.code, 40001);
  ok('文案点明支持格式', /jpg|png|webp/.test(String(r.message)), String(r.message));

  r = await upload(SUPER_TOKEN, { filename: 'looks-like-jpg.jpg', fileBase64: b64(PNG) });
  eq('PNG 内容 + .jpg 文件名 → 仍成功', r.code, 0);
  eq('  且按**内容**判定为 image/png（不看文件名）', r.data && r.data.mimetype, 'image/png');
  ok('  存储路径扩展名跟着内容走（.png）',
    /\.png$/.test(String(r.data && r.data.filename)), String(r.data && r.data.filename));

  r = await upload(SUPER_TOKEN, { filename: 'x', fileBase64: b64(WEBP) });
  eq('WEBP 魔数 → 成功', r.code, 0);
  eq('  识别为 image/webp', r.data && r.data.mimetype, 'image/webp');

  r = await upload(SUPER_TOKEN, { filename: 'x.jpg', fileBase64: `data:image/jpeg;base64,${b64(JPEG)}` });
  eq('带 data: 前缀的 base64 也能剥掉', r.code, 0);
  eq('  落盘大小正确（前缀没被算进内容）', r.data && r.data.size, JPEG.length);

  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024 + 16, 0x41)]);
  r = await upload(SUPER_TOKEN, { filename: 'big.jpg', fileBase64: b64(big) });
  eq('超过 2MB → 40001', r.code, 40001);
  ok('文案提示压缩', /2MB/.test(String(r.message)), String(r.message));

  /* ══════════════════ E. admin-web 的 cloud:// → https 换算 ══════════════════ */
  section('E. admin-web 换算（跑真实源码 admin-web/src/utils/avatar.js）');

  const avatarSrcCode = fs.readFileSync(path.join(ROOT, 'admin-web', 'src', 'utils', 'avatar.js'), 'utf8');
  const conv = new Function(`${extractFn(avatarSrcCode, 'cloudFileToHttps')}; return cloudFileToHttps;`)();

  eq('cloud:// → https 直链（官方 WXS 同款换算）',
    conv('cloud://test-env.6a79-test-env-1300000000/avatars/2026-10/a.jpg'),
    'https://6a79-test-env-1300000000.tcb.qcloud.la/avatars/2026-10/a.jpg');
  eq('http 链接原样返回', conv('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  eq('本地相对路径原样返回（旧数据兼容）', conv('/uploads/avatars/2026-09/x.jpg'), '/uploads/avatars/2026-09/x.jpg');
  eq('空值 → 空串（不炸）', conv(''), '');
  eq('畸形 fileID（无斜杠）原样返回，不抛错', conv('cloud://broken'), 'cloud://broken');

  /* ══════════════════ 输出 ══════════════════ */
  lines.push('');
  lines.push(`结论：断言 ${total} 项 / 失败 ${failed} 项`);
  const text = lines.join('\n');
  console.log(text);
  try { fs.writeFileSync(path.join(ROOT, '_verify_avatar_upload.txt'), text, 'utf8'); } catch (e) {}

  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身异常', e);
  process.exit(2);
});
