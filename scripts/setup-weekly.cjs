const assert = require('node:assert/strict');
const { run, ENV } = require('./cloudbase.cjs');
const api = (action, body = {}) => run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data;
const env = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV);
const Tag = env.Databases[0].InstanceId;
const tables = {
  weeklyPeriods: [ ['team_start_id', [['teamId', '1'], ['startDate', '-1'], ['_id', '-1']]], ['team_status_id', [['teamId', '1'], ['status', '1'], ['_id', '1']]],
    ['team_status_publish_id', [['teamId', '1'], ['status', '1'], ['publishAtMs', '1'], ['_id', '1']]] ],
  weeklyReports: [ ['team_owner_period', [['teamId', '1'], ['ownerId', '1'], ['periodId', '1']]], ['team_period_id', [['teamId', '1'], ['periodId', '1'], ['_id', '1']]] ],
  weeklyVersions: [ ['team_report_version', [['teamId', '1'], ['reportId', '1'], ['version', '-1']]] ],
  weeklyFiles: [ ['team_period_id', [['teamId', '1'], ['periodId', '1'], ['_id', '1']]] ], weeklyAudit: [], weeklyTemplates: []
};
for (const [TableName, indexes] of Object.entries(tables)) {
  try { api('DescribeTable', { Tag, TableName }); }
  catch (error) {
    if (!/ResourceNotFound/.test(error.message) || !error.message.includes('Db or Table not exist: ' + TableName + '.')) throw error;
    api('CreateTable', { Tag, TableName, PermissionInfo: { EnvId: ENV, AclTag: 'ADMINONLY' } });
  }
  api('ModifyDatabaseACL', { CollectionName: TableName, AclTag: 'ADMINONLY' });
  assert.equal(api('DescribeDatabaseACL', { CollectionName: TableName }).AclTag, 'ADMINONLY');
  const existing = api('DescribeTable', { Tag, TableName }).Indexes;
  for (const [IndexName, keys] of indexes) if (!existing.some(index => index.Name === IndexName)) {
    api('UpdateTable', { Tag, TableName, CreateIndexes: [{ IndexName, MgoKeySchema: {
      MgoIndexKeys: keys.map(([Name, Direction]) => ({ Name, Direction })), MgoIsUnique: false, MgoIsSparse: false
    } }] });
  }
  console.log(TableName + ' ready (ADMINONLY).');
}
console.log('No sample periods, reports or notifications created.');
