'use strict';

// 执行管理后台真实请求层，通过内存云网关验证 DELETE 确认和权限边界。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./harness');
const { sign } = require('../cloudfunctions/api/lib/auth');

const ROOT = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(ROOT, 'admin-web/src/utils/http.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/import\.meta\.env/g, '__env')
  .replace(/^export const /gm, 'const ')
  .replace('export default makeFacade();', 'globalThis.facade = makeFacade();');

const captured = [];
let token = sign({ id: 1, username: 'root', role: 0 });
let echo = false;
const noop = () => {};
const context = vm.createContext({
  __env: { VITE_REQUEST_MODE: 'cloud', VITE_CLOUD_API_URL: 'https://example.invalid/api' },
  axios: {
    create: () => ({ defaults: {}, interceptors: { request: { use: noop }, response: { use: noop } } }),
    post: async (url, payload) => {
      // JSON 往返模拟真实浏览器网络序列化，防止测试中的对象引用掩盖参数丢失。
      const envelope = JSON.parse(JSON.stringify(payload));
      captured.push({ url, envelope });
      const data = echo ? { code: 0, data: envelope } : await H.call({
        httpMethod: 'POST', path: '/api', headers: {},
        body: JSON.stringify(envelope), isBase64Encoded: false,
      });
      return { status: 200, data };
    },
  },
  ElMessage: { error: noop },
  router: { currentRoute: { value: { name: 'Login' } }, push: noop },
  localStorage: { getItem: () => token, removeItem: noop },
  Blob, FormData, atob,
});
vm.runInContext(source, context, { filename: 'admin-web/src/utils/http.js' });
const facade = context.facade;
let total = 0;
let failed = 0;
async function check(name, run) {
  total++;
  try { await run(); console.log('OK   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ' :: ' + error.message); }
}
const seed = () => H.reset({ submit: [
  { _id: 'song', id: 1, type: 1 }, { _id: 'article', id: 2, type: 2 },
] });

(async () => {
  seed();
  await check('DELETE config.data 的 DELETE 确认穿过真实门面和网关', async () => {
    const result = await facade.delete('/admin/submit/songs', { data: { confirm: 'DELETE' } });
    assert.equal(result.deletedSongs, 1);
    assert.deepEqual(captured.at(-1).envelope.body, { confirm: 'DELETE' });
  });
  await check('清空只删除点歌，文稿仍保留', () => {
    assert.deepEqual(H.dump().submit.map((row) => row.id), [2]);
  });
  seed();
  await check('缺少确认仍被真实服务端拒绝', async () => {
    await assert.rejects(facade.delete('/admin/submit/songs'), (error) => error.code === 40001);
    assert.equal(H.dump().submit.length, 2);
  });
  seed();
  token = sign({ id: 2, username: 'member', role: 1 });
  await check('普管带 DELETE 确认仍被服务端拒绝', async () => {
    await assert.rejects(facade.delete('/admin/submit/songs', { data: { confirm: 'DELETE' } }),
      (error) => error.code === 40301);
    assert.equal(H.dump().submit.length, 2);
  });

  echo = true;
  token = 'facade-test-token';
  for (const method of ['post', 'put', 'patch']) {
    await check(method.toUpperCase() + ' 仍按 axios 签名保留数据及查询参数', async () => {
      const result = await facade[method]('/fixture', { text: '中文内容' }, { params: { page: 2 } });
      assert.deepEqual(result.body, { text: '中文内容' });
      assert.deepEqual(result.query, { page: 2 });
      assert.equal(result.method, method.toUpperCase());
    });
  }
  await check('GET 仍从配置读取查询参数和可选请求体', async () => {
    const result = await facade.get('/fixture', { params: { page: 3 }, data: { value: 1 } });
    assert.deepEqual(result.query, { page: 3 });
    assert.deepEqual(result.body, { value: 1 });
    assert.equal(result.token, token);
  });
  await check('request 配置中的 DELETE 数据保持一致', async () => {
    const result = await facade.request({ method: 'DELETE', url: '/fixture', data: { confirm: 'DELETE' } });
    assert.deepEqual(result.body, { confirm: 'DELETE' });
    assert.equal(result.method, 'DELETE');
  });
  console.log(`\n结论：断言 ${total} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
