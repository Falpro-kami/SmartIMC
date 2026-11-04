const ENV = 'well-leopon-d5glrufc6e4fd4413';
const BUCKET = '7765-well-leopon-d5glrufc6e4fd4413-1516940081';
const TABLES = ['challengeEvents', 'challengeTeams', 'challengeFiles', 'challengeClaims', 'challengeSettings', 'challengeAudit'];
module.exports = async function initialize(providedManager) {
  const Manager = providedManager ? null : require('@cloudbase/manager-node');
  const manager = providedManager || new Manager({ envId: ENV, region: 'ap-shanghai', timeout: 15000 });
  const api = (Action, data) => manager.commonService('tcb').call({ Action, Param: { EnvId: ENV, ...data } });
  const storage = await api('DescribeStorageSafeRule', { Bucket: BUCKET });
  if (storage.AclTag !== 'PRIVATE') require('./challenge-policy').reject('CHALLENGE_SETUP_REQUIRED', '挑战赛需要沿用现有PRIVATE私有存储，请先检查云存储权限。');
  const collections = [];
  for (const name of TABLES) {
    if (!(await manager.database.checkCollectionExists(name)).Exists) await manager.database.createCollection(name);
    await api('ModifyDatabaseACL', { CollectionName: name, AclTag: 'ADMINONLY' });
    const acl = await api('DescribeDatabaseACL', { CollectionName: name });
    if (acl.AclTag !== 'ADMINONLY') throw new Error('Private ACL not applied: ' + name);
    collections.push({ name, permission: acl.AclTag });
  }
  for (const definition of [
    { table: 'challengeEvents', name: 'challenge_event_list', fields: { teamId: 1, status: 1, createdMs: -1, _id: -1 } },
    { table: 'challengeTeams', name: 'challenge_group_list', fields: { teamId: 1, eventId: 1, createdMs: 1, _id: 1 } }
  ]) {
    const existing = await manager.database.describeCollection(definition.table);
    if (!(existing.Indexes || []).some(index => index.Name === definition.name)) await manager.database.updateCollection(definition.table, { CreateIndexes: [{
      IndexName: definition.name, MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: Object.entries(definition.fields).map(([Name, direction]) => ({ Name, Direction: String(direction) })) }
    }] });
  }
  return { ok: true, collections, storagePrivate: true };
};
