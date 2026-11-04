const { randomUUID } = require('node:crypto');
const ENV = 'well-leopon-d5glrufc6e4fd4413';
const BUCKET = '7765-well-leopon-d5glrufc6e4fd4413-1516940081';
function baseRule(tag) {
  const own = 'auth != null && resource.openid == auth.openid';
  const rules = { READONLY: { read: true, write: own }, PRIVATE: { read: own, write: own }, ADMINWRITE: { read: true, write: false }, ADMINONLY: { read: false, write: false } };
  if (!rules[tag]) throw new Error('Unsupported existing storage ACL');
  return rules[tag];
}
function protectStorage(previous) {
  const rule = previous.AclTag === 'CUSTOM' ? typeof previous.Rule === 'string' ? JSON.parse(previous.Rule) : previous.Rule : baseRule(previous.AclTag);
  if (!rule || !['string', 'boolean'].includes(typeof rule.read) || !['string', 'boolean'].includes(typeof rule.write)) throw new Error('Existing storage rules cannot be safely merged');
  const prefix = '!/^sharing-(uploads|files)\\//.test(resource.path)';
  if (String(rule.read).includes(prefix) && String(rule.write).includes(prefix)) return { rule, changed: false };
  return { changed: true, rule: {
    read: prefix + ' && (' + rule.read + ')',
    write: '(auth != null && /^sharing-uploads\\//.test(resource.path) && resource.openid == auth.openid) || (' + prefix + ' && (' + rule.write + '))'
  } };
}
async function initialize(db, actorId, providedManager) {
  const Manager = providedManager ? null : require('@cloudbase/manager-node');
  const manager = providedManager || new Manager({ envId: ENV, region: 'ap-shanghai', timeout: 15000 });
  const api = (Action, body = {}) => manager.commonService('tcb').call({ Action, Param: { EnvId: ENV, ...body } });
  let stage = 'collections';
  try {
  const collections = [];
  for (const name of ['sharingTasks', 'sharingFiles', 'sharingAudit']) {
    const state = await manager.database.checkCollectionExists(name);
    if (!state.Exists) await manager.database.createCollection(name);
    await api('ModifyDatabaseACL', { CollectionName: name, AclTag: 'ADMINONLY' });
    const acl = await api('DescribeDatabaseACL', { CollectionName: name });
    if (acl.AclTag !== 'ADMINONLY') throw new Error('Private collection ACL not applied: ' + name);
    collections.push({ name, permission: acl.AclTag });
  }
  const definitions = require('./deployment.json').collections;
  stage = 'indexes';
  for (const collection of definitions) {
    if (!collection.indexes.length) continue;
    const existing = await manager.database.describeCollection(collection.name);
    const names = new Set((existing.Indexes || []).map(index => index.Name));
    const missing = collection.indexes.filter(index => !names.has(index.name));
    if (missing.length) await manager.database.updateCollection(collection.name, { CreateIndexes: missing.map(index => ({
      IndexName: index.name, MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: Object.entries(index.fields).map(([Name, direction]) => ({ Name, Direction: String(direction) })) }
    })) });
  }
  stage = 'storage.read';
  const previous = await api('DescribeStorageSafeRule', { Bucket: BUCKET });
  // PRIVATE already restricts staging to its uploader and keeps server-owned
  // copies private. The cloud function authorizes each download chunk. Retain
  // this preset on plans that do not support custom storage rules.
  const privatePreset = previous.AclTag === 'PRIVATE';
  const protectedRule = privatePreset ? { changed: false } : protectStorage(previous);
  if (protectedRule.changed) {
    await db.collection('sharingAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', actorId, action: 'storage.protect',
      before: { aclTag: previous.AclTag, rule: previous.Rule || null }, after: protectedRule.rule, createdMs: Date.now() } });
    stage = 'storage.update';
    await api('ModifyStorageSafeRule', { Bucket: BUCKET, AclTag: 'CUSTOM', Rule: JSON.stringify(protectedRule.rule) });
  }
  stage = 'storage.verify';
  const verified = await api('DescribeStorageSafeRule', { Bucket: BUCKET });
  const currentRule = verified.AclTag === 'CUSTOM' && typeof verified.Rule === 'string' ? JSON.parse(verified.Rule) : verified.Rule;
  const storagePrivate = privatePreset ? verified.AclTag === 'PRIVATE' : verified.AclTag === 'CUSTOM' && currentRule &&
    currentRule.read === protectedRule.rule.read && currentRule.write === protectedRule.rule.write;
  if (!storagePrivate) throw new Error('Private storage rules are not yet applied');
  stage = 'reminder.trigger';
  let trigger = 'created';
  try { await manager.functions.createFunctionTriggers('weeklySharing', [{ name: 'weekly-sharing-reminders', type: 'timer', config: '0 */5 * * * * *' }]); }
  catch (error) { if (/ResourceInUse|already exist|已存在/i.test(String(error.code) + ' ' + error.message)) trigger = 'exists'; else throw error; }
  stage = 'reviewer.binding';
  await db.collection('sharingAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', actorId, action: 'initialize', createdMs: Date.now() } });
  await require('./reviewer-binding')(db, actorId);
  return { ok: true, collections, storagePrivate: true, storageAcl: verified.AclTag, trigger };
  } catch (error) {
    // This operation is restricted to Gao in service.js; expose the failed setup
    // step to that operator without returning credentials, stack traces or URLs.
    const detail = String(error.message || error.code || 'Unknown setup error').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);
    const failure = new Error('每周分享初始化失败（' + stage + '）：' + detail);
    failure.businessCode = 'SHARING_SETUP_FAILED';
    throw failure;
  }
}
module.exports = initialize;
module.exports.protectStorage = protectStorage;
module.exports.inspect = async (db, providedManager) => {
  const Manager = providedManager ? null : require('@cloudbase/manager-node');
  const manager = providedManager || new Manager({ envId: ENV, region: 'ap-shanghai', timeout: 15000 });
  const detail = await manager.functions.getFunctionDetail('weeklySharing');
  const record = await db.collection('sharingAudit').doc(require('./timer').HEALTH_ID).get();
  const health = Array.isArray(record.data) ? record.data[0] : record.data;
  return { ok: true, status: detail.Status, triggers: (detail.Triggers || []).map(trigger => ({
    name: trigger.TriggerName || trigger.Name, type: trigger.Type, config: trigger.Config || trigger.TriggerDesc,
    enabled: trigger.Enable, availableStatus: trigger.AvailableStatus
  })), timer: health ? { state: health.state, startedMs: health.startedMs, finishedMs: health.finishedMs || 0,
    processed: health.processed || 0, errorCode: health.errorCode || '' } : null };
};
module.exports.configure = async () => {
  const Manager = require('@cloudbase/manager-node');
  const manager = new Manager({ envId: ENV, region: 'ap-shanghai', timeout: 15000 });
  await manager.functions.updateFunctionConfig({ name: 'weeklySharing', timeout: 60, memorySize: 256, runtime: 'Nodejs20.19' });
  return { ok: true };
};
