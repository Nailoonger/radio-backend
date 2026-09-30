'use strict';

const SHA = /^[a-f0-9]{40}$/;

function validRevision(revision) {
  if (!SHA.test(revision || '')) throw new Error('发布版本必须是完整的 Git 提交编号');
  return revision;
}

function componentChanged(component, paths) {
  if (!['web', 'api'].includes(component)) throw new Error('未知发布组件');
  return paths.some((file) => {
    const p = file.replace(/\\/g, '/');
    if (p === '.github/workflows/cloud-release.yml' || p.startsWith('scripts/release/')) return true;
    if (/\.md$/i.test(p)) return false;
    if (component === 'web') {
      return p.startsWith('admin-web/') && !/^admin-web\/(?:dist\/|_)/.test(p)
        && !['admin-web/Dockerfile', 'admin-web/.dockerignore', 'admin-web/.env.example'].includes(p);
    }
    return p.startsWith('cloud/cloudfunctions/api/') || p === 'cloud/scripts/sync.js';
  });
}

function scopeForPaths(paths) {
  if (componentChanged('web', paths) || componentChanged('api', paths)
      || paths.some(p => /^cloud\/scripts\/.*\.js$/.test(p))) return 'full';
  if (paths.some(p => p.startsWith('miniprogram/') && !p.startsWith('miniprogram/cloudfunctions/')
      && p !== 'miniprogram/project.private.config.json')) return 'mini';
  return 'policy';
}

function readConfig(env, { credentials = true } = {}) {
  const required = ['TCB_ENV_ID', 'VITE_CLOUD_API_URL', 'ADMIN_WEB_URL'];
  if (credentials) required.push('TCB_SECRET_ID', 'TCB_SECRET_KEY');
  const missing = required.filter(key => !String(env[key] || '').trim());
  if (missing.length) throw new Error(`缺少 GitHub 发布配置：${missing.join('、')}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]+$/.test(env.TCB_ENV_ID)) throw new Error('TCB_ENV_ID 格式不正确');
  function url(key) {
    let parsed;
    try { parsed = new URL(env[key]); } catch { throw new Error(`${key} 必须是完整的 HTTPS 地址`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${key} 必须是无账号、无查询参数的 HTTPS 地址`);
    }
    return parsed;
  }
  const api = url('VITE_CLOUD_API_URL');
  const web = url('ADMIN_WEB_URL');
  if (api.pathname.replace(/\/$/, '') !== '/api') throw new Error('VITE_CLOUD_API_URL 路径必须是 /api');
  if (web.pathname !== '/') throw new Error('ADMIN_WEB_URL 必须指向管理后台域名的根目录');
  return {
    envId: env.TCB_ENV_ID, apiUrl: api.href.replace(/\/$/, ''), webUrl: web.origin,
    secretId: env.TCB_SECRET_ID, secretKey: env.TCB_SECRET_KEY, codeSecret: env.TCB_CODE_SECRET || undefined,
  };
}

// SDK 错误正文可能含环境配置，日志仅保留错误类别与请求编号。
function safePlatformError(error) {
  const clean = value => String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100);
  return `平台请求失败（${clean(error.code || error.name) || 'unknown'}${error.requestId ? `，请求 ${clean(error.requestId)}` : ''}）`;
}

module.exports = { validRevision, componentChanged, scopeForPaths, readConfig, safePlatformError };
