#!/usr/bin/env node
'use strict';

/**
 * Provision recruitment collections and indexes, without touching old data.
 * Default: display a manifest only. Explicit cloud operation:
 *   node cloud/scripts/init-recruitment.js --run --env <development-env-id>
 * Reuses the lockfile-pinned SDK in scripts/release (npm ci there if missing).
 * Requires credential environment variables; never reads or prints their values.
 * APIs: https://docs.cloudbase.net/api-reference/manager/node/database
 *       https://docs.cloudbase.net/api-reference/manager/node/rule
 */
const path = require('path');
const { createRequire } = require('module');
const releaseRequire = createRequire(path.resolve(__dirname, '../../scripts/release/package.json'));
function index(name, keys) {
  return { IndexName: name, MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: keys.map(([Name, Direction]) => ({ Name, Direction })) } };
}
const MANIFEST = [
  { name: 'recruitment_batch', indexes: [
    index('recruitment_public', [['archivedAt', '1'], ['publishedAt', '-1'], ['opensAt', '1'], ['closesAt', '1']]),
    index('recruitment_batches', [['archivedAt', '1'], ['createdAt', '-1']]),
    index('recruitment_created', [['createdAt', '-1']]),
  ] },
  { name: 'recruitment_application', indexes: [
    index('recruitment_batch_created', [['batchId', '1'], ['createdAt', '-1']]),
    index('recruitment_grade_created', [['batchId', '1'], ['grade', '1'], ['createdAt', '-1']]),
    index('recruitment_status_created', [['batchId', '1'], ['progress', '1'], ['decision', '1'], ['createdAt', '-1']]),
    index('recruitment_grade_status', [['batchId', '1'], ['grade', '1'], ['progress', '1'], ['decision', '1'], ['createdAt', '-1']]),
  ] },
  { name: 'recruitment_unique', indexes: [] },
  { name: 'recruitment_code', indexes: [] },
  { name: 'recruitment_control', indexes: [] },
  { name: 'recruitment_rate', indexes: [index('recruitment_rate_expiry', [['expiresAt', '1']])] },
].map((item) => ({ ...item, permission: 'ADMINONLY' }));

async function initialize(manager, envId, report = () => {}) {
  const database = manager.database;
  if (!database || typeof database.createCollectionIfNotExists !== 'function' || typeof manager.commonService !== 'function') {
    throw new Error('Initialization requires a supported @cloudbase/manager-node SDK');
  }
  const common = manager.commonService();
  for (const item of MANIFEST) {
    await database.createCollectionIfNotExists(item.name);
    // Client SDKs must never gain direct access to application credentials/answers.
    await common.call({ Action: 'ModifySafeRule', Param: { CollectionName: item.name, EnvId: envId, AclTag: item.permission } });
    const rule = await common.call({ Action: 'DescribeSafeRule', Param: { CollectionName: item.name, EnvId: envId } });
    if (rule.AclTag !== item.permission) throw new Error(`Collection permission verification failed: ${item.name}`);
    const description = await database.describeCollection(item.name);
    if (!Array.isArray(description.Indexes)) throw new Error(`Invalid index description: ${item.name}`);
    const missing = [];
    for (const wanted of item.indexes) {
      const existing = description.Indexes.find((x) => x.Name === wanted.IndexName);
      if (!existing) { missing.push(wanted); continue; }
      const actualKeys = (existing.Keys || []).map((x) => [x.Name, String(x.Direction)]);
      const wantedKeys = wanted.MgoKeySchema.MgoIndexKeys.map((x) => [x.Name, x.Direction]);
      if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys) || ![false, 'false', '0', 0].includes(existing.Unique)) {
        // Never silently drop or rebuild an index that belongs to an existing env.
        throw new Error(`Existing index definition differs: ${item.name}/${wanted.IndexName}`);
      }
    }
    if (missing.length) await database.updateCollection(item.name, { CreateIndexes: missing });
    report({ collection: item.name, permission: item.permission, indexesCreated: missing.length, indexesExisting: item.indexes.length - missing.length });
  }
}

async function main(args = process.argv.slice(2)) {
  const allowed = ['--run', '--env'];
  for (let i = 0; i < args.length; i += 1) {
    if (!allowed.includes(args[i])) throw new Error('Usage: init-recruitment.js [--run] [--env <env-id>]');
    if (args[i] === '--env') { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--env requires an environment id'); i += 1; }
  }
  const at = args.indexOf('--env');
  const envId = at >= 0 ? args[at + 1] : process.env.CLOUDBASE_ENV_ID;
  if (!args.includes('--run')) {
    console.log(JSON.stringify({ dryRun: true, envId: envId || null, collections: MANIFEST }, null, 2));
    return;
  }
  const secretId = process.env.CLOUDBASE_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.CLOUDBASE_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY;
  if (!envId || !secretId || !secretKey) throw new Error('Set CLOUDBASE_ENV_ID, CLOUDBASE_SECRET_ID and CLOUDBASE_SECRET_KEY before --run');
  const pkg = releaseRequire('@cloudbase/manager-node'); const Manager = pkg.default || pkg;
  const manager = new Manager({ envId, secretId, secretKey, ...(process.env.CLOUDBASE_SESSION_TOKEN ? { token: process.env.CLOUDBASE_SESSION_TOKEN } : {}) });
  await initialize(manager, envId, (result) => console.log(JSON.stringify(result)));
  console.log('Recruitment collections, private permissions and indexes initialized. No old collections or documents were changed.');
}
if (require.main === module) main().catch((e) => { console.error('[init-recruitment]', e.message); process.exitCode = 1; });
module.exports = { MANIFEST, initialize, main };
