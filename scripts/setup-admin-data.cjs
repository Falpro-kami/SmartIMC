const assert = require('node:assert/strict');
const { run, ENV } = require('./cloudbase.cjs');
const api = (action, body = {}) => run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data;
const env = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV);
const Tag = env.Databases[0].InstanceId;
const TableName = 'adminBackups';
try { api('DescribeTable', { Tag, TableName }); }
catch (error) {
  if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + TableName + '.')) throw error;
  api('CreateTable', { Tag, TableName, PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
}
api('ModifyDatabaseACL', { CollectionName: TableName, AclTag: 'ADMINONLY' });
assert.equal(api('DescribeDatabaseACL', { CollectionName: TableName }).AclTag, 'ADMINONLY');
console.log('Manual admin backup collection is ready (ADMINONLY). No scheduled trigger created.');
