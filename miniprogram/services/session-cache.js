// Memory only. Membership/role changes clear the whole cache; no business data is persisted to disk.
const values = new Map();
const pending = new Map();
let generation = 0;
const subscribers = new Map();
const prefixes = { home: ['home:'], messages: ['access:messages'], approvals: ['access:approvals:'],
  weekly: ['weekly:'], members: ['access:list:', 'access:directory:'] };
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
function subscribe(channel, listener) {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(listener);
  return () => subscribers.get(channel).delete(listener);
}
function publish(channels) {
  const unique = Array.from(new Set(channels));
  for (const channel of unique) for (const prefix of prefixes[channel] || []) invalidate(prefix);
  const listeners = new Set();
  for (const channel of unique) for (const listener of subscribers.get(channel) || []) listeners.add(listener);
  for (const listener of listeners) listener(unique);
}
module.exports = { load, peek, subscribe, publish, set: (key, value) => values.set(key, { value, time: Date.now() }), invalidate, clear: () => invalidate() };
