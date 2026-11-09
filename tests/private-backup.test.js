const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../cloudfunctions/adminData/service');
const format = require('../cloudfunctions/adminData/export-format');
const createDatabase = require('./helpers/memory-db');
const ID = 'user_' + '5'.repeat(32), ENV = 'test-env';
test('超级管理员备份不读取请假、分享和挑战赛私密数据', async () => {
  const db = createDatabase({ teamMembers: { [ID]: { teamId: 'IMC', status: 'active', roles: ['super_admin'] } },
    publicData: { one: { title: '普通数据' } }, challengeFiles: { secret: { name: '私密作品' } }, sharingTasks: { hidden: { title: '未审批分享' } },
    leaveRequests: { hidden: { reason: '私密事由' } }, leaveAudit: { hidden: { note: '私密审批意见' } }, leaveLocks: { hidden: { version: 'lock' } } });
  const secretNames = ['challengeFiles', 'sharingTasks', 'leaveRequests', 'leaveAudit', 'leaveLocks'], fetched = []; let archive;
  const access = { TEAM_ID: 'IMC', readMember: async (store, id) => (await store.collection('teamMembers').doc(id).get()).data };
  const resources = async () => ({ api: async action => {
    if (action === 'DescribeEnvs') return { EnvList: [{ EnvId: ENV, Status: 'NORMAL', Databases: [{ InstanceId: 'db' }], Storages: [{ Bucket: 'bucket' }] }] };
    if (action === 'ListTables') return { Tables: ['publicData', ...secretNames].map(TableName => ({ TableName })) };
    if (action === 'DescribeStorageSafeRule') return { AclTag: 'PRIVATE' };
    return {};
  }, manager: { storage: { listDirectoryFiles: async () => ['public.txt', 'sharing-files/work.pdf', 'sharing-uploads/user/temp.pdf', 'challenge-files/private.pdf'].map(Key => ({ Key, Size: 1, ETag: 'etag' })) } } });
  const cloud = { downloadFile: async ({ fileID }) => { fetched.push(fileID); return { fileContent: Buffer.from('a') }; }, uploadFile: async ({ cloudPath, fileContent }) => { archive = fileContent; return { fileID: 'cloud://test/' + cloudPath }; } };
  const call = createService({ db, cloud, access, resources, envId: ENV, now: () => 1000000000 });
  const result = await call(ID, { action: 'create', password: 'correct-password-long' });
  assert.equal(result.ok, true); assert.equal(result.backup.canExport, true);
  assert.equal(fetched.length, 1); assert.ok(fetched[0].endsWith('/public.txt'));
  const decoded = format.decode(archive, 'correct-password-long');
  assert.deepEqual(decoded.collections.map(row => row.name), ['publicData']); assert.equal(decoded.files.length, 1);
  assert.equal(JSON.stringify(decoded.collections).includes('私密'), false); assert.equal(decoded.scope.version, 3);
  for (const name of secretNames) assert.ok(decoded.scope.excludedCollections.includes(name));
});
test('未隔离私密数据的旧备份不能通过下载接口导出', async () => {
  const id = 'backup_12345678-1234-1234-1234-123456789abc';
  const db = createDatabase({ adminBackups: { [id]: { status: 'ready', scopeVersion: 2, bytes: 100, fileID: 'cloud://x/admin-backups/' + id + '.imcbak' } } });
  let read = false;
  const call = createService({ db, cloud: { downloadFile: async () => { read = true; } }, access: { TEAM_ID: 'IMC', readMember: async () => ({ teamId: 'IMC', status: 'active', roles: ['super_admin'] }) }, resources: async () => ({}), envId: ENV });
  await assert.rejects(call(ID, { action: 'chunk', id, offset: 0 }), error => error.businessCode === 'BACKUP_SCOPE_CHANGED');
  assert.equal(read, false);
});
