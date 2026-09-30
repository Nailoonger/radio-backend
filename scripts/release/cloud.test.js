'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { createCloudAdapter } = require('./cloud');

const clone = (value) => structuredClone(value);
const detailFixture = () => ({
  FunctionName: 'api', FunctionId: 'lam-test', Namespace: 'test-env',
  Type: 'Event', Runtime: 'Nodejs18.15', Handler: 'index.main',
  InstallDependency: 'TRUE', MemorySize: 256, Timeout: 60, Status: 'Active',
  Environment: { Variables: [{ Key: 'JWT_SECRET', Value: 'private-test-value' }] },
  Triggers: [{ Name: 'songSweepTick', Type: 'timer', Config: '0 */1 * * * * *', Enable: 1,
    AddTime: 'yesterday', ModTime: 'yesterday' }],
  VpcConfig: { VpcId: 'vpc-fixture', SubnetId: 'subnet-fixture' },
  Role: 'test-role', InitTimeout: 65, AsyncRunEnable: 'FALSE',
  InstanceConcurrencyConfig: { DynamicEnabled: false, MaxConcurrency: 1 },
  CodeSize: 100, ModTime: 'yesterday', RequestId: 'old-request',
});
const routeFixture = () => ({
  Domains: [{ Domain: 'api.test', DomainType: 'HTTPSERVICE', AccessType: 'DIRECT', Enable: true,
    Status: 'SUCCESS', Routes: [{ Path: '/api', UpstreamResourceType: 'SCF',
      UpstreamResourceName: 'api', Enable: true, EnableAuth: false, EnableSafeDomain: false,
      EnablePathTransmission: false, PathRewrite: {}, QPSPolicy: { QPSTotal: 100 } }] }],
  OriginDomain: 'origin.test', TotalCount: 1, RequestId: 'route-request',
});
const websiteFixture = () => ({
  statusCode: 200, headers: { date: 'yesterday' },
  WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' },
    ErrorDocument: { Key: 'index.html' }, RoutingRules: [] },
});

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'radio-release-cloud-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('radio-release-cloud-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const apiDir = path.join(directory, 'api');
  const distDir = path.join(directory, 'web');
  await fs.mkdir(apiDir);
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(apiDir, 'index.js'), 'exports.main = async () => ({});');
  await fs.writeFile(path.join(apiDir, 'package.json'), '{}');
  await fs.writeFile(path.join(apiDir, 'package-lock.json'), '{}');
  const index = Buffer.from('<!doctype html><html><div id="app"></div></html>\n');
  const metadata = Buffer.from(JSON.stringify({ revision: 'a'.repeat(40), component: 'web', schemaVersion: 1 }));
  await fs.writeFile(path.join(distDir, 'index.html'), index);
  await fs.writeFile(path.join(distDir, 'release.json'), metadata);
  const before = clone(options.before || detailFixture());
  const after = clone(options.after || before);
  const routesBefore = clone(options.routesBefore || routeFixture());
  const routesAfter = clone(options.routesAfter || routesBefore);
  const siteBefore = clone(options.siteBefore || websiteFixture());
  const siteAfter = clone(options.siteAfter || siteBefore);
  const calls = [];
  const logs = [];
  let functionReads = 0;
  let routeReads = 0;
  let siteReads = 0;
  let healthCalls = 0;
  let remoteReads = 0;
  const webFetchCounts = new Map();
  const manager = {
    commonService: () => ({ call: async (request) => {
      calls.push(['getFunction', clone(request)]);
      if (options.readError) throw options.readError;
      functionReads += 1;
      return clone(functionReads === 1 ? before : after);
    } }),
    functions: { updateFunctionCode: async (request) => {
      calls.push(['updateFunctionCode', clone(request)]);
      if (options.updateError) throw options.updateError;
      return options.updateResult || { RequestId: 'deadbeef-dead-beef-dead-deadbeefdead' };
    } },
    env: { describeHttpServiceRoute: async (request) => {
      calls.push(['readRoutes', clone(request)]);
      routeReads += 1;
      if (options.routePage) return clone(options.routePage(request));
      return clone(routeReads === 1 ? routesBefore : routesAfter);
    } },
    hosting: {
      getWebsiteConfig: async () => {
        calls.push(['getWebsiteConfig']);
        siteReads += 1;
        return clone(siteReads === 1 ? siteBefore : siteAfter);
      },
      uploadFiles: async (request) => {
        calls.push(['uploadFiles', clone(request)]);
        if (options.uploadError) throw options.uploadError;
        return { verified: true };
      },
      downloadFile: async (request) => {
        calls.push(['downloadFile', clone(request)]);
        remoteReads += 1;
        const isMetadata = request.cloudPath.startsWith('release.json');
        const content = options.remoteFile
          ? options.remoteFile({ request, count: remoteReads, index, metadata, isMetadata })
          : options.remoteMismatch ? Buffer.from('stale') : isMetadata ? metadata : index;
        return Readable.from([content]);
      },
    },
  };
  const fetchImpl = async (url, request) => {
    calls.push(['fetch', String(url), request]);
    if (new URL(url).host === 'api.test') {
      healthCalls += 1;
      if (options.fetchError) throw options.fetchError;
      return { ok: !options.healthHttpFailure, status: options.healthHttpFailure ? 500 : 200,
        json: async () => options.healthBody || { code: 0, data: { dbReady: true, jwtReady: true } } };
    }
    const route = new URL(url).pathname;
    const count = (webFetchCounts.get(route) || 0) + 1;
    webFetchCounts.set(route, count);
    return { ok: !options.web404, status: options.web404 ? 404 : 200,
      arrayBuffer: async () => options.webBodyFor
        ? options.webBodyFor({ route, count, index }) : options.webBody || index };
  };
  const adapter = createCloudAdapter({ manager, envId: 'test-env', apiUrl: 'https://api.test/api',
    webUrl: options.webUrl || 'https://web.test/', apiDir, distDir, fetchImpl,
    codeSecret: options.codeSecret,
    sleepFn: async (ms) => { calls.push(['sleep', ms]); }, logger: (message) => logs.push(message) });
  return { adapter, calls, logs, directory, apiDir, distDir, before, after,
    get healthCalls() { return healthCalls; } };
}

