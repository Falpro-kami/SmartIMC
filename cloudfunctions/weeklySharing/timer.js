const { randomUUID } = require('node:crypto');
const HEALTH_ID = 'weekly-sharing-reminders';
module.exports = (db, reminders, clock = Date.now) => async function runTimer() {
  const ref = db.collection('sharingAudit').doc(HEALTH_ID);
  await ref.set({ data: { teamId: 'IMC', action: 'timer.health', runId: randomUUID(), state: 'running', startedMs: clock() } });
  try {
    const result = await reminders();
    await ref.update({ data: { state: 'success', finishedMs: clock(), processed: result.processed } });
    return result;
  } catch (error) {
    await ref.update({ data: { state: 'failed', finishedMs: clock(), errorCode: String(error.errCode || error.code || 'SHARING_TIMER_FAILED').slice(0, 120) } }).catch(() => {});
    throw error;
  }
};
module.exports.HEALTH_ID = HEALTH_ID;
