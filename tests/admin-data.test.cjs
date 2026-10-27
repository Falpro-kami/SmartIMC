const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const access = require('../cloudfunctions/_shared/access');
const format = require('../cloudfunctions/adminData/export-format');
const { createService } = require('../cloudfunctions/adminData/service');
const password = 'test-only-password-12345';
const active = roles => ({ teamId: 'IMC', status: 'active', roles });
function harness() {
  let resourceCalls = 0;
  const tables = {
    teamMembers: new Map([['owner', active(['super_admin'])], ['member', active([])]]),
    equipment: new Map([['device', { name: '设备', equipmentNumber: '00809485', updatedAt: new Date('2026-10-27T00:00:00Z') }]]),
    userProfiles: new Map([['owner', { name: '本人', avatarFileId: 'cloud://env.bucket/avatars/owner.jpg' }]]),
    adminBackups: new Map()
  };
  const blobs = new Map([['cloud://env.bucket/avatars/owner.jpg', Buffer.from([1, 2, 3])]]);
  function collection(name) {
    const table = tables[name]; let filter = {}, offset = 0, limit = 100, order = '_id', direction = 'asc';
    return {
      where(value) { filter = value; return this; }, orderBy(value, dir) { order = value; direction = dir; return this; },
      skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
      async get() { return { data: [...table].map(([id, value]) => ({ ...structuredClone(value), _id: id })).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).sort((a, b) => (a[order] > b[order] ? 1 : -1) * (direction === 'asc' ? 1 : -1)).slice(offset, offset + limit) }; },
      doc(id) { return {
        async get() { return { data: table.has(id) ? { ...structuredClone(table.get(id)), _id: id } : null }; },
        async set({ data }) { table.set(id, structuredClone(data)); },
        async update({ data }) { table.set(id, { ...table.get(id), ...structuredClone(data) }); }
      }; }
    };
  }
  const db = { collection, runTransaction: async fn => fn({ collection }) };
  const cloud = {
    async downloadFile({ fileID }) { return { fileContent: blobs.get(fileID) }; },
    async uploadFile({ cloudPath, fileContent }) { const fileID = 'cloud://env.bucket/' + cloudPath; blobs.set(fileID, fileContent); return { fileID }; }
  };
  const env = { EnvId: 'env', Status: 'NORMAL', Databases: [{ InstanceId: 'db' }], Storages: [{ Bucket: 'bucket' }] };
  const api = async (action, body) => {
    if (action === 'DescribeBillingInfo') return { EnvBillingInfoList: [{ EnvId: 'env', PackageName: '体验版', PackageId: 'baas_trial', ExpireTime: '2026-11-01 00:00:00', Status: 'NORMAL', IsAutoRenew: false }] };
    if (action === 'DescribeEnvs') return { EnvList: [env] };
    if (action === 'ListTables') return { Tables: Object.keys(tables).map(TableName => ({ TableName })) };
    if (action === 'DescribeDatabaseACL') return { AclTag: 'ADMINONLY' };
    if (action === 'DescribeTable') return { Indexes: [{ Name: '_id_' }] };
    if (action === 'DescribeStorageSafeRule') return { AclTag: 'PRIVATE' };
    throw Error(action);
  };
  const manager = { storage: { async listDirectoryFiles() { return [...blobs].map(([key, value]) => ({ Key: key.split('/').slice(3).join('/'), Size: String(value.length), ETag: format.sha256(value) })); } } };
  const resources = async () => { resourceCalls++; return { api, manager }; };
  const service = createService({ db, cloud, access, resources, envId: 'env', now: () => Date.parse('2026-10-27T00:00:00+08:00') });
  return { service, tables, blobs, cloud, manager, get resourceCalls() { return resourceCalls; } };
}
test('every admin action rejects unapproved, disabled, ordinary and other-team accounts before reading cloud resources', async () => {
  const app = harness();
  for (const member of [null, active([]), active(['weekly_admin']), { ...active(['super_admin']), status: 'pending' }, { ...active(['super_admin']), status: 'disabled' }, { ...active(['super_admin']), teamId: 'OTHER' }]) {
    if (member) app.tables.teamMembers.set('actor', member); else app.tables.teamMembers.delete('actor');
    for (const action of ['status', 'create', 'chunk']) await assert.rejects(() => app.service('actor', { action, id: 'owner', roles: ['super_admin'], password }), error => error.businessCode === 'FORBIDDEN');
  }
  assert.equal(app.resourceCalls, 0);
});
test('expiry uses current billing and a real date in China time, without creating scheduled notifications', async () => {
  const app = harness();
  const result = await app.service('owner', { action: 'status', expiresAt: '2099-01-01' });
  assert.equal(result.billing.daysRemaining, 5);
  assert.equal(result.billing.expiresAt, '2026-11-01 00:00:00');
  assert.equal(result.billing.isTrial, true);
  assert.equal(result.backups.length, 0);
  assert.equal(app.tables.adminBackups.size, 0);
});
test('manual exports include actual files and typed documents, exclude past archives, and can be downloaded and decrypted offline', async () => {
  const app = harness();
  const result = await app.service('owner', { action: 'create', password });
  assert.equal(result.backup.status, 'ready');
  assert.equal(result.backup.fileCount, 1);
  const chunks = await app.service('owner', { action: 'chunk', id: result.backup.id, offset: 0 });
  assert.equal(chunks.complete, true);
  const encrypted = Buffer.from(chunks.data, 'base64');
  assert.equal(encrypted.includes(Buffer.from('本人')), false);
  assert.throws(() => format.decode(encrypted, 'wrong-password-12345'));
  const recovered = format.decode(encrypted, password);
  const device = recovered.collections.find(item => item.name === 'equipment').documents[0];
  assert.equal(device.equipmentNumber, '00809485');
  assert.deepEqual(device.updatedAt, { $date: '2026-10-27T00:00:00.000Z' });
  assert.deepEqual(Buffer.from(recovered.files[0].base64, 'base64'), Buffer.from([1, 2, 3]));
  assert.equal(JSON.stringify([...app.tables.adminBackups.values()]).includes(password), false);
  const again = await app.service('owner', { action: 'create', password });
  assert.equal(again.backup.fileCount, 1);
  const listed = await app.service('owner', { action: 'status' });
  assert.equal(listed.backups.length, 2);
  assert.equal(listed.backups[0].fileID, undefined);
});
test('revoking an administrator prevents later downloads, corrupt files fail, and invalid passwords cannot create jobs', async () => {
  const app = harness();
  await assert.rejects(() => app.service('owner', { action: 'create', password: 'short' }), error => error.businessCode === 'INVALID_PASSWORD');
  assert.equal(app.tables.adminBackups.size, 0);
  const result = await app.service('owner', { action: 'create', password });
  const row = app.tables.adminBackups.get(result.backup.id);
  app.blobs.set(row.fileID, Buffer.from('damaged'));
  await assert.rejects(() => app.service('owner', { action: 'chunk', id: result.backup.id, offset: 0 }), error => error.businessCode === 'BACKUP_CORRUPTED');
  app.tables.teamMembers.set('owner', active([]));
  await assert.rejects(() => app.service('owner', { action: 'chunk', id: result.backup.id, offset: 0 }), error => error.businessCode === 'FORBIDDEN');
});
test('My hides privileged routes from ordinary members and an older status request cannot restore revoked privileges', async () => {
  let page, member = { ...active(['super_admin']), roleLabels: ['超级管理员'], permissions: ['*'] };
  let finish; const navigated = [];
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/profile/index.js', 'utf8'), {
    Page: value => { page = value; }, wx: { navigateTo: value => navigated.push(value.url) },
    require: name => name.endsWith('/member-page') ? value => value : name.endsWith('/access') ? { get: async () => ({ member }), can: (value, permission) => access.allowed(value, permission) } : {
      status: () => new Promise(resolve => { finish = resolve; }), expiryLabel: () => '剩余 5 天'
    }
  });
  page.setData = value => Object.assign(page.data, value);
  await page.loadAccess();
  page.openDataBackup(); page.openServiceExpiry();
  assert.deepEqual(navigated, ['/pages/module/index?id=data-backup', '/pages/module/index?id=service-expiry']);
  member = { ...active([]), roleLabels: ['普通成员'], permissions: [] };
  await page.loadAccess();
  finish({ billing: { daysRemaining: 5 } }); await Promise.resolve();
  assert.equal(page.data.canManage, false); assert.equal(page.data.expiryLabel, '-');
  page.openDataBackup(); page.openServiceExpiry();
  assert.equal(navigated.length, 2);
});

