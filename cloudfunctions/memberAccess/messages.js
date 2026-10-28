const { createHash } = require('node:crypto');
const sync = require('./sync');
const collection = 'teamMessages';
function key(value) { return 'msg_' + createHash('sha256').update(value).digest('hex').slice(0, 32); }
function document(result) { return Array.isArray(result.data) ? result.data[0] : result.data; }

module.exports = function messages(db, access) {
  function filter(id, member, unreadOnly = false) {
    const recipients = [id];
    if (access.allowed(member, 'members.manage')) recipients.push('role:super_admin');
    return { teamId: access.TEAM_ID, recipientKey: db.command.in(recipients),
      ...(unreadOnly ? { readBy: db.command.nin([id]) } : {}) };
  }
  async function state(id, member) {
    const result = await db.collection(collection).where(filter(id, member, true)).field({ _id: true }).limit(100).get();
    const unreadCount = result.data.length;
    return { hasUnread: unreadCount > 0, unreadCount };
  }
  async function unread(id, member) { return (await state(id, member)).hasUnread; }
  function visible(message, id, member) {
    return message && message.teamId === access.TEAM_ID && (message.recipientKey === id ||
      Array.isArray(message.recipientKey) && message.recipientKey.includes(id) ||
      message.recipientKey === 'role:super_admin' && access.allowed(member, 'members.manage'));
  }
  async function readAll(id, event) {
    const now = Date.now(), readBeforeMs = event.readBeforeMs === undefined ? now : event.readBeforeMs;
    if (!Number.isSafeInteger(readBeforeMs) || readBeforeMs < 0 || readBeforeMs > now) return { ok: false, code: 'INVALID_INPUT', message: '消息参数不正确。' };
    const member = await access.readMember(db, id);
    if (!access.allowed(member, 'equipment.read')) return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '通过 IMC 成员审核后才能访问。' };
    const rows = (await db.collection(collection).where({ ...filter(id, member, true), createdMs: db.command.lte(readBeforeMs) }).field({ _id: true }).limit(40).get()).data;
    const result = await db.runTransaction(async transaction => {
      const current = document(await transaction.collection('teamMembers').doc(id).get());
      if (!access.allowed(current, 'equipment.read')) return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '通过 IMC 成员审核后才能访问。' };
      const records = await Promise.all(rows.map(row => transaction.collection(collection).doc(row._id).get()));
      const marked = records.map(document).filter(message => visible(message, id, current) && message.createdMs <= readBeforeMs && !(message.readBy || []).includes(id));
      for (const message of marked) await transaction.collection(collection).doc(message._id).update({ data: { readBy: db.command.addToSet(id) } });
      if (marked.length) await sync.bump(transaction, ['messages']);
      return { ok: true, readIds: marked.map(message => message._id) };
    });
    const response = result && result.result || result;
    if (!response.ok) return response;
    const current = await access.readMember(db, id);
    if (!access.allowed(current, 'equipment.read')) return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '通过 IMC 成员审核后才能访问。' };
    const remaining = await db.collection(collection).where({ ...filter(id, current, true), createdMs: db.command.lte(readBeforeMs) }).field({ _id: true }).limit(1).get();
    return { ok: true, readBeforeMs, readIds: response.readIds, hasMore: remaining.data.length > 0, ...await state(id, current) };
  }
  function present(message, id) {
    return { id: message._id, title: message.title, body: message.body,
      createdMs: message.createdMs, read: (message.readBy || []).includes(id),
      resolved: message.state === 'resolved' };
  }
  async function list(id, event) {
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: 'INVALID_INPUT', message: '分页参数不正确。' };
    const member = await access.readMember(db, id);
    const result = await db.collection(collection).where(filter(id, member))
      .orderBy('createdMs', 'desc').orderBy('_id', 'desc').skip(offset).limit(51).get();
    const rows = result.data.slice(0, 50);
    return { ok: true, messages: rows.map(row => present(row, id)), nextOffset: offset + rows.length, hasMore: result.data.length > 50,
      ...await state(id, member) };
  }
  async function read(id, event, markRead = true) {
    if (typeof event.id !== 'string' || !/^msg_[a-f0-9]{32}$/.test(event.id)) return { ok: false, code: 'INVALID_INPUT', message: '消息参数不正确。' };
    const result = await db.runTransaction(async transaction => {
      let url = '';
      const member = document(await transaction.collection('teamMembers').doc(id).get());
      if (!access.allowed(member, 'equipment.read')) return { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '通过 IMC 成员审核后才能访问。' };
      const reference = transaction.collection(collection).doc(event.id);
      const message = document(await reference.get());
      const canManage = access.allowed(member, 'members.manage');
      if (!message || message.teamId !== access.TEAM_ID ||
        (message.recipientKey !== id && !(Array.isArray(message.recipientKey) && message.recipientKey.includes(id)) && !(message.recipientKey === 'role:super_admin' && canManage))) {
        return { ok: false, code: 'FORBIDDEN', message: '无法访问这条消息。' };
      }
      if (message.kind === 'member_application' && message.state === 'open' && canManage) {
        url = '/pages/members/index?id=' + encodeURIComponent(message.subjectId);
      }
      if (message.kind === 'weekly' && /^wp_[a-f0-9]{32}$/.test(message.subjectId || '')) {
        url = '/pages/module/index?id=weekly&period=' + message.subjectId;
      }
      if (markRead && !(message.readBy || []).includes(id)) {
        await reference.update({ data: { readBy: db.command.addToSet(id) } });
        await sync.bump(transaction, ['messages']);
      }
      return { ok: true, url };
    });
    // wx-server-sdk resolves the callback value directly; accept node-sdk's result wrapper as well.
    const response = result && result.result || result;
    if (response.ok && markRead) {
      const member = await access.readMember(db, id);
      Object.assign(response, access.allowed(member, 'equipment.read') ? await state(id, member) : { hasUnread: false, unreadCount: 0 });
    }
    return response;
  }
  function applicationId(id, cycle = 0) { return key('application:' + id + (cycle ? ':' + cycle : '')); }
  function applicationData(id, name, createdMs = Date.now(), cycle = 0) {
    return { _id: applicationId(id, cycle), teamId: access.TEAM_ID, recipientKey: 'role:super_admin',
      kind: 'member_application', subjectId: id, title: cycle ? '重新入组申请' : '成员申请', body: name + (cycle ? '申请重新加入 IMC' : '申请加入 IMC'),
      createdMs, state: 'open', readBy: [] };
  }
  function changeData(auditId, id, before, after, createdMs = Date.now()) {
    let title = '身份已更新';
    let body = '当前身份：' + access.present({ ...after, teamId: access.TEAM_ID }).roleLabels.join('、');
    if (before.status === 'pending' && after.status === 'active') { title = '入组申请已通过'; body = '你已加入 IMC'; }
    else if (before.status === 'pending' && after.status === 'disabled') { title = '入组申请未通过'; body = '你的 IMC 入组申请未通过'; }
    else if (after.status === 'disabled') { title = '账号已停用'; body = '你的 IMC 成员账号已停用'; }
    else if (after.status === 'removed') { title = '已移出团队'; body = '你已被移出 IMC'; }
    else if (after.status === 'pending') { title = '成员状态已更新'; body = '你的 IMC 成员状态为待审核'; }
    else if (before.status === 'disabled' && after.status === 'active') { title = '账号已恢复'; body = '你的 IMC 成员账号已恢复'; }
    return { _id: key('change:' + auditId), teamId: access.TEAM_ID, recipientKey: id,
      kind: 'member_change', subjectId: id, title, body, createdMs, state: 'open', readBy: [] };
  }
  async function put(transaction, message) {
    const { _id, ...data } = message;
    await transaction.collection(collection).doc(_id).set({ data });
    await sync.bump(transaction, ['messages']);
  }
  return { unread, state, list, read, readAll, open: (id, event) => read(id, event, false), applicationData, changeData, put,
    applicationId };
};
