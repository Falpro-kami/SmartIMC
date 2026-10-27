// Memory only. Membership/role changes clear the whole cache; no business data is persisted to disk.
const values = new Map();
const pending = new Map();
let generation = 0;
function peek(key) { const entry = values.get(key); return entry ? entry.value : null; }
function load(key, loader, ttl = 60000, force = false) {
  const entry = values.get(key);
  if (!force && entry && Date.now() - entry.time < ttl) return Promise.resolve(entry.value);
  if (pending.has(key)) return pending.get(key);
  const epoch = generation;
  const request = Promise.resolve().then(loader).then(value => {
    if (epoch === generation) values.set(key, { value, time: Date.now() });
    return value;
  }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
function invalidate(prefix = '') {
  generation++;
  for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}
module.exports = { load, peek, set: (key, value) => values.set(key, { value, time: Date.now() }), invalidate, clear: () => invalidate() };
