const { createHash, randomUUID } = require('node:crypto');
const studentPolicy = require('./student-policy');

const TEAM = 'IMC';
const MB = 1024 * 1024;
const DESK_PAGE_SIZE = 30;
const ARCHIVE_CLAIM_LIMIT = 200;
const ARCHIVE_SIZE_LIMIT = 64 * MB;
const stages = ['等待核验', '已核验', '已制单', '已签字', '已提交财务处', '已到账'];
const categories = ['打车', '物料', '其他'];
const studentCategories = studentPolicy.rules.map(rule => rule.category);
const kinds = ['invoice', 'payment', 'purchase', 'trip'];
const documents = ['pdf', 'png', 'jpg', 'jpeg'];
const idPattern = /^user_[a-f0-9]{32}$/;
const requestPattern = /^[a-f0-9]{32}$/;
const claimPattern = /^fc_[a-f0-9]{32}$/;
const filePattern = /^ff_[a-f0-9]{32}$/;
const archivePattern = /^fa_[a-f0-9]{32}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
const read = async (db, table, id) => document(await db.collection(table).doc(id).get());
const unwrap = value => value && Object.hasOwn(value, 'result') ? value.result : value;
const datePattern = /^20\d{2}-\d{2}-\d{2}$/;
const WEEK_MS = 7 * 86400000;
const teachingTerms = [{ firstMonday: '2026-08-31', lastSunday: '2027-01-31' }];
const numerals = '零一二三四五六七八九';
const localDate = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const localMinute = now => new Date(now + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const inputText = value => typeof value === 'string' ? value.trim() : '';

function fail(code, message) { throw Object.assign(new Error(message), { businessCode: code }); }
function monday(now) {
  const local = new Date(now + 8 * 3600000);
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7);
  return local.toISOString().slice(0, 10);
}
function validWeek(value) {
  return typeof value === 'string' && datePattern.test(value) &&
    Number.isFinite(Date.parse(value)) && monday(Date.parse(value)) === value;
}
function deskWeekInfo(start) {
  const startMs = Date.parse(start);
  const end = new Date(startMs + 6 * 86400000).toISOString().slice(0, 10);
  const term = teachingTerms.find(item => start >= item.firstMonday && end <= item.lastSunday);
  if (!term) return { start, end, label: '' };
  const number = (startMs - Date.parse(term.firstMonday)) / WEEK_MS + 1;
  const units = number % 10;
  const tens = Math.floor(number / 10);
  const label = tens ? (tens > 1 ? numerals[tens] : '') + '十' + (units ? numerals[units] : '') : numerals[units];
  return { start, end, label: '第' + label + '周' };
}
function validFile(bytes, ext) {
  if (ext === 'pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (ext === 'png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
}
const publicFile = file => ({ id: file.id, kind: file.kind, name: file.name, ext: file.ext, size: file.size });
const progressVersion = row => hash(JSON.stringify([row._id, row.revision, row.stage, row.status, row.reviewState, row.updatedAt, row.updatedMs]));

module.exports = function finance(db, storage, access, options = {}) {
  const { prefix, makeArchive, feishu, reviewerIds = [], clock = Date.now, studentOnly = false, studentSubmit = false, financeDesk = false } = options;
  const configuredCategories = Array.isArray(options.categories) && options.categories.length ? [...new Set(['打车', ...options.categories])] : categories;
  const claimRef = (tx, id) => tx.collection('financeClaims').doc(id);
  const fileRef = (tx, id) => tx.collection('financeFiles').doc(id);
  const run = async callback => unwrap(await db.runTransaction(callback));

  async function actor(id, tx = db) {
    const member = await read(tx, 'teamMembers', id);
    if (!access.allowed(member, 'finance.read.own')) fail('FORBIDDEN', '仅已通过审核的成员可以使用财务报销。');
    const roles = member.roles || [];
    const officer = roles.includes('finance_admin');
    return { id, finance: !studentOnly && officer, financeDesk: studentOnly && financeDesk && officer,
      reviewer: !studentOnly && roles.includes('academic_admin') && reviewerIds.includes(id) };
  }
  function requireRole(current, role) {
    if (!current[role]) fail('FORBIDDEN', role === 'reviewer' ? '仅负责报销的学术管理员可执行此操作。' : '仅财务专员可执行此操作。');
  }
  async function claim(id, tx = db) {
    if (!claimPattern.test(id || '')) fail('INVALID_INPUT', '报销申请编号不正确。');
    const row = await read(tx, 'financeClaims', id);
    if (!row || row.teamId !== TEAM) fail('NOT_FOUND', '未找到报销申请。');
    return row;
  }
  function canSee(current, row) {
    return current.id === row.ownerId || current.finance || current.financeDesk || (current.reviewer && !!row.weekStart);
  }
  function view(row) {
    const manualStage = studentOnly ? stages.indexOf(row.status) : -1;
    const stage = manualStage >= 0 ? manualStage : Number.isInteger(row.stage) && stages[row.stage] ? row.stage : 0;
    const reviewState = manualStage >= 0 ? '' : row.reviewState;
    let cents = row.cents;
    if (studentOnly && typeof row.amount === 'number' && /^\d+(?:\.\d{1,2})?$/.test(String(row.amount))) {
      const value = Math.round(row.amount * 100);
      if (Number.isSafeInteger(value)) cents = value;
    }
    return { id: row._id, ownerId: row.ownerId, ownerName: row.ownerName, category: row.category, cents,
      number: row.number, createdMs: row.createdMs, updatedAt: row.updatedAt,
      description: row.description, invoiceDate: row.invoiceDate, transport: row.transport, confirmed: row.confirmed,
      files: (row.files || []).map(publicFile), reviewState,
      reason: manualStage >= 0 ? '' : row.reason, stage, stageLabel: stages[stage], weekStart: row.weekStart,
      revision: row.revision, updatedMs: row.updatedMs, pending: reviewState === 'review', checkedMs: row.checkedMs, paidMs: row.paidMs };
  }
  async function notice(tx, row, recipientKey, title, body) {
    const messageId = 'msg_' + hash('finance:' + row._id + ':' + row.revision + ':' + recipientKey).slice(0, 32);
    await tx.collection('teamMessages').doc(messageId).set({ data: {
      teamId: TEAM, recipientKey, kind: 'finance', subjectId: row._id, title, body, createdMs: clock(), state: 'open', readBy: []
    } });
    const result = await tx.collection('teamSync').doc(TEAM).update({ data: { messages: randomUUID() } });
    if (result && (result.updated === 0 || result.stats && result.stats.updated === 0)) throw new Error('Sync metadata is not initialized');
  }
  async function update(tx, row, changes, actorId, action, updatedMs = clock()) {
    const revision = (row.revision || 0) + 1;
    const fields = { ...changes, revision, updatedMs };
    const next = { ...row, ...fields };
    await claimRef(tx, row._id).update({ data: fields });
    await tx.collection('financeAudit').doc(row._id + '_' + next.revision).set({ data: {
      teamId: TEAM, claimId: row._id, actorId, action, stage: next.stage, reviewState: next.reviewState, createdMs: next.updatedMs
    } });
    return next;
  }

  async function uploadable(id, target, tx = db) {
    const current = await actor(id, tx);
    if (studentOnly && target) fail('FORBIDDEN', '请为本人新建报销申请。');
    if (!target) return;
    const row = await claim(target, tx);
    if (!(current.id === row.ownerId || current.finance) || row.reviewState !== 'needs') fail('FORBIDDEN', '当前申请不能补传附件。');
  }
  async function prepare(id, event) {
    const name = typeof event.name === 'string' ? event.name.trim() : '';
    const ext = name.split('.').pop().toLowerCase();
    const target = event.claimId || '';
    const allowedKinds = studentOnly ? Object.keys(studentPolicy.kinds) : kinds;
    if (!allowedKinds.includes(event.kind) || !documents.includes(ext) || !name || name.length > 100 ||
      /[\x00-\x1f/\\]/.test(name) || !Number.isSafeInteger(event.size) || event.size < 1 || event.size > 8 * MB ||
      (studentOnly && event.kind === 'invoice' && ext !== 'pdf') ||
      (studentOnly && event.kind === 'photo' && ext === 'pdf') ||
      (!studentOnly && ['purchase', 'payment'].includes(event.kind) && ext === 'pdf'))
      fail('INVALID_FILE', '电子发票请选择 PDF，其他材料请按类型选择 PDF、JPG 或 PNG，单份不超过 8 MB。');
    await uploadable(id, target);
    let storedName = '';
    if (studentOnly) {
      const { category, cents, ordinal } = event;
      if (!studentCategories.includes(category) || !Number.isSafeInteger(cents) || cents < 1 || cents > 100000000 ||
          !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 12) fail('INVALID_INPUT', '请先填写报销类别和金额。');
      storedName = studentPolicy.fileName({ kind: event.kind, ext }, category, cents, ordinal);
    }
    const fileId = 'ff_' + randomUUID().replace(/-/g, '');
    const path = 'finance-uploads/' + id + '/' + fileId + '.' + ext;
    await fileRef(db, fileId).set({ data: { teamId: TEAM, actorId: id, target, kind: event.kind, name: storedName || name, ext,
      size: event.size, path, createdMs: clock(), state: 'uploading' } });
    return { id: fileId, cloudPath: path };
  }
  async function finish(id, event) {
    if (!filePattern.test(event.fileId || '')) fail('INVALID_FILE', '附件编号不正确。');
    const file = await read(db, 'financeFiles', event.fileId);
    if (!file || file.teamId !== TEAM || file.actorId !== id || !prefix || event.fileID !== prefix + file.path) fail('FORBIDDEN', '无法使用该附件。');
    await uploadable(id, file.target);
    if (file.state === 'ready') return { file: publicFile({ ...file, id: file._id }) };
    if (clock() - file.createdMs > 86400000) fail('EXPIRED', '上传已过期，请重新选择附件。');
    const bytes = await storage.read(event.fileID);
    if (bytes.length !== file.size || !validFile(bytes, file.ext)) {
      await storage.remove(event.fileID);
      fail('INVALID_FILE', '文件内容与格式或大小不匹配。');
    }
    const saved = await storage.freeze(bytes, file.ext, studentOnly ? file.name : '');
    let retained = false;
    try {
      retained = await run(async tx => {
        await uploadable(id, file.target, tx);
        const current = await read(tx, 'financeFiles', file._id);
        if (current.state === 'ready') return false;
        await fileRef(tx, file._id).update({ data: { fileID: saved, sha256: hash(bytes), state: 'ready' } });
        return true;
      });
    } finally { if (!retained) await storage.remove(saved); }
    await storage.remove(event.fileID);
    return { file: publicFile({ ...file, id: file._id }) };
  }
  async function filesFor(tx, ids, actorId, target, previous = []) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 12 || ids.some(id => !filePattern.test(id || '')) ||
      new Set(ids).size !== ids.length) fail('INVALID_FILE', '请上传 1 至 12 份材料。');
    const files = [];
    for (const id of ids) {
      const file = await read(tx, 'financeFiles', id);
      if (!file || file.teamId !== TEAM || file.actorId !== actorId || file.target !== target || file.state !== 'ready' || file.usedBy) fail('INVALID_FILE', '存在未上传、已使用或不属于本次申请的附件。');
      files.push({ ...publicFile({ ...file, id }), fileID: file.fileID, sha256: file.sha256 });
    }
    const combined = previous.concat(files);
    if (combined.length > 12 || combined.reduce((sum, file) => sum + file.size, 0) > 16 * MB) fail('FILE_LIMIT', '每笔申请最多 12 份材料，合计不超过 16 MB。');
    return combined;
  }
  function checkMaterials(files, cents, category) {
    const required = ['invoice'];
    if (cents >= 50000) required.push('payment', 'purchase');
    if (category === '打车') required.push('trip');
    const labels = { invoice: '电子发票', payment: '支付记录截图', purchase: '购买记录截图', trip: '行程单' };
    const missing = required.filter(kind => !files.some(file => file.kind === kind));
    if (missing.length) fail('MISSING_MATERIALS', '请补齐：' + missing.map(kind => labels[kind]).join('、'));
  }
  function studentDetails(event, rule, files, now, description) {
    const { invoiceDate, cents } = event;
    const date = typeof invoiceDate === 'string' && datePattern.test(invoiceDate) ? new Date(invoiceDate) : null;
    if (!date || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== invoiceDate || invoiceDate > localDate(now))
      fail('INVALID_INPUT', '请选择有效的开票日期。');
    if (!description) fail('INVALID_INPUT', '请填写' + (rule.purpose || '报销用途') + '。');
    if (rule.confirmation && event.confirmed !== true) fail('INVALID_INPUT', '请确认：' + rule.confirmation);

    let transport = null;
    if (rule.category === '交通费') {
      const { transportMode } = event;
      const origin = inputText(event.origin), destination = inputText(event.destination);
      if (!['ride', 'taxi'].includes(transportMode) || !origin || !destination || origin.length > 80 || destination.length > 80)
        fail('INVALID_INPUT', '请选择乘车方式并填写出发地和目的地。');
      if (transportMode === 'ride' && (event.wuhan !== true || event.school !== true || event.nonHub !== true || /高铁站|火车站|铁路站|机场|车站/.test(destination)))
        fail('INVALID_INPUT', '网约车须在武汉市内，起点或终点须为学校，目的地须符合要求。');
      transport = { mode: transportMode, origin, destination };
    }
    const required = studentPolicy.requirements(rule, cents, transport?.mode);
    const allowed = new Set(required.concat(rule.optional || []));
    if (files.some(file => !allowed.has(file.kind))) fail('INVALID_FILE', '请按所选类别和金额上传对应材料。');
    const missing = required.filter(kind => !files.some(file => file.kind === kind));
    if (missing.length) fail('MISSING_MATERIALS', '请补齐：' + missing.map(kind => studentPolicy.kinds[kind]).join('、'));
    if (files.filter(file => file.kind === 'invoice' && file.ext === 'pdf').length !== 1 || files.filter(file => file.kind === 'invoice').length !== 1)
      fail('INVALID_FILE', '每笔申请请上传一张 PDF 发票。');
    return { invoiceDate, transport, ...(rule.confirmation ? { confirmed: true } : {}) };
  }
  async function submit(id, event) {
    const description = inputText(event.description);
    const rule = studentPolicy.rules.find(item => item.category === event.category);
    if (!requestPattern.test(event.requestId || '') || !(studentOnly ? rule : configuredCategories.includes(event.category)) || description.length > 200 ||
      !Number.isSafeInteger(event.cents) || event.cents < 1 || event.cents > 100000000) fail('INVALID_INPUT', '请填写正确的分类和报销金额。');
    const ownerId = event.ownerId || id;
    if (!idPattern.test(ownerId)) fail('INVALID_INPUT', '报销人无效。');
    const newId = 'fc_' + hash(id + ':' + event.requestId).slice(0, 32);
    await run(async tx => {
      const current = await actor(id, tx);
      if (ownerId !== id) requireRole(current, 'finance');
      const existing = await read(tx, 'financeClaims', newId);
      if (existing) return;
      const owner = await actor(ownerId, tx);
      const profile = await read(tx, 'userProfiles', owner.id);
      if (!profile || typeof profile.name !== 'string' || !profile.name.trim()) fail('INVALID_INPUT', '请先完善报销人的成员资料。');
      const files = await filesFor(tx, event.fileIds, id, '');
      const now = clock();
      const details = studentOnly ? studentDetails(event, rule, files, now, description) : {};
      if (studentOnly) {
        const counts = new Map();
        for (const file of files) {
          const ordinal = (counts.get(file.kind) || 0) + 1;
          counts.set(file.kind, ordinal);
          if (file.name !== studentPolicy.fileName(file, event.category, event.cents, ordinal))
            fail('INVALID_FILE', '报销类别或金额已修改，请重新上传对应材料。');
        }
      } else checkMaterials(files, event.cents, event.category);
      const data = { teamId: TEAM, ownerId, ownerName: profile.name, recorderId: id, category: event.category, cents: event.cents,
        description, ...details, ...(studentOnly ? { number: 'BX-' + localDate(now).replace(/-/g, '') + '-' + newId.slice(-12).toUpperCase() } : {}),
        files, approvedFiles: [], revision: 1, materialVersion: 0, reviewState: 'review', reason: '', stage: 0,
        weekStart: '', collectedWeek: monday(now), checkedMs: 0, paidMs: 0, createdMs: now, updatedMs: now, syncMs: 0, feishuId: '', syncError: '' };
      await claimRef(tx, newId).set({ data });
      for (const file of files) await fileRef(tx, file.id).update({ data: { usedBy: newId } });
      if (studentOnly) await notice(tx, { ...data, _id: newId }, ownerId, '报销申请已提交', '材料已收到，可在财务报销中查看进度。');
      else await notice(tx, { ...data, _id: newId }, 'role:finance_admin', '报销申请待核验', '收到一笔报销申请，请查看材料。');
    });
    return { claim: view(await claim(newId)) };
  }
  function checkRevision(row, revision) {
    if (row.revision !== revision) fail('CONFLICT', '申请已更新，请刷新后重试。');
  }
  async function supplement(id, event) {
    const result = await run(async tx => {
      const current = await actor(id, tx), row = await claim(event.claimId, tx);
      if (!(current.id === row.ownerId || current.finance)) fail('FORBIDDEN', '无法修改这笔申请。');
      if (row.supplementRequest && row.supplementRequest === event.requestId && row.supplementActor === id) return row;
      if (!requestPattern.test(event.requestId || '')) fail('INVALID_INPUT', '补件请求参数不正确。');
      checkRevision(row, event.revision);
      if (row.reviewState !== 'needs') fail('CONFLICT', '只有退回补件的申请可以补传。');
      const removeIds = event.removeIds === undefined ? [] : event.removeIds;
      if (!Array.isArray(removeIds) || new Set(removeIds).size !== removeIds.length ||
        removeIds.some(fileId => !row.files.some(file => file.id === fileId))) fail('INVALID_FILE', '请选择本申请中的材料。');
      const previous = row.files.filter(file => !removeIds.includes(file.id));
      const files = await filesFor(tx, event.fileIds, id, row._id, previous);
      checkMaterials(files, row.cents, row.category);
      const next = await update(tx, row, { files, reviewState: 'review', supplementRequest: event.requestId, supplementActor: id }, id, 'supplement');
      for (const fileId of event.fileIds) await fileRef(tx, fileId).update({ data: { usedBy: row._id } });
      await notice(tx, next, 'role:finance_admin', '报销补件待核验', '申请人已补传材料，请重新核验。');
      return next;
    });
    return { claim: view(result) };
  }
  async function review(id, event) {
    const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
    if (typeof event.pass !== 'boolean' || (!event.pass && (!reason || reason.length > 300))) fail('INVALID_INPUT', '请填写不超过 300 字的补件说明。');
    const row = await run(async tx => {
      const current = await actor(id, tx), previous = await claim(event.claimId, tx);
      if (event.pass || current.finance) requireRole(current, 'finance');
      else {
        requireRole(current, 'reviewer');
        if (!previous.weekStart || feishu) fail('FORBIDDEN', '请在飞书填写报送后补件要求。');
      }
      checkRevision(previous, event.revision);
      if (previous.stage === 5 || (event.pass && previous.reviewState !== 'review') || (!event.pass && previous.reviewState === 'needs'))
        fail('CONFLICT', '当前状态不能执行此操作。');
      if (!event.pass) {
        const next = await update(tx, previous, { reviewState: 'needs', reason }, id, 'request_materials');
        await notice(tx, next, previous.ownerId, '报销申请需要补件', '请打开申请查看补件要求。');
        return next;
      }
      checkMaterials(previous.files, previous.cents, previous.category);
      const next = await update(tx, previous, { reviewState: 'ready', reason: '', checkedMs: clock(), stage: Math.max(1, previous.stage),
        materialVersion: previous.materialVersion + 1, approvedFiles: previous.files, syncAttemptMs: 0, syncDirty: true }, id, 'verify');
      await notice(tx, next, previous.ownerId, '报销材料已核验', '财务专员已核验这笔申请。');
      return next;
    });
    return { claim: view(row) };
  }
  async function sendWeek(id, event) {
    const { week, ids } = event;
    if (!validWeek(week) || week > monday(clock()) || !Array.isArray(ids) || !ids.length || ids.length > 20 ||
      new Set(ids).size !== ids.length || ids.some(value => !claimPattern.test(value || ''))) fail('INVALID_INPUT', '请选择有效周次和 1 至 20 笔申请。');
    await run(async tx => {
      requireRole(await actor(id, tx), 'finance');
      const ref = tx.collection('financeWeeks').doc(week);
      const archive = document(await ref.get());
      const rows = [];
      for (const claimId of ids) rows.push(await claim(claimId, tx));
      if (rows.some(row => row.weekStart ? row.weekStart !== week : row.reviewState !== 'ready')) fail('CONFLICT', '只能报送已核验且未归入其他周次的申请。');
      const fresh = rows.filter(row => !row.weekStart);
      if (!fresh.length) return;
      const claimIds = [...new Set((archive && archive.claimIds || []).concat(fresh.map(row => row._id)))];
      if (claimIds.length > 100) fail('WEEK_LIMIT', '初版每周最多归档 100 笔申请。');
      for (const row of fresh) await update(tx, row, { weekStart: week, sentMs: clock(), syncAttemptMs: 0, syncActive: true, syncDirty: true }, id, 'report_week');
      await ref.set({ data: { teamId: TEAM, claimIds, updatedMs: clock() } });
    });
    return {};
  }
  async function move(id, event) {
    const target = event.stage;
    const row = await run(async tx => {
      const current = await actor(id, tx), previous = await claim(event.claimId, tx);
      requireRole(current, target === 5 ? 'finance' : 'reviewer');
      if (target !== 5 && feishu) fail('FORBIDDEN', '飞书已接入，请在飞书更新处理进度。');
      checkRevision(previous, event.revision);
      if (!Number.isInteger(target) || target < 2 || target > 5 || !previous.weekStart ||
        previous.reviewState !== 'ready' || target !== previous.stage + 1 ||
        (target === 5 && event.received !== true)) fail('CONFLICT', '请按顺序更新进度，到账须由同学确认。');
      const next = await update(tx, previous, { stage: target, ...(target === 5 ? { paidMs: clock(), syncAttemptMs: 0, syncActive: true, syncDirty: true } : {}) }, id, 'advance');
      await notice(tx, next, previous.ownerId, '报销进度已更新', '当前进度为「' + stages[target] + '」。');
      return next;
    });
    return { claim: view(row) };
  }
  async function list(id, event) {
    const current = await actor(id);
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_INPUT', '分页参数无效。');
    const filters = { teamId: TEAM };
    if (event.scope === 'queue') {
      requireRole(current, 'finance');
      if (event.queue === 'report') Object.assign(filters, { weekStart: '', reviewState: 'ready' });
      if (event.queue === 'review') filters.reviewState = 'review';
      if (event.queue === 'needs') filters.reviewState = 'needs';
    } else {
      filters.ownerId = id;
      if (studentOnly && event.category) {
        if (!studentCategories.includes(event.category)) fail('INVALID_INPUT', '报销类别无效。');
        filters.category = event.category;
      }
    }
    const { data } = await db.collection('financeClaims').where(filters).orderBy('createdMs', 'desc').orderBy('_id', 'desc').skip(offset).limit(31).get();
    return { claims: data.slice(0, 30).map(view), hasMore: data.length > 30, current, stages, categories: studentOnly ? studentCategories : configuredCategories,
      week: monday(clock()), feishuEnabled: !!feishu, studentOnly,
      ...(studentOnly && studentSubmit ? { studentRules: studentPolicy.rules, studentFileKinds: studentPolicy.kinds } : {}) };
  }
  async function weekRows(week) {
    if (!validWeek(week)) fail('INVALID_INPUT', '请选择周一作为周次。');
    const row = await read(db, 'financeWeeks', week);
    if (!row || row.teamId !== TEAM || !row.claimIds.length) return [];
    const blocks = [];
    for (let offset = 0; offset < row.claimIds.length; offset += 20) {
      const ids = row.claimIds.slice(offset, offset + 20);
      blocks.push(db.collection('financeClaims').where({ teamId: TEAM, weekStart: week, _id: db.command.in(ids) }).limit(20).get());
    }
    const rows = new Map((await Promise.all(blocks)).flatMap(result => result.data.map(item => [item._id, item])));
    if (rows.size !== row.claimIds.length) fail('CONFLICT', '周次记录有变化，请刷新。');
    return row.claimIds.map(id => rows.get(id));
  }
  async function weekView(id, event) {
    const current = await actor(id);
    if (!current.finance) requireRole(current, 'reviewer');
    const rows = await weekRows(event.week);
    const inbox = current.finance ? (await db.collection('financeClaims').where({ teamId: TEAM, collectedWeek: event.week, weekStart: '' })
      .orderBy('createdMs', 'desc').orderBy('_id', 'desc').limit(51).get()).data : [];
    return { claims: rows.map(row => ({
      ...view(current.finance ? row : { ...row, files: row.approvedFiles }),
      invoiceCount: row.approvedFiles.filter(file => file.kind === 'invoice').length
    })), inbox: inbox.slice(0, 50).map(view), hasMoreInbox: inbox.length > 50, syncErrors: rows.filter(row => row.syncError).length,
      lastSyncMs: Math.max(0, ...rows.map(row => row.syncMs)), pendingSync: feishu ? rows.filter(row => row.syncDirty || row.syncError).length : 0 };
  }
  async function get(id, event) {
    const current = await actor(id), row = await claim(event.claimId);
    if (!canSee(current, row)) fail('FORBIDDEN', '无权查看该申请。');
    if (current.reviewer && !current.finance && current.id !== row.ownerId) return { claim: view({ ...row, files: row.approvedFiles }) };
    if (current.financeDesk) {
      const [record] = await deskNames([row]);
      return { claim: deskDetail(record) };
    }
    return { claim: view(row) };
  }

  const deskFiles = row => row.files?.length ? row.files : row.approvedFiles || [];
  const deskDetail = row => ({ ...view({ ...row, files: deskFiles(row) }), progressVersion: progressVersion(row) });
  const cursorFor = row => ({ id: row._id, createdMs: row.createdMs });
  const submissionLabel = files => files.some(file => file.kind === 'invoice') ? '已提交发票' :
    files.length ? '已提交附件 · 缺少发票' : '已登记 · 无线上附件';
  async function deskNames(rows) {
    const missing = [...new Set(rows.filter(row => !inputText(row.ownerName)).map(row => row.ownerId).filter(id => idPattern.test(id)))];
    const names = new Map();
    for (let offset = 0; offset < missing.length; offset += 20) {
      const { data } = await db.collection('userProfiles').where({ _id: db.command.in(missing.slice(offset, offset + 20)) }).limit(20).get();
      for (const profile of data) names.set(profile._id, inputText(profile.name));
    }
    return rows.map(row => ({ ...row, ownerName: inputText(row.ownerName) || names.get(row.ownerId) || '未登记姓名' }));
  }
  async function deskRows(week, ownerId, cursor, limit) {
    if (!validWeek(week)) fail('INVALID_INPUT', '请选择有效的提交周。');
    if (ownerId !== undefined && !idPattern.test(ownerId)) fail('INVALID_INPUT', '报销人无效。');
    const start = Date.parse(week + 'T00:00:00+08:00');
    const end = start + WEEK_MS;
    const cmd = db.command;
    const filters = { teamId: TEAM, createdMs: cmd.and([cmd.gte(start), cmd.lt(end)]),
      ...(ownerId ? { ownerId } : {}) };
    if (cursor !== undefined && (!cursor || !claimPattern.test(cursor.id) ||
        !Number.isSafeInteger(cursor.createdMs) || cursor.createdMs < start || cursor.createdMs >= end)) {
      fail('INVALID_INPUT', '分页参数无效。');
    }
    const where = cursor ? cmd.and([filters, cmd.or([
      { createdMs: cmd.lt(cursor.createdMs) }, { createdMs: cursor.createdMs, _id: cmd.lt(cursor.id) }
    ])]) : filters;
    return (await db.collection('financeClaims').where(where).orderBy('createdMs', 'desc').orderBy('_id', 'desc').limit(limit).get()).data;
  }
  async function deskWeek(id, event) {
    requireRole(await actor(id), 'financeDesk');
    const rows = await deskRows(event.week, undefined, event.cursor, DESK_PAGE_SIZE + 1);
    const page = await deskNames(rows.slice(0, DESK_PAGE_SIZE));
    return { weekInfo: deskWeekInfo(event.week), claims: page.map(row => {
      const files = deskFiles(row);
      const { id, ownerId, ownerName, number, category, cents, createdMs, stage, stageLabel, reviewState } = view({ ...row, files: [] });
      return { id, ownerId, ownerName, number, category, cents, createdMs, stage, stageLabel, reviewState, files: [],
        invoiceCount: files.filter(file => file.kind === 'invoice').length, submission: submissionLabel(files) };
    }), nextCursor: rows.length > DESK_PAGE_SIZE ? cursorFor(page[page.length - 1]) : null };
  }
  async function deskProgress(id, event) {
    const { stage, received, version } = event;
    const row = await run(async tx => {
      requireRole(await actor(id, tx), 'financeDesk');
      if (!Number.isInteger(stage) || !stages[stage] || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))
        fail('INVALID_INPUT', '请选择有效的报销进度。');
      if (stage === stages.length - 1 && received !== true) fail('INVALID_INPUT', '请在同学确认收款后登记已到账。');
      const previous = await claim(event.claimId, tx);
      const current = view(previous);
      if (stage === current.stage) return previous;
      if (version !== progressVersion(previous)) fail('CONFLICT', '这笔申请的进度已被更新，请刷新后重试。');
      const now = clock();
      const next = await update(tx, previous, {
        stage, status: stages[stage], reviewState: stage ? 'ready' : 'review', reason: '',
        checkedMs: stage ? previous.checkedMs || now : 0, paidMs: stage === stages.length - 1 ? now : 0, updatedAt: localMinute(now)
      }, id, 'desk_progress', now);
      await notice(tx, next, previous.ownerId, '报销进度已更新', '当前进度为「' + stages[stage] + '」。');
      return next;
    });
    const [record] = await deskNames([row]);
    return { claim: deskDetail(record) };
  }
  async function deskArchive(id, event) {
    const authorize = current => requireRole(current, 'financeDesk');
    authorize(await actor(id));
    const rows = [];
    let cursor;
    do {
      const batch = await deskRows(event.week, event.ownerId, cursor, DESK_PAGE_SIZE);
      rows.push(...batch);
      if (rows.length > ARCHIVE_CLAIM_LIMIT)
        fail('FILE_LIMIT', event.ownerId ? '该成员本周申请超过 200 笔。' : '本周申请超过 200 笔，请按人导出。');
      cursor = batch.length === DESK_PAGE_SIZE ? cursorFor(batch[batch.length - 1]) : undefined;
    } while (cursor);
    if (!rows.length) fail('NOT_FOUND', '该周没有可导出的报销申请。');
    const claims = (await deskNames(rows)).map(row => {
      const approvedFiles = deskFiles(row);
      const { id, ownerId, ownerName, number, category, cents, createdMs, updatedMs, updatedAt, stageLabel, reviewState } = view({ ...row, files: [] });
      const progress = reviewState === 'needs' ? '待补件' : reviewState === 'review' && stageLabel !== stages[0] ? '补件待核验' : stageLabel;
      return { _id: id, ownerId, ownerName, number, category, cents, createdMs, updatedMs, updatedAt,
        progress, submission: submissionLabel(approvedFiles), approvedFiles };
    });
    const weekInfo = deskWeekInfo(event.week);
    const weekName = weekInfo.label ? weekInfo.label + '_' + weekInfo.start : weekInfo.start;
    const archiveId = 'fa_' + hash(JSON.stringify(['financeDesk-v2', weekName, event.ownerId || '', claims])).slice(0, 32);
    const title = event.ownerId ? claims[0].ownerName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 24) : '全部成员';
    return saveArchive(id, event.week, archiveId, claims, authorize, {
      source: 'financeDesk', weekName, name: weekName + '_' + title + '_报销材料.zip'
    });
  }

  async function openArchive(id, event) {
    const authorize = current => { if (!current.finance) requireRole(current, 'reviewer'); };
    authorize(await actor(id));
    const rows = await weekRows(event.week);
    if (!rows.length) fail('NOT_FOUND', '该周暂无已报送申请。');
    const archiveId = 'fa_' + hash(event.week + ':' + rows.map(row => row._id + ':' + row.materialVersion).join(',')).slice(0, 32);
    return saveArchive(id, event.week, archiveId, rows, authorize, { name: event.week + '_报销材料_' + archiveId.slice(-8) + '.zip' });
  }
  async function saveArchive(id, week, archiveId, rows, authorize, metadata) {
    if (rows.reduce((sum, row) => sum + row.approvedFiles.reduce((size, file) => size + file.size, 0), 0) > ARCHIVE_SIZE_LIMIT)
      fail('FILE_LIMIT', metadata.source ? '材料超过 64 MB，请尝试按人导出。' : '该周材料超过初版周包的 64 MB 上限。');
    const viewArchive = data => ({ id: archiveId, size: data.size, name: data.name, ext: 'zip' });
    const existing = await read(db, 'financeArchives', archiveId);
    if (existing) return { file: viewArchive(existing) };
    const bytes = await makeArchive(metadata.weekName || week, rows, storage, { desk: metadata.source === 'financeDesk' });
    const fileID = await storage.freeze(bytes, 'zip');
    const data = { teamId: TEAM, week, fileID, size: bytes.length, ...metadata };
    let retained = false;
    try {
      const stored = await run(async tx => {
        authorize(await actor(id, tx));
        const cached = await read(tx, 'financeArchives', archiveId);
        if (cached) return cached;
        await tx.collection('financeArchives').doc(archiveId).set({ data });
        return data;
      });
      retained = stored.fileID === fileID;
      return { file: viewArchive(stored) };
    } finally { if (!retained) await storage.remove(fileID); }
  }
  async function chunk(id, event) {
    const current = await actor(id);
    let file;
    if (archivePattern.test(event.fileId || '')) {
      if (studentOnly) requireRole(current, 'financeDesk');
      else if (!current.finance) requireRole(current, 'reviewer');
      file = await read(db, 'financeArchives', event.fileId);
      if (!file || file.teamId !== TEAM || (file.source === 'financeDesk') !== studentOnly) fail('NOT_FOUND', '周包不存在，请重新生成。');
    } else {
      const row = await claim(event.claimId);
      if (!canSee(current, row)) fail('FORBIDDEN', '无权下载该申请材料。');
      const files = current.financeDesk ? deskFiles(row) : (current.reviewer && !current.finance && current.id !== row.ownerId ? row.approvedFiles : row.files) || [];
      file = files.find(value => value.id === event.fileId);
      if (!file) fail('NOT_FOUND', '该申请中没有此附件。');
    }
    const { offset } = event;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) fail('INVALID_INPUT', '下载范围不正确。');
    const length = Math.min(384 * 1024, file.size - offset);
    const bytes = await storage.slice(file.fileID, offset, length, file.size);
    if (bytes.length !== length) fail('INCOMPLETE_DOWNLOAD', '文件读取不完整，请重试。');
    return { data: bytes.toString('base64'), nextOffset: offset + length, total: file.size };
  }

  async function syncRow(input) {
    const lease = randomUUID();
    const row = await run(async tx => {
      const current = await claim(input._id, tx);
      if (current.syncLeaseUntil > clock()) return null;
      await claimRef(tx, current._id).update({ data: { syncLease: lease, syncLeaseUntil: clock() + 60000, syncAttemptMs: clock() } });
      return current;
    });
    if (!row) return true;
    let remote, syncError = '';
    try { remote = await feishu.exchange(row); }
    catch (error) { syncError = String(error.code || 'FEISHU_SYNC_FAILED').slice(0, 64); }
    await run(async tx => {
      const current = await claim(row._id, tx);
      if (current.syncLease !== lease) return;
      const ref = claimRef(tx, current._id), release = { syncLease: '', syncLeaseUntil: 0 };
      if (current.revision !== row.revision) {
        await ref.update({ data: release });
        return;
      }
      if (syncError) {
        await ref.update({ data: { ...release, syncError } });
        if (!current.syncError) {
          await notice(tx, { ...current, revision: current.revision + ':sync:' + lease }, 'role:finance_admin',
            '报销同步失败', '请检查飞书配置或重试该周同步。');
        }
        return;
      }
      const metadata = { ...release, feishuId: remote.id, syncMs: clock(), syncError: '', syncActive: current.stage < 5, syncDirty: false,
        ...(remote.needs ? {} : { lastFeishuNeed: '' }) };
      if (current.stage < 5 && remote.needs && remote.needs !== current.lastFeishuNeed) {
        const next = await update(tx, current, { ...metadata, reviewState: 'needs', reason: remote.needs, lastFeishuNeed: remote.needs }, 'feishu', 'request_materials');
        await notice(tx, next, current.ownerId, '报销申请需要补件', '助理已更新补件要求，请查看原申请。');
        await notice(tx, next, 'role:finance_admin', '助理要求补件', '请跟进已报送的报销申请。');
      } else if (current.reviewState === 'ready' && remote.stage > current.stage && remote.stage <= 4) {
        const next = await update(tx, current, { ...metadata, stage: remote.stage }, 'feishu', 'advance');
        await notice(tx, next, current.ownerId, '报销进度已更新', '当前进度为「' + stages[next.stage] + '」。');
      } else await ref.update({ data: metadata });
    });
    return !syncError;
  }
  async function syncWeek(id, event) {
    requireRole(await actor(id), 'finance');
    if (!feishu) fail('NOT_CONFIGURED', '尚未配置飞书同步。');
    const offset = Number.isSafeInteger(event.offset) && event.offset >= 0 ? event.offset : 0;
    const rows = await weekRows(event.week);
    const results = await Promise.all(rows.slice(offset, offset + 5).map(syncRow));
    return { failed: results.filter(result => !result).length, nextOffset: offset + results.length, hasMore: offset + results.length < rows.length };
  }
  async function tick() {
    if (!feishu) return { ok: true, configured: false };
    const { data } = await db.collection('financeClaims').where({ teamId: TEAM, syncActive: true })
      .orderBy('syncAttemptMs', 'asc').limit(5).get();
    const results = await Promise.all(data.map(syncRow));
    return { ok: true, synced: results.filter(Boolean).length, failed: results.filter(result => !result).length };
  }

  const studentHandlers = { list, get, chunk };
  const handlers = studentOnly ? { ...studentHandlers, ...(studentSubmit ? { prepare, finish, submit } : {}),
    ...(financeDesk ? { deskWeek, deskArchive, deskProgress } : {}) } : {
    ...studentHandlers, prepare, finish, submit, supplement, review, sendWeek, move, weekView, openArchive, syncWeek
  };
  async function dispatch(id, event) {
    if (!Object.prototype.hasOwnProperty.call(handlers, event.action)) fail('INVALID_INPUT', '未知的报销操作。');
    return { ok: true, ...await handlers[event.action](id, event) };
  }
  return { dispatch, tick };
};
