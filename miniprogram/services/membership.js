const access = require('./access');
const profiles = require('./profile');
let state = { phase: 'checking', approved: false, error: '' };
let pending = null;
let submitting = false;
let epoch = 0;
const subscribers = new Set();
function publish(value) { state = value; for (const listener of subscribers) listener(state); return state; }
function accept(result) {
  const member = result && result.member;
  const approved = !!(member && member.teamId === 'IMC' && member.status === 'active' && access.can(member, 'equipment.read'));
  let phase = approved ? 'active' : member ? member.status : 'apply';
  if (!approved && phase === 'active') phase = 'disabled';
  if (!['active', 'apply', 'pending', 'disabled', 'removed'].includes(phase) || (member && member.teamId !== 'IMC')) phase = 'disabled';
  return publish({ phase, approved, error: '' });
}
function check() {
  if (pending) return pending;
  const request = ++epoch;
  publish({ phase: 'checking', approved: false, error: '' });
  pending = Promise.resolve().then(() => access.get()).then(result => request === epoch ? accept(result) : state)
    .catch(error => request === epoch ? publish({ phase: 'error', approved: false, error: error.message || '身份验证失败，请重试。' }) : state)
    .finally(() => { pending = null; });
  return pending;
}
async function submit(value) {
  if (submitting || state.phase !== 'apply') return state;
  submitting = true;
  const request = ++epoch;
  try {
    await profiles.save(value);
    const result = await access.apply();
    return request === epoch ? accept(result) : state;
  } catch (error) {
    // A lost response can hide a committed application; recover its actual state before retrying.
    try {
      const result = await access.get();
      if (request === epoch && result.member) return accept(result);
    } catch (_) { /* Preserve the original save/application error. */ }
    throw error;
  } finally { submitting = false; }
}
function subscribe(listener) { subscribers.add(listener); listener(state); return () => subscribers.delete(listener); }
module.exports = { check, accept, submit, subscribe, current: () => state };
