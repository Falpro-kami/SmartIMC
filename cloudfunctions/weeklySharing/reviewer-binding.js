const policy = require('./policy');
const sync = require('./sync');
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
module.exports = async (db, actorId) => db.runTransaction(async tx => {
  const member = document(await tx.collection('teamMembers').doc(actorId).get());
  if (!policy.reviewer(member)) policy.reject('FORBIDDEN', '仅高创可完成分享权限绑定。');
  const securityRef = tx.collection('teamSecurity').doc('IMC');
  const security = document(await securityRef.get());
  if (!security) throw new Error('Team security is not initialized');
  if (security.sharingReviewerId && security.sharingReviewerId !== actorId) policy.reject('CONFLICT', '分享审批账号绑定已变化。');
  await securityRef.update({ data: { sharingReviewerId: actorId } });
  const auditRef = tx.collection('memberAudit').doc('sharing_reviewer_initial_binding');
  if (!document(await auditRef.get())) await auditRef.set({ data: { actorId, targetId: actorId, action: 'sharing.reviewer.bind',
    before: { status: member.status, roles: member.roles },
    after: { status: member.status, roles: member.roles }, createdAt: db.serverDate() } });
  await sync.bump(tx, ['members', 'home', 'weekly', 'approvals', 'messages']);
  return { ok: true };
});
