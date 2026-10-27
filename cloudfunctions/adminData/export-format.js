const crypto = require('node:crypto');
const zlib = require('node:zlib');
const MAX = 32 * 1024 * 1024;
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
function safeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') || /[\x00-\x1f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('INVALID_ARCHIVE_PATH');
  return name;
}
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.collections) || !Array.isArray(value.files)) throw new Error('INVALID_ARCHIVE');
  const names = new Set();
  for (const collection of value.collections) {
    safeName(collection.name);
    if (collection.name.includes('/') || names.has(collection.name) || !Array.isArray(collection.documents) || new Set(collection.documents.map(row => JSON.stringify(row._id))).size !== collection.documents.length) throw new Error('INVALID_COLLECTION');
    names.add(collection.name);
  }
  const paths = new Set();
  for (const file of value.files) {
    safeName(file.key);
    const content = Buffer.from(file.base64, 'base64');
    if (paths.has(file.key) || content.length !== file.bytes || sha256(content) !== file.sha256) throw new Error('FILE_CHECKSUM_FAILED');
    paths.add(file.key);
  }
  return value;
}
function encode(value, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('INVALID_PASSWORD');
  validate(value);
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > MAX) throw new Error('BACKUP_TOO_LARGE');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('IMC-EXPORT:1'));
  const payload = Buffer.concat([cipher.update(zlib.gzipSync(raw)), cipher.final()]);
  key.fill(0);
  return Buffer.from(JSON.stringify({ format: 'IMC-EXPORT', version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), payload: payload.toString('base64') }));
}
function decode(buffer, password) {
  if (buffer.length > MAX * 2 || typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('INVALID_ARCHIVE');
  const value = JSON.parse(buffer);
  const salt = Buffer.from(value.salt || '', 'base64'), iv = Buffer.from(value.iv || '', 'base64'), tag = Buffer.from(value.tag || '', 'base64');
  if (value.format !== 'IMC-EXPORT' || value.version !== 1 || salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || typeof value.payload !== 'string') throw new Error('INVALID_ARCHIVE');
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('IMC-EXPORT:1')); cipher.setAuthTag(tag);
  let raw;
  try { raw = Buffer.concat([cipher.update(Buffer.from(value.payload, 'base64')), cipher.final()]); }
  finally { key.fill(0); }
  return validate(JSON.parse(zlib.gunzipSync(raw, { maxOutputLength: MAX })));
}
function json(value) {
  return JSON.stringify(value, function (key, item) {
    const original = this[key];
    return original instanceof Date ? { $date: original.toISOString() } : item;
  });
}
module.exports = { encode, decode, validate, sha256, safeName, json };