test('API code-only update preserves handler, runtime, install mode, timers, environment and gateway', async (t) => {
  const f = await fixture(t, { codeSecret: 'code-protection-test' });
  const result = await f.adapter.publishApi();
  assert.deepEqual(result, { configurationVerified: true, gatewayVerified: true, healthy: true });
  const update = f.calls.find(([name]) => name === 'updateFunctionCode')[1];
  assert.deepEqual(update, { func: { name: 'api', handler: 'index.main', runtime: 'Nodejs18.15',
    installDependency: 'TRUE', isWaitInstall: true }, functionPath: f.apiDir,
    deployMode: 'cos', codeSecret: 'code-protection-test' });
  const read = f.calls.find(([name]) => name === 'getFunction')[1];
  assert.deepEqual(read, { Action: 'GetFunction', Param: { EnvId: 'test-env', Namespace: 'test-env',
    FunctionName: 'api', ShowCode: 'FALSE', CodeSecret: 'code-protection-test' } });
  const fetchCall = f.calls.find(([name]) => name === 'fetch');
  assert.equal(fetchCall[1], 'https://api.test/api');
  assert.equal(fetchCall[2].method, 'POST');
  assert.deepEqual(JSON.parse(fetchCall[2].body), { method: 'GET', path: '/health', body: {}, token: '' });
  assert.equal(f.healthCalls, 1);
  assert.ok(!f.logs.join('\n').includes('private-test-value'));
});

