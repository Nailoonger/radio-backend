'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cleanEnvironment, sourceJsFiles, resolveApiUrl, parseArgs, verify } = require('./verify');

test('校验子进程不获得生产凭据或真实联调开关', () => {
  const input = { JWT_SECRET: 'fixture', WECHAT_SECRET: 'fixture', TCB_SECRET_ID: 'fixture',
    TCB_SECRET_KEY: 'fixture', GITHUB_TOKEN: 'fixture', NEW_JWT_SECRET: 'fixture',
    HARNESS_API_DIR: '/stale/bundle', MOCK_WECHAT: '1', NODE_ENV: 'test', PATH: '/usr/bin',
    VITE_CLOUD_API_URL: 'https://example.invalid/api' };
  const result = cleanEnvironment(input);
  for (const key of Object.keys(input).filter((key) => /SECRET|TOKEN|HARNESS/.test(key))) {
    assert.equal(result[key], undefined, key);
  }
  assert.equal(result.PATH, input.PATH);
  assert.equal(result.DB_STORAGE, ':memory:');
  assert.equal(result.NODE_ENV, 'development');
  assert.equal(result.MOCK_WECHAT, undefined);
  assert.equal(input.JWT_SECRET, 'fixture');
});

test('生产必须明确配置真实 HTTPS API，PR 可以使用无效域名', () => {
  assert.throws(() => resolveApiUrl('', true), /缺少/);
  assert.throws(() => resolveApiUrl('http://example.com/api', true), /HTTPS/);
  assert.throws(() => resolveApiUrl('https://user:pass@example.com/api', true), /账号密码/);
  assert.throws(() => resolveApiUrl('https://example.invalid/api', true), /测试/);
  assert.equal(resolveApiUrl('', false), 'https://example.invalid/api');
  assert.equal(resolveApiUrl('https://example.com/api', true), 'https://example.com/api');
});

test('小程序源码检查排除生成的云函数和安装依赖', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-verify-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const file of ['app.js', 'pages/index.js', 'cloudfunctions/api/index.js', 'node_modules/cache.js']) {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  assert.deepEqual(sourceJsFiles(temp).map((file) => path.relative(temp, file).replace(/\\/g, '/')),
    ['app.js', 'pages/index.js']);
});

test('policy 与 mini 范围只执行对应校验，不构建或安装线上产物', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-verify-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts/release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'miniprogram'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/release/policy.test.js'), '');
  fs.writeFileSync(path.join(root, 'miniprogram/app.js'), '');
  const stages = [];
  const runStage = (label, executable, args, options) => stages.push({ label, args, env: options.env });
  verify({ root, scope: 'policy', runStage });
  assert.equal(stages.length, 1);
  stages.length = 0;
  verify({ root, scope: 'mini', runStage });
  assert.equal(stages.length, 2);
  assert.ok(stages[1].args.includes('--check'));
  assert.throws(() => verify({ root, scope: 'unknown', runStage }), /scope/);
});

test('校验 CLI 拒绝缺失参数且保留显式生产选项', () => {
  assert.deepEqual(parseArgs(['--scope', 'mini', '--production']), { scope: 'mini', production: true });
  assert.throws(() => parseArgs(['--revision']), /不完整/);
});

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-verify-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts/release', 'miniprogram', 'admin-web/dist']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'scripts/release/policy.test.js'), '');
  fs.writeFileSync(path.join(root, 'miniprogram/app.js'), '');
  return root;
}

test('前置校验失败立即停止，不生成网页构建或成功产物', (t) => {
  const root = fixtureRoot(t);
  const stages = [];
  assert.throws(() => verify({ root, revision: 'a'.repeat(40), apiUrl: 'https://example.invalid/api',
    runStage: (label) => { stages.push(label); if (label.includes('源码回归')) throw new Error('fixture failure'); },
  }), /fixture failure/);
  assert.ok(stages.some((label) => label.includes('重新生成')));
  assert.ok(!stages.some((label) => label.includes('构建')));
  assert.ok(!fs.existsSync(path.join(root, 'admin-web/dist/release.json')));
});

test('完整校验传递隔离环境和固定云地址，产物公开记录同一提交', (t) => {
  const root = fixtureRoot(t);
  const stages = [];
  const revision = 'b'.repeat(40);
  verify({ root, revision, production: true, apiUrl: 'https://example.com/api',
    env: { JWT_SECRET: 'fixture', TCB_SECRET_KEY: 'fixture' },
    runStage: (label, executable, args, options) => stages.push({ label, options }),
    log: () => {},
  });
  const build = stages.find((stage) => stage.label === '管理后台云通道构建');
  assert.equal(build.options.env.VITE_REQUEST_MODE, 'cloud');
  assert.equal(build.options.env.VITE_CLOUD_API_URL, 'https://example.com/api');
  for (const stage of stages) {
    assert.equal(stage.options.env.JWT_SECRET, undefined);
    assert.equal(stage.options.env.TCB_SECRET_KEY, undefined);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'admin-web/dist/release.json'), 'utf8')),
    { schemaVersion: 1, component: 'web', revision });
  assert.ok(stages.some((stage) => stage.label === '真实云函数运行依赖加载'));
});
