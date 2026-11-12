const test = require('node:test');
const assert = require('node:assert/strict');
const createDatabase = require('./helpers/memory-db');
const createSharing = require('../cloudfunctions/weeklySharing/service');
const createReminders = require('../cloudfunctions/weeklySharing/reminders');
const policy = require('../cloudfunctions/weeklySharing/policy');
const access = require('../cloudfunctions/weeklySharing/access');
const createMessages = require('../cloudfunctions/memberAccess/messages');
const sharingApprovals = require('../cloudfunctions/memberAccess/sharing-approvals');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const uid = value => 'user_' + String(value).repeat(32);
const OWNER = uid(1), GAO = policy.REVIEWER_ID, OTHER = uid(3), ADMIN = uid(4), SUPER = uid(5);
const tid = 'sh_20261102', weekStart = '2026-11-02';
const timestamp = value => Date.parse(value + '+08:00');
function fixture() {
  let now = timestamp('2026-11-02T08:00:00');
  const member = roles => ({ teamId: 'IMC', status: 'active', roles, revision: 0 });
  const db = createDatabase({
    teamMembers: { [OWNER]: member([]), [GAO]: member(['academic_admin']), [OTHER]: member([]), [ADMIN]: member(['academic_admin']), [SUPER]: member(['super_admin']) },
    userProfiles: { [OWNER]: { name: '值班同学' }, [GAO]: { name: '高创' } },
    teamSync: { IMC: { home: 'h', messages: 'm', approvals: 'a', weekly: 'w', members: 'u' } }
  });
  const bytes = Buffer.from('%PDF-1.7\nprivate sharing content'), files = new Map(), coverFiles = new Map();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64');
  let copies = 0, onSlice;
  const storage = { read: async path => path.endsWith('.png') ? image : bytes, freeze: async buffer => { const id = 'server-owned-' + ++copies; files.set(id, Buffer.from(buffer)); return id; },
    slice: async (id, offset, length) => { if (onSlice) await onSlice(); return files.get(id).subarray(offset, offset + length); } };
  const cloud = { deleteFile: async () => ({}) };
  const service = createSharing(db, cloud, access, () => now, storage);
  const call = (id, action, data = {}) => service.dispatch(id, { ...data, action });
  const get = (id = OWNER) => call(id, 'get', { taskId: tid });
  const schedule = () => call(GAO, 'saveTask', { weekStart, assigneeId: OWNER, reminderTime: '09:00', revision: 0 });
  const upload = async (owner = OWNER) => {
    const prepared = await call(owner, 'prepareUpload', { taskId: tid, name: 'secret-slides.pdf', size: bytes.length });
    const fileID = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/' + prepared.cloudPath;
    return (await call(owner, 'finishUpload', { fileId: prepared.id, fileID })).file;
  };
  const cover = async (owner = OWNER) => {
    if (coverFiles.has(owner)) return coverFiles.get(owner);
    const prepared = await call(owner, 'prepareUpload', { taskId: tid, name: 'cover.png', kind: 'cover', size: image.length });
    const fileID = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/' + prepared.cloudPath;
    const file = (await call(owner, 'finishUpload', { fileId: prepared.id, fileID })).file;
    coverFiles.set(owner, file); return file;
  };
  const submit = async (file, requestId = 'a'.repeat(32)) => call(OWNER, 'submit', { taskId: tid, revision: (await get()).task.revision,
    title: 'private-title', note: 'private-note', coverFileId: (await cover()).id, fileIds: [file.id], requestId });
  const review = async (decision, comment = '') => {
    const row = (await get(GAO)).task;
    return call(GAO, 'review', { taskId: tid, revision: row.revision, version: row.submission.version, decision, comment });
  };
  return { db, call, get, schedule, upload, cover, submit, review, reminders: createReminders(db, () => now),
    setTime: value => { now = timestamp(value); }, revokeOnSlice: fn => { onSlice = fn; }, member };
}
const forbidden = promise => assert.rejects(promise, error => error.businessCode === 'FORBIDDEN');

