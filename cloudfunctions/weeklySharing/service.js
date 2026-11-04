const { createHash, randomUUID } = require('node:crypto');
const policy = require('./policy');
const notices = require('./notifications');
const sync = require('./sync');
const covers = require('./cover');
const { reject } = policy;
const PREFIX = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/';
const FILE_LIMIT = 20 * 1024 * 1024, TOTAL_LIMIT = 50 * 1024 * 1024;
const EXTENSIONS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
const validTask = id => typeof id === 'string' && /^sh_20\d{6}$/.test(id);
const validFile = id => typeof id === 'string' && /^sf_[a-f0-9]{32}$/.test(id);
function signature(bytes, ext) {
  if (ext === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (['docx', 'pptx', 'xlsx'].includes(ext)) return bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
  return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
}
module.exports = function sharing(db, cloud, access, clock = Date.now, storage = require('./storage')(cloud)) {
  const read = async (store, table, id) => document(await store.collection(table).doc(id).get());
  async function authorize(id, store = db) {
    const member = await read(store, 'teamMembers', id);
    if (!policy.active(member)) reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能访问。');
    return member;
  }
  async function task(store, id) {
    if (!validTask(id)) reject('INVALID_INPUT', '值班任务参数不正确。');
    const row = await read(store, 'sharingTasks', id);
    if (!row || row.teamId !== 'IMC') reject('NOT_FOUND', '值班任务不存在。');
    return row;
  }
  async function get(id, event) {
    await authorize(id);
    const row = await task(db, event.taskId);
    const member = await authorize(id);
    if (!policy.canViewSchedule(row, id, member, clock()) && !policy.canRead(row, id, member)) reject('FORBIDDEN', '仅可查看本周、下周及本人的值班安排。');
    return { ok: true, task: policy.present(row, id, member, clock(), true), canManage: policy.manager(member), isReviewer: policy.reviewer(member) };
  }
  async function list(id, event) {
    const actor = await authorize(id), manages = policy.manager(actor);
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || !['all', 'pending', 'completed', 'incomplete', 'review', 'archived'].includes(event.filter || 'all')) reject('INVALID_INPUT', '任务筛选参数不正确。');
    const filter = { teamId: 'IMC', archived: event.filter === 'archived' ? true : db.command.neq(true) }, now = clock();
    if (event.weekStart !== undefined) { policy.week(event.weekStart); filter.weekStart = event.weekStart; }
    if (event.month !== undefined) {
      if (typeof event.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(event.month)) reject('INVALID_INPUT', '月份参数不正确。');
      const first = Date.parse(event.month + '-01T00:00:00+08:00');
      const starts = [];
      for (let i = 0, start = policy.weekWindow(first).startMs; i < 6; i++) starts.push(start + i * 7 * policy.DAY);
      filter.startMs = db.command.in(starts);
    }
    if (event.filter === 'completed') filter.reviewState = 'approved';
    if (event.filter === 'review') {
      if (!policy.reviewer(await authorize(id))) reject('FORBIDDEN', '仅分享审批人可以查看待审批任务。');
      filter.reviewState = 'pending';
    }
    if (['pending', 'incomplete'].includes(event.filter)) {
      filter.reviewState = db.command.neq('approved');
      filter.endMs = event.filter === 'pending' ? db.command.gt(now) : db.command.lte(now);
    }
    if (event.mine === true) filter.assigneeIds = id;
    const window = policy.weekWindow(now);
    const scopedFilter = manages ? filter : db.command.and([filter, db.command.or([
      { startMs: db.command.in([window.startMs, window.nextStartMs]) }, { assigneeIds: id }
    ])]);
    const result = await db.collection('sharingTasks').where(scopedFilter).orderBy('weekStart', 'desc').orderBy('_id', 'desc').skip(offset).limit(21).get();
    const member = await authorize(id), rows = result.data.slice(0, 20);
    if (policy.manager(member) !== manages) reject('FORBIDDEN', '排班查看权限已变化，请重新加载。');
    return { ok: true, tasks: rows.map(row => policy.present(row, id, member, clock())),
      canManage: policy.manager(member), isReviewer: policy.reviewer(member), nextOffset: offset + rows.length, hasMore: result.data.length > 20 };
  }
  async function members(id, event) {
    if (!policy.manager(await authorize(id))) reject('FORBIDDEN', '没有维护值班表的权限。');
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '成员参数不正确。');
    const result = await db.collection('teamMembers').where({ teamId: 'IMC', status: 'active' }).orderBy('_id', 'asc').skip(offset).limit(51).get();
    const rows = result.data.slice(0, 50);
    const profiles = rows.length ? (await db.collection('userProfiles').where({ _id: db.command.in(rows.map(row => row._id)) }).limit(50).get()).data : [];
    const names = new Map(profiles.map(row => [row._id, row.name || '-']));
    if (!policy.manager(await authorize(id))) reject('FORBIDDEN', '值班表管理权限已变化。');
    return { ok: true, members: rows.map(row => ({ id: row._id, name: names.get(row._id) || '-' })), nextOffset: offset + rows.length, hasMore: result.data.length > 50 };
  }
  async function previews(id) {
    await authorize(id);
    const result = await db.collection('sharingTasks').where({ teamId: 'IMC', archived: db.command.neq(true), reviewState: 'approved' })
      .orderBy('weekStart', 'desc').orderBy('_id', 'desc').limit(4).get();
    await authorize(id);
    return { ok: true, items: result.data.filter(policy.approved).map(row => ({
      id: row._id, type: 'sharing', title: row.submission.title, publishedMs: row.submission.reviewedMs,
      version: row.submission.version, cover: row.submission.cover ? policy.fileView(row.submission.cover) : null
    })) };
  }
  async function saveTask(id, event) {
    const dates = policy.week(event.weekStart), tid = 'sh_' + event.weekStart.replace(/-/g, '');
    const ids = Array.isArray(event.assigneeIds) ? event.assigneeIds : [event.assigneeId];
    if (!Number.isSafeInteger(event.revision) || event.revision < 0 || (event.taskId && event.taskId !== tid) || !ids.length || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(value => !/^user_[a-f0-9]{32}$/.test(value || '')) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(event.reminderTime || '')) reject('INVALID_INPUT', '请完整填写值班周、1至2名负责人和提醒时间。');
    const [hour, minute] = event.reminderTime.split(':').map(Number), reminderMs = dates.startMs + (hour * 60 + minute) * 60000;
    await db.runTransaction(async tx => {
      const actor = await authorize(id, tx);
      if (!policy.manager(actor)) reject('FORBIDDEN', '没有维护值班表的权限。');
      const names = [];
      for (const assigneeId of ids) {
        const assignee = await read(tx, 'teamMembers', assigneeId), profile = await read(tx, 'userProfiles', assigneeId);
        if (!policy.active(assignee)) reject('INVALID_INPUT', '负责人必须是已审核通过的团队成员。');
        names.push(profile && profile.name || '-');
      }
      const previous = await read(tx, 'sharingTasks', tid);
      if (previous && previous.teamId !== 'IMC') reject('FORBIDDEN', '无法修改此任务。');
      if ((previous ? previous.revision : 0) !== event.revision) reject('CONFLICT', '本周值班表已更新，请重新打开。');
      if (previous && previous.archived) reject('ARCHIVED', '请先恢复跟进，再调整值班安排。');
      if (previous && previous.submission) reject('LOCKED', '已上传内容的任务不能更换负责人或提醒时间。');
      if (!previous && clock() >= dates.endMs) reject('CLOSED', '不能新建已结束周的值班表。');
      const reassigned = previous && JSON.stringify(policy.assignedIds(previous).slice().sort()) !== JSON.stringify(ids.slice().sort());
      const data = { teamId: 'IMC', weekStart: event.weekStart, ...dates, reminderMs, assigneeId: ids[0], assigneeIds: ids,
        assigneeName: names.join('、'), assigneeNames: names, unboundNames: [], revision: event.revision + 1, reviewState: 'none', submission: null,
        initialNotified: !!(previous && !reassigned && previous.initialNotified), midweekNotified: !!(previous && !reassigned && previous.midweekNotified), endNotified: !!(previous && previous.endNotified),
        assignmentVersion: previous ? (previous.assignmentVersion || 1) + (reassigned ? 1 : 0) : 1,
        createdMs: previous ? previous.createdMs : clock(), updatedMs: clock(), updatedBy: id };
      data.nextReminderMs = policy.nextReminder(data, clock());
      await tx.collection('sharingTasks').doc(tid).set({ data });
      if (reassigned && policy.assignedIds(previous).length) await notices.send(tx, { _id: tid }, 'reassigned:' + data.assignmentVersion, policy.assignedIds(previous), '每周分享值班已调整', event.weekStart + ' 当周的值班负责人已调整。', clock());
      await tx.collection('sharingAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', taskId: tid, actorId: id, action: 'schedule', assigneeIds: ids, revision: data.revision, createdMs: clock() } });
      await sync.bump(tx, ['home', 'weekly', 'messages', 'approvals']);
    });
    return get(id, { taskId: tid });
  }
  async function setArchived(id, event) {
    if (typeof event.archived !== 'boolean' || !Number.isSafeInteger(event.revision) || event.revision < 1) reject('INVALID_INPUT', '归档参数不正确。');
    await db.runTransaction(async tx => {
      const actor = await authorize(id, tx);
      if (!policy.manager(actor)) reject('FORBIDDEN', '仅高创可以归档或恢复值班任务。');
      const row = await task(tx, event.taskId);
      if ((row.archived === true) === event.archived) return;
      if (row.revision !== event.revision) reject('CONFLICT', '任务已更新，请重新打开后处理。');
      if (event.archived && (clock() < row.endMs || !policy.needsUpdate(row))) reject('LOCKED', '仅已结束且未提交或需修改的任务可以归档，待审批内容请先完成审批。');
      const next = { ...row, archived: event.archived };
      await tx.collection('sharingTasks').doc(row._id).update({ data: { archived: event.archived,
        archivedMs: event.archived ? clock() : 0, archivedBy: event.archived ? id : '', revision: row.revision + 1,
        updatedMs: clock(), updatedBy: id, nextReminderMs: policy.nextReminder(next, clock()) } });
      if (event.archived) {
        for (const message of ['missing', 'initial:' + row.assignmentVersion, 'midweek:' + row.assignmentVersion, 'inactive:' + row.assignmentVersion]) await notices.resolve(tx, row, message);
      }
      await tx.collection('sharingAudit').doc(randomUUID()).set({ data: { teamId: 'IMC', taskId: row._id, actorId: id,
        action: event.archived ? 'archive' : 'restore', revision: row.revision + 1, createdMs: clock() } });
      await sync.bump(tx, ['home', 'weekly', 'messages', 'approvals']);
    });
    return get(id, event);
  }
  async function uploadable(store, id, tid) {
    const member = await authorize(id, store), row = await task(store, tid);
    if (!policy.canUpload(row, id, member, clock())) reject('FORBIDDEN', '仅当周负责人可上传；待审批或已通过的内容不能修改。');
    return row;
  }
  async function prepareUpload(id, event) {
    const name = typeof event.name === 'string' ? event.name.trim() : '', ext = name.split('.').pop().toLowerCase();
    const kind = event.kind === undefined ? 'document' : event.kind;
    if (!['document', 'cover'].includes(kind)) reject('INVALID_FILE', '请选择分享文件或封面图片。');
    const isCover = kind === 'cover';
    if (!name || name.length > 120 || /[\x00-\x1f/\\]/.test(name) || !(isCover ? covers.EXTENSIONS : EXTENSIONS).includes(ext) || !Number.isSafeInteger(event.size) || event.size < 1 || event.size > (isCover ? covers.LIMIT : FILE_LIMIT)) reject('INVALID_FILE', isCover ? '封面支持 JPG、PNG，大小不超过2MB。' : '支持 PDF、Word、PPT、Excel 文件，单个文件不超过20MB。');
    const fid = 'sf_' + randomUUID().replace(/-/g, ''), path = 'sharing-uploads/' + id + '/' + fid + '.' + ext;
    await db.runTransaction(async tx => {
      const row = await uploadable(tx, id, event.taskId);
      await tx.collection('sharingFiles').doc(fid).set({ data: { teamId: 'IMC', taskId: row._id, ownerId: id,
        name, ext, size: event.size, kind, path, status: 'uploading', createdMs: clock() } });
    });
    return { ok: true, id: fid, cloudPath: path };
  }
  async function finishUpload(id, event) {
    await authorize(id);
    if (!validFile(event.fileId)) reject('INVALID_INPUT', '附件参数不正确。');
    const file = await read(db, 'sharingFiles', event.fileId);
    if (!file || file.teamId !== 'IMC' || file.ownerId !== id || PREFIX + file.path !== event.fileID) reject('FORBIDDEN', '无法使用这份附件。');
    await uploadable(db, id, file.taskId);
    if (file.status === 'ready') return { ok: true, file: policy.fileView(file) };
    if (clock() - file.createdMs > policy.DAY) reject('EXPIRED', '上传已过期，请重新选择文件。');
    const bytes = await storage.read(PREFIX + file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || (file.kind === 'cover' ? !covers.valid(bytes, file.ext) : bytes.length > FILE_LIMIT || !signature(bytes, file.ext))) reject('INVALID_FILE', '文件内容与格式或大小不匹配。');
    const sha256 = createHash('sha256').update(bytes).digest('hex'), fileID = await storage.freeze(bytes, file.ext);
    let retained = false;
    try {
      const result = await db.runTransaction(async tx => {
        await uploadable(tx, id, file.taskId);
        const current = await read(tx, 'sharingFiles', file._id);
        if (!current || current.ownerId !== id || current.path !== file.path) reject('CONFLICT', '附件已变更，请重新上传。');
        if (current.status === 'ready') return false;
        await tx.collection('sharingFiles').doc(file._id).update({ data: { status: 'ready', fileID, sha256 } });
        return true;
      });
      retained = result === true || !!(result && result.result === true);
    } finally {
      if (!retained) await cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
    }
    await cloud.deleteFile({ fileList: [PREFIX + file.path] }).catch(() => {});
    return { ok: true, file: policy.fileView(file) };
  }
  async function submit(id, event) {
    const title = typeof event.title === 'string' ? event.title.trim() : '', note = typeof event.note === 'string' ? event.note.trim() : '';
    if (!title || title.length > 80 || /[\x00-\x1f]/.test(title) || note.length > 3000 || !validFile(event.coverFileId) || !Number.isSafeInteger(event.revision) || !/^[a-f0-9]{32}$/.test(event.requestId || '') || !Array.isArray(event.fileIds) || !event.fileIds.length || event.fileIds.length > 5 || event.fileIds.some(fid => !validFile(fid)) || new Set(event.fileIds).size !== event.fileIds.length) reject('INVALID_INPUT', '请填写分享主题、上传封面及1至5个分享文件。');
    await db.runTransaction(async tx => {
      const member = await authorize(id, tx), row = await task(tx, event.taskId);
      if (row.lastSubmitRequest === event.requestId && row.submission && row.submission.ownerId === id) return;
      if (!policy.canUpload(row, id, member, clock())) reject('FORBIDDEN', '当前任务不能提交。');
      if (row.revision !== event.revision) reject('CONFLICT', '任务已更新，请重新打开后提交。');
      const cover = await read(tx, 'sharingFiles', event.coverFileId);
      if (!cover || cover.teamId !== 'IMC' || cover.taskId !== row._id || cover.ownerId !== id || cover.status !== 'ready' || cover.kind !== 'cover') reject('FORBIDDEN', '封面未完成上传或不属于本次任务。');
      const files = [];
      for (const fid of event.fileIds) {
        const file = await read(tx, 'sharingFiles', fid);
        if (!file || file.teamId !== 'IMC' || file.taskId !== row._id || file.ownerId !== id || file.status !== 'ready' || file.kind === 'cover') reject('FORBIDDEN', '附件未完成上传或不属于本次任务。');
        files.push({ ...policy.fileView(file), fileID: file.fileID, sha256: file.sha256 });
      }
      if (files.reduce((sum, file) => sum + file.size, 0) > TOTAL_LIMIT) reject('FILE_LIMIT', '附件总大小不超过50MB。');
      const version = (row.submission ? row.submission.version : 0) + 1;
      const submission = { ownerId: id, title, note, files, cover: { ...policy.fileView(cover), fileID: cover.fileID, sha256: cover.sha256 }, version, state: 'pending', submittedMs: clock(), reviewedMs: 0, reviewedBy: '', reviewComment: '' };
      const next = { ...row, submission, reviewState: 'pending', revision: row.revision + 1, lastSubmitRequest: event.requestId, updatedMs: clock() };
      await tx.collection('sharingTasks').doc(row._id).update({ data: { submission, reviewState: next.reviewState, revision: next.revision,
        lastSubmitRequest: event.requestId, nextReminderMs: policy.nextReminder(next, clock()), updatedMs: clock() } });
      await tx.collection('sharingAudit').doc(row._id + '_' + version + '_submit').set({ data: { teamId: 'IMC', taskId: row._id, actorId: id, action: 'submit', version, createdMs: clock() } });
      await notices.send(tx, row, 'review:' + version, 'role:sharing_reviewer', '每周分享待审批', row.weekStart + ' 当周的分享已提交，请查看并审批。', clock());
      await sync.bump(tx, ['home', 'weekly', 'messages', 'approvals']);
    });
    return get(id, event);
  }
  async function review(id, event) {
    const comment = typeof event.comment === 'string' ? event.comment.trim() : '';
    if (!['approved', 'rejected'].includes(event.decision) || !Number.isSafeInteger(event.revision) || !Number.isSafeInteger(event.version) || comment.length > 500 || (event.decision === 'rejected' && !comment)) reject('INVALID_INPUT', '驳回时请填写原因，审批意见不超过500字。');
    await db.runTransaction(async tx => {
      if (!policy.reviewer(await authorize(id, tx))) reject('FORBIDDEN', '仅分享审批人（高创）可以审批。');
      const row = await task(tx, event.taskId), previous = row.submission;
      if (!previous || previous.version !== event.version) reject('CONFLICT', '提交版本已变化，请重新打开。');
      if (previous.state === event.decision && previous.reviewedBy === id && previous.reviewComment === comment) return;
      if (row.revision !== event.revision || previous.state !== 'pending') reject('CONFLICT', '任务已被处理，请刷新后查看。');
      const submission = { ...previous, state: event.decision, reviewComment: comment, reviewedBy: id, reviewedMs: clock() };
      const next = { ...row, submission, reviewState: event.decision, revision: row.revision + 1 };
      await tx.collection('sharingTasks').doc(row._id).update({ data: { submission, reviewState: next.reviewState, revision: next.revision, updatedMs: clock(), nextReminderMs: policy.nextReminder(next, clock()) } });
      await tx.collection('sharingAudit').doc(row._id + '_' + previous.version + '_review').set({ data: { teamId: 'IMC', taskId: row._id, actorId: id,
        ownerId: previous.ownerId, action: event.decision, version: previous.version, comment, createdMs: clock() } });
      await notices.resolve(tx, row, 'review:' + previous.version);
      await notices.send(tx, row, 'decision:' + previous.version, previous.ownerId, event.decision === 'approved' ? '每周分享已通过' : '每周分享需修改',
        row.weekStart + (event.decision === 'approved' ? ' 当周的分享已公开，任务已完成。' : ' 当周的分享未通过审批，请查看意见并重新提交。'), clock());
      await sync.bump(tx, ['home', 'weekly', 'messages', 'approvals']);
    });
    return get(id, event);
  }
  async function authorizedFile(id, event) {
    const member = await authorize(id), row = await task(db, event.taskId);
    if (!policy.canRead(row, id, member)) reject('FORBIDDEN', '审批通过前，仅上传人和分享审批人可以查看内容。');
    const file = [...row.submission.files, ...(row.submission.cover ? [row.submission.cover] : [])].find(item => item.id === event.fileId);
    if (!file) reject('NOT_FOUND', '文件不存在或已不属于当前提交版本。');
    return file;
  }
  async function downloadChunk(id, event) {
    if (!validFile(event.fileId) || !Number.isSafeInteger(event.offset) || event.offset < 0) reject('INVALID_INPUT', '下载参数不正确。');
    const file = await authorizedFile(id, event), length = Math.min(128 * 1024, file.size - event.offset);
    if (length <= 0) reject('INVALID_INPUT', '下载位置不正确。');
    const bytes = await storage.slice(file.fileID, event.offset, length, file.size);
    const current = await authorizedFile(id, event);
    if (current.sha256 !== file.sha256) reject('CONFLICT', '文件版本已变化，请重新下载。');
    // Never expose a file ID or bearer URL; every chunk checks the current membership and approval.
    return { ok: true, data: bytes.toString('base64'), nextOffset: event.offset + length, total: file.size,
      complete: event.offset + length === file.size, file: policy.fileView(file) };
  }
  async function dispatch(id, event) {
    if (typeof event.action === 'string' && event.action.startsWith('challenge.')) return require('./challenge-service')(db, cloud, access, clock, storage).dispatch(id, { ...event, action: event.action.slice(10) });
    const handlers = { get, list, previews, members, saveTask, setArchived, prepareUpload, finishUpload, submit, review, downloadChunk,
      roster: (actor, data) => require('./roster')(db, authorize, clock).preview(actor, data),
      importRoster: (actor, data) => require('./roster')(db, authorize, clock).import(actor, data) };
    handlers.initialize = async actor => {
      if (!policy.manager(await authorize(actor))) reject('FORBIDDEN', '仅高创可以初始化每周分享。');
      return require('./setup')(db, actor);
    };
    handlers.configure = async actor => {
      if (!policy.manager(await authorize(actor))) reject('FORBIDDEN', '仅高创可以配置每周分享服务。');
      return require('./setup').configure();
    };
    handlers.status = async actor => {
      if (!policy.manager(await authorize(actor))) reject('FORBIDDEN', '仅高创可以查看每周分享运行状态。');
      return require('./setup').inspect(db);
    };
    if (!Object.prototype.hasOwnProperty.call(handlers, event.action)) reject('INVALID_ACTION', '不支持的每周分享操作。');
    return handlers[event.action](id, event);
  }
  return { dispatch };
};
