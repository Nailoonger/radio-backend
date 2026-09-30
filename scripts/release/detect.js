'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { GitHub } = require('./github');
const { scopeForPaths, componentChanged, validRevision } = require('./policy');

function gitPaths(base, head) {
  return execFileSync('git', ['diff', '--name-only', '-z', validRevision(base), validRevision(head)], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
}
async function detect({ event, eventName, sha, github, pathsBetween = gitPaths, mergeBase }) {
  validRevision(sha);
  if (eventName === 'workflow_dispatch') return 'full';
  if (eventName === 'pull_request') {
    const base = mergeBase || execFileSync('git', ['merge-base', event.pull_request.base.sha, sha], { encoding: 'utf8' }).trim();
    return scopeForPaths(pathsBetween(base, sha));
  }
  const changed = event.before && !/^0+$/.test(event.before) ? pathsBetween(event.before, sha) : ['.github/workflows/cloud-release.yml'];
  let scope = scopeForPaths(changed);
  // 补查成功发布之后累积的改动，避免等待任务被替换后漏发。
  for (const component of ['web', 'api']) {
    const base = await github.lastSuccess(component);
    if (base && componentChanged(component, pathsBetween(base, sha))) scope = 'full';
  }
  return scope;
}
if (require.main === module) {
  (async () => {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const github = new GitHub({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
    const scope = await detect({ event, eventName: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA, github });
    console.log(`本次校验范围：${scope}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nfull=${scope === 'full'}\n`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { detect, gitPaths };
