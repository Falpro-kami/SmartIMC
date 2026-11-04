const policy = require('./policy');
const notices = require('./notifications');
const sync = require('./sync');
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
module.exports = function reminders(db, clock = Date.now) {
  async function process(taskId) {
    await db.runTransaction(async tx => {
      const ref = tx.collection('sharingTasks').doc(taskId), row = document(await ref.get()), now = clock();
      if (!row || row.teamId !== 'IMC' || row.nextReminderMs > now) return;
      const next = { ...row };
      const ids = policy.assignedIds(row), recipients = [];
      for (const id of ids) if (policy.active(document(await tx.collection('teamMembers').doc(id).get()))) recipients.push(id);
      const recipientKey = recipients.length === 1 ? recipients[0] : recipients;
      const missingMember = recipients.length !== ids.length || !!(row.unboundNames || []).length;
      const cycle = row.assignmentVersion;
      if (policy.approved(row)) next.endNotified = true;
      else if (now >= row.endMs) {
        if (policy.needsUpdate(row)) await notices.send(tx, row, 'missing', 'role:sharing_reviewer', '每周分享未完成', row.weekStart + ' 当周值班人员尚未提交有效更新，请查看任务。', now);
        next.endNotified = true;
      } else if (policy.needsUpdate(row) && now >= row.midweekMs && !row.midweekNotified) {
        if (recipients.length) await notices.send(tx, row, 'midweek:' + cycle, recipientKey, '每周分享更新提醒', '已过周三24:00，' + row.weekStart + ' 当周的分享尚未更新，请及时上传并提交审批。', now);
        if (missingMember) await notices.send(tx, row, 'inactive:' + cycle, 'role:sharing_reviewer', '每周分享负责人需调整', row.weekStart + ' 当周的负责人账号未绑定或已失效，请调整值班表。', now);
        next.initialNotified = next.midweekNotified = true;
      } else if (policy.needsUpdate(row) && now >= row.reminderMs && !row.initialNotified) {
        if (recipients.length) await notices.send(tx, row, 'initial:' + cycle, recipientKey, '本周分享值班提醒', '本周由你们共同负责更新每周分享，请在周三24:00前上传并提交审批。', now);
        if (missingMember) await notices.send(tx, row, 'inactive:' + cycle, 'role:sharing_reviewer', '每周分享负责人需调整', row.weekStart + ' 当周的负责人账号未绑定或已失效，请调整值班表。', now);
        next.initialNotified = true;
      }
      await ref.update({ data: { initialNotified: next.initialNotified, midweekNotified: next.midweekNotified,
        endNotified: next.endNotified, nextReminderMs: policy.nextReminder(next, now) } });
      await sync.bump(tx, ['messages', 'home', 'weekly']);
    });
  }
  return async function run() {
    let processed = 0;
    const started = Date.now();
    // The cursor is stored on each task; bounded batches resume on the next timer invocation.
    for (let batch = 0; batch < 5; batch++) {
      const rows = (await db.collection('sharingTasks').where({ teamId: 'IMC', nextReminderMs: db.command.lte(clock()) }).orderBy('nextReminderMs', 'asc').limit(20).get()).data;
      if (!rows.length) break;
      for (const row of rows) {
        if (Date.now() - started > 45000) return { ok: true, processed };
        await process(row._id); processed++;
      }
    }
    return { ok: true, processed };
  };
};
