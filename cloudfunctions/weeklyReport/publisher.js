const { createHash } = require('node:crypto');
const sync = require('./sync');
const key = (prefix, value) => prefix + createHash('sha256').update(value).digest('hex').slice(0, 32);
const doc = result => Array.isArray(result.data) ? result.data[0] : result.data;
module.exports = function publisher(db, access, clock = Date.now) {
  return async function publishDue() {
    const now = clock(), rows = [];
    for (let offset = 0; ; offset += 100) {
      const batch = (await db.collection('weeklyPeriods').where({ teamId: 'IMC', status: 'scheduled', publishAtMs: db.command.lte(now) })
        .orderBy('publishAtMs', 'asc').orderBy('_id', 'asc').skip(offset).limit(100).get()).data;
      rows.push(...batch); if (batch.length < 100) break;
    }
    let published = 0, blocked = 0;
    for (const candidate of rows) {
      const value = await db.runTransaction(async tx => {
        const ref = tx.collection('weeklyPeriods').doc(candidate._id), p = doc(await ref.get());
        if (!p || p.teamId !== 'IMC' || p.status !== 'scheduled' || p.publishAtMs > now) return 'skipped';
        const actor = doc(await tx.collection('teamMembers').doc(p.updatedBy).get());
        if (!access.allowed(actor, 'weekly.manage')) {
          if (p.publishError !== '发布人已失去周报管理权限') await ref.update({ data: { publishError: '发布人已失去周报管理权限' } });
          return 'blocked';
        }
        const messageId = key('msg_', 'weekly:' + p._id + ':scheduled-publish');
        const existingMessage = doc(await tx.collection('teamMessages').doc(messageId).get());
        const recipients = [];
        for (const person of p.roster.filter(r => !r.exempt)) {
          const member = doc(await tx.collection('teamMembers').doc(person.id).get());
          if (access.allowed(member, 'weekly.read.own')) recipients.push(person.id);
        }
        if (!existingMessage && recipients.length) await tx.collection('teamMessages').doc(messageId).set({ data: {
          teamId: 'IMC', kind: 'weekly', recipientKey: recipients, subjectId: p._id, title: '周报待提交', body: p.title,
          createdMs: now, state: 'open', readBy: []
        } });
        await ref.update({ data: { status: 'open', publishedMs: now, publishError: '', updatedMs: now, revision: p.revision + 1 } });
        await tx.collection('weeklyAudit').doc(key('wa_', 'scheduled-publish:' + p._id)).set({ data: {
          teamId: 'IMC', actorId: p.updatedBy, action: 'period.scheduledPublish', subjectId: p._id, createdMs: now, scheduledMs: p.publishAtMs
        } });
        await sync.bump(tx, ['home', 'weekly', 'messages']);
        return 'published';
      });
      const outcome = value && value.result || value;
      if (outcome === 'published') published++; else if (outcome === 'blocked') blocked++;
    }
    return { ok: true, published, blocked };
  };
};
