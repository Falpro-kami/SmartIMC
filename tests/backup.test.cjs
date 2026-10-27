const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const archive = require('../scripts/lib/backup-archive.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imc-backup-test-'));
  t.after(() => {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'imc-backup-test-'))) throw Error('Unsafe test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'backup');
  fs.mkdirSync(directory);
  const key = crypto.randomBytes(32);
  const writer = archive.writer(directory, key);
  const document = { _id: 'record', name: 'private-name-测试', date: { $date: { $numberLong: '1792999072726' } }, number: '00809485' };
  const image = Buffer.from([0, 1, 2, 255]);
  writer.put('database/equipment.json', JSON.stringify([document]));
  writer.put('storage/avatars/example.jpg', image);
  writer.finish({ envId: 'test', collections: [{ name: 'equipment', path: 'database/equipment.json', count: 1 }], cloudFiles: [{ key: 'avatars/example.jpg' }] });
  return { root, directory, key, document, image };
}
test('encrypted backup recovers exact document types, leading zeroes and file bytes without a cloud connection', t => {
  const value = fixture(t);
  for (const file of fs.readdirSync(value.directory)) {
    assert.equal(fs.readFileSync(path.join(value.directory, file)).includes(Buffer.from('private-name-测试')), false);
  }
  const output = path.join(value.root, 'restored');
  archive.restore(value.directory, value.key, output);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'database/equipment.json'), 'utf8')), [value.document]);
  assert.deepEqual(fs.readFileSync(path.join(output, 'storage/avatars/example.jpg')), value.image);
  assert.throws(() => archive.restore(value.directory, value.key, output), /already exists/);
});
test('a wrong key, corrupt blob or missing blob fails before recovery writes any plaintext', t => {
  const value = fixture(t);
  assert.throws(() => archive.verify(value.directory, crypto.randomBytes(32)));
  const blob = path.join(value.directory, '000001.bin');
  const bytes = fs.readFileSync(blob); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(blob, bytes);
  const output = path.join(value.root, 'untrusted');
  assert.throws(() => archive.restore(value.directory, value.key, output));
  assert.equal(fs.existsSync(output), false);
  fs.unlinkSync(blob);
  assert.throws(() => archive.verify(value.directory, value.key));
});
test('authenticated but malformed manifests cannot escape the recovery folder or silently lose rows', t => {
  const value = fixture(t);
  const file = path.join(value.directory, 'manifest.imc');
  const valid = JSON.parse(archive.unseal(fs.readFileSync(file), value.key));
  const bad = structuredClone(valid); bad.entries[0].name = '../outside.json';
  fs.writeFileSync(file, archive.seal(Buffer.from(JSON.stringify(bad)), value.key));
  assert.throws(() => archive.verify(value.directory, value.key), /Invalid archive path/);
  valid.collections[0].count = 2;
  fs.writeFileSync(file, archive.seal(Buffer.from(JSON.stringify(valid)), value.key));
  assert.throws(() => archive.verify(value.directory, value.key), /count or identity mismatch/);
});
test('backup rejects duplicate paths, path traversal and replacement keys for existing backups', t => {
  const value = fixture(t);
  for (const name of ['/absolute', '../parent', 'C:/secret', 'folder\\file', 'a/./b', 'a//b']) assert.throws(() => archive.relativeName(name));
  const write = archive.writer(value.directory, value.key);
  assert.throws(() => write.put('../leak', 'private'));
  const another = path.join(value.root, 'another'); fs.mkdirSync(another);
  const duplicate = archive.writer(another, value.key);
  duplicate.put('same.json', '{}');
  assert.throws(() => duplicate.put('same.json', '{}'), /Duplicate/);
  const keyPath = path.join(value.root, 'key');
  assert.throws(() => archive.loadKey(keyPath), /missing/);
});