test('首页仅展示已审批分享的标题和封面，未公开内容对所有角色都不进入轮播', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(), cover = await f.cover();
  await f.submit(file);
  for (const id of [OWNER, GAO, OTHER, SUPER]) assert.equal((await f.call(id, 'previews')).items.length, 0);
  assert.equal((await f.get(OTHER)).task.submission, undefined);
  await forbidden(f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: cover.id, offset: 0 }));
  assert.equal((await f.call(GAO, 'downloadChunk', { taskId: tid, fileId: cover.id, offset: 0 })).complete, true);
  await f.review('rejected', '完善内容');
  assert.equal((await f.call(OWNER, 'previews')).items.length, 0);
  await f.submit(file, 'b'.repeat(32)); await f.review('approved');
  f.setTime('2026-12-01T09:00:00');
  const items = (await f.call(OTHER, 'previews')).items;
  assert.equal(items.length, 1); assert.equal(items[0].title, 'private-title'); assert.equal(items[0].cover.id, cover.id);
  assert.equal(items[0].type, 'sharing');
  for (const key of ['assigneeIds', 'assigneeName', 'weekStart', 'note', 'fileID', 'path', 'sha256']) assert.equal(items[0][key], undefined);
  for (const key of ['fileID', 'path', 'sha256']) assert.equal(items[0].cover[key], undefined);
  assert.equal((await f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: cover.id, offset: 0 })).file.ext, 'png');
  assert.equal((await f.get(OTHER)).task.canViewSchedule, false);
});

test('封面必须是本任务上传人的图片，不能拿搭档封面或图片充当附件', async () => {
  const f = fixture();
  await f.call(GAO, 'saveTask', { weekStart, assigneeIds: [OWNER, OTHER], reminderTime: '09:00', revision: 0 });
  const file = await f.upload(), own = await f.cover(), partner = await f.cover(OTHER);
  const data = { taskId: tid, title: '主题', note: '', revision: 1, fileIds: [file.id], requestId: 'a'.repeat(32) };
  await assert.rejects(f.call(OWNER, 'submit', data), error => error.businessCode === 'INVALID_INPUT');
  await forbidden(f.call(OWNER, 'submit', { ...data, coverFileId: partner.id }));
  await forbidden(f.call(OWNER, 'submit', { ...data, coverFileId: file.id }));
  await forbidden(f.call(OWNER, 'submit', { ...data, coverFileId: own.id, fileIds: [own.id] }));
  const stored = f.db.rows('sharingFiles').find(row => row._id === own.id);
  f.db.put('sharingFiles', own.id, { ...stored, taskId: 'sh_20261109' });
  await forbidden(f.call(OWNER, 'submit', { ...data, coverFileId: own.id }));
});

test('封面上传校验格式与大小，并沿用负责人权限及成员撤销检查', async () => {
  const f = fixture(); await f.schedule();
  await forbidden(f.call(GAO, 'prepareUpload', { taskId: tid, kind: 'cover', name: 'cover.png', size: 68 }));
  for (const data of [{ name: 'cover.svg', size: 50 }, { name: 'cover.png', size: 2 * 1024 * 1024 + 1 }, { name: 'cover.pdf', size: 50 }]) {
    await assert.rejects(f.call(OWNER, 'prepareUpload', { taskId: tid, kind: 'cover', ...data }), error => error.businessCode === 'INVALID_FILE');
  }
  const malformed = await f.call(OWNER, 'prepareUpload', { taskId: tid, kind: 'cover', name: 'fake.jpg', size: Buffer.byteLength('%PDF-1.7\nprivate sharing content') });
  await assert.rejects(f.call(OWNER, 'finishUpload', { fileId: malformed.id, fileID: 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/' + malformed.cloudPath }), error => error.businessCode === 'INVALID_FILE');
  const file = await f.upload(), cover = await f.cover(); await f.submit(file); await f.review('approved');
  f.revokeOnSlice(() => f.db.put('teamMembers', OTHER, { teamId: 'IMC', status: 'removed', roles: [] }));
  await assert.rejects(f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: cover.id, offset: 0 }), error => error.businessCode === 'MEMBERSHIP_REQUIRED');
  await assert.rejects(f.call(OTHER, 'previews'), error => error.businessCode === 'MEMBERSHIP_REQUIRED');
});

test('轮播只取最近四条已通过内容，旧内容无封面仍可读取且不返回排班信息', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file); await f.review('approved');
  const base = f.db.rows('sharingTasks')[0];
  for (let i = 0; i < 7; i++) {
    const weekStart = new Date(Date.parse('2026-11-09T00:00:00Z') + i * 7 * policy.DAY).toISOString().slice(0, 10);
    f.db.put('sharingTasks', 'sh_' + weekStart.replace(/-/g, ''), { ...base, weekStart, ...policy.week(weekStart), updatedMs: i,
      submission: { ...base.submission, title: '历史分享' + i, cover: null }, archived: i === 6 });
  }
  const result = await f.call(OTHER, 'previews');
  assert.equal(result.items.length, 4); assert.equal(result.items[0].title, '历史分享5');
  assert.equal(result.items[0].cover, null);
});

