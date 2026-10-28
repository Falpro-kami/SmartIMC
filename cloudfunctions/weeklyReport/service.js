const { createHash, randomUUID } = require('node:crypto');
const sync = require('./sync');
const form = require('./form');
const TEAM = 'IMC';
const PREFIX = 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/';
const FILE_LIMIT = 5 * 1024 * 1024, TOTAL_LIMIT = 10 * 1024 * 1024, COUNT_LIMIT = 5;
const EXTENSIONS = ['pdf', 'doc', 'docx'];
const hash = (prefix, value) => prefix + createHash('sha256').update(value).digest('hex').slice(0, 32);
const reportId = (period, owner) => hash('wr_', period + ':' + owner);
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
function validId(value, prefix) { return typeof value === 'string' && new RegExp('^' + prefix + '_[a-f0-9]{32}$').test(value); }
function dateMs(date) {
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return NaN;
  const value = Date.parse(date + 'T00:00:00+08:00');
  return Number.isFinite(value) && new Date(value + 8 * 3600000).toISOString().slice(0, 10) === date ? value : NaN;
}
function signature(bytes, ext) {
  if (ext === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (ext === 'png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (['jpg', 'jpeg'].includes(ext)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (['docx', 'xlsx', 'pptx'].includes(ext)) return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
  return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
}
function csvCell(value) {
  let text = String(value == null ? '' : value);
  // Excel formula injection also applies to names supplied by users.
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
module.exports = function weekly(db, cloud, access, clock = Date.now, storage = require('./storage')(cloud)) {
  const read = async (store, table, id) => document(await store.collection(table).doc(id).get());
  async function all(table, filter) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await db.collection(table).where(filter).orderBy('_id', 'asc').skip(offset).limit(100).get()).data;
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }
  async function authorize(id, permission = 'weekly.read.own', store = db) {
    const member = await read(store, 'teamMembers', id);
    if (!access.allowed(member, 'weekly.read.own')) reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能访问。');
    if (!access.allowed(member, permission)) reject('FORBIDDEN', '没有这项周报操作权限。');
    return member;
  }
  async function period(store, id) {
    if (!validId(id, 'wp')) reject('INVALID_INPUT', '周报周期参数不正确。');
    const row = await read(store, 'weeklyPeriods', id);
    if (!row || row.teamId !== TEAM) reject('NOT_FOUND', '周报周期不存在。');
    return row;
  }
  const target = (p, id) => p.roster.find(row => row.id === id);
  function editable(p, id, report) {
    const person = target(p, id);
    if (!person || person.exempt) reject('NOT_REQUIRED', '本周期无需你提交周报。');
    if (p.status !== 'open') reject('CLOSED', p.status === 'archived' ? '该周期已归档。' : '该周期已关闭。');
    if (clock() < dateMs(p.startDate)) reject('NOT_STARTED', '本周期尚未开始。');
    if (clock() > p.deadlineMs && !(report && report.status === 'submitted' ? p.allowLateEdit : p.allowLateSubmit)) reject('DEADLINE', '已超过提交截止时间。');
  }
  const fileView = f => ({ id: f.id || f._id, name: f.name, size: f.size, ext: f.ext });
  const reportView = r => r ? { id: r._id, status: r.status, revision: r.revision, files: (r.draftFiles || r.files || []).map(fileView),
    answers: r.draftAnswers || r.answers || {},
    submittedFiles: (r.files || []).map(fileView), hasChanges: r.hasChanges === true, version: r.version || 0,
    submittedMs: r.submittedMs || 0, firstSubmittedMs: r.firstSubmittedMs || 0, updatedMs: r.updatedMs, late: r.late === true } : null;
  function periodView(p, id, report) {
    const person = target(p, id);
    let canEdit = true;
    try { editable(p, id, report); } catch (_) { canEdit = false; }
    return { id: p._id, title: p.title, startDate: p.startDate, endDate: p.endDate, deadlineMs: p.deadlineMs,
      status: p.status, revision: p.revision, allowLateSubmit: p.allowLateSubmit, allowLateEdit: p.allowLateEdit,
      publishAtMs: p.publishAtMs || 0, publishError: p.publishError || '',
      schema: p.schema || null, templateName: p.templateName || '',
      required: !!person && !person.exempt, exemption: person && person.exempt || '', canEdit,
      ownStatus: person && person.exempt ? 'exempt' : !person ? 'outside' : report ? report.status : 'unsubmitted' };
  }
  function rights(member) { return { isLeader: (member.roles || []).includes('leader'), canManage: access.allowed(member, 'weekly.manage'), canReadTeam: access.allowed(member, 'weekly.read.team'),
    canRemind: access.allowed(member, 'weekly.remind'), canExport: access.allowed(member, 'weekly.export') }; }
  async function list(id, event) {
    const actor = await authorize(id);
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '分页参数不正确。');
    const periods = (await db.collection('weeklyPeriods').where({ teamId: TEAM, ...(access.allowed(actor, 'weekly.manage') ? {} : { status: db.command.in(['open', 'closed', 'archived']) }) }).orderBy('startDate', 'desc').orderBy('_id', 'desc').skip(offset).limit(21).get()).data;
    const rows = periods.slice(0, 20);
    const own = rows.length ? (await db.collection('weeklyReports').where({ teamId: TEAM, ownerId: id, periodId: db.command.in(rows.map(p => p._id)) }).limit(20).get()).data : [];
    const reports = new Map(own.map(r => [r.periodId, r]));
    const current = await authorize(id);
    return { ok: true, periods: rows.map(p => periodView(p, id, reports.get(p._id))), ...rights(current),
      nextOffset: offset + rows.length, hasMore: periods.length > 20 };
  }
  async function get(id, event) {
    const p = await period(db, event.periodId);
    const ownerId = event.ownerId || id;
    const viewer = await authorize(id, ownerId === id ? 'weekly.read.own' : 'weekly.read.team');
    if (['scheduled', 'cancelled'].includes(p.status) && !access.allowed(viewer, 'weekly.manage')) reject('NOT_FOUND', '周报周期尚未发布。');
    const r = await read(db, 'weeklyReports', reportId(p._id, ownerId));
    if (ownerId !== id && (!r || r.status !== 'submitted')) reject('NOT_FOUND', '该成员尚未提交周报。');
    const versions = (await db.collection('weeklyVersions').where({ teamId: TEAM, reportId: reportId(p._id, ownerId) }).orderBy('version', 'desc').limit(100).get()).data;
    // Team readers can see submitted snapshots only, including when an owner has further draft changes.
    const visible = r && ownerId !== id ? { ...r, draftFiles: r.files, draftAnswers: r.answers || {}, hasChanges: false } : r;
    const imageURLs = await imageLinks(visible && (visible.draftFiles || visible.files) || []);
    const actor = await authorize(id, ownerId === id ? 'weekly.read.own' : 'weekly.read.team');
    return { ok: true, period: periodView(p, id, r), report: reportView(visible), own: ownerId === id, ...rights(actor),
      imageURLs, ownerName: (target(p, ownerId) || {}).name || '-', versions: versions.map(v => ({ id: v._id, version: v.version, submittedMs: v.submittedMs, late: v.late, files: p.schema ? [] : v.files.map(fileView) })) };
  }
  async function imageLinks(files) {
    const imageFiles = files.filter(f => ['png', 'jpg', 'jpeg'].includes(f.ext)), imageURLs = {};
    if (imageFiles.length) {
      const unique = [...new Map(imageFiles.map(f => [f.id, f])).values()];
      const links = await cloud.getTempFileURL({ fileList: unique.map(f => f.fileID) });
      for (const f of unique) { const link = (links.fileList || []).find(l => l.fileID === f.fileID && l.status === 0 && /^https:\/\//.test(l.tempFileURL)); if (link) imageURLs[f.id] = link.tempFileURL; }
    }
    return imageURLs;
  }
  async function getVersion(id, e) {
    if (!validId(e.versionId, 'wv')) reject('INVALID_INPUT', '提交记录参数不正确。');
    const v = await read(db, 'weeklyVersions', e.versionId);
    if (!v || v.teamId !== TEAM) reject('NOT_FOUND', '提交记录不存在。');
    const permission = v.ownerId === id ? 'weekly.read.own' : 'weekly.read.team';
    await authorize(id, permission);
    const p = await period(db, v.periodId);
    const imageURLs = await imageLinks(v.files);
    await authorize(id, permission);
    return { ok: true, version: { id: v._id, answers: v.answers || {}, files: v.files.map(fileView) }, imageURLs, schema: p.schema || null };
  }
  async function templates(id) {
    await authorize(id, 'weekly.manage');
    const rows = await all('weeklyTemplates', { teamId: TEAM });
    await authorize(id, 'weekly.manage');
    return { ok: true, templates: rows.map(t => ({ id: t._id, name: t.name, revision: t.revision, schema: t.schema })) };
  }
  async function saveTemplate(id, e) {
    await authorize(id, 'weekly.manage');
    if (!validId(e.id, 'wt') || !Number.isSafeInteger(e.revision) || e.revision < 0 || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 60 || /[\u0000-\u001f]/.test(e.name)) reject('INVALID_INPUT', '请填写模板名称。');
    const schema = form.schema(e.schema);
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.manage', tx);
      const previous = await read(tx, 'weeklyTemplates', e.id);
      if (previous && previous.teamId !== TEAM) reject('FORBIDDEN', '无法编辑该模板。');
      if ((previous ? previous.revision : 0) !== e.revision) reject('CONFLICT', '模板已更新，请重新打开。');
      await tx.collection('weeklyTemplates').doc(e.id).set({ data: { teamId: TEAM, name: e.name.trim(), schema, revision: e.revision + 1, updatedMs: clock(), updatedBy: id } });
      await audit(tx, id, 'template.save', e.id, { revision: e.revision + 1 });
      await sync.bump(tx, ['weekly']);
    });
    return { ok: true, template: { id: e.id, name: e.name.trim(), schema, revision: e.revision + 1 } };
  }
  async function roster(id) {
    await authorize(id, 'weekly.manage');
    const members = await all('teamMembers', { teamId: TEAM, status: 'active' });
    const profiles = new Map();
    for (let offset = 0; offset < members.length; offset += 100) {
      const rows = (await db.collection('userProfiles').where({ _id: db.command.in(members.slice(offset, offset + 100).map(m => m._id)) }).limit(100).get()).data;
      rows.forEach(row => profiles.set(row._id, row.name));
    }
    await authorize(id, 'weekly.manage');
    return { ok: true, members: members.map(m => ({ id: m._id, name: profiles.get(m._id) || '-' })) };
  }
  async function configuration(id, event) {
    await authorize(id, 'weekly.manage');
    const p = await period(db, event.periodId);
    return { ok: true, period: { ...periodView(p, id), roster: p.roster } };
  }
  async function audit(tx, actorId, action, subjectId, data = {}) {
    await tx.collection('weeklyAudit').doc(hash('wa_', randomUUID())).set({ data: { teamId: TEAM, actorId, action, subjectId, ...data, createdMs: clock() } });
  }
  async function notice(tx, p, ids, suffix, title) {
    if (!ids.length) return;
    const messageId = hash('msg_', 'weekly:' + p._id + ':' + suffix);
    // Idempotent notification: retries never reset readBy or re-light an already read message.
    if (await read(tx, 'teamMessages', messageId)) return;
    await tx.collection('teamMessages').doc(messageId).set({ data: { teamId: TEAM, kind: 'weekly', recipientKey: ids,
      subjectId: p._id, title, body: p.title, createdMs: clock(), state: 'open', readBy: [] } });
    await sync.bump(tx, ['messages']);
  }
  async function savePeriod(id, e) {
    await authorize(id, 'weekly.manage');
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const deadlineMs = typeof e.deadline === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.deadline) ? Date.parse(e.deadline + ':00+08:00') : NaN;
    const publishAtMs = e.status === 'scheduled' && typeof e.publishAt === 'string' && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.publishAt) ? Date.parse(e.publishAt + ':00+08:00') : 0;
    if (!validId(e.id, 'wp') || !Number.isSafeInteger(e.revision) || e.revision < 0 || !title || title.length > 60 || /[\r\n\u0000-\u001f]/.test(title) ||
      !Number.isFinite(dateMs(e.startDate)) || !Number.isFinite(dateMs(e.endDate)) || e.endDate < e.startDate || !Number.isFinite(deadlineMs) || !Number.isFinite(dateMs((e.deadline || '').slice(0, 10))) || deadlineMs < dateMs(e.startDate) ||
      !['scheduled', 'cancelled', 'open', 'closed', 'archived'].includes(e.status) || (e.status === 'scheduled' && (!publishAtMs || !Number.isFinite(dateMs(e.publishAt.slice(0, 10))) || publishAtMs <= clock() || publishAtMs >= deadlineMs)) || typeof e.allowLateSubmit !== 'boolean' || typeof e.allowLateEdit !== 'boolean' ||
      !Array.isArray(e.roster) || !e.roster.length || e.roster.length > 300 || new Set(e.roster.map(r => r.id)).size !== e.roster.length ||
      e.roster.some(r => !validId(r.id, 'user') || typeof r.exempt !== 'string' || r.exempt.length > 80)) reject('INVALID_INPUT', '请检查周期名称、日期、截止时间和应交成员。');
    const active = await roster(id), names = new Map(active.members.map(m => [m.id, m.name]));
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.manage', tx);
      const previous = await read(tx, 'weeklyPeriods', e.id);
      if (previous && previous.teamId !== TEAM) reject('NOT_FOUND', '周报周期不存在。');
      if ((previous ? previous.revision : 0) !== e.revision) reject('CONFLICT', '周期已更新，请重新打开后编辑。');
      if (!previous && !['open', 'scheduled'].includes(e.status)) reject('INVALID_INPUT', '请选择立即发布或定时发布。');
      if (previous && !['scheduled', 'cancelled'].includes(previous.status) && ['scheduled', 'cancelled'].includes(e.status)) reject('INVALID_INPUT', '已发布的周期不能改回定时发布。');
      const oldNames = new Map((previous ? previous.roster : []).map(r => [r.id, r.name]));
      const selected = e.roster.map(r => {
        if (!names.has(r.id) && !oldNames.has(r.id)) reject('INVALID_INPUT', '应交成员已变更，请重新选择。');
        return { id: r.id, name: names.get(r.id) || oldNames.get(r.id), exempt: r.exempt.trim() };
      });
      const schema = e.schema ? form.schema(e.schema) : previous && previous.schema || null;
      if (previous && !['scheduled', 'cancelled'].includes(previous.status) && JSON.stringify(schema) !== JSON.stringify(previous.schema || null)) reject('INVALID_FORM', '已发布周期的表单保持不变，请在新周期使用修改后的模板。');
      const p = { _id: e.id, teamId: TEAM, title, startDate: e.startDate, endDate: e.endDate, deadlineMs, status: e.status,
        schema, templateName: typeof e.templateName === 'string' ? e.templateName.slice(0, 60) : previous && previous.templateName || '',
        allowLateSubmit: e.allowLateSubmit, allowLateEdit: e.allowLateEdit, roster: selected,
        publishAtMs, publishError: '', publishedMs: ['scheduled', 'cancelled'].includes(e.status) ? 0 : previous && previous.publishedMs || clock(),
        revision: e.revision + 1, createdMs: previous ? previous.createdMs : clock(), updatedMs: clock(), updatedBy: id };
      const newRecipients = selected.filter(r => !r.exempt && !(previous && !['scheduled', 'cancelled'].includes(previous.status) && previous.roster.some(old => old.id === r.id && !old.exempt))).map(r => r.id);
      if (e.status === 'open') await notice(tx, p, newRecipients, 'publish:' + p.revision, '周报待提交');
      const { _id, ...data } = p;
      await tx.collection('weeklyPeriods').doc(e.id).set({ data });
      await audit(tx, id, previous ? 'period.update' : e.status === 'scheduled' ? 'period.schedule' : 'period.publish', e.id, { before: previous || null, after: p });
      await sync.bump(tx, ['home', 'weekly']);
    });
    return { ok: true, id: e.id };
  }
  async function prepare(id, e) {
    await authorize(id, 'weekly.submit.own');
    const ext = typeof e.name === 'string' ? e.name.split('.').pop().toLowerCase() : '';
    const image = e.kind === 'image';
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 160 || /[\\/\u0000-\u001f]/.test(e.name) || !(image ? ['png', 'jpg', 'jpeg'] : EXTENSIONS).includes(ext) ||
      !Number.isSafeInteger(e.size) || e.size < 1 || e.size > FILE_LIMIT) reject('INVALID_FILE', '支持 Word、PDF 文档，单个文件不超过5MB。');
    const fid = hash('wf_', randomUUID()), path = 'weekly/' + id + '/' + e.periodId + '/' + fid + '.' + ext;
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.submit.own', tx);
      const p = await period(tx, e.periodId), r = await read(tx, 'weeklyReports', reportId(p._id, id));
      editable(p, id, r);
      const field = p.schema && p.schema.sections.flatMap(s => s.fields).find(f => f.id === e.fieldId);
      if (p.schema && (!field || field.type !== (image ? 'text' : 'attachment')) || image && !p.schema) reject('INVALID_FORM', '请选择有效的表单字段。');
      if (field && field.type === 'attachment' && e.size > field.maxSizeMB * 1024 * 1024) reject('FILE_LIMIT', '文件超过该字段的大小限制。');
      await tx.collection('weeklyFiles').doc(fid).set({ data: { teamId: TEAM, ownerId: id, periodId: p._id, name: e.name.trim(), size: e.size, ext,
        fieldId: field ? field.id : '', kind: image ? 'image' : 'attachment',
        path, status: 'uploading', createdMs: clock() } });
    });
    return { ok: true, id: fid, cloudPath: path };
  }
  async function finish(id, e) {
    await authorize(id, 'weekly.submit.own');
    if (!validId(e.fileId, 'wf')) reject('INVALID_INPUT', '附件参数不正确。');
    const f = await read(db, 'weeklyFiles', e.fileId);
    if (!f || f.teamId !== TEAM || f.ownerId !== id || PREFIX + f.path !== e.fileID) reject('FORBIDDEN', '无法使用这份附件。');
    const p = await period(db, f.periodId), r = await read(db, 'weeklyReports', reportId(p._id, id));
    editable(p, id, r);
    if (f.status === 'ready') return { ok: true, file: fileView(f) };
    if (clock() - f.createdMs > 24 * 3600000 && f.status !== 'ready') reject('EXPIRED', '上传已过期，请重新选择文件。');
    const bytes = await storage.read(PREFIX + f.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== f.size || bytes.length > FILE_LIMIT || !signature(bytes, f.ext)) reject('INVALID_FILE', '文件内容或大小不匹配，请重新选择文件。');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const frozenFileID = await storage.freeze(bytes, f.ext);
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.submit.own', tx);
      const currentP = await period(tx, f.periodId), currentR = await read(tx, 'weeklyReports', reportId(f.periodId, id));
      editable(currentP, id, currentR);
      const current = await read(tx, 'weeklyFiles', e.fileId);
      if (!current || current.ownerId !== id || PREFIX + current.path !== e.fileID || (current.sha256 && current.sha256 !== sha256)) reject('CONFLICT', '附件已变更，请重新上传。');
      if (current.status === 'ready') return;
      await tx.collection('weeklyFiles').doc(e.fileId).update({ data: { status: 'ready', fileID: frozenFileID, sha256, readyMs: clock() } });
    });
    // The stable server copy is recorded first; staging cleanup must never invalidate a successful upload.
    if (typeof cloud.deleteFile === 'function') {
      try { await cloud.deleteFile({ fileList: [PREFIX + f.path] }); } catch (_) { /* Private staging can be removed manually later. */ }
    }
    return { ok: true, file: fileView({ ...f, id: e.fileId }) };
  }
  async function saveDraft(id, e, submit = false) {
    await authorize(id, 'weekly.submit.own');
    if (!Number.isSafeInteger(e.revision) || e.revision < 0) reject('INVALID_INPUT', '周报版本不正确。');
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.submit.own', tx);
      const p = await period(tx, e.periodId), rid = reportId(p._id, id), r = await read(tx, 'weeklyReports', rid);
      // A retried submit after a lost response succeeds without producing another version.
      if (submit && validId(e.requestId, 'ws') && r && r.lastSubmitRequest === e.requestId) return;
      if (!submit && validId(e.requestId, 'wd') && r && r.lastDraftRequest === e.requestId) return;
      editable(p, id, r);
      if ((r ? r.revision : 0) !== e.revision) reject('CONFLICT', '周报已在其他位置更新，请重新打开。');
      if (submit && !validId(e.requestId, 'ws')) reject('INVALID_INPUT', '提交参数不正确。');
      if (!submit && !validId(e.requestId, 'wd')) reject('INVALID_INPUT', '自动保存参数不正确。');
      const content = p.schema ? form.answers(p.schema, e.answers || {}, submit) : null;
      const fileIds = content ? content.fileIds : e.fileIds;
      if (!Array.isArray(fileIds) || fileIds.length > (content ? 50 : COUNT_LIMIT) || fileIds.some(f => !validId(f, 'wf')) || new Set(fileIds).size !== fileIds.length || (!content && submit && !fileIds.length)) reject('INVALID_INPUT', submit ? '请上传周报文件后提交。' : '最多上传5个文件。');
      const files = [];
      for (const fileId of fileIds) {
        const f = await read(tx, 'weeklyFiles', fileId);
        if (!f || f.teamId !== TEAM || f.ownerId !== id || f.periodId !== p._id || f.status !== 'ready') reject('FORBIDDEN', '附件尚未完成上传或不属于本次周报。');
        if (content) {
          const field = p.schema.sections.flatMap(s => s.fields).find(field => field.type === 'text' ? content.imageFields[fileId] === field.id : field.type === 'attachment' && (content.values[field.id] || []).includes(fileId));
          if (!field || f.fieldId !== field.id || (field.type === 'text' ? !['png', 'jpg', 'jpeg'].includes(f.ext) : !EXTENSIONS.includes(f.ext) || f.size > field.maxSizeMB * 1024 * 1024)) reject('FORBIDDEN', '附件不属于该字段或超过字段限制。');
        }
        files.push({ id: fileId, name: f.name, ext: f.ext, size: f.size, fileID: f.fileID, sha256: f.sha256 });
      }
      if (files.reduce((n, f) => n + f.size, 0) > TOTAL_LIMIT) reject('FILE_LIMIT', '每份周报附件合计不超过10MB。');
      const now = clock(), version = (r && r.version || 0) + (submit ? 1 : 0);
      if (submit && version > 100) reject('VERSION_LIMIT', '本周期提交次数已达100次。');
      const data = { teamId: TEAM, periodId: p._id, ownerId: id, status: submit ? 'submitted' : r && r.status || 'draft',
        revision: e.revision + 1, version, draftFiles: files, files: submit ? files : r && r.files || [],
        draftAnswers: content ? content.values : {}, answers: submit && content ? content.values : r && r.answers || {},
        hasChanges: !submit && !!(r && r.status === 'submitted') && (JSON.stringify(files.map(f => f.id)) !== JSON.stringify(r.files.map(f => f.id)) || content && JSON.stringify(content.values) !== JSON.stringify(r.answers || {})),
        submittedMs: submit ? now : r && r.submittedMs || 0, firstSubmittedMs: r && r.firstSubmittedMs || (submit ? now : 0),
        late: submit ? now > p.deadlineMs : r && r.late || false, createdMs: r ? r.createdMs : now, updatedMs: now,
        lastSubmitRequest: submit ? e.requestId : r && r.lastSubmitRequest || '', lastDraftRequest: submit ? r && r.lastDraftRequest || '' : e.requestId };
      if (submit) {
        await tx.collection('weeklyVersions').doc(hash('wv_', rid + ':' + version)).set({ data: { teamId: TEAM, reportId: rid, periodId: p._id,
          ownerId: id, version, files, answers: content ? content.values : {}, submittedMs: now, late: data.late } });
        await audit(tx, id, 'report.submit', rid, { version, fileIds });
      }
      await tx.collection('weeklyReports').doc(rid).set({ data });
      await sync.bump(tx, ['home', 'weekly']);
    });
    return get(id, { periodId: e.periodId });
  }
  async function team(id, e, permission = 'weekly.read.team') {
    const actor = await authorize(id, permission);
    const p = await period(db, e.periodId), reports = await all('weeklyReports', { teamId: TEAM, periodId: p._id });
    if (['scheduled', 'cancelled'].includes(p.status) && !access.allowed(actor, 'weekly.manage')) reject('NOT_FOUND', '周报周期尚未发布。');
    const map = new Map(reports.map(r => [r.ownerId, r]));
    const rows = p.roster.map(person => {
      const r = map.get(person.id);
      return { id: person.id, name: person.name, exemption: person.exempt, status: person.exempt ? 'exempt' : r ? r.status : 'unsubmitted',
        submittedMs: r && r.submittedMs || 0, firstSubmittedMs: r && r.firstSubmittedMs || 0, late: r && r.late === true, version: r && r.version || 0,
        files: r && r.status === 'submitted' ? r.files.map(fileView) : [] };
    });
    await authorize(id, permission);
    return { ok: true, period: periodView(p, id), rows, total: rows.filter(r => r.status !== 'exempt').length,
      submitted: rows.filter(r => r.status === 'submitted').length };
  }
  async function remind(id, e) {
    const stats = await team(id, e, 'weekly.remind');
    const ids = stats.rows.filter(r => r.status === 'draft' || r.status === 'unsubmitted').map(r => r.id);
    const activeMembers = new Set((await all('teamMembers', { teamId: TEAM, status: 'active' })).map(m => m._id));
    const recipients = ids.filter(targetId => activeMembers.has(targetId));
    await db.runTransaction(async tx => {
      await authorize(id, 'weekly.remind', tx);
      const p = await period(tx, e.periodId);
      if (p.revision !== stats.period.revision) reject('CONFLICT', '周期已更新，请重试。');
      if (p.status !== 'open') reject('CLOSED', '只有开放中的周报周期可以催交。');
      const day = new Date(clock() + 8 * 3600000).toISOString().slice(0, 10);
      await notice(tx, p, recipients, 'remind:' + day, '周报提交提醒');
      await audit(tx, id, 'period.remind', p._id, { recipientIds: recipients });
    });
    return { ok: true, count: recipients.length };
  }
  async function authorizedFile(id, e) {
    if (!validId(e.fileId, 'wf')) reject('INVALID_INPUT', '附件参数不正确。');
    const f = await read(db, 'weeklyFiles', e.fileId);
    if (!f || f.teamId !== TEAM || f.status !== 'ready') reject('NOT_FOUND', '附件不存在。');
    const permission = id === f.ownerId ? 'weekly.read.own' : 'weekly.read.team';
    await authorize(id, permission);
    const r = await read(db, 'weeklyReports', reportId(f.periodId, f.ownerId));
    let visible = r && (id === f.ownerId ? (r.draftFiles || r.files).concat(r.files || []) : r.files || []).some(v => v.id === e.fileId);
    if (!visible && validId(e.versionId, 'wv')) {
      const version = await read(db, 'weeklyVersions', e.versionId);
      visible = version && version.teamId === TEAM && version.ownerId === f.ownerId && version.periodId === f.periodId && version.files.some(v => v.id === e.fileId);
    }
    if (!visible) reject('FORBIDDEN', '无法访问这份附件。');
    return { f, permission };
  }
  async function download(id, e) {
    const { f, permission } = await authorizedFile(id, e);
    const result = await cloud.getTempFileURL({ fileList: [f.fileID] });
    const value = (result.fileList || []).find(v => v.fileID === f.fileID && v.status === 0 && /^https:\/\//.test(v.tempFileURL));
    await authorize(id, permission);
    if (!value) reject('DOWNLOAD_FAILED', '附件暂时无法下载。');
    return { ok: true, url: value.tempFileURL, file: fileView(f) };
  }
  async function imageURL(id, e) {
    await authorize(id, 'weekly.submit.own');
    if (!validId(e.fileId, 'wf')) reject('INVALID_INPUT', '图片参数不正确。');
    const f = await read(db, 'weeklyFiles', e.fileId);
    if (!f || f.teamId !== TEAM || f.ownerId !== id || f.status !== 'ready' || f.kind !== 'image') reject('FORBIDDEN', '无法访问这张图片。');
    const p = await period(db, f.periodId); editable(p, id, await read(db, 'weeklyReports', reportId(p._id, id)));
    const result = await cloud.getTempFileURL({ fileList: [f.fileID] });
    const link = (result.fileList || []).find(f => f.status === 0 && /^https:\/\//.test(f.tempFileURL));
    await authorize(id, 'weekly.submit.own');
    if (!link) reject('DOWNLOAD_FAILED', '图片暂时无法加载。');
    return { ok: true, url: link.tempFileURL };
  }
  async function downloadChunk(id, e) {
    const { f, permission } = await authorizedFile(id, e);
    if (!Number.isSafeInteger(e.offset) || e.offset < 0 || e.offset >= f.size) reject('INVALID_INPUT', '文件分页参数不正确。');
    const length = Math.min(256 * 1024, f.size - e.offset);
    const bytes = await storage.slice(f.fileID, e.offset, length, f.size);
    await authorize(id, permission);
    return { ok: true, data: bytes.toString('base64'), total: f.size, nextOffset: e.offset + length, complete: e.offset + length === f.size };
  }
  async function exportStats(id, e) {
    const result = await team(id, e, 'weekly.export');
    const labels = { submitted: '已提交', draft: '草稿', unsubmitted: '未提交', exempt: '免交' };
    const lines = [['姓名', '状态', '最后提交时间（北京时间）', '提交版本', '逾期', '免交原因', '已提交文件']];
    for (const r of result.rows) lines.push([r.name, labels[r.status], r.submittedMs ? new Date(r.submittedMs + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '',
      r.version || '', r.late ? '是' : '', r.exemption, r.files.map(f => f.name).join('；')]);
    return { ok: true, name: '周报提交统计-' + result.period.startDate + '.csv', csv: '\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n') };
  }
  const actions = { list, get, roster, configuration, savePeriod, prepareUpload: prepare, finishUpload: finish, saveDraft,
    submit: (id, e) => saveDraft(id, e, true), team, remind, download, downloadChunk, exportStats, templates, saveTemplate, imageURL, getVersion };
  return { dispatch: async (id, e) => {
    if (!Object.prototype.hasOwnProperty.call(actions, e.action)) reject('INVALID_ACTION', '不支持的周报操作。');
    await authorize(id);
    return actions[e.action](id, e);
  } };
};
