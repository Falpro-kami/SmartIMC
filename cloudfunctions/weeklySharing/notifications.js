const { createHash } = require('node:crypto');
const key = value => 'msg_' + createHash('sha256').update(value).digest('hex').slice(0, 32);
const messageId = (task, event) => key('sharing:' + task._id + ':' + event);
async function send(tx, task, event, recipientKey, title, body, now) {
  const ref = tx.collection('teamMessages').doc(messageId(task, event));
  const existing = await ref.get();
  if (Array.isArray(existing.data) ? existing.data.length : existing.data) return;
  await ref.set({ data: { teamId: 'IMC', recipientKey, kind: 'sharing', subjectId: task._id,
    title, body, createdMs: now, state: 'open', readBy: [] } });
}
async function resolve(tx, task, event) {
  const ref = tx.collection('teamMessages').doc(messageId(task, event));
  const result = await ref.get();
  if (Array.isArray(result.data) ? result.data.length : result.data) await ref.update({ data: { state: 'resolved' } });
}
module.exports = { send, resolve };
