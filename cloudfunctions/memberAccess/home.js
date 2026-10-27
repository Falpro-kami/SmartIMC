const TABLE = 'teamAnnouncements';
function reject(code, message) { const error = new Error(message); error.businessCode = code; throw error; }
function document(result) { return Array.isArray(result.data) ? result.data[0] : result.data; }
module.exports = function home(db, access, approvals) {
  async function authorize(id, manage = false, store = db) {
    const member = document(await store.collection('teamMembers').doc(id).get());
    if (!member || member.teamId !== access.TEAM_ID || member.status !== 'active') reject('MEMBERSHIP_REQUIRED', '通过 IMC 成员审核后才能查看团队内容。');
    if (manage && !access.allowed(member, 'announcements.manage')) reject('FORBIDDEN', '仅超级管理员可以管理团队公告。');
    return member;
  }
  function present(row, body = false) {
    return { id: row._id, title: row.title, pinned: row.pinned === true,
      authorName: row.authorName || '-', publishedMs: row.publishedMs, revision: row.revision,
      ...(body ? { body: row.body } : {}) };
  }
  async function list(id, event) {
    const actor = await authorize(id);
    const offset = event.offset === undefined ? 0 : event.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) reject('INVALID_INPUT', '分页参数不正确。');
    const result = await db.collection(TABLE).where({ teamId: access.TEAM_ID, status: 'published' })
      .orderBy('pinned', 'desc').orderBy('publishedMs', 'desc').orderBy('_id', 'desc').skip(offset).limit(21).get();
    const rows = result.data.slice(0, 20);
    const current = await authorize(id);
    return { ok: true, announcements: rows.map(row => present(row)), nextOffset: offset + rows.length,
      hasMore: result.data.length > 20, canManage: access.allowed(actor, 'announcements.manage') && access.allowed(current, 'announcements.manage') };
  }
  async function dashboard(id) {
    const actor = await authorize(id);
    let todos = [];
    if (access.allowed(actor, 'members.manage')) {
      const pending = await approvals.list(id, { scope: 'pending', offset: 0 });
      if (!pending.ok) reject(pending.code, pending.message);
      todos = pending.requests.slice(0, 5).map(row => ({ id: row.id, memberId: row.memberId,
        title: row.title, type: '成员入组申请', createdMs: row.createdMs }));
    }
    const result = await list(id, { offset: 0 });
    if (!access.allowed(await authorize(id), 'members.manage')) todos = [];
    return { ok: true, todos, announcements: result.announcements.slice(0, 3), canManage: result.canManage };
  }
  async function get(id, event) {
    await authorize(id);
    if (!/^ann_[a-f0-9]{32}$/.test(event.id || '')) reject('INVALID_INPUT', '公告参数不正确。');
    const row = document(await db.collection(TABLE).doc(event.id).get());
    if (!row || row.teamId !== access.TEAM_ID || row.status !== 'published') reject('NOT_FOUND', '公告不存在或已撤下。');
    const actor = await authorize(id);
    return { ok: true, announcement: present(row, true), canManage: access.allowed(actor, 'announcements.manage') };
  }
  async function save(id, event, withdraw = false) {
    await authorize(id, true);
    if (!/^ann_[a-f0-9]{32}$/.test(event.id || '') || !Number.isSafeInteger(event.revision) || event.revision < 0) reject('INVALID_INPUT', '公告参数不正确。');
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    const body = typeof event.body === 'string' ? event.body.trim() : '';
    if (!withdraw && (!title || title.length > 80 || /[\r\n\u0000-\u001f]/.test(title) || !body || body.length > 10000 || typeof event.pinned !== 'boolean')) {
      reject('INVALID_INPUT', '标题需1至80字，正文需1至10000字。');
    }
    await db.runTransaction(async transaction => {
      await authorize(id, true, transaction);
      const ref = transaction.collection(TABLE).doc(event.id);
      const previous = document(await ref.get());
      const profile = document(await transaction.collection('userProfiles').doc(id).get());
      if (previous && (previous.teamId !== access.TEAM_ID || previous.status !== 'published')) reject('NOT_FOUND', '公告不存在或已撤下。');
      if ((!previous && (event.revision !== 0 || withdraw)) || (previous && previous.revision !== event.revision)) reject('CONFLICT', '公告已更新，请重新打开后操作。');
      if (!withdraw && (!profile || !profile.name)) reject('PROFILE_REQUIRED', '请先完善姓名。');
      const now = Date.now();
      if (withdraw) await ref.update({ data: { status: 'withdrawn', revision: previous.revision + 1, updatedBy: id, updatedMs: now } });
      else await ref.set({ data: { teamId: access.TEAM_ID, status: 'published', title, body, pinned: event.pinned,
        authorName: profile.name, createdBy: previous ? previous.createdBy : id, updatedBy: id,
        createdMs: previous ? previous.createdMs : now, publishedMs: previous ? previous.publishedMs : now,
        updatedMs: now, revision: event.revision + 1 } });
    });
    return { ok: true, id: event.id };
  }
  return { dashboard, list, get, save, withdraw: (id, event) => save(id, event, true) };
};
