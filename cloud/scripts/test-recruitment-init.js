'use strict';
const assert = require('assert');
const { MANIFEST, initialize } = require('./init-recruitment');
let count = 0;
let failed = 0;
function check(name, fn) { count++; try { fn(); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); } }
(async () => {
  const collections = new Map();
  const touched = [];
  const rules = new Map();
  const manager = {
    database: {
      createCollectionIfNotExists: async name => { touched.push(name); if (!collections.has(name)) collections.set(name, []); },
      describeCollection: async name => ({ Indexes: collections.get(name) }),
      updateCollection: async (name, { CreateIndexes }) => {
        CreateIndexes.forEach(index => collections.get(name).push({ Name: index.IndexName,
          Keys: index.MgoKeySchema.MgoIndexKeys, Unique: false }));
      },
    },
    commonService: () => ({ call: async ({ Action, Param }) => {
      if (Action === 'ModifySafeRule') { rules.set(Param.CollectionName, Param.AclTag); return {}; }
      if (Action === 'DescribeSafeRule') return { AclTag: rules.get(Param.CollectionName) };
      throw new Error('Unexpected manager action');
    } }),
  };
  collections.set('user', [{ name: 'original' }]);
  await initialize(manager, 'development-env');
  check('创建6个招新集合', () => assert.strictEqual(MANIFEST.length, 6));
  check('只触碰招新集合', () => assert.ok(touched.every(name => name.startsWith('recruitment_'))));
  check('每个新集合限制客户端访问', () => assert.ok(MANIFEST.every(x => rules.get(x.name) === 'ADMINONLY')));
  check('已有学生集合未变', () => assert.deepStrictEqual(collections.get('user'), [{ name: 'original' }]));
  const first = JSON.stringify(Array.from(collections));
  await initialize(manager, 'development-env');
  check('初始化可重复不增重复索引', () => assert.strictEqual(JSON.stringify(Array.from(collections)), first));
  collections.get('recruitment_batch')[0].Unique = true;
  let refused = false;
  try { await initialize(manager, 'development-env'); } catch (_) { refused = true; }
  check('索引不同拒绝静默覆盖', () => assert.ok(refused));
  check('冲突索引保留原定义', () => assert.strictEqual(collections.get('recruitment_batch')[0].Unique, true));
  manager.commonService = () => ({ call: async ({ Action }) => Action === 'DescribeSafeRule' ? { AclTag: 'READONLY' } : {} });
  refused = false;
  try { await initialize(manager, 'development-env'); } catch (_) { refused = true; }
  check('权限验证失败立即停止', () => assert.ok(refused));
})().catch(e => { failed++; console.error(e); }).finally(() => {
  console.log(`结论：断言 ${count} 项 / 失败 ${failed} 项`);
  process.exitCode = failed ? 1 : 0;
});
