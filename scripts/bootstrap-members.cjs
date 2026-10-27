// Management CLI only. There is deliberately no public "claim super administrator" API.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { run, ENV } = require('./cloudbase.cjs');
const [id, expectedName] = process.argv.slice(2);
if (!/^user_[a-f0-9]{32}$/.test(id || '') || !expectedName) throw new Error('Usage: node scripts/bootstrap-members.cjs <confirmed-user-id> <confirmed-name>');
function query(table, command, type = 'QUERY') {
  const unwrap = value => {
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === 'object') {
      for (const key of ['$numberInt', '$numberLong', '$numberDouble']) if (key in value) return Number(value[key]);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
    }
    return value;
  };
  return unwrap(run(['db', 'nosql', 'execute', '--command', JSON.stringify([{ TableName: table, CommandType: type, Command: JSON.stringify(command) }])]).data.results[0]);
}
function api(action, body) { return run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']); }
const profiles = query('userProfiles', { find: 'userProfiles', filter: { _id: id }, limit: 1 });
assert.equal(profiles.length, 1, 'Confirmed account no longer exists');
assert.equal(profiles[0].name, expectedName, 'Confirmed account name changed; stop and re-confirm identity');
for (const table of ['teamMembers', 'teamSecurity', 'memberAudit']) {
  try { api('DescribeTable', { TableName: table, Tag: 'tnt-6e39g5y8u' }); }
  catch (error) {
    if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + table + '.')) throw error;
    api('CreateTable', { TableName: table, Tag: 'tnt-6e39g5y8u', PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
  }
  api('ModifyDatabaseACL', { CollectionName: table, AclTag: 'ADMINONLY' });
}
const members = query('teamMembers', { find: 'teamMembers', filter: {}, limit: 2 });
const security = query('teamSecurity', { find: 'teamSecurity', filter: { _id: 'IMC' }, limit: 1 });
if (members.length) {
  assert.equal(members.length, 1, 'Initial bootstrap only; use the member management UI');
  assert.equal(members[0]._id, id);
  assert.equal(members[0].status, 'active');
  assert.deepEqual(members[0].roles, ['super_admin']);
  assert.deepEqual(security[0].superAdminIds, [id]);
  console.log('Confirmed account already has super administrator access.');
  process.exit(0);
}
assert.ok(!security.length || (security.length === 1 && security[0].superAdminIds.length === 1 && security[0].superAdminIds[0] === id), 'Unexpected existing administrator registry');
const now = new Date().toISOString();
function insert(table, doc) {
  const [result] = query(table, { insert: table, documents: [doc], ordered: true }, 'INSERT');
  assert.equal(result.ok, 1);
  assert.ok(!result.writeErrors || !result.writeErrors.length, JSON.stringify(result));
}
if (!security.length) insert('teamSecurity', { _id: 'IMC', superAdminIds: [id], updatedAt: now });
insert('teamMembers', { _id: id, teamId: 'IMC', status: 'active', roles: ['super_admin'], revision: 0, createdAt: now, updatedAt: now, updatedBy: 'management-bootstrap' });
insert('memberAudit', { _id: randomUUID(), actorId: 'management-bootstrap', targetId: id,
  before: null, after: { status: 'active', roles: ['super_admin'] }, createdAt: now });
const [actual] = query('teamMembers', { find: 'teamMembers', filter: { _id: id }, limit: 1 });
assert.deepEqual(actual.roles, ['super_admin']);
assert.equal(actual.status, 'active');
console.log('Confirmed account is now an active IMC super administrator; all membership collections are ADMINONLY.');
