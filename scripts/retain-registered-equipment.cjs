// User-authorized migration: keep the 128 source rows, remove the other sheet's 7 devices.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execute } = require('./cloudbase.cjs');
const expected = JSON.parse(fs.readFileSync('.local/equipment-import.json', 'utf8'));
const report = JSON.parse(fs.readFileSync('.local/equipment-import-report.json', 'utf8'));
assert.equal(expected.length, 128);
assert.ok(expected.every(record => record.ledger === 'registered'));
assert.equal(report.incompleteRecords, 2);
assert.equal(report.excludedUnregisteredIds.length, 7);

const current = [];
for (let offset = 0; ; offset += 50) {
  const batch = execute({ find: 'equipment', filter: {}, sort: { _id: 1 }, skip: offset, limit: 50, batchSize: 50 });
  assert.ok(Array.isArray(batch));
  current.push(...batch);
  if (batch.length < 50) break;
}
const byId = new Map(current.map(record => [record._id, record]));
const allowed = new Set(expected.map(record => record._id).concat(report.excludedUnregisteredIds));
assert.ok(current.every(record => allowed.has(record._id)), 'Unexpected records present; migration stopped.');
const missing = expected.filter(record => !byId.has(record._id));
assert.ok(missing.every(record => !record.name && !record.equipmentNumber && record.inventoryNumber),
  'An existing complete device is missing; migration stopped.');
for (const record of expected) {
  if (!byId.has(record._id)) continue;
  for (const [key, value] of Object.entries(record)) {
    assert.deepEqual(byId.get(record._id)[key], value, `Existing record differs: ${record._id}.${key}`);
  }
}
const toDelete = current.filter(record => report.excludedUnregisteredIds.includes(record._id));
assert.ok(toDelete.every(record => record.ledger === 'unregistered' && record.sourceHash === expected[0].sourceHash));
fs.mkdirSync('.local', { recursive: true });
fs.writeFileSync(`.local/equipment-before-128-${Date.now()}.json`, JSON.stringify(current, null, 2), { flag: 'wx' });
if (missing.length) {
  const [result] = execute({ insert: 'equipment', documents: missing, ordered: true }, 'INSERT');
  assert.equal(result.ok, 1);
  assert.ok(!result.writeErrors || result.writeErrors.length === 0);
  assert.equal(result.n, missing.length);
}
if (toDelete.length) {
  const [result] = execute({ delete: 'equipment', deletes: [{ q: {
    _id: { $in: toDelete.map(record => record._id) }, ledger: 'unregistered', sourceHash: expected[0].sourceHash
  }, limit: 0 }] }, 'DELETE');
  assert.equal(result.ok, 1);
  assert.equal(result.n, toDelete.length);
}
const [count] = execute({ count: 'equipment', query: {} });
assert.equal(count.n, 128);
const [excluded] = execute({ count: 'equipment', query: { ledger: 'unregistered' } });
assert.equal(excluded.n, 0);
console.log(`Kept 128 records; inserted ${missing.length} incomplete source rows; deleted ${toDelete.length} unregistered devices. Backup saved locally.`);
