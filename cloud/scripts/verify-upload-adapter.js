'use strict';
/* 验证 admin-web/src/utils/http.js 里新增的「上传适配」。
 *
 * 背景：切到 cloud 通道后，请求体是 **JSON 信封**，`FormData` 一 JSON.stringify 就变 `{}`，
 *       文件直接丢 —— 云函数报 `40001 缺少文件内容（fileBase64）`。
 *       修法是在公共请求层把 FormData 认出来、读成 base64、改发云端契约 `{ filename, fileBase64 }`。
 *
 * 这个脚本要证的就是「那一层转换真的能接上」：
 *   ① 单元：跑 `http.js` 里**真实的那份源码**（不是抄一份），断言产物形状 = 云端契约
 *   ② 端到端（本地闭环，不需要密钥）：真 FormData → 真适配器 → 真云函数（内存假库 harness）
 *      ⇒ 证明「适配器的输出」被真 handler 吃得下、能解析出表格
 *   ③ 远端（可选）：有 JWT_SECRET 时再打一次真云端
 *
 * 用法（仓库根目录）：
 *   node cloud/scripts/verify-upload-adapter.js
 *   JWT_SECRET='<云端那串>' node cloud/scripts/verify-upload-adapter.js   # 追加第 ③ 段
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(ROOT, 'cloud', 'cloudfunctions', 'api');
const CLOUD_API = 'https://jy-radio-d1gdwmptl816ee6a9-1491709115.ap-shanghai.app.tcloudbase.com/api';
const SECRET = process.env.JWT_SECRET || '';

let failed = 0;
function ok(name, cond, extra = '') {
  if (!cond) failed++;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ── Node 里没有 FileReader，补一个最小实现（用 Blob.arrayBuffer） ── */
globalThis.FileReader = class FileReader {
  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = `data:${blob.type || ''};base64,${Buffer.from(buf).toString('base64')}`;
        if (this.onload) this.onload();
      })
      .catch((e) => {
        this.error = e;
        if (this.onerror) this.onerror();
      });
  }
};

