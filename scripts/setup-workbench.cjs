const assert = require('node:assert/strict');
const { run, ENV } = require('./cloudbase.cjs');
const TableName = 'workbenchUsage';
function api(action, body) { return run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']); }
try { api('DescribeTable', { TableName, Tag: 'tnt-6e39g5y8u' }); }
catch (error) {
  if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + TableName + '.')) throw error;
  api('CreateTable', { TableName, Tag: 'tnt-6e39g5y8u', PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
}
api('ModifyDatabaseACL', { CollectionName: TableName, AclTag: 'ADMINONLY' });
assert.equal(api('DescribeDatabaseACL', { CollectionName: TableName }).data.AclTag, 'ADMINONLY');
console.log('Per-user workbench usage collection ready (ADMINONLY).');