test('封面图片尺寸有上限，拒绝伪装格式与超大像素图片', () => {
  const covers = require('../cloudfunctions/weeklySharing/cover');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64');
  assert.equal(covers.valid(image, 'png'), true); assert.equal(covers.valid(image, 'jpg'), false);
  const huge = Buffer.from(image); huge.writeUInt32BE(8193, 16); assert.equal(covers.valid(huge, 'png'), false);
  huge.writeUInt32BE(8000, 16); huge.writeUInt32BE(8000, 20); assert.equal(covers.valid(huge, 'png'), false);
  assert.equal(covers.valid(Buffer.from('<svg/>'), 'png'), false);
});

function seedScopedWeeks(f) {
  const base = f.db.rows('sharingTasks')[0];
  for (let i = -1; i < 30; i++) {
    const value = new Date(Date.parse('2026-11-02T00:00:00Z') + i * 7 * policy.DAY).toISOString().slice(0, 10);
    f.db.put('sharingTasks', 'sh_' + value.replace(/-/g, ''), { ...base, weekStart: value, ...policy.week(value),
      assigneeId: i === 0 || i === 15 ? OWNER : OTHER, assigneeIds: [i === 0 || i === 15 ? OWNER : OTHER] });
  }
}
test('非高创排班在数据库分页前限制为本周、下周及本人全部周次，超级管理员也不例外', async () => {
  const f = fixture(); await f.schedule(); seedScopedWeeks(f);
  const own = await f.call(OWNER, 'list', {});
  assert.equal(own.tasks.length, 3); assert.equal(own.hasMore, false);
  assert.deepEqual(own.tasks.map(row => row.weekStart), ['2027-02-15', '2026-11-09', '2026-11-02']);
  for (const id of [ADMIN, SUPER]) assert.equal((await f.call(id, 'list', {})).tasks.length, 2);
  const all = await f.call(GAO, 'list', {});
  assert.equal(all.tasks.length, 20); assert.equal(all.hasMore, true);
  assert.equal((await f.call(GAO, 'list', { offset: 20 })).tasks.length, 11);
  await forbidden(f.call(SUPER, 'get', { taskId: 'sh_20261116' }));
});
test('日历月份和指定周筛选不能绕过排班范围，支持本人跨年的安排', async () => {
  const f = fixture(); await f.schedule(); seedScopedWeeks(f);
  assert.equal((await f.call(OWNER, 'list', { weekStart: '2026-11-16' })).tasks.length, 0);
  assert.equal((await f.call(OWNER, 'list', { month: '2027-02' })).tasks[0].weekStart, '2027-02-15');
  assert.equal((await f.call(ADMIN, 'list', { month: '2027-02' })).tasks.length, 0);
  assert.equal((await f.call(GAO, 'list', { month: '2027-02' })).tasks.length, 6);
  assert.equal((await f.call(OWNER, 'list', { mine: true })).tasks.length, 2);
  await assert.rejects(f.call(OWNER, 'list', { month: '2026-13' }), error => error.businessCode === 'INVALID_INPUT');
});
test('排班周范围在北京时间周一零点更新，跨年时保持正确', () => {
  assert.equal(new Date(policy.weekWindow(timestamp('2026-11-08T23:59:59')).startMs + 8 * 3600000).toISOString().slice(0, 10), '2026-11-02');
  assert.equal(new Date(policy.weekWindow(timestamp('2026-11-09T00:00:00')).startMs + 8 * 3600000).toISOString().slice(0, 10), '2026-11-09');
  const member = { ...fixture().member([]), _id: OWNER };
  const next = { ...policy.week('2027-01-04'), assigneeIds: [OTHER] };
  assert.equal(policy.canViewSchedule(next, OWNER, member, timestamp('2027-01-03T23:59:59')), true);
  assert.equal(policy.canViewSchedule({ ...policy.week('2027-01-11'), assigneeIds: [OTHER] }, OWNER, member, timestamp('2027-01-03T23:59:59')), false);
});
test('公开分享仍可通过内容链接查看，隐藏范围之外的排班人员与提醒数据', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file); await f.review('approved');
  f.setTime('2026-11-09T09:00:00');
  const shared = await f.get(OTHER);
  assert.equal(shared.task.submission.title, 'private-title');
  assert.equal(shared.task.canViewSchedule, false);
  for (const key of ['weekStart', 'endDate', 'assigneeId', 'assigneeIds', 'assigneeName', 'assigneeNames', 'reminderMs']) assert.equal(shared.task[key], undefined);
  assert.equal((await f.call(OTHER, 'list', {})).tasks.length, 0);
  assert.equal((await f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: file.id, offset: 0 })).complete, true);
});

