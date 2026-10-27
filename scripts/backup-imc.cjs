// Local operator tool: read-only cloud access; encrypted backup outside the source checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, ENV } = require('./cloudbase.cjs');
const archive = require('./lib/backup-archive.cjs');
const root = path.resolve(__dirname, '..');
const backupRoot = path.resolve(process.env.IMC_BACKUP_DIR || path.join(root, '..', 'IMC-backups'));
const keyFile = process.env.IMC_BACKUP_KEY_FILE || path.join(process.env.LOCALAPPDATA || process.env.HOME, 'IMC', 'backup-keys', 'imc-data.key');
function api(action, body = {}) { return run(['api', 'tcb', action, '--body', JSON.stringify({ EnvId: ENV, ...body }), '-r', 'ap-shanghai']).data; }
function tables(tag) {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    const response = api('ListTables', { Tag: tag, MgoLimit: 100, MgoOffset: offset });
    const rows = response.Tables || [];
    result.push(...rows.map(row => row.TableName));
    if (rows.length < 100) return result.sort();
  }
}
function rows(table) {
  const documents = [];
  for (let skip = 0; ; skip += 100) {
    const response = run(['db', 'nosql', 'execute', '--command', JSON.stringify([
      { TableName: table, CommandType: 'QUERY', Command: JSON.stringify({ find: table, filter: {}, sort: { _id: 1 }, skip, limit: 100, batchSize: 100 }) }
    ])]);
    const batch = response.data.results[0];
    if (!Array.isArray(batch)) throw new Error('Unexpected database result for ' + table);
    documents.push(...batch);
    if (batch.length < 100) return documents;
  }
}
function safeSources(write, current = root, relative = '') {
  const top = ['miniprogram', 'cloudfunctions', 'scripts', 'tests', 'design', 'README.md', 'AGENTS.md', 'project.config.json', 'cloudbaserc.json'];
  for (const item of fs.readdirSync(current, { withFileTypes: true })) {
    if (!relative && !top.includes(item.name)) continue;
    if (['node_modules', '.git', '.local'].includes(item.name) || item.isSymbolicLink()) continue;
    const name = relative ? relative + '/' + item.name : item.name;
    const filename = path.join(current, item.name);
    if (item.isDirectory()) safeSources(write, filename, name);
    else if (item.isFile()) write.put('project/' + name, fs.readFileSync(filename));
  }
}
async function download(url, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Cloud file download failed: HTTP ' + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024) throw new Error('File exceeds 64 MiB; streaming archive is required');
    chunks.push(chunk);
  }
  if (size !== Number(expected)) throw new Error('Cloud file size changed during backup');
  return Buffer.concat(chunks);
}
async function main() {
  if (backupRoot === root || backupRoot.startsWith(root + path.sep)) throw new Error('Backups must be outside the project checkout');
  archive.privateDirectory(backupRoot);
  const recoveryTools = path.join(backupRoot, '_recovery-tools');
  fs.mkdirSync(path.join(recoveryTools, 'lib'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, 'restore-imc.cjs'), path.join(recoveryTools, 'restore-imc.cjs'));
  fs.copyFileSync(path.join(__dirname, 'lib/backup-archive.cjs'), path.join(recoveryTools, 'lib/backup-archive.cjs'));
  fs.copyFileSync(path.join(__dirname, 'restore-app-backup.cjs'), path.join(recoveryTools, 'restore-app-backup.cjs'));
  fs.copyFileSync(path.join(root, 'cloudfunctions/adminData/export-format.js'), path.join(recoveryTools, 'lib/app-export.cjs'));
  const existing = fs.readdirSync(backupRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).some(entry =>
    fs.readdirSync(path.join(backupRoot, entry.name)).some(name => name === 'manifest.imc' || /^\d{6}\.bin$/.test(name)));
  const key = archive.loadKey(keyFile, !existing);
  const env = api('DescribeEnvs').EnvList.find(item => item.EnvId === ENV);
  if (!env || env.Status !== 'NORMAL') throw new Error('Cloud environment is not ready');
  const startedAt = new Date().toISOString();
  const businessTables = () => tables(env.Databases[0].InstanceId).filter(name => name !== 'adminBackups');
  const businessFiles = () => run(['storage', 'list', '/']).data.filter(file => !file.key.startsWith('admin-backups/'));
  const names = businessTables();
  const directory = path.join(backupRoot, startedAt.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(directory, { mode: 0o700 });
  const write = archive.writer(directory, key);
  console.log('Backing up ' + names.length + ' collections; no cloud data will be modified.');
  const collections = [];
  const documents = new Map();
  for (const name of names) {
    archive.relativeName(name);
    const data = rows(name);
    documents.set(name, data);
    const entry = { name, path: 'database/' + name + '.json', count: data.length };
    write.put(entry.path, JSON.stringify(data));
    collections.push(entry);
    const acl = api('DescribeDatabaseACL', { CollectionName: name });
    const indexes = api('DescribeTable', { Tag: env.Databases[0].InstanceId, TableName: name });
    write.put('metadata/collections/' + name + '.json', JSON.stringify({ acl, indexes }));
  }
  const storage = env.Storages[0];
  const storageRules = api('DescribeStorageSafeRule', { Bucket: storage.Bucket });
  const initial = businessFiles();
  if (!Array.isArray(initial)) throw new Error('Unexpected cloud file inventory');
  const cloudFiles = [];
  for (const file of initial) {
    archive.relativeName(file.key);
    if (file.key.endsWith('/')) continue;
    const link = run(['storage', 'url', file.key]).data;
    if (!link || typeof link.url !== 'string' || !link.url.startsWith('https://')) throw new Error('Cannot create authenticated download link');
    const content = await download(link.url, file.size);
    write.put('storage/' + file.key, content);
    cloudFiles.push({ key: file.key, fileId: 'cloud://' + ENV + '.' + storage.Bucket + '/' + file.key, bytes: content.length, sha256: archive.sha256(content) });
  }
  // Refuse to report success if data changed while being read. This is a stable logical export,
  // not a cross-collection transaction snapshot; retry during a quiet period if it fails.
  for (const name of names) if (archive.sha256(JSON.stringify(rows(name))) !== archive.sha256(JSON.stringify(documents.get(name)))) throw new Error('Data changed during backup: ' + name);
  if (JSON.stringify(businessTables()) !== JSON.stringify(names)) throw new Error('Collection inventory changed');
  const last = businessFiles();
  const inventory = files => JSON.stringify(files.map(file => ({ key: file.key, size: file.size, eTag: file.eTag })).sort((a, b) => a.key.localeCompare(b.key)));
  if (inventory(initial) !== inventory(last)) throw new Error('Cloud files changed during backup');
  const fileIds = new Set(cloudFiles.map(file => file.fileId));
  const fileReferences = new Set();
  function references(value) {
    if (typeof value === 'string' && value.startsWith('cloud://')) fileReferences.add(value);
    else if (Array.isArray(value)) value.forEach(references);
    else if (value && typeof value === 'object') Object.values(value).forEach(references);
  }
  for (const data of documents.values()) references(data);
  const missing = [...fileReferences].filter(file => !fileIds.has(file));
  if (missing.length) throw new Error(missing.length + ' referenced cloud files are absent; backup is incomplete');
  const billing = api('DescribeBillingInfo').EnvBillingInfoList.find(item => item.EnvId === ENV);
  write.put('metadata/environment.json', JSON.stringify({ env, storageRules, billing }));
  safeSources(write);
  const manifest = write.finish({ envId: ENV, startedAt, completedAt: new Date().toISOString(), collections, cloudFiles,
    consistency: 'stable-double-read-logical-export' });
  const expiresAt = billing?.ExpireTime || '';
  console.log(JSON.stringify({ ok: true, directory, collections: collections.length, documents: collections.reduce((n, c) => n + c.count, 0), cloudFiles: cloudFiles.length, encryptedEntries: manifest.entries.length,
    expiresAt, isTrial: billing?.PackageId === 'baas_trial', autoRenew: billing?.IsAutoRenew === true }, null, 2));
}
if (require.main === module) main().catch(error => { console.error('Backup failed: ' + error.message); process.exitCode = 1; });
module.exports = { main };