test('disabled dependency installation is passed through exactly', async (t) => {
  const before = detailFixture();
  before.InstallDependency = 'FALSE';
  const f = await fixture(t, { before });
  await f.adapter.publishApi();
  assert.equal(f.calls.find(([name]) => name === 'updateFunctionCode')[1].func.installDependency, 'FALSE');
});

test('environment changes fail with field name only, never old or new values', async (t) => {
  const after = detailFixture();
  after.Environment.Variables[0].Value = 'other-sensitive-test-value';
  const f = await fixture(t, { after });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.equal(error.code, 'CONFIG_CHANGED');
    assert.match(error.message, /Environment/);
    assert.doesNotMatch(error.message, /private-test-value|other-sensitive-test-value|JWT_SECRET/);
    return true;
  });
  assert.equal(f.healthCalls, 0);
});

test('all additional returned runtime settings are protected', async (t) => {
  const after = detailFixture();
  after.InstanceConcurrencyConfig.MaxConcurrency = 2;
  const f = await fixture(t, { after });
  await assert.rejects(f.adapter.publishApi(), /InstanceConcurrencyConfig/);
});

test('code size, status diagnostics, timestamp changes and environment order do not corrupt comparisons', async (t) => {
  const before = detailFixture();
  before.Environment.Variables.push({ Key: 'OTHER', Value: 'test' });
  const after = clone(before);
  after.CodeSize = 200;
  after.ModTime = 'today';
  after.RequestId = 'new-request';
  after.Triggers[0].ModTime = 'today';
  after.Environment.Variables.reverse();
  const f = await fixture(t, { before, after });
  await f.adapter.publishApi();
});

test('missing environment metadata fails before production mutation', async (t) => {
  const before = detailFixture();
  delete before.Environment;
  const f = await fixture(t, { before });
  await assert.rejects(f.adapter.publishApi(), { code: 'INCOMPLETE_FUNCTION_CONFIG' });
  assert.ok(!f.calls.some(([name]) => name === 'updateFunctionCode'));
});

test('missing timer fails before production mutation', async (t) => {
  const before = detailFixture();
  before.Triggers = [];
  const f = await fixture(t, { before });
  await assert.rejects(f.adapter.publishApi(), { code: 'MISSING_TIMER' });
  assert.ok(!f.calls.some(([name]) => name === 'updateFunctionCode'));
});

test('missing locked artifact fails before any cloud request', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.apiDir, 'package-lock.json'));
  await assert.rejects(f.adapter.publishApi(), { code: 'MISSING_ARTIFACT' });
  assert.equal(f.calls.length, 0);
});

test('SCF error result is failure and does not expose its response message', async (t) => {
  const f = await fixture(t, { updateResult: { RequestId: 'deadbeef-dead-beef-dead-deadbeefdead',
    SCFErrorCode: 'FailedOperation', SCFErrorMsg: 'private-test-value' } });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.match(error.message, /FailedOperation/);
    assert.doesNotMatch(error.message, /private-test-value/);
    return true;
  });
  assert.equal(f.healthCalls, 0);
});

test('SDK errors expose only validated category and request identifier', async (t) => {
  const f = await fixture(t, { updateError: Object.assign(new Error('credential=private-test-value'), {
    code: 'UnauthorizedOperation', requestId: 'deadbeef-dead-beef-dead-deadbeefdead' }) });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.match(error.message, /UnauthorizedOperation/);
    assert.match(error.message, /deadbeef-dead-beef-dead-deadbeefdead/);
    assert.doesNotMatch(error.message, /credential|private-test-value/);
    return true;
  });
});

test('SDK error values outside safe error formats are not printed', async (t) => {
  const f = await fixture(t, { readError: { code: 'token=private-test-value', requestId: 'private-test-value',
    message: 'private-test-value' } });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.doesNotMatch(error.message, /private-test-value|token=/);
    return true;
  });
});

test('a credential-shaped error category is omitted even when it is syntactically a word', async (t) => {
  const f = await fixture(t, { readError: { code: 'private-test-value', message: 'private-test-value' } });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.doesNotMatch(error.message, /private-test-value/);
    return true;
  });
});

