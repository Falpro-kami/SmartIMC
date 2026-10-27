const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const MAGIC = Buffer.from('IMCBK1');
const MAX_BYTES = 256 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function relativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(name)) {
    throw new Error('Invalid archive path');
  }
  return name;
}
function privateDirectory(directory) {
  directory = path.resolve(directory);
  if (directory === path.parse(directory).root) throw new Error('A drive root cannot be a backup directory');
  // Refuse symlink/reparse redirection before creating private output.
  for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink output is not allowed');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
    if (identity.status || !sid) throw new Error('Cannot determine backup owner');
    const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
    if (acl.status) throw new Error('Cannot restrict backup directory permissions');
  } else fs.chmodSync(directory, 0o700);
  return directory;
}
function loadKey(filename, create = false) {
  if (!fs.existsSync(filename)) {
    if (!create) throw new Error('Backup key is missing; do not create a replacement for existing backups');
    privateDirectory(path.dirname(filename));
    fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw new Error('Invalid backup key');
  return key;
}
function seal(buffer, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}
function unseal(buffer, key) {
  if (buffer.length < 34 || !buffer.subarray(0, 6).equals(MAGIC)) throw new Error('Invalid backup format');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(6, 18));
  cipher.setAuthTag(buffer.subarray(18, 34));
  return Buffer.concat([cipher.update(buffer.subarray(34)), cipher.final()]);
}
function writer(directory, key) {
  const entries = [];
  const names = new Set();
  let total = 0;
  return {
    put(name, content) {
      relativeName(name);
      if (names.has(name)) throw new Error('Duplicate archive entry');
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      total += buffer.length;
      if (total > MAX_BYTES) throw new Error('Backup exceeds 256 MiB; use streaming backup for larger datasets');
      const blob = String(entries.length).padStart(6, '0') + '.bin';
      fs.writeFileSync(path.join(directory, blob), seal(buffer, key), { flag: 'wx', mode: 0o600 });
      entries.push({ name, blob, bytes: buffer.length, sha256: sha256(buffer) });
      names.add(name);
    },
    finish(metadata) {
      const manifest = { ...metadata, version: 1, entries, bytes: total };
      fs.writeFileSync(path.join(directory, 'manifest.imc'), seal(Buffer.from(JSON.stringify(manifest)), key), { flag: 'wx', mode: 0o600 });
      verify(directory, key);
      fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), manifestSha256: sha256(fs.readFileSync(path.join(directory, 'manifest.imc'))) }), { flag: 'wx', mode: 0o600 });
      return manifest;
    }
  };
}
function verify(directory, key) {
  const raw = fs.readFileSync(path.join(directory, 'manifest.imc'));
  if (raw.length > 4 * 1024 * 1024) throw new Error('Manifest too large');
  const manifest = JSON.parse(unseal(raw, key));
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || !Array.isArray(manifest.collections)) throw new Error('Invalid manifest');
  const files = new Map();
  const blobs = new Set();
  let total = 0;
  for (const entry of manifest.entries) {
    relativeName(entry.name);
    if (!/^\d{6}\.bin$/.test(entry.blob) || files.has(entry.name) || blobs.has(entry.blob) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Invalid archive entry');
    total += entry.bytes;
    if (total > MAX_BYTES) throw new Error('Backup too large');
    const filename = path.join(directory, entry.blob);
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size !== entry.bytes + 34) throw new Error('Blob size mismatch');
    const content = unseal(fs.readFileSync(filename), key);
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256) throw new Error('Backup checksum mismatch');
    files.set(entry.name, content);
    blobs.add(entry.blob);
  }
  if (total !== manifest.bytes) throw new Error('Backup byte count mismatch');
  for (const table of manifest.collections) {
    const rows = JSON.parse(files.get(table.path)?.toString() || 'null');
    if (!Array.isArray(rows) || rows.length !== table.count || new Set(rows.map(row => JSON.stringify(row._id))).size !== rows.length) throw new Error('Collection count or identity mismatch');
  }
  for (const file of manifest.cloudFiles || []) {
    if (!files.has('storage/' + relativeName(file.key))) throw new Error('Cloud file missing from archive');
  }
  return { manifest, files };
}
function restore(directory, key, output) {
  // Authenticate every entry before writing any restored data. Never merge into existing directories.
  const archive = verify(directory, key);
  if (fs.existsSync(output)) throw new Error('Restore destination already exists');
  const root = privateDirectory(output);
  for (const [name, content] of archive.files) {
    const filename = path.resolve(root, relativeName(name));
    if (!filename.startsWith(root + path.sep)) throw new Error('Restore path escapes destination');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
    if (sha256(fs.readFileSync(filename)) !== sha256(content)) throw new Error('Restored file differs');
  }
  return archive.manifest;
}
module.exports = { sha256, privateDirectory, loadKey, seal, unseal, writer, verify, restore, relativeName };
