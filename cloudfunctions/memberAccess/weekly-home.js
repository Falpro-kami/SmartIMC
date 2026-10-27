module.exports = async function weeklyTodos(db, id) {
  const periods = [];
  for (let offset = 0; ; offset += 100) {
    const rows = (await db.collection('weeklyPeriods').where({ teamId: 'IMC', status: 'open' }).orderBy('_id', 'asc').skip(offset).limit(100).get()).data;
    periods.push(...rows);
    if (rows.length < 100) break;
  }
  const reports = new Map();
  for (let offset = 0; offset < periods.length; offset += 100) {
    const rows = (await db.collection('weeklyReports').where({ teamId: 'IMC', ownerId: id,
      periodId: db.command.in(periods.slice(offset, offset + 100).map(p => p._id)) }).limit(100).get()).data;
    rows.forEach(r => reports.set(r.periodId, r));
  }
  const todos = [];
  for (const p of periods) {
    const person = p.roster.find(r => r.id === id);
    if (!person || person.exempt || Date.now() < Date.parse(p.startDate + 'T00:00:00+08:00') || (Date.now() > p.deadlineMs && !p.allowLateSubmit)) continue;
    const report = reports.get(p._id);
    if (report && report.status === 'submitted') continue;
    todos.push({ id: p._id, periodId: p._id, title: p.title, type: '周报提交', statusLabel: report ? '草稿' : '未提交', createdMs: p.deadlineMs });
  }
  return todos.sort((a, b) => a.createdMs - b.createdMs);
};