/* ── 从 http.js 里抠出真实函数源码（按括号配平截取，测的就是那一份） ── */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`没找到函数 ${name}`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 括号不配平`);
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

(async () => {
  /* ═══════════════ ① 单元：真实源码 → 云端契约形状 ═══════════════ */
  console.log('══ ① 单元：formDataToFilePayload（跑 http.js 里的真实源码）══');
  const src = fs.readFileSync(path.join(ROOT, 'admin-web', 'src', 'utils', 'http.js'), 'utf8');
  const bizError = (code, message) => Object.assign(new Error(message), { code });
  const formDataToFilePayload = new Function(`${extractFn(src, 'formDataToFilePayload')}\nreturn formDataToFilePayload;`)();

  const fakeBytes = Buffer.from('PK\u0003\u0004hello-xlsx');
  const fd = new FormData();
  fd.append('file', new File([fakeBytes], '名册.xlsx', { type: XLSX_MIME }));
  const out = await formDataToFilePayload(fd, bizError);

  eq('filename 带上了扩展名（云端靠它判 csv/xlsx）', out.filename, '名册.xlsx');
  ok('产物里有 fileBase64', typeof out.fileBase64 === 'string' && out.fileBase64.length > 0);
  ok('不带 data: 前缀（云端直接 Buffer.from(b64)）', !out.fileBase64.startsWith('data:'));
  ok('base64 往返一致（字节没被改坏）', Buffer.from(out.fileBase64, 'base64').equals(fakeBytes));
  eq('字段名就是云端契约那个', Object.keys(out).filter((k) => k === 'fileBase64'), ['fileBase64']);

  try {
    await formDataToFilePayload(new FormData(), bizError);
    ok('空 FormData 应当报错而不是静默发空', false);
  } catch (e) {
    eq('空 FormData → 40001「没有找到要上传的文件」', [e.code, e.message], [40001, '没有找到要上传的文件']);
  }

  /* ═══════════════ ② 端到端（本地闭环）：真 FormData → 真云函数 ═══════════════ */
  console.log('\n══ ② 端到端（本地假库）：适配器输出 → 真 importPreview ══');

  const H = require('./harness');
  const { sign } = require(path.join(API_DIR, 'lib', 'auth'));
  const sheet = require(path.join(API_DIR, 'services', 'sheet'));
  const switchSvc = require(path.join(API_DIR, 'services', 'switch'));
  const accountService = require(path.join(API_DIR, 'services', 'studentAccount'));
  const bcrypt = require('bcryptjs');

  const HASH = bcrypt.hashSync('password123', 4);
  const SUPER_TOKEN = sign({ id: 1, username: 'root', role: 0 });

  H.reset({
    admin: [{ _id: 'ad1', id: 1, username: 'root', password: HASH, nickname: '超管', role: 0, status: 1, createTime: new Date() }],
    user: [
      // 已存在且未激活 —— 预览里应归入 update
      { _id: 'u1', id: 1, openid: null, username: '20240101', password: HASH, grade: '2024', classNo: '01', seatNo: '01', nickname: '张三', status: 1, pwdChangedAt: null, lastLoginAt: null, loginCount: 0, importBatchId: null, createTime: new Date('2026-09-01T10:00:00+08:00'), updateTime: new Date() },
    ],
  });
  switchSvc.invalidate();
  accountService._clearCache();

  // 造一张**真 xlsx**（用云函数自己的 sheet 服务，不自造一个假的 Excel）
  const xbuf = await sheet.buildWorkbook([{
    name: '名册',
    columns: [{ header: '年级', width: 10 }, { header: '班级', width: 10 }, { header: '序号', width: 10 }, { header: '姓名', width: 14 }],
    rows: [
      ['2024', '01', '01', '张三'],   // 库里已有、未激活 → update
      ['2024', '03', '01', '钱七'],   // 新建 → new
    ],
  }]);

  // ⭐ 这里是关键：走**和浏览器里一模一样的路径**
  //    FormData（ImportSheet.vue 的写法）→ 适配器 → 信封 body
  const fd2 = new FormData();
  fd2.append('file', new File([xbuf], '名册.xlsx', { type: XLSX_MIME }));
  const payload = await formDataToFilePayload(fd2, bizError);

  const r = await H.call(H.req('POST', '/admin/student/import/preview?force=0', payload, SUPER_TOKEN));

  eq('适配器产物直接喂给 importPreview → code 0', r.code, 0);
  if (r.code === 0 && r.data) {
    eq('回显 filename（说明 base64 与文件名都被吃到了）', r.data.filename, '名册.xlsx');
    eq('sheetName 解析出来了', r.data.sheetName, '名册');
    eq('总计行数', r.data.totalRows, 2);
    eq('分类统计：新建 1 / 覆盖 1 / 跳过 0 / 异常 0', r.data.summary, { new: 1, update: 1, active: 0, invalid: 0 });
    eq('账号拼装正确', [r.data.rows[0].username, r.data.rows[1].username], ['20240101', '20240301']);
    console.log('  ⇒ 链路通了：浏览器 FormData → 适配器 → 云端契约 → 真 handler 解析成功');
  } else {
    console.log('  ⇒ 失败：' + (r.message || JSON.stringify(r)));
  }

  // 反证：不经过适配器（直接把 FormData 塞进信封 = 修复前的行为）会怎样
  const rawFd = new FormData();
  rawFd.append('file', new File([xbuf], '名册.xlsx', { type: XLSX_MIME }));
  const broken = await H.call(H.req('POST', '/admin/student/import/preview', JSON.parse(JSON.stringify(rawFd)), SUPER_TOKEN));
  eq('反证：修复前那样发（信封里塞 FormData）→ 40001 缺少文件内容', [broken.code, broken.message], [40001, '缺少文件内容（fileBase64）']);

  /* ═══════════════ ③ 远端（可选）：打真云端 ═══════════════ */
  if (!SECRET) {
    console.log('\n══ ③ 远端 ══');
    console.log('  (未提供 JWT_SECRET，跳过。要跑就：JWT_SECRET=<云端那串> node cloud/scripts/verify-upload-adapter.js)');
  } else {
    console.log('\n══ ③ 远端：真 xlsx → 真云端 importPreview ══');
    const b64u = (x) => Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const p = b64u(JSON.stringify({ id: 1, username: 'teacher', role: 0, iat: now, exp: now + 300 }));
    const T = `${h}.${p}.${b64u(crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
    const call = async (m, pathname, body) => {
      const res = await fetch(CLOUD_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: m, path: pathname, body: body || {}, token: T }),
      });
      return res.json();
    };
    const remote = await call('POST', '/admin/student/import/preview?force=0', payload);
    eq('真云端 importPreview → code 0', remote.code, 0);
    if (remote.code === 0 && remote.data) {
      console.log(`  ⇒ 云端解析成功：sheetName=${remote.data.sheetName} 行数=${remote.data.totalRows} 统计=${JSON.stringify(remote.data.summary)}`);
    } else {
      console.log('  ⇒ ' + remote.code + ' ' + (remote.message || ''));
    }
  }

  console.log(`\n══ 汇总 ══\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
})();
