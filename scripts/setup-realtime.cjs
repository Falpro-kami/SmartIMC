const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { run, ENV } = require('./cloudbase.cjs');
const rules = require('./lib/sync-rules.cjs');
const { CHANNELS } = require('../cloudfunctions/_shared/sync');
const api = (action, body = {}) => run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data;
const Tag = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV).Databases[0].InstanceId;
for (const TableName of ['teamSyncAccess', 'teamSync']) {
  try { api('DescribeTable', { Tag, TableName }); }
  catch (error) {
    if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + TableName + '.')) throw error;
    api('CreateTable', { Tag, TableName, PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
  }
}
api('ModifyDatabaseACL', { CollectionName: 'teamSyncAccess', AclTag: 'ADMINONLY' });
const command = { update: 'teamSync', updates: [{ q: { _id: 'IMC' },
  u: { $setOnInsert: Object.fromEntries(CHANNELS.map(channel => [channel, randomUUID()])) }, upsert: true }] };
const result = run(['db', 'nosql', 'execute', '--command', JSON.stringify([
  { TableName: 'teamSync', CommandType: 'UPDATE', Command: JSON.stringify(command) }
])]).data.results[0];
assert.ok(result.every(row => !row.writeErrors || !row.writeErrors.length), 'Cannot initialize sync metadata');
api('ModifySafeRule', { CollectionName: 'teamSync', AclTag: 'CUSTOM', Rule: JSON.stringify(rules) });
const actual = api('DescribeSafeRule', { CollectionName: 'teamSync' });
assert.equal(actual.AclTag, 'CUSTOM');
assert.deepEqual(JSON.parse(actual.Rule), rules);
assert.equal(api('DescribeDatabaseACL', { CollectionName: 'teamSyncAccess' }).AclTag, 'ADMINONLY');
console.log('Realtime metadata ready; active-member read, server-only write. No business records or read states changed.');
