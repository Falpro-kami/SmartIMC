const assert = require('node:assert/strict');
const { run, ENV } = require('./cloudbase.cjs');
const api = (action, body = {}) => run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data;
const env = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV);
const Tag = env.Databases[0].InstanceId;
const TableName = 'teamAnnouncements';
try { api('DescribeTable', { Tag, TableName }); }
catch (error) {
  if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + TableName + '.')) throw error;
  api('CreateTable', { Tag, TableName, PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
}
api('ModifyDatabaseACL', { CollectionName: TableName, AclTag: 'ADMINONLY' });
assert.equal(api('DescribeDatabaseACL', { CollectionName: TableName }).AclTag, 'ADMINONLY');
const IndexName = 'team_status_pinned_published_id';
if (!api('DescribeTable', { Tag, TableName }).Indexes.some(index => index.Name === IndexName)) {
  api('UpdateTable', { Tag, TableName, CreateIndexes: [{ IndexName, MgoKeySchema: {
    MgoIndexKeys: [['teamId', '1'], ['status', '1'], ['pinned', '-1'], ['publishedMs', '-1'], ['_id', '-1']].map(([Name, Direction]) => ({ Name, Direction })),
    MgoIsUnique: false, MgoIsSparse: false
  } }] });
}
console.log('Team announcements collection ready (ADMINONLY). No example announcements published.');
