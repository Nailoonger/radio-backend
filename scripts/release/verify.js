'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../..');
const TEST_API_URL = 'https://example.invalid/api';

function cleanEnvironment(env = process.env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY/i.test(key)) delete cleaned[key];
  }
  // 上传适配器将 JWT_SECRET 当成主动联网的开关，校验阶段绝不设置它。
  delete cleaned.HARNESS_API_DIR;
  // NODE_ENV=test 会跳过账号登录硬闸门；云回归要真实校验这条业务约束。
  cleaned.NODE_ENV = 'development';
  cleaned.DB_DIALECT = 'sqlite';
  cleaned.DB_STORAGE = ':memory:';
  delete cleaned.MOCK_WECHAT;
  cleaned.WECHAT_SECURITY_CHECK = '0';
  return cleaned;
}

function sourceJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ['node_modules', 'cloudfunctions'].includes(entry.name)) continue;
    const location = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceJsFiles(location));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(location);
  }
  return files.sort();
}

function resolveApiUrl(apiUrl, production) {
  if (!apiUrl && production) throw new Error('生产构建缺少 VITE_CLOUD_API_URL。');
  const result = apiUrl || TEST_API_URL;
  let url;
  try { url = new URL(result); } catch { throw new Error('VITE_CLOUD_API_URL 必须是完整 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('VITE_CLOUD_API_URL 必须是没有账号密码的 HTTPS 地址。');
  }
  if (production && url.hostname.endsWith('.invalid')) throw new Error('生产构建不能使用测试 API 地址。');
  return result;
}

function runStage(label, executable, args, options = {}) {
  console.log('[verify] ' + label);
  const result = spawnSync(executable, args, {
    cwd: options.cwd || ROOT,
    env: options.env || cleanEnvironment(),
    stdio: 'inherit',
    timeout: options.timeout || 5 * 60 * 1000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const code = result.error?.code || result.status;
    throw new Error(label + '失败（' + String(code) + '）。');
  }
}

function npmCommand(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find((candidate) => candidate && candidate.endsWith('.js') && fs.existsSync(candidate));
  if (cli) return { executable: process.execPath, args: [cli, ...args] };
  if (process.platform !== 'win32') return { executable: 'npm', args };
  throw new Error('无法定位 npm-cli.js，请从已安装 Node.js 的终端执行校验。');
}

function validateDependencies(directory) {
  const requireFromBundle = createRequire(path.join(directory, 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    requireFromBundle(dependency);
    console.log('[verify] 运行时依赖已加载：' + dependency);
  }
  if (typeof requireFromBundle('./index.js').main !== 'function') {
    throw new Error('重新生成的云函数入口没有导出 main。');
  }
}

function verify(options = {}) {
  const root = options.root || ROOT;
  const scope = options.scope || 'full';
  if (!['full', 'mini', 'policy'].includes(scope)) throw new Error('scope 只能是 full、mini 或 policy。');
  const stage = options.runStage || runStage;
  const env = cleanEnvironment(options.env || process.env);
  const node = (label, args, extra = {}) => stage(label, process.execPath, args, { cwd: root, env, ...extra });
  const releaseDir = path.join(root, 'scripts/release');
  const testFiles = fs.readdirSync(releaseDir).filter((name) => name.endsWith('.test.js'))
    .sort().map((name) => path.join(releaseDir, name));
  if (!testFiles.length) throw new Error('发布控制测试文件缺失。');
  node('发布控制回归', ['--test', ...testFiles]);
  if (scope === 'policy') return { scope };

  const miniFiles = sourceJsFiles(path.join(root, 'miniprogram'));
  if (!miniFiles.length) throw new Error('小程序源码缺失。');
  for (const file of miniFiles) node('小程序语法 ' + path.relative(root, file), ['--check', file]);
  if (scope === 'mini') return { scope, miniFiles: miniFiles.length };

  const revision = options.revision || env.RELEASE_REVISION;
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) throw new Error('发布校验需要完整的 40 位提交 SHA。');
  const apiUrl = resolveApiUrl(options.apiUrl || env.VITE_CLOUD_API_URL, options.production);
  node('重新生成云函数产物', [path.join(root, 'cloud/scripts/sync.js')]);
  node('云函数源码回归', [path.join(root, 'cloud/scripts/regression.js'), '--source'], { timeout: 10 * 60 * 1000 });
  const bundleDir = path.join(root, 'miniprogram/cloudfunctions/api');
  const command = npmCommand(['ci', '--omit=dev', '--no-audit', '--no-fund']);
  stage('云函数产物安装锁定运行依赖', command.executable, command.args, { cwd: bundleDir, env });
  node('真实云函数运行依赖加载', [__filename, '--load-dependencies', bundleDir]);
  node('云函数锁定依赖产物回归', [path.join(root, 'cloud/scripts/regression.js'), '--bundle'], { timeout: 10 * 60 * 1000 });
  node('Vue 模板绑定检查', [path.join(root, 'scripts/check-vue-bindings.js')]);
  node('管理后台云通道构建', [path.join(root, 'admin-web/node_modules/vite/bin/vite.js'), 'build'], {
    cwd: path.join(root, 'admin-web'),
    env: { ...env, NODE_ENV: 'production', VITE_REQUEST_MODE: 'cloud', VITE_CLOUD_API_URL: apiUrl },
  });
  const manifest = { schemaVersion: 1, component: 'web', revision };
  fs.writeFileSync(path.join(root, 'admin-web/dist/release.json'), JSON.stringify(manifest) + '\n', 'utf8');

  (options.log || console.log)('[verify] 全部最低发布校验通过，提交 ' + revision);
  return { scope, revision, miniFiles: miniFiles.length, manifest };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--production') options.production = true;
    else if (['--scope', '--revision', '--api-url'].includes(arg) && args[i + 1]) {
      const key = { '--scope': 'scope', '--revision': 'revision', '--api-url': 'apiUrl' }[arg];
      options[key] = args[++i];
    } else throw new Error('未知或不完整的校验参数：' + arg);
  }
  return options;
}

if (require.main === module) {
  try {
    if (process.argv[2] === '--load-dependencies') validateDependencies(path.resolve(process.argv[3]));
    else {
      const options = parseArgs(process.argv.slice(2));
      options.production ||= process.env.GITHUB_REF === 'refs/heads/master';
      if (!options.revision && !process.env.RELEASE_REVISION && (options.scope || 'full') === 'full') {
        const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
        if (result.status !== 0) throw new Error('无法读取当前 Git 提交。');
        options.revision = result.stdout.trim();
      }
      verify(options);
    }
  } catch (error) {
    console.error('[verify] ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { cleanEnvironment, sourceJsFiles, resolveApiUrl, parseArgs, verify };
