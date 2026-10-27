const APP_IDS = ['lab-equipment', 'finance', 'weekly', 'activities', 'ai-challenge', 'approvals', 'leave', 'knowledge', 'weekly-sharing'];
function sanitize(raw = {}) {
  return Object.fromEntries(APP_IDS.map(id => {
    const value = raw && raw[id] || {};
    return [id, { count: Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0,
      lastOpenedMs: Number.isSafeInteger(value.lastOpenedMs) && value.lastOpenedMs >= 0 ? value.lastOpenedMs : 0 }];
  }));
}
module.exports = function workbench(db) {
  async function get(id) {
    const result = await db.collection('workbenchUsage').where({ _id: id }).limit(1).get();
    return { ok: true, usage: sanitize(result.data[0] && result.data[0].stats) };
  }
  async function record(id, event) {
    if (!APP_IDS.includes(event.toolId)) return { ok: false, code: 'INVALID_INPUT', message: '应用不存在。' };
    const result = await db.runTransaction(async transaction => {
      const reference = transaction.collection('workbenchUsage').doc(id);
      const previous = await reference.get();
      const document = Array.isArray(previous.data) ? previous.data[0] : previous.data;
      const stats = sanitize(document && document.stats);
      stats[event.toolId] = { count: Math.min(Number.MAX_SAFE_INTEGER, stats[event.toolId].count + 1), lastOpenedMs: Date.now() };
      await reference.set({ data: { stats, updatedAt: db.serverDate() } });
      return { ok: true, usage: stats };
    });
    return result && result.result || result;
  }
  return { get, record };
};
