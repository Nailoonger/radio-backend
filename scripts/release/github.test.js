'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GitHub } = require('./github');
const sha = 'a'.repeat(40);
test('按组件查成功基线，忽略失败和其他部署入口', async () => {
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/statuses')
    ? [{ state: url.includes('/2/') ? 'failure' : 'success' }]
    : [{ id: 3, sha, payload: { managedBy: 'other', component: 'web' } },
      { id: 2, sha: 'b'.repeat(40), payload: { managedBy: 'radio-release-v1', component: 'web' } },
      { id: 1, sha, payload: { managedBy: 'radio-release-v1', component: 'web' } }] });
  const github = new GitHub({ repo: 'owner/repo', token: 'fake', fetchImpl });
  assert.equal(await github.lastSuccess('web'), sha);
});
test('发布记录不自动合并，无令牌进入正文', async () => {
  const bodies = [];
  const github = new GitHub({ repo: 'owner/repo', token: 'private', fetchImpl: async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: 10 }) };
  } });
  await github.start('api', sha);
  assert.equal(bodies[0].auto_merge, false);
  assert.deepEqual(bodies[0].required_contexts, []);
  assert.equal(bodies[0].payload.component, 'api');
  assert.equal(JSON.stringify(bodies).includes('private'), false);
  assert.equal(bodies[1].state, 'in_progress');
});
test('权限错误只报告 HTTP 状态，不读取平台错误正文', async () => {
  const github = new GitHub({ repo: 'owner/repo', token: 'fake', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(github.head(), /HTTP 403/);
});
