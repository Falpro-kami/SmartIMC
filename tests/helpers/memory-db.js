const clone = value => structuredClone(value);
const get = (row, key) => key.split('.').reduce((value, part) => value && value[part], row);
const operation = (op, value) => ({ op, value });
function matches(actual, expected) {
  if (!expected || typeof expected !== 'object' || !expected.op) return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
  const { op, value } = expected;
  if (op === 'and') return value.every(condition => matches(actual, condition));
  if (op === 'in') return Array.isArray(actual) ? actual.some(item => value.includes(item)) : value.includes(actual);
  if (op === 'nin') return Array.isArray(actual) ? actual.every(item => !value.includes(item)) : !value.includes(actual);
  if (op === 'neq') return actual !== value;
  if (op === 'lte') return actual <= value;
  if (op === 'lt') return actual < value;
  if (op === 'gt') return actual > value;
  if (op === 'gte') return actual >= value;
  throw new Error('Unsupported query operation: ' + op);
}
module.exports = function memoryDatabase(seed = {}) {
  let tables = clone(seed), queue = Promise.resolve(), failTable = '';
  const db = {
    command: Object.fromEntries(['in', 'nin', 'neq', 'lt', 'lte', 'gt', 'gte', 'addToSet', 'and', 'or'].map(op => [op, value => operation(op, value)])),
    serverDate: () => new Date(),
    rows: table => Object.entries(tables[table] || {}).map(([id, row]) => ({ ...clone(row), _id: id })),
    put(table, id, data) { tables[table] ||= {}; tables[table][id] = clone(data); },
    failNextWrite(table) { failTable = table; },
    collection(table) {
      const query = (filter = {}, orders = [], offset = 0, limit = 100, fields = null) => ({
        where: next => query(next, orders, offset, limit, fields),
        orderBy: (key, direction) => query(filter, orders.concat({ key, direction }), offset, limit, fields),
        skip: next => query(filter, orders, next, limit, fields),
        limit: next => query(filter, orders, offset, next, fields),
        field: next => query(filter, orders, offset, limit, next),
        async get() {
          const matchesRow = (row, condition) => condition.op === 'and' ? condition.value.every(item => matchesRow(row, item)) :
            condition.op === 'or' ? condition.value.some(item => matchesRow(row, item)) :
            Object.entries(condition).every(([key, expected]) => matches(get(row, key), expected));
          let rows = db.rows(table).filter(row => matchesRow(row, filter));
          rows.sort((left, right) => { for (const order of orders) { const a = get(left, order.key), b = get(right, order.key); if (a !== b) return (a < b ? -1 : 1) * (order.direction === 'desc' ? -1 : 1); } return 0; });
          rows = rows.slice(offset, offset + limit);
          if (fields) rows = rows.map(row => Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [key, row[key]])));
          return { data: rows };
        }
      });
      const write = () => { if (failTable === table) { failTable = ''; throw new Error('Injected database write failure'); } };
      return { ...query(), doc(id) { return {
        async get() { const data = tables[table] && tables[table][id]; return { data: data ? { ...clone(data), _id: id } : null }; },
        async set({ data }) { write(); db.put(table, id, data); return { _id: id }; },
        async update({ data }) {
          write();
          const row = tables[table] && tables[table][id];
          if (!row) return { updated: 0 };
          for (const [key, value] of Object.entries(data)) row[key] = value && value.op === 'addToSet' ? Array.from(new Set([...(row[key] || []), value.value])) : clone(value);
          return { updated: 1 };
        }
      }; } };
    },
    runTransaction(callback) {
      const next = queue.then(async () => {
        const before = clone(tables);
        try { return await callback(db); } catch (error) { tables = before; throw error; }
      });
      queue = next.catch(() => {});
      return next;
    }
  };
  return db;
};
