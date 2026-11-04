const policy = require('./sharing-policy');
module.exports = (db, access) => async function sharingApprovals(id, event) {
  const offset = event.offset === undefined ? 0 : event.offset, scope = event.scope;
  if (!['mine', 'pending', 'done'].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: 'INVALID_INPUT', message: '审批参数不正确。' };
  const actor = await access.readMember(db, id);
  if (!policy.active(actor) || scope !== 'mine' && !policy.reviewer(actor)) return { ok: false, code: 'FORBIDDEN', message: '没有分享审批权限。' };
  const done = scope === 'done';
  const filter = done ? { teamId: 'IMC', actorId: id, action: db.command.in(['approved', 'rejected']) } :
    { teamId: 'IMC', ...(scope === 'mine' ? { 'submission.ownerId': id } : { reviewState: 'pending' }) };
  const result = await db.collection(done ? 'sharingAudit' : 'sharingTasks').where(filter)
    .orderBy(done ? 'createdMs' : 'weekStart', 'desc').orderBy('_id', 'desc').skip(offset).limit(51).get();
  const member = await access.readMember(db, id);
  if (!policy.active(member) || scope !== 'mine' && !policy.reviewer(member)) return { ok: false, code: 'FORBIDDEN', message: '分享审批权限已变化。' };
  const rows = result.data.slice(0, 50);
  return { ok: true, requests: rows.map(row => {
    const state = done ? row.action : row.reviewState;
    return { id: row._id, sharingTaskId: done ? row.taskId : row._id,
      title: done ? '每周分享 · 第' + row.version + '次提交' : row.weekStart + ' 每周分享', type: '每周分享',
      statusLabel: { approved: '已通过', rejected: '已驳回', pending: '待审批' }[state] || '待提交',
      statusTone: state === 'approved' ? 'success' : state === 'rejected' ? 'rejected' : 'pending',
      createdMs: done ? row.createdMs : row.submission && row.submission.submittedMs || 0 };
  }), nextOffset: offset + rows.length, hasMore: result.data.length > 50 };
};