test('client downloads exact encrypted chunks and removes a partial file when access is revoked', async () => {
  const encrypted = Buffer.alloc(150000, 0x59);
  const files = new Map(); let revoke = false, service;
  const record = { id: 'backup_12345678-1234-1234-1234-123456789abc', bytes: encrypted.length };
  const filesystem = {
    writeFile({ filePath, data, success }) { files.set(filePath, Buffer.from(data)); success(); },
    appendFile({ filePath, data, success }) { files.set(filePath, Buffer.concat([files.get(filePath), Buffer.from(data)])); success(); },
    unlink({ filePath, success }) { files.delete(filePath); success(); }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('miniprogram/services/admin-data.js', 'utf8'), {
    module, exports: module.exports, require: () => ({ adminDataFunction: 'adminData' }), getApp: () => ({ globalData: { cloudReady: true } }),
    wx: { env: { USER_DATA_PATH: '/user-data' }, getFileSystemManager: () => filesystem,
      base64ToArrayBuffer(value) { const bytes = Buffer.from(value, 'base64'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      cloud: { async callFunction({ name, data }) {
        assert.equal(name, 'adminData');
        if (revoke && data.offset > 0) return { result: { ok: false, code: 'FORBIDDEN', message: '权限已撤销' } };
        const end = Math.min(data.offset + 128 * 1024, encrypted.length);
        return { result: { ok: true, data: encrypted.subarray(data.offset, end).toString('base64'), total: encrypted.length, nextOffset: end, complete: end === encrypted.length } };
      } }
    }
  });
  service = module.exports;
  const result = await service.download(record);
  assert.deepEqual(files.get(result.filePath), encrypted);
  revoke = true;
  await assert.rejects(() => service.download(record), error => error.code === 'FORBIDDEN');
  assert.equal(files.size, 0);
});
test('backup creation checks matching passwords and clears both fields before sending the request', async () => {
  let page, sent = 0;
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/module/index.js', 'utf8'), {
    Page: value => { page = value; }, wx: { showToast() {} }, require: name => name.endsWith('/member-page') ? value => value : ({
      async create(value) { sent++; assert.equal(value, password); assert.equal(page.data.password, ''); assert.equal(page.data.passwordConfirm, ''); return { backup: { id: 'new' } }; },
      present: value => value
    })
  });
  page.setData = value => Object.assign(page.data, value);
  page.setData({ billing: {}, password });
  await page.createBackup(); assert.equal(sent, 0);
  page.onBackupPasswordConfirm({ detail: { value: password } });
  await page.createBackup(); assert.equal(sent, 1);
  assert.equal(page.data.backups[0].id, 'new');
  assert.equal(page.data.creating, false);
});
