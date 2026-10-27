const assert = require('node:assert/strict');
const { run, ENV } = require('./cloudbase.cjs');
const access = require('../cloudfunctions/_shared/access');
const messages = require('../cloudfunctions/memberAccess/messages')({}, access);
const table = 'teamMessages';
function api(action, body) { return run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']); }
function query(name, command, type = 'QUERY') {
  return run(['db', 'nosql', 'execute', '--command', JSON.stringify([{ TableName: name, CommandType: type, Command: JSON.stringify(command) }])]).data.results[0];
}
try { api('DescribeTable', { TableName: table, Tag: 'tnt-6e39g5y8u' }); }
catch (error) {
  if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + table + '.')) throw error;
  api('CreateTable', { TableName: table, Tag: 'tnt-6e39g5y8u', PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
}
api('ModifyDatabaseACL', { CollectionName: table, AclTag: 'ADMINONLY' });
let seeded = 0;
for (let skip = 0; ; skip += 100) {
  const rows = query('teamMembers', { find: 'teamMembers', filter: { teamId: 'IMC', status: 'pending' }, sort: { _id: 1 }, skip, limit: 100 });
  for (const row of rows) {
    const [profile] = query('userProfiles', { find: 'userProfiles', filter: { _id: row._id }, projection: { name: 1 }, limit: 1 });
    const stamp = row.createdAt && row.createdAt.$date;
    const time = stamp && typeof stamp === 'object' ? Number(stamp.$numberLong) : Date.parse(stamp || row.createdAt);
    const { _id, ...data } = messages.applicationData(row._id, profile && profile.name || '-', Number.isFinite(time) ? time : Date.now());
    const result = query(table, { update: table, updates: [{ q: { _id }, u: { $setOnInsert: data }, upsert: true }] }, 'UPDATE');
    assert.ok(!result[0].writeErrors || !result[0].writeErrors.length, 'Message seed failed');
    seeded += 1;
  }
  if (rows.length < 100) break;
}
const permission = api('DescribeDatabaseACL', { CollectionName: table });
assert.equal(permission.data.AclTag, 'ADMINONLY');
console.log(`Message collection ready (ADMINONLY); ${seeded} pending applications checked without changing existing read states.`);
