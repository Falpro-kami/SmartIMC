const { randomUUID } = require('node:crypto');
const source = require('./roster-source.json');
const policy = require('./policy');
const sync = require('./sync');
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
const clean = name => String(name || '').normalize('NFKC').replace(/\s/g, '');
module.exports = (db, authorize, clock = Date.now) => {
  async function preview(id) {
    if (!policy.manager(await authorize(id))) policy.reject('FORBIDDEN', '仅高创可以导入和维护值班表。');
    const names = new Map();
    for (let offset = 0; ; offset += 100) {
      const members = (await db.collection('teamMembers').where({ teamId: 'IMC', status: 'active' }).orderBy('_id', 'asc').skip(offset).limit(100).get()).data;
      const profiles = members.length ? (await db.collection('userProfiles').where({ _id: db.command.in(members.map(member => member._id)) }).limit(100).get()).data : [];
      for (const profile of profiles) { const key = clean(profile.name); if (!names.has(key)) names.set(key, []); names.get(key).push(profile._id); }
      if (members.length < 100) break;
    }
    if (!policy.manager(await authorize(id))) policy.reject('FORBIDDEN', '值班表维护权限已失效。');
    return { ok: true, source: source.source, sha256: source.sha256, weeks: source.weeks.map(row => ({ ...row,
      assignees: row.assigneeNames.map(name => { const ids = names.get(clean(name)) || []; return { name, memberId: ids.length === 1 ? ids[0] : '', status: ids.length === 1 ? 'matched' : ids.length ? 'ambiguous' : 'missing' }; }) })) };
  }
  async function importRoster(id, event) {
    const plan = await preview(id);
    if (event.sha256 !== source.sha256) policy.reject('CONFLICT', '排班来源已变化，请重新预览后导入。');
    let created = 0, skipped = 0;
    const unboundNames = new Set();
    for (const entry of plan.weeks) {
      const result = await db.runTransaction(async tx => {
        if (!policy.manager(await authorize(id, tx))) policy.reject('FORBIDDEN', '仅高创可以维护值班表。');
        const taskId = 'sh_' + entry.weekStart.replace(/-/g, ''), ref = tx.collection('sharingTasks').doc(taskId);
        if (document(await ref.get())) return { created: false, unbound: [] };
        const ids = [], unbound = [];
        for (const person of entry.assignees) {
          const member = person.memberId && document(await tx.collection('teamMembers').doc(person.memberId).get());
          const profile = person.memberId && document(await tx.collection('userProfiles').doc(person.memberId).get());
          if (policy.active(member) && clean(profile && profile.name) === clean(person.name)) ids.push(person.memberId);
          else unbound.push(person.name);
        }
        const dates = policy.week(entry.weekStart), now = clock(), historical = now >= dates.endMs;
        const data = { teamId: 'IMC', weekStart: entry.weekStart, ...dates, reminderMs: dates.startMs + 9 * 3600000,
          assigneeId: ids[0] || '', assigneeIds: ids, assigneeName: entry.assigneeNames.join('、'), assigneeNames: entry.assigneeNames,
          unboundNames: unbound, revision: 1, reviewState: 'none', submission: null, assignmentVersion: 1,
          initialNotified: historical, midweekNotified: historical, endNotified: historical,
          createdMs: now, updatedMs: now, updatedBy: id, source: source.source, sourceRange: entry.sourceRange, sourceHash: source.sha256 };
        data.nextReminderMs = policy.nextReminder(data, now);
        await ref.set({ data });
        await tx.collection('sharingAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', taskId, actorId: id, action: 'import', sourceHash: source.sha256, createdMs: now } });
        await sync.bump(tx, ['home', 'weekly', 'approvals']);
        return { created: true, unbound };
      });
      const outcome = result && result.result || result;
      if (outcome.created) created++; else skipped++;
      outcome.unbound.forEach(name => unboundNames.add(name));
    }
    return { ok: true, created, skipped, unboundNames: Array.from(unboundNames) };
  }
  return { preview, import: importRoster };
};
