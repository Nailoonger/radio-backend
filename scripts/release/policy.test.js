'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { componentChanged, scopeForPaths, readConfig, validRevision, safePlatformError } = require('./policy');

test('组件变更覆盖网页、网关与发布机制，文档和旧服务器不发布', () => {
  assert.equal(componentChanged('web', ['admin-web/src/utils/http.js']), true);
  assert.equal(componentChanged('api', ['admin-web/src/utils/http.js']), false);
  assert.equal(componentChanged('api', ['cloud/cloudfunctions/api/handlers/admin/_kit.js']), true);
  for (const component of ['web', 'api']) {
    assert.equal(componentChanged(component, ['scripts/release/publish.js']), true);
    assert.equal(componentChanged(component, ['docs/git-release.md', 'src/app.js', 'sql/schema.sql', 'preview/x.html']), false);
  }
  assert.equal(componentChanged('web', ['admin-web/README.md', 'admin-web/Dockerfile']), false);
});
test('按实际变更确定校验范围', () => {
  assert.equal(scopeForPaths(['docs/git-release.md']), 'policy');
  assert.equal(scopeForPaths(['miniprogram/pages/submit/submit.js']), 'mini');
  assert.equal(scopeForPaths(['cloud/scripts/test-admin-submit.js']), 'full');
  assert.equal(scopeForPaths(['.github/workflows/cloud-release.yml']), 'full');
});
test('缺少配置在发布前明确失败，无凭据值输出', () => {
  assert.throws(() => readConfig({ TCB_SECRET_ID: 'private' }), /TCB_ENV_ID/);
  const config = { TCB_ENV_ID: 'env-123', VITE_CLOUD_API_URL: 'https://api.example.com/api', ADMIN_WEB_URL: 'https://web.example.com/' };
  assert.equal(readConfig(config, { credentials: false }).webUrl, 'https://web.example.com');
  assert.throws(() => readConfig(config), /TCB_SECRET_ID、TCB_SECRET_KEY/);
  assert.throws(() => readConfig({ ...config, ADMIN_WEB_URL: 'http://web.example.com' }, { credentials: false }), /HTTPS/);
  assert.throws(() => readConfig({ ...config, VITE_CLOUD_API_URL: 'https://api.example.com' }, { credentials: false }), /\/api/);
});
test('禁止非完整提交，SDK 错误不泄露原始正文', () => {
  assert.throws(() => validRevision('master'), /完整/);
  assert.equal(validRevision('a'.repeat(40)), 'a'.repeat(40));
  const err = Object.assign(new Error('JWT_SECRET=private'), { code: 'AuthFailure', requestId: 'req-123' });
  assert.equal(safePlatformError(err), '平台请求失败（AuthFailure，请求 req-123）');
});
