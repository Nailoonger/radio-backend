'use strict';
const fs = require('fs');
const path = require('path');
const { validRevision, componentChanged, readConfig } = require('./policy');
const { GitHub } = require('./github');
const { gitPaths } = require('./detect');

async function publish({ revision, manual = false, github, cloud, pathsBetween = gitPaths, logger = console, logUrl, webUrl, apiUrl }) {
  validRevision(revision);
  const head = await github.head();
  if (head !== revision) {
    logger.log(`跳过过时任务：候选 ${revision.slice(0, 7)}，当前 master ${head.slice(0, 7)}`);
    return { skipped: true, components: [] };
  }
  const baseline = {};
  for (const component of ['api', 'web']) baseline[component] = await github.lastSuccess(component);
  if (!manual && Object.values(baseline).some(value => !value)) {
    throw new Error('尚未建立完整发布基线：请在 GitHub Actions 手动运行一次 mode=publish');
  }
  const needed = ['api', 'web'].filter(component => manual || componentChanged(component, pathsBetween(baseline[component], revision)));
  const completed = [];
  for (const component of needed) {
    logger.log(`开始发布 ${component}：${revision.slice(0, 7)}`);
    const id = await github.start(component, revision);
    try {
      if (component === 'api') await cloud.publishApi();
      else await cloud.publishWeb();
      await github.status(id, 'success', { logUrl, url: component === 'web' ? webUrl : apiUrl });
      completed.push(component);
      logger.log(`${component} 发布与验收成功`);
    } catch (error) {
      try { await github.status(id, 'failure', { logUrl }); }
      catch { throw new Error(`${component} 发布失败，且 GitHub 无法记录失败状态，请查看本次日志`); }
      throw error;
    }
  }
  if (!needed.length) logger.log('两端均无未发布的代码改动');
  return { skipped: false, components: completed };
}

function validateArtifacts({ revision, apiDir, distDir }) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(distDir, 'release.json'), 'utf8')); }
  catch { throw new Error('网页发布版本文件缺失或格式无效，禁止发布'); }
  if (meta?.schemaVersion !== 1 || meta.revision !== revision || meta.component !== 'web') {
    throw new Error('网页产物与本次提交不匹配，禁止发布');
  }
  function requireFile(directory, name) {
    let stat;
    try { stat = fs.statSync(path.join(directory, name)); } catch { /* Report only the expected filename. */ }
    if (!stat?.isFile() || stat.size === 0) throw new Error(`发布产物缺少有效的 ${name}，禁止发布`);
  }
  requireFile(distDir, 'index.html');
  for (const file of ['index.js', 'package.json', 'package-lock.json', 'config.json']) {
    requireFile(apiDir, file);
  }
  let dependencies;
  try { dependencies = fs.statSync(path.join(apiDir, 'node_modules')); } catch { /* Controlled failure below. */ }
  if (!dependencies?.isDirectory()) throw new Error('云函数产物缺少已验证的运行依赖');
}

async function main(env = process.env) {
  if (env.GITHUB_REF !== 'refs/heads/master' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('仅 master 的推送或手动发布允许更新生产环境');
  }
  const revision = validRevision(env.GITHUB_SHA);
  const config = readConfig(env);
  const root = path.resolve(__dirname, '../..');
  const apiDir = path.join(root, 'miniprogram/cloudfunctions/api');
  const distDir = path.join(root, 'admin-web/dist');
  validateArtifacts({ revision, apiDir, distDir });
  const github = new GitHub({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN });
  const CloudBase = require('@cloudbase/manager-node');
  const { createCloudAdapter } = require('./cloud');
  const manager = new CloudBase({ envId: config.envId, secretId: config.secretId, secretKey: config.secretKey, region: 'ap-shanghai' });
  const cloud = createCloudAdapter({ manager, ...config, apiDir, distDir, logger: message => console.log(message) });
  const logUrl = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const result = await publish({ revision, manual: env.RELEASE_MANUAL === 'true', github, cloud, logUrl, ...config });
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      `\n提交：\`${revision}\`\n\n${result.skipped ? '已跳过过时任务。' : `成功发布：${result.components.join('、') || '无需更新'}。`}\n`);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publish, validateArtifacts, main };
