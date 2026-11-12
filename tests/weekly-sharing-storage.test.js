const test = require('node:test');
const assert = require('node:assert/strict');
const { protectStorage } = require('../cloudfunctions/weeklySharing/setup');
const initialize = require('../cloudfunctions/weeklySharing/setup');
const createDatabase = require('./helpers/memory-db');
const { REVIEWER_ID } = require('../cloudfunctions/weeklySharing/policy');
const allowed = (rule, action, path, owner = 'owner', viewer = 'owner') => new Function('resource', 'auth', 'return (' + rule[action] + ');')({ path, openid: owner }, { openid: viewer });
test('文件规则仅收紧分享目录，保留其他目录的既有读写规则', () => {
  const { rule } = protectStorage({ AclTag: 'READONLY' });
  for (const action of ['read', 'write']) assert.equal(allowed(rule, action, 'sharing-files/secret.pdf'), false);
  assert.equal(allowed(rule, 'read', 'sharing-uploads/temp.pdf'), false);
  assert.equal(allowed(rule, 'write', 'sharing-uploads/temp.pdf'), true);
  assert.equal(allowed(rule, 'write', 'sharing-uploads/temp.pdf', 'owner', 'other'), false);
  assert.equal(allowed(rule, 'read', 'avatars/photo.png', 'owner', 'other'), true);
  assert.equal(allowed(rule, 'write', 'avatars/photo.png', 'owner', 'other'), false);
  assert.equal(allowed(rule, 'write', 'avatars/photo.png'), true);
  const repeated = protectStorage({ AclTag: 'CUSTOM', Rule: JSON.stringify(rule) });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.rule, rule);
});
function setupFixture(failAction, acl = 'CUSTOM', privateRule = null) {
  const db = createDatabase({ teamMembers: { [REVIEWER_ID]: { teamId: 'IMC', status: 'active', roles: ['academic_admin'] } }, teamSecurity: { IMC: { superAdminIds: [] } },
    teamSync: { IMC: { home: 'h', messages: 'm', approvals: 'a', weekly: 'w', members: 'u' } } });
  let rule = protectStorage({ AclTag: 'PRIVATE' }).rule;
  const manager = {
    database: { checkCollectionExists: async () => ({ Exists: true }), describeCollection: async () => ({ Indexes: [] }), updateCollection: async () => {} },
    commonService: () => ({ call: async ({ Action, Param }) => {
      if (Action === failAction) throw new Error('Invalid rule at https://example.invalid/private');
      if (Action === 'DescribeDatabaseACL') return { AclTag: 'ADMINONLY' };
      // The server may serialize the same keys in a different order.
      if (Action === 'DescribeStorageSafeRule') return { AclTag: acl, Rule: acl === 'PRIVATE' ? privateRule : JSON.stringify({ write: rule.write, read: rule.read }) };
      if (Action === 'ModifyStorageSafeRule') rule = JSON.parse(Param.Rule);
      return {};
    } }),
    functions: { createFunctionTriggers: async () => {} }
  };
  return { db, manager };
}
test('初始化按规则含义核验，忽略服务端 JSON 键顺序', async () => {
  const { db, manager } = setupFixture();
  const result = await initialize(db, REVIEWER_ID, manager);
  assert.equal(result.storagePrivate, true);
  assert.equal(result.trigger, 'created');
  assert.equal(db.rows('teamSecurity')[0].sharingReviewerId, REVIEWER_ID);
});
test('初始化失败保留具体步骤，隐藏错误中的 URL', async () => {
  const { db, manager } = setupFixture('DescribeStorageSafeRule');
  await assert.rejects(initialize(db, REVIEWER_ID, manager), error => {
    assert.equal(error.businessCode, 'SHARING_SETUP_FAILED');
    assert.match(error.message, /storage.read/);
    assert.doesNotMatch(error.message, /https:\/\//);
    return true;
  });
});

test('已有私有存储沿用 PRIVATE，套餐不支持自定义规则也能安全完成初始化', async () => {
  const { db, manager } = setupFixture('ModifyStorageSafeRule', 'PRIVATE');
  const result = await initialize(db, REVIEWER_ID, manager);
  assert.equal(result.storagePrivate, true);
  assert.equal(result.storageAcl, 'PRIVATE');
  assert.equal(db.rows('sharingAudit').some(row => row.action === 'storage.protect'), false);
  assert.equal(db.rows('teamSecurity')[0].sharingReviewerId, REVIEWER_ID);
});

test('PRIVATE 的空字符串规则无需解析，按实际权限标签完成核验', async () => {
  const { db, manager } = setupFixture('ModifyStorageSafeRule', 'PRIVATE', '');
  const result = await initialize(db, REVIEWER_ID, manager);
  assert.equal(result.storagePrivate, true);
  assert.equal(result.storageAcl, 'PRIVATE');
  assert.equal(result.trigger, 'created');
});