test('高创可调整未提交的历史排班并安排补交，已发逾期提醒不重复发送', async () => {
  const f = fixture(); await f.schedule();
  f.setTime('2026-11-09T09:00:00'); await f.reminders();
  assert.equal((await f.get(GAO)).task.canEdit, true);
  await forbidden(f.get(OTHER));
  const revision = (await f.get()).task.revision;
  await f.call(GAO, 'saveTask', { taskId: tid, weekStart, assigneeIds: [OWNER, OTHER], reminderTime: '09:00', revision });
  await f.reminders();
  assert.equal(f.db.rows('teamMessages').filter(row => row.title === '每周分享未完成').length, 1);
  const file = await f.upload(); await f.submit(file); await f.review('approved');
  assert.equal((await f.get()).task.status, 'completed');
});

test('仅高创可归档逾期任务：保留未完成、移出待办及默认列表，支持幂等恢复', async () => {
  const f = fixture(); await f.schedule();
  const archive = (id = GAO, archived = true, revision = 1) => f.call(id, 'setArchived', { taskId: tid, revision, archived });
  await assert.rejects(archive(), error => error.businessCode === 'LOCKED');
  f.setTime('2026-11-09T09:00:00'); await f.reminders();
  const sharingHome = require('../cloudfunctions/memberAccess/sharing-home');
  const home = id => sharingHome(f.db, access, id, () => timestamp('2026-11-09T09:00:00'));
  assert.equal((await home(GAO)).length, 1);
  for (const id of [OWNER, OTHER, ADMIN, SUPER]) await forbidden(archive(id));
  await assert.rejects(archive(GAO, true, 9), error => error.businessCode === 'CONFLICT');
  const result = await archive(); await archive();
  assert.equal(result.task.status, 'incomplete');
  assert.equal(result.task.archived, true);
  assert.equal(result.task.canRestore, true);
  assert.equal((await f.get()).task.canUpload, false);
  assert.equal((await home(GAO)).length, 0);
  assert.equal((await home(OWNER)).length, 0);
  assert.equal((await f.call(OWNER, 'list', { filter: 'all' })).tasks.length, 0);
  assert.equal((await f.call(OWNER, 'list', { filter: 'archived' })).tasks.length, 1);
  assert.equal(f.db.rows('teamMessages').filter(row => row.state === 'open').length, 0);
  assert.equal(f.db.rows('sharingTasks')[0].nextReminderMs, policy.NEVER);
  assert.equal(f.db.rows('sharingAudit').filter(row => row.action === 'archive').length, 1);
  await forbidden(f.upload());
  await assert.rejects(f.call(GAO, 'saveTask', { taskId: tid, weekStart, assigneeId: OWNER, reminderTime: '09:00', revision: 2 }), error => error.businessCode === 'ARCHIVED');
  await archive(GAO, false, 2); await archive(GAO, false, 2);
  assert.equal((await f.get()).task.canUpload, true);
  assert.equal((await home(GAO)).length, 1);
  assert.equal(f.db.rows('sharingAudit').filter(row => row.action === 'restore').length, 1);
});

