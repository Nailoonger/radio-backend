'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { publish, validateArtifacts, main } = require('./publish');
const sha = 'a'.repeat(40), old = 'b'.repeat(40);
function fixture({ head = sha, baselines = { api: old, web: old }, failApi = false, failWeb = false } = {}) {
  const calls = [];
  return { calls, github: { head: async () => head, lastSuccess: async component => baselines[component],
    start: async component => { calls.push(`start:${component}`); return component; },
    status: async (id, state) => calls.push(`${id}:${state}`) },
  cloud: { publishApi: async () => { calls.push('api:write'); if (failApi) throw new Error('云函数健康检查失败'); },
    publishWeb: async () => { calls.push('web:write'); if (failWeb) throw new Error('网页验证失败'); } },
  logger: { log() {} } };
}
test('同次双端发布先云函数，成功后才网页', async () => {
  const f = fixture();
  await publish({ ...f, revision: sha, pathsBetween: () => ['scripts/release/publish.js'] });
  assert.deepEqual(f.calls, ['start:api','api:write','api:success','start:web','web:write','web:success']);
});
test('云函数或配置验收失败阻止网页发布', async () => {
  const f = fixture({ failApi: true });
  await assert.rejects(publish({ ...f, revision: sha, manual: true }), /健康/);
  assert.deepEqual(f.calls, ['start:api','api:write','api:failure']);
});
test('网页失败不会覆盖已经成功的云函数基线', async () => {
  const f = fixture({ failWeb: true });
  await assert.rejects(publish({ ...f, revision: sha, manual: true }), /网页/);
  assert.equal(f.calls.includes('api:success'), true);
  assert.equal(f.calls.at(-1), 'web:failure');
  const retry = fixture({ baselines: { api: sha, web: old } });
  await publish({ ...retry, revision: sha, pathsBetween: base => base === sha ? [] : ['admin-web/src/App.vue'] });
  assert.deepEqual(retry.calls, ['start:web','web:write','web:success']);
});
test('过时任务不写平台，手动初始化不能跳过 master 检查', async () => {
  const f = fixture({ head: old });
  const result = await publish({ ...f, revision: sha, manual: true });
  assert.equal(result.skipped, true);
  assert.deepEqual(f.calls, []);
});
test('无基线自动任务失败；显式初始化才允许发布', async () => {
  const f = fixture({ baselines: { api: null, web: null } });
  await assert.rejects(publish({ ...f, revision: sha }), /发布基线/);
  assert.deepEqual(f.calls, []);
  await publish({ ...f, revision: sha, manual: true });
  assert.equal(f.calls.includes('web:success'), true);
});
test('纯资料改动不发布；PR 即使有配置也不能进入发布入口', async () => {
  const f = fixture();
  assert.deepEqual((await publish({ ...f, revision: sha, pathsBetween: () => ['docs/git-release.md'] })).components, []);
  await assert.rejects(main({ GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'pull_request' }), /仅 master/);
});
test('所有发布产物在生产更新之前校验，缺网页入口、版本或运行依赖均失败', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const apiDir = path.join(dir, 'api'), distDir = path.join(dir, 'web');
  fs.mkdirSync(apiDir); fs.mkdirSync(distDir);
  fs.mkdirSync(path.join(apiDir, 'node_modules'));
  for (const file of ['index.js', 'package.json', 'package-lock.json', 'config.json']) {
    fs.writeFileSync(path.join(apiDir, file), '{}');
  }
  const metadata = { schemaVersion: 1, component: 'web', revision: sha };
  const validate = () => validateArtifacts({ revision: sha, apiDir, distDir });
  fs.writeFileSync(path.join(distDir, 'release.json'), JSON.stringify(metadata));
  assert.throws(validate, /index.html/);
  fs.writeFileSync(path.join(distDir, 'index.html'), '');
  assert.throws(validate, /index.html/);
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html>ready</html>');
  assert.doesNotThrow(validate);
  fs.writeFileSync(path.join(distDir, 'release.json'), JSON.stringify({ ...metadata, schemaVersion: 2 }));
  assert.throws(validate, /本次提交不匹配/);
  fs.writeFileSync(path.join(distDir, 'release.json'), 'credential-shaped-parse-content');
  assert.throws(validate, error => /格式无效/.test(error.message) && !error.message.includes('credential-shaped'));
  fs.writeFileSync(path.join(distDir, 'release.json'), JSON.stringify(metadata));
  fs.rmSync(path.join(apiDir, 'node_modules'), { recursive: true });
  assert.throws(validate, /运行依赖/);
});
