'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('./detect');
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
test('文档推送也能接住此前等待任务被替换的网页改动', async () => {
  const scope = await detect({ eventName: 'push', event: { before: b }, sha: c,
    github: { lastSuccess: async () => a },
    pathsBetween: base => base === b ? ['docs/test.md'] : ['admin-web/src/App.vue', 'docs/test.md'],
  });
  assert.equal(scope, 'full');
});
test('无未发布积累的文档仅做政策测试，小程序仅做源码检查', async () => {
  const shared = { eventName: 'push', event: { before: b }, sha: c, github: { lastSuccess: async () => b } };
  assert.equal(await detect({ ...shared, pathsBetween: () => ['docs/test.md'] }), 'policy');
  assert.equal(await detect({ ...shared, pathsBetween: () => ['miniprogram/app.js'] }), 'mini');
});
test('PR 不读取部署基线，手动操作执行完整校验', async () => {
  const github = { lastSuccess: async () => { throw new Error('PR 不应查发布基线'); } };
  assert.equal(await detect({ eventName: 'pull_request', event: { pull_request: { base: { sha: a } } },
    sha: c, github, mergeBase: a, pathsBetween: () => ['admin-web/src/App.vue'] }), 'full');
  assert.equal(await detect({ eventName: 'workflow_dispatch', event: {}, sha: c, github }), 'full');
});
