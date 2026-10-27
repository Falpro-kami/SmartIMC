function document(result) { return Array.isArray(result.data) ? result.data[0] : result.data; }
function milliseconds(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value.$date || value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}
module.exports = function approvals(db, access, messages) {
  const decided = row => row.before && row.before.status === 'pending' && row.after && ['active', 'disabled'].includes(row.after.status);
  const outcome = status => status === 'active' ? '已通过' : status === 'disabled' ? '未通过' : status === 'removed' ? '已终止' : '待审批';
  async function list(id, event) {
    const { scope } = event;
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!['mine', 'pending', 'done'].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) {
      return { ok: false, code: 'INVALID_INPUT', message: '申请与审批参数不正确。' };
    }
    const actor = await access.readMember(db, id);
    if (scope !== 'mine' && !access.allowed(actor, 'members.manage')) {
      return { ok: false, code: 'FORBIDDEN', message: '当前账号没有成员审批权限。' };
    }
    if (scope === 'mine') {
      if (offset) return { ok: true, requests: [], nextOffset: offset, hasMore: false };
      const application = document(await db.collection('teamMessages').doc(messages.applicationId(id)).get());
      if (!application || application.teamId !== access.TEAM_ID || application.subjectId !== id || application.kind !== 'member_application') {
        return { ok: true, requests: [], nextOffset: 0, hasMore: false };
      }
      // Read the actual decision: later role or membership changes are not a new application result.
      let decision;
      let skip = 0;
      do {
        const result = await db.collection('memberAudit').where({ targetId: id }).orderBy('createdAt', 'asc').orderBy('_id', 'asc').skip(skip).limit(100).get();
        decision = result.data.find(decided);
        if (decision || result.data.length < 100) break;
        skip += result.data.length;
      } while (true);
      const status = decision ? decision.after.status : actor && actor.status === 'removed' ? 'removed' : 'pending';
      return { ok: true, requests: [{ id: application._id, title: '加入 IMC', type: '成员入组',
        statusLabel: outcome(status), statusTone: status === 'active' ? 'success' : ['disabled', 'removed'].includes(status) ? 'rejected' : 'pending',
        createdMs: application.createdMs || 0 }], nextOffset: 1, hasMore: false };
    }
    const pending = scope === 'pending';
    let query = db.collection(pending ? 'teamMembers' : 'memberAudit')
      .where(pending ? { teamId: access.TEAM_ID, status: 'pending' } : { actorId: id })
      .orderBy(pending ? '_id' : 'createdAt', pending ? 'asc' : 'desc');
    if (!pending) query = query.orderBy('_id', 'desc');
    const result = await query.skip(offset).limit(51).get();
    const page = result.data.slice(0, 50);
    const rows = pending ? page : page.filter(decided);
    // Legacy audits have no team field, so also check their targets belong to this team.
    const targets = !pending && rows.length ? (await db.collection('teamMembers').where({ _id: db.command.in(rows.map(row => row.targetId)), teamId: access.TEAM_ID }).limit(50).get()).data : [];
    const teamIds = new Set(targets.map(row => row._id));
    const visible = pending ? rows : rows.filter(row => teamIds.has(row.targetId));
    const ids = visible.map(row => pending ? row._id : row.targetId);
    const profiles = ids.length ? (await db.collection('userProfiles').where({ _id: db.command.in(ids) }).limit(50).get()).data : [];
    const names = new Map(profiles.map(row => [row._id, row.name || '-']));
    if (!access.allowed(await access.readMember(db, id), 'members.manage')) {
      return { ok: false, code: 'FORBIDDEN', message: '当前账号没有成员审批权限。' };
    }
    return { ok: true, requests: visible.map(row => ({ id: row._id,
      title: names.get(pending ? row._id : row.targetId) || '-', type: '成员入组',
      ...(pending ? { memberId: row._id } : {}), statusLabel: pending ? '待审批' : outcome(row.after.status),
      statusTone: pending ? 'pending' : row.after.status === 'active' ? 'success' : 'rejected',
      createdMs: milliseconds(row.createdAt) })), nextOffset: offset + page.length, hasMore: result.data.length > 50 };
  }
  return { list };
};
