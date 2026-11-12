const DAY = 86400000;
const NEVER = Number.MAX_SAFE_INTEGER;
const REVIEWER_ID = 'user_1db996e0b87233a509a73b4bd6434874';
const active = member => !!member && member.teamId === 'IMC' && member.status === 'active';
// Private submissions require an explicitly assigned reviewer, including for super administrators.
const reviewer = member => active(member) && (member._id || member.id) === REVIEWER_ID && (member.roles || []).includes('academic_admin');
const manager = reviewer;
function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
function week(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) reject('INVALID_INPUT', '请选择值班周的周一。');
  const startMs = Date.parse(value + 'T00:00:00+08:00');
  if (!Number.isFinite(startMs) || new Date(startMs + 8 * 3600000).toISOString().slice(0, 10) !== value || new Date(startMs + 8 * 3600000).getUTCDay() !== 1) reject('INVALID_INPUT', '值班周必须从周一开始。');
  return { startMs, midweekMs: startMs + 3 * DAY, endMs: startMs + 7 * DAY };
}
const approved = task => !!task.submission && task.submission.state === 'approved';
const assignedIds = task => Array.isArray(task.assigneeIds) ? task.assigneeIds : task.assigneeId ? [task.assigneeId] : [];
const assignedNames = task => Array.isArray(task.assigneeNames) ? task.assigneeNames : [task.assigneeName || '-'];
function weekWindow(now) {
  const local = new Date(now + 8 * 3600000);
  const startMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - ((local.getUTCDay() + 6) % 7) * DAY - 8 * 3600000;
  return { startMs, nextStartMs: startMs + 7 * DAY };
}
const canViewSchedule = (task, id, member, now) => {
  if (!active(member)) return false;
  const window = weekWindow(now);
  return reviewer(member) || assignedIds(task).includes(id) || task.startMs === window.startMs || task.startMs === window.nextStartMs;
};
const needsUpdate = task => !task.submission || task.submission.state === 'rejected';
const status = (task, now) => approved(task) ? 'completed' : now >= task.endMs ? 'incomplete' : 'pending';
const canRead = (task, id, member) => active(member) && !!task.submission && (approved(task) || task.submission.ownerId === id || reviewer(member));
const canUpload = (task, id, member, now) => active(member) && !task.archived && assignedIds(task).includes(id) && now >= task.startMs &&
  (!task.submission || task.submission.state === 'rejected' && task.submission.ownerId === id);
function nextReminder(task, now) {
  if (task.archived || approved(task) || task.endNotified) return NEVER;
  if (now >= task.endMs) return task.endMs;
  if (needsUpdate(task)) {
    if (!task.midweekNotified && now >= task.midweekMs) return task.midweekMs;
    if (!task.initialNotified) return task.reminderMs;
    if (!task.midweekNotified) return task.midweekMs;
  }
  return task.endMs;
}
const fileView = file => ({ id: file.id || file._id, name: file.name, size: file.size, ext: file.ext });
function present(task, id, member, now, detail = false) {
  const readable = canRead(task, id, member), scheduleVisible = canViewSchedule(task, id, member, now);
  return { id: task._id, canViewSchedule: scheduleVisible,
    ...(scheduleVisible ? { weekStart: task.weekStart, endDate: new Date(task.endMs - 1 + 8 * 3600000).toISOString().slice(0, 10),
    assigneeId: task.assigneeId || '', assigneeName: assignedNames(task).join('、'), assigneeIds: assignedIds(task), assigneeNames: assignedNames(task),
    unboundNames: task.unboundNames || [], reminderMs: task.reminderMs } : {}), revision: task.revision,
    status: status(task, now), reviewState: task.submission ? task.submission.state : 'none', archived: task.archived === true,
    archivedMs: task.archivedMs || 0,
    canRead: readable, canUpload: canUpload(task, id, member, now), canEdit: manager(member) && !task.archived && !task.submission,
    canArchive: manager(member) && !task.archived && now >= task.endMs && needsUpdate(task),
    canRestore: manager(member) && task.archived === true,
    canReview: reviewer(member) && !!task.submission && task.submission.state === 'pending',
    ...(detail && readable ? { submission: { ownerId: task.submission.ownerId, title: task.submission.title, note: task.submission.note,
      files: task.submission.files.map(fileView), version: task.submission.version, state: task.submission.state,
      cover: task.submission.cover ? fileView(task.submission.cover) : null,
      submittedMs: task.submission.submittedMs, reviewedMs: task.submission.reviewedMs || 0,
      reviewComment: task.submission.reviewComment || '' } } : {}) };
}
module.exports = { DAY, NEVER, REVIEWER_ID, active, reviewer, manager, reject, week, weekWindow, canViewSchedule, assignedIds, assignedNames, approved, needsUpdate, status, canRead, canUpload, nextReminder, fileView, present };