test('health retains existing cloud string-response compatibility', async (t) => {
  const f = await fixture(t, { healthBody: JSON.stringify({ code: 0,
    data: { dbReady: true, jwtReady: true } }) });
  await f.adapter.publishApi();
  assert.equal(f.healthCalls, 1);
});

test('bad health response retries boundedly, stops publication, and hides diagnostic payload', async (t) => {
  const f = await fixture(t, { healthBody: { code: 0,
    data: { dbReady: false, jwtReady: true, dbError: 'private-test-value' } } });
  await assert.rejects(f.adapter.publishApi(), (error) => {
    assert.equal(error.code, 'API_HEALTH_FAILED');
    assert.doesNotMatch(error.message, /private-test-value/);
    return true;
  });
  assert.equal(f.healthCalls, 8);
  assert.equal(f.calls.filter(([name]) => name === 'sleep').length, 7);
});

test('API routing changes cannot be reported as successful', async (t) => {
  const routesAfter = routeFixture();
  routesAfter.Domains[0].Routes[0].EnableAuth = true;
  const f = await fixture(t, { routesAfter });
  await assert.rejects(f.adapter.publishApi(), { code: 'CONFIG_CHANGED' });
  assert.equal(f.healthCalls, 0);
});

test('wrong API target fails before code mutation', async (t) => {
  const routesBefore = routeFixture();
  routesBefore.Domains[0].Routes[0].UpstreamResourceName = 'other-function';
  const f = await fixture(t, { routesBefore });
  await assert.rejects(f.adapter.publishApi(), { code: 'MISSING_API_ROUTE' });
  assert.ok(!f.calls.some(([name]) => name === 'updateFunctionCode'));
});

test('gateway pagination reads and compares every domain', async (t) => {
  const first = routeFixture().Domains[0];
  const second = { Domain: 'other.test', Enable: true, Routes: [] };
  const f = await fixture(t, { routePage: (request) => ({ Domains: [request.Offset === 0 ? first : second],
    TotalCount: 2, OriginDomain: 'origin.test', RequestId: 'request' }) });
  await f.adapter.publishApi();
  assert.deepEqual(f.calls.filter(([name]) => name === 'readRoutes').map(([, request]) => request.Offset), [0, 1, 0, 1]);
});

test('web directory uses safe verified upload, retains old files, preserves fallback and verifies public routes', async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.publishWeb();
  assert.equal(result.publicVerified, true);
  assert.deepEqual(f.calls.find(([name]) => name === 'uploadFiles')[1], {
    localPath: f.distDir, cloudPath: '', entryFiles: ['index.html'], verify: true, safe: true, prune: false,
  });
  const reads = f.calls.filter(([name]) => name === 'downloadFile');
  assert.match(reads[0][1].cloudPath, /^release\.json\?radio-release=[a-f0-9]{64}$/);
  const requests = f.calls.filter(([name]) => name === 'fetch');
  assert.equal(new URL(requests[0][1]).pathname, '/');
  assert.equal(new URL(requests[1][1]).pathname, '/submit/settings');
  assert.equal(requests[1][2].headers['Sec-Fetch-Mode'], 'navigate');
  assert.equal(requests[1][2].headers.Referer, 'https://web.test/');
});

test('explicit 404 routing rule supports SPA fallback without ErrorDocument', async (t) => {
  const siteBefore = websiteFixture();
  delete siteBefore.WebsiteConfiguration.ErrorDocument;
  siteBefore.WebsiteConfiguration.RoutingRules = [{ Condition: { HttpErrorCodeReturnedEquals: '404' },
    Redirect: { ReplaceKeyWith: 'index.html' } }];
  const f = await fixture(t, { siteBefore });
  await f.adapter.publishWeb();
});

