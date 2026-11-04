const policy = require('./sharing-policy');
module.exports = async function sharingHome(db, access, id, clock = Date.now) {
  const actor = await access.readMember(db, id);
  if (!policy.active(actor)) return [];
  const now = clock(), rows = [];
  const filter = { teamId: 'IMC', archived: db.command.neq(true), reviewState: db.command.neq('approved'), startMs: db.command.lte(now),
    ...(!policy.reviewer(actor) ? { assigneeIds: id } : {}) };
  for (let offset = 0; ; offset += 100) {
    const result = await db.collection('sharingTasks').where(filter).orderBy('weekStart', 'desc').orderBy('_id', 'desc').skip(offset).limit(100).get();
    rows.push(...result.data);
    if (result.data.length < 100) break;
  }
  const member = await access.readMember(db, id);
  if (!policy.active(member)) return [];
  return rows.filter(row => !row.archived && (policy.assignedIds(row).includes(id) || policy.reviewer(member) && (row.reviewState === 'pending' || row.endMs <= now)))
    .map(row => ({ id: row._id, sharingTaskId: row._id, title: row.weekStart + ' 每周分享', type: row.reviewState === 'pending' && policy.reviewer(member) ? '分享审批' : '分享值班',
      statusLabel: row.reviewState === 'pending' ? '待审批' : policy.status(row, now) === 'incomplete' ? '未完成' : '待完成', createdMs: row.startMs }));
};
