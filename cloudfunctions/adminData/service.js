const { randomUUID } = require('node:crypto');
const format = require('./export-format');
const TABLE = 'adminBackups';
const PREFIX = 'admin-backups/';
const CHUNK = 128 * 1024;
const LIMIT = 32 * 1024 * 1024;
function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
function document(result) { return Array.isArray(result.data) ? result.data[0] : result.data; }
function createService({ db, cloud, access, resources, envId, now = Date.now }) {
  async function authorize(id, database = db) {
    const member = await access.readMember(database, id);
    if (!member || member.teamId !== access.TEAM_ID || member.status !== 'active' || !member.roles.includes('super_admin')) reject('FORBIDDEN', '仅超级管理员可以管理备份和到期提醒。');
    return member;
  }
  async function all(name) {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const batch = await db.collection(name).orderBy('_id', 'asc').skip(offset).limit(100).get();
      result.push(...batch.data);
      if (Buffer.byteLength(format.json(result)) > LIMIT) reject('BACKUP_TOO_LARGE', '数据较大，请使用电脑备份工具。');
      if (batch.data.length < 100) return result;
    }
  }
  async function collectionNames(api, tag) {
    const names = [];
    for (let offset = 0; ; offset += 100) {
      const result = await api('ListTables', { Tag: tag, MgoLimit: 100, MgoOffset: offset });
      const batch = result.Tables || [];
      names.push(...batch.map(item => item.TableName).filter(name => name !== TABLE));
      if (batch.length < 100) return names.sort();
    }
  }
  const present = row => ({ id: row._id, createdAt: row.createdAt, status: row.status, bytes: row.bytes || 0,
    documentCount: row.documentCount || 0, fileCount: row.fileCount || 0, collectionCount: row.collectionCount || 0 });
  async function status(id) {
    const { api } = await resources();
    const result = await api('DescribeBillingInfo');
    const billing = result.EnvBillingInfoList?.find(item => item.EnvId === envId);
    if (!billing) reject('BILLING_UNAVAILABLE', '暂时无法获取云服务到期信息。');
    const expiresAt = billing.ExpireTime || '';
    const timestamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(expiresAt) ? Date.parse(expiresAt.replace(' ', 'T') + '+08:00') : NaN;
    const daysRemaining = Number.isFinite(timestamp) ? Math.ceil((timestamp - now()) / 86400000) : null;
    const recent = await db.collection(TABLE).where({ status: 'ready' }).orderBy('createdAt', 'desc').limit(10).get();
    await authorize(id);
    return { ok: true, billing: { packageName: billing.PackageName || '-', expiresAt, daysRemaining,
      status: billing.Status || '-', isTrial: billing.PackageId === 'baas_trial', autoRenew: billing.IsAutoRenew === true }, backups: recent.data.map(present) };
  }
  async function create(id, event) {
    if (typeof event.password !== 'string' || event.password.length < 12 || event.password.length > 128) reject('INVALID_PASSWORD', '备份密码需要12至128个字符。');
    const jobId = 'backup_' + randomUUID();
    const started = now();
    await db.runTransaction(async transaction => {
      await authorize(id, transaction);
      const ref = transaction.collection(TABLE).doc('control');
      const state = document(await ref.get());
      if (state && started - state.startedAt < 120000) reject('BACKUP_BUSY', '已有备份正在处理，请稍后再试。');
      await ref.set({ data: { jobId, startedAt: started, actorId: id } });
      await transaction.collection(TABLE).doc(jobId).set({ data: { actorId: id, status: 'creating', createdAt: started } });
    });
    try {
      const { api, manager } = await resources();
      const environments = await api('DescribeEnvs');
      const env = environments.EnvList.find(item => item.EnvId === envId);
      if (!env || env.Status !== 'NORMAL') reject('ENV_UNAVAILABLE', '云环境暂时不可用。');
      const names = await collectionNames(api, env.Databases[0].InstanceId);
      const collections = [];
      for (const name of names) {
        const documents = await all(name);
        const [acl, indexes] = await Promise.all([
          api('DescribeDatabaseACL', { CollectionName: name }), api('DescribeTable', { Tag: env.Databases[0].InstanceId, TableName: name })
        ]);
        if (name === 'teamSync') acl.safeRule = await api('DescribeSafeRule', { CollectionName: name });
        collections.push({ name, documents: JSON.parse(format.json(documents)), acl, indexes });
      }
      const inventory = async () => (await manager.storage.listDirectoryFiles('')).filter(file => !file.Key.startsWith(PREFIX) && !file.Key.endsWith('/')).sort((a, b) => a.Key.localeCompare(b.Key));
      const initial = await inventory();
      const files = [];
      let total = Buffer.byteLength(format.json(collections));
      for (const file of initial) {
        format.safeName(file.Key);
        if (Number(file.Size) > 8 * 1024 * 1024 || total + Number(file.Size) * 1.4 > LIMIT) reject('BACKUP_TOO_LARGE', '附件较大，请使用电脑备份工具。');
        const fileID = 'cloud://' + envId + '.' + env.Storages[0].Bucket + '/' + file.Key;
        const response = await cloud.downloadFile({ fileID });
        const buffer = response.fileContent;
        if (buffer.length !== Number(file.Size)) reject('BACKUP_CHANGED', '备份期间文件发生变化，请重新创建。');
        total += buffer.length * 1.4;
        files.push({ key: file.Key, fileID, bytes: buffer.length, sha256: format.sha256(buffer), base64: buffer.toString('base64') });
      }
      for (const collection of collections) {
        if (format.sha256(format.json(await all(collection.name))) !== format.sha256(JSON.stringify(collection.documents))) reject('BACKUP_CHANGED', '备份期间数据发生变化，请重新创建。');
      }
      const fingerprint = items => JSON.stringify(items.map(item => [item.Key, item.Size, item.ETag]));
      if (fingerprint(initial) !== fingerprint(await inventory()) || JSON.stringify(names) !== JSON.stringify(await collectionNames(api, env.Databases[0].InstanceId))) reject('BACKUP_CHANGED', '备份期间数据发生变化，请重新创建。');
      const fileIds = new Set(files.map(file => file.fileID));
      function checkReferences(value) {
        if (typeof value === 'string' && value.startsWith('cloud://') && !fileIds.has(value)) reject('FILE_MISSING', '存在缺失的关联文件，请检查后重试。');
        if (Array.isArray(value)) value.forEach(checkReferences);
        else if (value && typeof value === 'object') Object.values(value).forEach(checkReferences);
      }
      collections.forEach(collection => checkReferences(collection.documents));
      const storageRules = await api('DescribeStorageSafeRule', { Bucket: env.Storages[0].Bucket });
      const payload = { version: 1, envId, createdAt: started, collections, files, environment: env, storageRules };
      const encrypted = format.encode(payload, event.password);
      format.decode(encrypted, event.password);
      await authorize(id);
      const cloudPath = PREFIX + jobId + '.imcbak';
      const upload = await cloud.uploadFile({ cloudPath, fileContent: encrypted });
      if (!upload.fileID) throw new Error('UPLOAD_FAILED');
      await db.runTransaction(async transaction => {
        await authorize(id, transaction);
        await transaction.collection(TABLE).doc(jobId).update({ data: { status: 'ready', bytes: encrypted.length,
          fileID: upload.fileID, sha256: format.sha256(encrypted), collectionCount: collections.length,
          documentCount: collections.reduce((sum, collection) => sum + collection.documents.length, 0), fileCount: files.length } });
      });
      return { ok: true, backup: { id: jobId, status: 'ready', createdAt: started, bytes: encrypted.length, collectionCount: collections.length,
        documentCount: collections.reduce((sum, collection) => sum + collection.documents.length, 0), fileCount: files.length } };
    } catch (error) {
      try { await db.collection(TABLE).doc(jobId).update({ data: { status: 'failed' } }); } catch (_) {}
      throw error;
    } finally {
      try {
        await db.runTransaction(async transaction => {
          const ref = transaction.collection(TABLE).doc('control');
          const state = document(await ref.get());
          if (state?.jobId === jobId) await ref.set({ data: { jobId: '', startedAt: 0, actorId: id } });
        });
      } catch (_) {}
    }
  }
  async function chunk(id, event) {
    if (!/^backup_[a-f0-9-]{36}$/.test(event.id || '') || !Number.isSafeInteger(event.offset) || event.offset < 0 || event.offset % CHUNK !== 0) reject('INVALID_INPUT', '备份参数不正确。');
    const backup = document(await db.collection(TABLE).doc(event.id).get());
    if (!backup || backup.status !== 'ready' || backup.bytes > LIMIT * 2) reject('BACKUP_NOT_FOUND', '备份不存在或尚未完成。');
    if (event.offset >= backup.bytes || !backup.fileID?.endsWith('/' + PREFIX + event.id + '.imcbak')) reject('INVALID_INPUT', '备份参数不正确。');
    const response = await cloud.downloadFile({ fileID: backup.fileID });
    const buffer = response.fileContent;
    if (buffer.length !== backup.bytes || format.sha256(buffer) !== backup.sha256) reject('BACKUP_CORRUPTED', '备份校验失败，请重新创建。');
    await authorize(id);
    const end = Math.min(event.offset + CHUNK, buffer.length);
    return { ok: true, data: buffer.subarray(event.offset, end).toString('base64'), nextOffset: end, total: buffer.length, complete: end === buffer.length };
  }
  return async (id, event) => {
    await authorize(id);
    if (event.action === 'status') return status(id);
    if (event.action === 'create') return create(id, event);
    if (event.action === 'chunk') return chunk(id, event);
    reject('INVALID_ACTION', '不支持的备份操作。');
  };
}
module.exports = { createService };