test('missing web artifact or SPA fallback never begins upload', async (t) => {
  const siteBefore = websiteFixture();
  delete siteBefore.WebsiteConfiguration.ErrorDocument;
  const f = await fixture(t, { siteBefore });
  await assert.rejects(f.adapter.publishWeb(), { code: 'MISSING_SPA_FALLBACK' });
  assert.ok(!f.calls.some(([name]) => name === 'uploadFiles'));
  await fs.unlink(path.join(f.distDir, 'release.json'));
  const count = f.calls.length;
  await assert.rejects(f.adapter.publishWeb(), { code: 'MISSING_ARTIFACT' });
  assert.equal(f.calls.length, count);
});

test('changed website configuration fails before content acceptance', async (t) => {
  const siteAfter = websiteFixture();
  siteAfter.WebsiteConfiguration.RoutingRules = [{ Condition: { KeyPrefixEquals: 'private' },
    Redirect: { ReplaceKeyWith: 'index.html' } }];
  const f = await fixture(t, { siteAfter });
  await assert.rejects(f.adapter.publishWeb(), { code: 'CONFIG_CHANGED' });
  assert.ok(!f.calls.some(([name]) => name === 'downloadFile'));
});

test('stale hosted content fails after bounded propagation retries', async (t) => {
  const f = await fixture(t, { remoteMismatch: true });
  await assert.rejects(f.adapter.publishWeb(), { code: 'WEB_CONTENT_MISMATCH' });
  assert.equal(f.calls.filter(([name]) => name === 'downloadFile').length, 16);
  assert.ok(!f.calls.some(([name]) => name === 'fetch'));
});

test('transient CDN propagation retries hosted files and both public routes before succeeding', async (t) => {
  const f = await fixture(t, {
    remoteFile: ({ count, isMetadata, index, metadata }) => count <= 4
      ? Buffer.from('stale') : isMetadata ? metadata : index,
    webBodyFor: ({ count, index }) => count === 1 ? Buffer.from('stale') : index,
  });
  await f.adapter.publishWeb();
  assert.equal(f.calls.filter(([name]) => name === 'downloadFile').length, 6);
  assert.equal(f.calls.filter(([name]) => name === 'fetch').length, 4);
  assert.equal(f.calls.filter(([name]) => name === 'sleep').reduce((sum, [, ms]) => sum + ms, 0), 8000);
});

test('all CDN checks share one 30-second retry budget', async (t) => {
  const f = await fixture(t, {
    remoteFile: ({ count, isMetadata, index, metadata }) => count <= 14
      ? Buffer.from('stale') : isMetadata ? metadata : index,
    webBodyFor: ({ route, count, index }) => route === '/' && count === 8 ? index : Buffer.from('stale'),
  });
  await assert.rejects(f.adapter.publishWeb(), { code: 'WEB_ROUTE_HEALTH_FAILED' });
  const totalDelay = f.calls.filter(([name]) => name === 'sleep').reduce((sum, [, ms]) => sum + ms, 0);
  assert.equal(totalDelay, 30000);
  assert.equal(f.calls.filter(([name]) => name === 'fetch').length, 9);
});

test('public website interstitial or wrong body fails without printing body', async (t) => {
  const f = await fixture(t, { webBody: Buffer.from('private-test-value') });
  await assert.rejects(f.adapter.publishWeb(), (error) => {
    assert.equal(error.code, 'WEB_ROUTE_HEALTH_FAILED');
    assert.doesNotMatch(error.message, /private-test-value/);
    return true;
  });
});

test('unsafe upload error body is excluded from publication error', async (t) => {
  const f = await fixture(t, { uploadError: new Error('signed-url=private-test-value') });
  await assert.rejects(f.adapter.publishWeb(), (error) => {
    assert.match(error.message, /上传管理后台网页失败/);
    assert.doesNotMatch(error.message, /signed-url|private-test-value/);
    return true;
  });
  assert.ok(!f.calls.some(([name]) => name === 'downloadFile'));
});
