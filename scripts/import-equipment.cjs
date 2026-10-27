const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execute } = require('./cloudbase.cjs');

const records = JSON.parse(fs.readFileSync('.local/equipment-import.json', 'utf8'));
const verifyOnly = process.argv.includes('--verify-only');

function count() {
  const [result] = execute({ count: 'equipment', query: {} });
  assert.equal(result.ok, 1, 'Count failed');
  return result.n;
}

if (!verifyOnly) {
  if (count() !== 0) throw new Error('equipment 集合已有数据，停止导入以避免覆盖。可用 --verify-only 验证。');
  for (let offset = 0; offset < records.length; offset += 40) {
    const batch = records.slice(offset, offset + 40);
    const [result] = execute({ insert: 'equipment', documents: batch, ordered: true }, 'INSERT');
    assert.equal(result.ok, 1);
    assert.ok(!result.writeErrors || result.writeErrors.length === 0, 'Insert errors');
    assert.equal(result.n, batch.length);
    console.log(`Imported ${Math.min(offset + batch.length, records.length)}/${records.length}`);
  }
}

assert.equal(count(), records.length, 'Record count mismatch');
for (let offset = 0; offset < records.length; offset += 50) {
  const batch = records.slice(offset, offset + 50);
  const actual = execute({ find: 'equipment', filter: { _id: { $in: batch.map(item => item._id) } },
    limit: 50, batchSize: 50 });
  assert.ok(Array.isArray(actual), 'Invalid query response');
  assert.equal(actual.length, batch.length);
  const byId = new Map(actual.map(item => [item._id, item]));
  for (const expected of batch) {
    const found = byId.get(expected._id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(found[key], value, `${expected._id}.${key}`);
  }
}
console.log(`Verified all ${records.length} records and every imported field against the workbook extract.`);
