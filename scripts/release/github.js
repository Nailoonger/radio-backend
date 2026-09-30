'use strict';
const { validRevision } = require('./policy');

class GitHub {
  constructor({ repo, token, fetchImpl = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !token) throw new Error('缺少 GitHub 仓库或工作流令牌');
    this.repo = repo;
    this.token = token;
    this.fetch = fetchImpl;
  }
  async request(path, body) {
    const response = await this.fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub 发布记录请求失败（HTTP ${response.status}）`);
    return response.json();
  }
  async head() {
    const result = await this.request('/git/ref/heads/master');
    return validRevision(result.object.sha);
  }
  async lastSuccess(component) {
    const environment = `radio-production-${component}`;
    for (let page = 1; ; page++) {
      const records = await this.request(`/deployments?environment=${environment}&task=deploy&per_page=100&page=${page}`);
      if (!Array.isArray(records)) throw new Error('GitHub 发布记录格式不正确');
      for (const record of records) {
        if (record.payload?.managedBy !== 'radio-release-v1' || record.payload.component !== component) continue;
        const statuses = await this.request(`/deployments/${record.id}/statuses?per_page=100`);
        if (statuses.some(status => status.state === 'success')) return validRevision(record.sha);
      }
      if (records.length < 100) return null;
    }
  }
  async start(component, revision) {
    const record = await this.request('/deployments', {
      ref: validRevision(revision), task: 'deploy', environment: `radio-production-${component}`,
      auto_merge: false, required_contexts: [], production_environment: true,
      payload: { managedBy: 'radio-release-v1', component, revision },
      description: `菁悠广播站 ${component}：${revision.slice(0, 7)}`,
    });
    if (!record.id) throw new Error('GitHub 未创建发布记录');
    await this.status(record.id, 'in_progress');
    return record.id;
  }
  async status(id, state, { url, logUrl } = {}) {
    return this.request(`/deployments/${id}/statuses`, {
      state, auto_inactive: false, description: `云端发布：${state}`,
      ...(url ? { environment_url: url } : {}), ...(logUrl ? { log_url: logUrl } : {}),
    });
  }
}
module.exports = { GitHub };
