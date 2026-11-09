const { createHash, randomUUID } = require('node:crypto');
const sync = require('./sync');
const DAY = 86400000;
const TYPES = ['事假', '病假', '其他'];
const PENDING = ['pending', 'cancel_pending'];
const LABELS = { pending: '待审批', approved: '已通过', rejected: '未通过', withdrawn: '已撤回', cancel_pending: '取消待审批', cancelled: '已取消', cancel_rejected: '取消未通过' };
const ID = /^lv_[a-f0-9]{32}$/;
const USER = /^user_[a-f0-9]{32}$/;
const document = result => Array.isArray(result.data) ? result.data[0] : result.data;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const reject = (code, message) => { throw Object.assign(new Error(message), { businessCode: code }); };
function timestamp(day, time) {
  if (typeof day !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(day) || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const value = Date.parse(day + 'T' + time + ':00+08:00');
  return Number.isFinite(value) && china(value).slice(0, 10) === day ? value : NaN;
}
function china(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function range(row) {
  if (!row.allDay) return china(row.startMs) + ' 至 ' + china(row.endMs);
  const first = china(row.startMs).slice(0, 10), last = china(row.endMs - DAY).slice(0, 10);
  return (first === last ? first : first + ' 至 ' + last) + ' · 全天';
}
function reason(value, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((required && !text) || text.length > 300) reject('INVALID_INPUT', '请填写1至300字的说明。');
  return text;
}
module.exports = function leave(db, access, messages, now = Date.now) {
  const member = async (store, id) => document(await store.collection('teamMembers').doc(id).get());
  const get = async (store, id) => document(await store.collection('leaveRequests').doc(id).get());
  const active = row => row && row.teamId === access.TEAM_ID && row.status === 'active';
  const leader = row => active(row) && Array.isArray(row.roles) && row.roles.includes('leader');
  async function authorize(store, id) {
    const actor = await member(store, id);
    if (!active(actor)) reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能使用请假。');
    return actor;
  }
  function canReview(row, id, actor) { return row.reviewerId === id && row.ownerId !== id && leader(actor); }
  async function name(store, id) {
    const profile = document(await store.collection('userProfiles').doc(id).get());
    return profile && profile.name || '团队成员';
  }
  function summary(row) {
    return { id: row._id, leaveId: row._id, title: row.ownerName, type: '请假', createdMs: row.createdMs, timeRange: range(row),
      statusLabel: LABELS[row.status], statusTone: row.status === 'approved' ? 'success' : ['rejected', 'cancel_rejected'].includes(row.status) ? 'rejected' : 'pending' };
  }
  async function reviewers(id) {
    await authorize(db, id);
    const rows = [], pageSize = 50;
    for (let offset = 0; ; offset += pageSize) {
      const result = await db.collection('teamMembers').where({ teamId: access.TEAM_ID, status: 'active' })
        .orderBy('_id', 'asc').skip(offset).limit(pageSize).get();
      rows.push(...result.data.filter(row => row._id !== id && leader(row)));
      if (result.data.length < pageSize) break;
    }
    const options = await Promise.all(rows.map(async row => ({ id: row._id, name: await name(db, row._id) })));
    await authorize(db, id);
    return { ok: true, reviewers: options };
  }
  async function list(id, event) {
    const scope = event.scope || 'mine', offset = event.offset === undefined ? 0 : event.offset;
    if (!['mine', 'pending', 'done'].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '请假列表参数不正确。');
    const actor = await authorize(db, id);
    if (scope !== 'mine' && !leader(actor)) reject('FORBIDDEN', '仅领导可以审批请假。');
    const filter = { teamId: access.TEAM_ID, ...(scope === 'mine' ? { ownerId: id } : { reviewerId: id }),
      ...(scope === 'pending' ? { status: db.command.in(PENDING) } : scope === 'done' ? { reviewedBy: id } : {}) };
    const result = await db.collection('leaveRequests').where(filter).orderBy('createdMs', 'desc').orderBy('_id', 'desc').skip(offset).limit(51).get();
    const current = await authorize(db, id);
    if (scope !== 'mine' && !leader(current)) reject('FORBIDDEN', '请假审批权限已变化。');
    const rows = result.data.slice(0, 50);
    return { ok: true, requests: rows.map(row => ({
      ...summary(scope === 'done' ? { ...row, status: row.reviewedStatus } : row),
      ...(scope === 'mine' ? { title: row.leaveType } : {})
    })), nextOffset: offset + rows.length, hasMore: result.data.length > 50 };
  }
  async function detail(id, event) {
    if (!ID.test(event.id || '')) reject('INVALID_INPUT', '请假单参数不正确。');
    const row = await get(db, event.id);
    const actor = await authorize(db, id);
    if (!row || row.teamId !== access.TEAM_ID || (row.ownerId !== id && !canReview(row, id, actor))) reject('NOT_FOUND', '请假单不存在或无权查看。');
    const own = row.ownerId === id, pending = PENDING.includes(row.status), beforeStart = now() < row.startMs;
    const needsReviewer = own && (pending || row.status === 'approved' && beforeStart) && !leader(await member(db, row.reviewerId));
    return { ok: true, request: { ...summary(row), leaveType: row.leaveType, ownerName: row.ownerName, reviewerName: row.reviewerName,
      reason: row.reason, decisionNote: row.decisionNote || '', cancellationReason: row.cancellationReason || '', cancellationNote: row.cancellationNote || '',
      retroactive: row.allDay ? china(row.startMs).slice(0, 10) < china(row.createdMs).slice(0, 10) : row.startMs < row.createdMs,
      revision: row.revision, canReview: pending && canReview(row, id, actor),
      canApprove: row.status !== 'cancel_pending' || beforeStart, canWithdraw: own && pending, canCancel: own && row.status === 'approved' && beforeStart,
      canReassign: needsReviewer, withdrawalLabel: row.status === 'cancel_pending' ? '撤回取消申请' : '撤回申请',
      reviewTitle: row.status === 'cancel_pending' ? '审批取消申请' : '审批请假', approveLabel: row.status === 'cancel_pending' ? '同意取消' : '通过' } };
  }
  async function choose(store, ownerId, reviewerId) {
    if (!USER.test(reviewerId || '') || ownerId === reviewerId || !leader(await member(store, reviewerId))) {
      reject('NO_REVIEWER', '请选择一位仍在团队中的其他领导审批。');
    }
    return name(store, reviewerId);
  }
  function audit(tx, row, id, action, at, note = '') {
    return tx.collection('leaveAudit').doc(row._id + '_' + row.revision).set({ data: {
      leaveId: row._id, teamId: row.teamId, actorId: id, action, status: row.status, createdMs: at, note
    } });
  }
  function notice(tx, row, recipientKey, title, at, pending = false) {
    const id = 'msg_' + hash('leave:' + row._id + ':' + row.revision + ':' + recipientKey);
    return messages.put(tx, { _id: id, teamId: row.teamId, recipientKey, kind: 'leave', subjectId: row._id, title,
      body: '打开查看请假单。', createdMs: at, state: pending ? 'open' : 'resolved', readBy: [] }).then(() => id);
  }
  async function submit(id, event) {
    const at = now();
    if (!TYPES.includes(event.leaveType) || typeof event.allDay !== 'boolean' || typeof event.requestId !== 'string' || !/^[a-z0-9]{12,64}$/.test(event.requestId)) reject('INVALID_INPUT', '请假申请参数不正确。');
    const startMs = timestamp(event.startDate, event.allDay ? '00:00' : event.startTime);
    const endDay = timestamp(event.endDate, event.allDay ? '00:00' : event.endTime);
    const endMs = endDay + (event.allDay ? DAY : 0);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) reject('INVALID_RANGE', '请填写有效的起止时间，结束须晚于开始。');
    const body = reason(event.reason), requestId = 'lv_' + hash(id + ':' + event.requestId);
    const payload = { reviewerId: event.reviewerId, leaveType: event.leaveType, allDay: event.allDay, startMs, endMs, reason: body };
    await authorize(db, id);
    const lockRef = db.collection('leaveLocks').doc(id);
    const version = document(await lockRef.get());
    const overlap = await db.collection('leaveRequests').where({ teamId: access.TEAM_ID, ownerId: id,
      status: db.command.in(['pending', 'approved', 'cancel_pending']), startMs: db.command.lte(endMs - 1), endMs: db.command.gt(startMs) }).limit(1).get();
    const result = await db.runTransaction(async tx => {
      await authorize(tx, id);
      const previous = await get(tx, requestId);
      if (previous) {
        if (previous.ownerId !== id || previous.submissionHash !== hash(JSON.stringify(payload))) reject('CONFLICT', '该提交已处理，请返回查看记录。');
        return { ok: true, id: requestId };
      }
      const lock = tx.collection('leaveLocks').doc(id);
      const current = document(await lock.get());
      // The SDK uses document transactions; fence the overlap query with an owner-specific write.
      if ((current && current.version) !== (version && version.version)) reject('CONFLICT', '有另一条请假申请刚刚提交，请重试。');
      if (overlap.data.length) reject('OVERLAP', '所选时段与待审批或已通过的请假重叠。');
      const reviewerName = await choose(tx, id, event.reviewerId);
      const ownerName = await name(tx, id);
      const row = { _id: requestId, ...payload, teamId: access.TEAM_ID, ownerId: id, ownerName, reviewerName,
        status: 'pending', createdMs: at, updatedMs: at, revision: 1, submissionHash: hash(JSON.stringify(payload)) };
      const pendingMessageId = await notice(tx, row, row.reviewerId, '请假待审批', at, true);
      const { _id, ...data } = row;
      await tx.collection('leaveRequests').doc(_id).set({ data: { ...data, pendingMessageId } });
      await lock.set({ data: { version: randomUUID() } });
      await audit(tx, row, id, 'submit', at);
      await sync.bump(tx, ['home', 'approvals']);
      return { ok: true, id: requestId };
    });
    return result && result.result || result;
  }
  async function change(id, event) {
    if (!ID.test(event.id || '') || !Number.isSafeInteger(event.revision) || event.revision < 1) reject('INVALID_INPUT', '请假单参数不正确。');
    const action = event.action;
    const result = await db.runTransaction(async tx => {
      const actor = await authorize(tx, id), row = await get(tx, event.id);
      const at = now();
      const review = action === 'leaveReview';
      if (!row || row.teamId !== access.TEAM_ID || (review ? !canReview(row, id, actor) : row.ownerId !== id)) reject('FORBIDDEN', '无权处理此请假单。');
      if (row.revision !== event.revision) reject('CONFLICT', '请假单已更新，请刷新后重试。');
      const next = { ...row, revision: row.revision + 1, updatedMs: at, pendingMessageId: '' };
      let notify = '', note = '';
      if (review && PENDING.includes(row.status) && ['approve', 'reject'].includes(event.decision)) {
        const cancel = row.status === 'cancel_pending', approved = event.decision === 'approve';
        if (cancel && approved && at >= row.startMs) reject('INVALID_STATE', '请假已开始，不能批准取消。');
        note = reason(event.note, !approved);
        next.status = cancel ? approved ? 'cancelled' : 'approved' : approved ? 'approved' : 'rejected';
        next[cancel ? 'cancellationNote' : 'decisionNote'] = note;
        next.reviewedBy = id;
        next.reviewedStatus = cancel && !approved ? 'cancel_rejected' : next.status;
        notify = cancel ? approved ? '请假已取消' : '取消请假未通过' : approved ? '请假已通过' : '请假未通过';
      } else if (action === 'leaveWithdraw' && PENDING.includes(row.status)) {
        next.status = row.status === 'pending' ? 'withdrawn' : 'approved';
        if (row.status === 'cancel_pending') { next.cancellationReason = ''; next.cancellationNote = ''; }
      } else if (action === 'leaveCancel' && row.status === 'approved' && at < row.startMs) {
        if (!leader(await member(tx, row.reviewerId))) reject('NO_REVIEWER', '原审批人不可用，请先更换审批人。');
        note = reason(event.note);
        next.status = 'cancel_pending'; next.cancellationReason = note; next.cancellationNote = '';
      } else if (action === 'leaveReassign' && (PENDING.includes(row.status) || row.status === 'approved' && at < row.startMs)) {
        if (leader(await member(tx, row.reviewerId))) reject('INVALID_STATE', '原审批人仍可处理此申请。');
        next.reviewerName = await choose(tx, id, event.reviewerId); next.reviewerId = event.reviewerId;
      } else reject('INVALID_STATE', '当前状态不能执行此操作。');
      if (row.pendingMessageId) await tx.collection('teamMessages').doc(row.pendingMessageId).update({ data: { state: 'resolved' } });
      if (PENDING.includes(next.status)) next.pendingMessageId = await notice(tx, next, next.reviewerId, next.status === 'pending' ? '请假待审批' : '取消请假待审批', at, true);
      if (notify) await notice(tx, next, row.ownerId, notify, at);
      const { _id, ...data } = next;
      await tx.collection('leaveRequests').doc(_id).update({ data });
      await audit(tx, next, id, action, at, note);
      await sync.bump(tx, ['home', 'approvals', 'messages']);
      return { ok: true, id: _id };
    });
    return result && result.result || result;
  }
  async function todos(id) {
    if (!leader(await member(db, id))) return [];
    try { return (await list(id, { scope: 'pending' })).requests; }
    catch (error) {
      if (['FORBIDDEN', 'MEMBERSHIP_REQUIRED'].includes(error.businessCode)) return [];
      // Leave configuration failures must not hide other workbench tasks.
      console.error('Leave todos unavailable:', error.errCode || error.code || 'LEAVE_TODOS_FAILED');
      return [];
    }
  }
  return { reviewers, list, detail, submit, change, todos };
};