test('归档不能跳过审批，驳回后归档仍保持私密内容隔离', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  f.setTime('2026-11-09T09:00:00');
  const archive = () => f.call(GAO, 'setArchived', { taskId: tid, revision: f.db.rows('sharingTasks')[0].revision, archived: true });
  await assert.rejects(archive(), error => error.businessCode === 'LOCKED');
  await f.review('rejected', '需要补充'); await archive();
  assert.equal((await f.get(OWNER)).task.submission.title, 'private-title');
  await forbidden(f.get(OTHER));
  assert.equal((await f.get(OWNER)).task.canUpload, false);
  const approved = fixture(); await approved.schedule(); const approvedFile = await approved.upload(); await approved.submit(approvedFile); await approved.review('approved');
  approved.setTime('2026-11-09T09:00:00');
  await assert.rejects(approved.call(GAO, 'setArchived', { taskId: tid, revision: (await approved.get()).task.revision, archived: true }), error => error.businessCode === 'LOCKED');
});

test('归档审计写入失败时回滚任务、提醒及待办状态', async () => {
  const f = fixture(); await f.schedule(); f.setTime('2026-11-09T09:00:00'); await f.reminders();
  f.db.failNextWrite('sharingAudit');
  await assert.rejects(f.call(GAO, 'setArchived', { taskId: tid, revision: 1, archived: true }));
  assert.equal((await f.get(GAO)).task.archived, false);
  assert.equal((await f.get()).task.canUpload, true);
  assert.equal(f.db.rows('teamMessages')[0].state, 'open');
});
test('只有高创角色可维护值班表，日期必须是北京时间周一', async () => {
  const f = fixture();
  for (const id of [OWNER, OTHER, ADMIN, SUPER]) await forbidden(f.call(id, 'saveTask', { weekStart, assigneeId: OWNER, reminderTime: '09:00', revision: 0 }));
  await assert.rejects(f.call(GAO, 'saveTask', { weekStart: '2026-11-03', assigneeId: OWNER, reminderTime: '09:00', revision: 0 }), error => error.businessCode === 'INVALID_INPUT');
  await f.schedule();
  await assert.rejects(f.schedule(), error => error.businessCode === 'CONFLICT');
});
test('审批前的详情和文件只允许上传人和高创读取，审批通过后公开', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  for (const id of [OTHER, ADMIN, SUPER]) {
    const result = await f.get(id);
    assert.equal(result.task.canRead, false);
    assert.equal(result.task.submission, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-title|private-note|secret-slides|server-owned/);
    await forbidden(f.call(id, 'downloadChunk', { taskId: tid, fileId: file.id, offset: 0 }));
    await forbidden(f.call(id, 'review', { taskId: tid, revision: result.task.revision, version: 1, decision: 'approved' }));
  }
  for (const id of [OWNER, GAO]) {
    const result = await f.get(id);
    assert.equal(result.task.submission.title, 'private-title');
    assert.doesNotMatch(JSON.stringify(result), /server-owned/);
    const chunk = await f.call(id, 'downloadChunk', { taskId: tid, fileId: file.id, offset: 0 });
    assert.match(Buffer.from(chunk.data, 'base64').toString(), /private sharing content/);
  }
  await f.review('approved');
  assert.equal((await f.get(OTHER)).task.status, 'completed');
  assert.equal((await f.get(OTHER)).task.submission.title, 'private-title');
  await f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: file.id, offset: 0 });
  await forbidden(f.upload());
});
test('提交和审批可安全重试，驳回后重新提交必须重新审批且拒绝旧版本', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  const first = (await f.get()).task;
  await f.submit(file);
  assert.equal((await f.get()).task.revision, first.revision);
  assert.equal(f.db.rows('teamMessages').filter(row => /待审批/.test(row.title)).length, 1);
  await f.review('rejected', '请补充内容');
  assert.equal((await f.get()).task.canUpload, true);
  await f.submit(file, 'b'.repeat(32));
  await assert.rejects(f.call(GAO, 'review', { taskId: tid, revision: first.revision, version: 1, decision: 'approved' }), error => error.businessCode === 'CONFLICT');
  const current = (await f.get(GAO)).task;
  const request = { taskId: tid, revision: current.revision, version: 2, decision: 'approved', comment: '' };
  await Promise.all([f.call(GAO, 'review', request), f.call(GAO, 'review', request)]);
  assert.equal(f.db.rows('sharingAudit').filter(row => row.action === 'approved').length, 1);
  assert.equal((await f.get()).task.status, 'completed');
});
test('下载过程中撤销成员权限会中止传输', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file); await f.review('approved');
  f.revokeOnSlice(() => f.db.put('teamMembers', OTHER, { teamId: 'IMC', status: 'disabled', roles: [] }));
  await assert.rejects(f.call(OTHER, 'downloadChunk', { taskId: tid, fileId: file.id, offset: 0 }), error => error.businessCode === 'MEMBERSHIP_REQUIRED');
});
test('周一提醒、周三24点再次提醒和周结束通知均按北京时间执行且不重复', async () => {
  const f = fixture(); await f.schedule();
  await f.reminders(); assert.equal(f.db.rows('teamMessages').length, 0);
  f.setTime('2026-11-02T09:00:00'); await f.reminders(); await f.reminders(); assert.equal(f.db.rows('teamMessages').length, 1);
  f.setTime('2026-11-04T23:59:59'); await f.reminders(); assert.equal(f.db.rows('teamMessages').length, 1);
  f.setTime('2026-11-05T00:00:00'); await f.reminders(); await f.reminders(); assert.equal(f.db.rows('teamMessages').length, 2);
  f.setTime('2026-11-08T23:59:59'); assert.equal((await f.get()).task.status, 'pending');
  f.setTime('2026-11-09T00:00:00'); assert.equal((await f.get()).task.status, 'incomplete');
  await f.reminders(); await f.reminders();
  const messages = f.db.rows('teamMessages');
  assert.equal(messages.length, 3); assert.equal(messages[2].recipientKey, 'role:sharing_reviewer');
  assert.match(messages[2].title, /未完成/);
});
test('已上传待审批任务不发送缺更提醒，只有通过后才显示已完成', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  f.setTime('2026-11-05T00:00:00'); await f.reminders();
  assert.equal(f.db.rows('teamMessages').length, 1);
  assert.equal((await f.get()).task.status, 'pending');
  f.setTime('2026-11-09T00:00:00'); await f.reminders();
  assert.equal(f.db.rows('teamMessages').length, 1);
  assert.equal((await f.get()).task.status, 'incomplete');
  assert.equal((await f.get()).task.reviewState, 'pending');
  await f.review('approved'); await f.reminders(); assert.equal((await f.get()).task.status, 'completed');
});
test('错过定时执行会补发当前阶段提醒，写入失败回滚后可重试', async () => {
  const f = fixture(); await f.schedule(); f.setTime('2026-11-05T06:00:00');
  f.db.failNextWrite('teamSync');
  await assert.rejects(f.reminders());
  assert.equal(f.db.rows('teamMessages').length, 0);
  await f.reminders(); await f.reminders();
  assert.equal(f.db.rows('teamMessages').length, 1);
  assert.match(f.db.rows('teamMessages')[0].title, /更新提醒/);
});
test('成员、审批人和管理员看到的审批及消息范围各自隔离', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  const list = sharingApprovals(f.db, access), messages = createMessages(f.db, access);
  assert.equal((await list(GAO, { scope: 'pending' })).requests.length, 1);
  assert.equal((await list(SUPER, { scope: 'pending' })).ok, false);
  assert.equal((await list(OTHER, { scope: 'mine' })).requests.length, 0);
  assert.equal((await list(OWNER, { scope: 'mine' })).requests.length, 1);
  assert.equal((await messages.list(GAO, {})).messages.length, 1);
  assert.equal((await messages.list(SUPER, {})).messages.length, 0);
  const messageId = f.db.rows('teamMessages')[0]._id;
  assert.equal((await messages.open(SUPER, { id: messageId })).ok, false);
  assert.equal((await messages.open(GAO, { id: messageId })).url, '/pages/module/index?id=weekly-sharing&task=' + tid);
  await f.review('approved');
  assert.equal((await list(GAO, { scope: 'done' })).requests[0].statusLabel, '已通过');
});
test('禁止跨任务附件与伪造上传路径；值班修改受版本控制', async () => {
  const f = fixture(); await f.schedule();
  const prepared = await f.call(OWNER, 'prepareUpload', { taskId: tid, name: 'test.pdf', size: 10 });
  await forbidden(f.call(OTHER, 'finishUpload', { fileId: prepared.id, fileID: 'forged' }));
  await forbidden(f.call(OWNER, 'finishUpload', { fileId: prepared.id, fileID: 'forged' }));
  await assert.rejects(f.call(OWNER, 'submit', { taskId: tid, revision: 1, title: 'title', note: '', coverFileId: (await f.cover()).id, fileIds: [prepared.id], requestId: 'c'.repeat(32) }), error => error.businessCode === 'FORBIDDEN');
  const existing = f.db.rows('sharingTasks')[0];
  f.db.put('sharingTasks', tid, { ...existing, submission: null });
  await f.call(GAO, 'saveTask', { taskId: tid, weekStart, assigneeId: OTHER, reminderTime: '09:30', revision: 1 });
  await forbidden(f.upload());
});
test('过滤按任务状态分页且列表不暴露私密内容', async () => {
  const f = fixture(); await f.schedule(); const file = await f.upload(); await f.submit(file);
  const pending = await f.call(OTHER, 'list', { filter: 'pending' });
  assert.equal(pending.tasks.length, 1);
  assert.equal(pending.tasks[0].submission, undefined);
  assert.equal((await f.call(OTHER, 'list', { filter: 'completed' })).tasks.length, 0);
  await f.review('approved');
  assert.equal((await f.call(OTHER, 'list', { filter: 'completed' })).tasks.length, 1);
  assert.equal((await f.call(OTHER, 'list', { filter: 'pending' })).tasks.length, 0);
  assert.equal(policy.manager(f.member(['academic_admin'])), false);
});
test('成员管理拒绝旧角色，学术管理员身份仅给原授权账号保留分享权限', async () => {
  const f = fixture();
  f.db.put('teamSecurity', 'IMC', { superAdminIds: [SUPER], sharingReviewerId: GAO });
  const filename = require.resolve('../cloudfunctions/memberAccess/index');
  const localRequire = createRequire(filename), exports = {};
  const sdk = { init() {}, database: () => f.db, getWXContext: () => ({}) };
  const requireWithFixtures = name => name === 'wx-server-sdk' ? sdk : name === './access' ? { ...access, identity: () => SUPER } : localRequire(name);
  new Function('require', 'exports', fs.readFileSync(filename, 'utf8'))(requireWithFixtures, exports);
  const assign = (id, roles, revision) => exports.main({ action: 'set', id, roles, revision, status: 'active' });
  assert.equal((await assign(OTHER, ['sharing_reviewer'], 0)).code, 'INVALID_INPUT');
  assert.equal((await assign(GAO, ['sharing_reviewer'], 0)).code, 'INVALID_INPUT');
  assert.equal((await assign(GAO, [], 0)).ok, true);
  assert.equal(policy.reviewer(f.db.rows('teamMembers').find(row => row._id === GAO)), false);
  assert.equal((await assign(OTHER, ['academic_admin'], 0)).ok, true);
  assert.equal(policy.reviewer(f.db.rows('teamMembers').find(row => row._id === OTHER)), false);
  assert.equal((await assign(GAO, ['academic_admin'], 1)).ok, true);
  assert.equal(policy.reviewer(f.db.rows('teamMembers').find(row => row._id === GAO)), true);
  assert.equal(policy.reviewer({ ...f.member(['sharing_reviewer']), _id: GAO }), false);
  assert.equal(f.db.rows('teamSecurity')[0].sharingReviewerId, GAO);
});
test('双人共同值班：两人收到提醒、仅一份提交，未审批内容对搭档保密', async () => {
  const f = fixture();
  await f.call(GAO, 'saveTask', { weekStart, assigneeIds: [OWNER, OTHER], reminderTime: '09:00', revision: 0 });
  assert.equal((await f.get(OTHER)).task.canUpload, true);
  assert.equal((await f.call(OTHER, 'list', { mine: true })).tasks.length, 1);
  f.setTime('2026-11-02T09:00:00'); await f.reminders();
  const recipients = f.db.rows('teamMessages')[0].recipientKey;
  assert.deepEqual(recipients, [OWNER, OTHER]);
  const file = await f.upload(); await f.submit(file);
  assert.equal((await f.get(OTHER)).task.submission, undefined);
  assert.equal((await f.get(OTHER)).task.canUpload, false);
  await f.review('rejected', '请补充');
  assert.equal((await f.get(OTHER)).task.canUpload, false);
  assert.equal((await f.get(OWNER)).task.canUpload, true);
  await f.submit(file, 'b'.repeat(32)); await f.review('approved');
  assert.equal((await f.get(OTHER)).task.status, 'completed');
});
test('双人同时提交时仅首份提交成功，避免覆盖搭档文件', async () => {
  const f = fixture();
  await f.call(GAO, 'saveTask', { weekStart, assigneeIds: [OWNER, OTHER], reminderTime: '09:00', revision: 0 });
  const file1 = await f.upload(), file2 = await f.upload(OTHER);
  const cover1 = await f.cover(), cover2 = await f.cover(OTHER);
  const submit = (id, file, requestId) => f.call(id, 'submit', { taskId: tid, revision: 1, title: '分享', note: '', coverFileId: id === OWNER ? cover1.id : cover2.id, fileIds: [file.id], requestId });
  const results = await Promise.allSettled([submit(OWNER, file1, 'a'.repeat(32)), submit(OTHER, file2, 'b'.repeat(32))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.db.rows('sharingAudit').filter(row => row.action === 'submit').length, 1);
});
test('仅高创可导入14周排班，缺少账号保留待绑定且重复导入不覆盖', async () => {
  const f = fixture();
  f.db.put('userProfiles', OWNER, { name: '敖家俊' }); f.db.put('userProfiles', OTHER, { name: '罗杰文' });
  for (const id of [OWNER, OTHER, ADMIN, SUPER]) await forbidden(f.call(id, 'roster'));
  const plan = await f.call(GAO, 'roster'); assert.equal(plan.weeks.length, 14);
  const result = await f.call(GAO, 'importRoster', { sha256: plan.sha256 });
  assert.equal(result.created, 14); assert.ok(result.unboundNames.includes('李潇'));
  assert.deepEqual((await f.get()).task.assigneeIds, [OWNER, OTHER]);
  assert.equal((await f.get(OTHER)).task.canUpload, true);
  const historical = f.db.rows('sharingTasks').find(row => row._id === 'sh_20261026');
  assert.equal(historical.endNotified, true); assert.equal(historical.nextReminderMs, policy.NEVER);
  const repeated = await f.call(GAO, 'importRoster', { sha256: plan.sha256 });
  assert.equal(repeated.created, 0); assert.equal(repeated.skipped, 14);
  assert.equal(f.db.rows('sharingTasks').length, 14);
});
test('高创绑定在同一事务中保留超级管理员配置、补齐审计并刷新权限', async () => {
  const f = fixture(), bind = require('../cloudfunctions/weeklySharing/reviewer-binding');
  f.db.put('teamSecurity', 'IMC', { superAdminIds: [SUPER] });
  await forbidden(bind(f.db, SUPER));
  await bind(f.db, GAO); await bind(f.db, GAO);
  assert.equal(f.db.rows('teamSecurity')[0].sharingReviewerId, GAO);
  assert.deepEqual(f.db.rows('teamSecurity')[0].superAdminIds, [SUPER]);
  assert.equal(f.db.rows('memberAudit').length, 1);
});
