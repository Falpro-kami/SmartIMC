const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const access = require('../cloudfunctions/_shared/access');
const APPID = access.APP_ID;
const userId = name => access.identity({ APPID, OPENID: name });
const active = roles => ({ teamId: 'IMC', status: 'active', roles, revision: 0 });

function harness(options = {}) {
  let context = { APPID, OPENID: 'owner' };
  let tables = { teamSync: new Map([['IMC', Object.fromEntries(['home', 'messages', 'approvals', 'weekly', 'members'].map(k => [k, 'initial']))]]), teamSyncAccess: new Map(), teamMembers: new Map(), teamSecurity: new Map(), memberAudit: new Map(), userProfiles: new Map(), equipment: new Map(), teamMessages: new Map(), workbenchUsage: new Map(), teamAnnouncements: new Map(), weeklyPeriods: new Map(), weeklyReports: new Map() };
  const makeCollection = (store, name) => {
    const table = store[name];
    let filter = {};
    let offset = 0;
    let limit = 100;
    const order = [];
    return {
      where(value) { filter = value; return this; }, field() { return this; }, orderBy(field, direction) { if (options.sort) order.push([field, direction]); return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
      async get() { if (options.onRead) options.onRead(name); return { data: [...table].map(([id, value]) => ({ ...structuredClone(value), _id: id })).filter(row => Object.entries(filter).every(([key, value]) => {
        if (Array.isArray(value)) return (Array.isArray(row[key]) ? row[key] : [row[key]]).some(item => value.includes(item));
        if (value && value.$nin) return !(Array.isArray(row[key]) ? row[key] : [row[key]]).some(item => value.$nin.includes(item));
        return row[key] === value;
      })).sort((a, b) => { for (const [key, direction] of order) { if (a[key] < b[key]) return direction === 'desc' ? 1 : -1; if (a[key] > b[key]) return direction === 'desc' ? -1 : 1; } return 0; }).slice(offset, offset + limit) }; },
      doc(id) { return {
        async get() { return { data: table.has(id) ? { ...structuredClone(table.get(id)), _id: id } : null }; },
        async set({ data }) {
          if (name === 'teamMessages' && options.failMessageWrite) throw new Error('message write failed');
          table.set(id, structuredClone(data));
        },
        async update({ data }) {
          assert.ok(table.has(id));
          const previous = table.get(id);
          const values = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
            value && value.$addToSet ? Array.from(new Set([...(previous[key] || []), value.$addToSet])) : structuredClone(value)]));
          table.set(id, { ...previous, ...values });
        }
      }; }
    };
  };
  const db = { collection: name => makeCollection(tables, name), command: { in: values => values,
    nin: values => ({ $nin: values }), addToSet: value => ({ $addToSet: value }) }, serverDate: () => 'server-time',
    async runTransaction(callback) {
      const draft = structuredClone(tables);
      const result = await callback({ collection: name => makeCollection(draft, name) });
      tables = draft;
      return result;
    } };
  const cloud = { init() {}, database: () => db, getWXContext: () => context,
    async getTempFileURL({ fileList }) {
      if (options.avatarFailure) throw new Error('storage unavailable');
      return { fileList: fileList.map((fileID, index) => ({ fileID, tempFileURL: 'https://avatar.example/' + index + '.png', status: 0 })) };
    } };
  const load = name => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(`cloudfunctions/${name}/index.js`, 'utf8'), {
      module, exports: module.exports, console, require: key => ({ 'wx-server-sdk': cloud, './access': access,
        './sync': require('../cloudfunctions/memberAccess/sync'), './messages': require('../cloudfunctions/memberAccess/messages'), './approvals': require('../cloudfunctions/memberAccess/approvals'), './home': require('../cloudfunctions/memberAccess/home'), './workbench': require('../cloudfunctions/memberAccess/workbench'), 'node:crypto': crypto })[key]
    });
    return module.exports.main;
  };
  return { db, member: load('memberAccess'), equipment: load('equipmentQuery'), check: load('checkDatabase'),
    as: name => { context = { APPID, OPENID: name }; },
    table: name => tables[name] };
}

test('unread counts are scoped to the viewer, capped for 99+, and change only after explicit marking', async () => {
  const app = harness({ sort: true }), owner = userId('owner'), peer = userId('peer'), ordinary = userId('ordinary');
  app.table('teamMembers').set(owner, active(['super_admin'])); app.table('teamMembers').set(peer, active(['super_admin'])); app.table('teamMembers').set(ordinary, active([]));
  const ids = Array.from({ length: 103 }, (_, i) => 'msg_' + crypto.createHash('sha256').update('unread-' + i).digest('hex').slice(0, 32));
  ids.forEach((id, i) => app.table('teamMessages').set(id, { teamId: 'IMC', recipientKey: owner, title: '测试通知', body: '测试内容', state: i % 2 ? 'resolved' : 'open', readBy: [], createdMs: i }));
  const roleId = 'msg_' + 'b'.repeat(32);
  app.table('teamMessages').set(roleId, { teamId: 'IMC', recipientKey: 'role:super_admin', title: '团队通知', state: 'open', readBy: [], createdMs: 104 });
  assert.equal((await app.member({ action: 'get' })).unreadCount, 100);
  await app.member({ action: 'openMessage', id: ids[0] }); assert.equal((await app.member({ action: 'notificationState' })).unreadCount, 100);
  for (const id of ids.slice(0, 5)) await app.member({ action: 'readMessage', id });
  assert.equal((await app.member({ action: 'notificationState' })).unreadCount, 99);
  assert.equal((await app.member({ action: 'messages', offset: 50 })).unreadCount, 99, 'the badge is independent of the current list page');
  assert.equal((await app.member({ action: 'readMessage', id: ids[0] })).unreadCount, 99, 'repeated marking must not decrement twice');
  await app.member({ action: 'readMessage', id: roleId });
  app.as('peer'); assert.equal((await app.member({ action: 'notificationState' })).unreadCount, 1);
  app.as('ordinary'); assert.equal((await app.member({ action: 'notificationState' })).unreadCount, 0);
  app.table('teamMembers').get(ordinary).status = 'removed'; assert.equal((await app.member({ action: 'get' })).unreadCount, 0);
});

test('business roles are additive and isolated; an active super administrator has every permission', () => {
  assert.equal(access.allowed(active([]), 'equipment.read'), true);
  assert.equal(access.allowed(active([]), 'equipment.create'), false);
  const member = active(['five_s_admin', 'weekly_admin']);
  assert.equal(access.allowed(member, 'equipment.approve'), true);
  assert.equal(access.allowed(member, 'weekly.export'), true);
  assert.equal(access.allowed(member, 'finance.review'), false);
  assert.equal(access.allowed(active(['finance_admin']), 'members.manage'), false);
  assert.equal(access.allowed(active(['super_admin']), 'future.module.permission'), true);
  assert.equal(access.allowed({ ...active(['super_admin']), status: 'disabled' }, 'equipment.read'), false);
  assert.equal(access.allowed({ ...active(['super_admin']), teamId: 'OTHER' }, 'members.manage'), false);
  assert.equal(access.identity({ APPID, OPENID: '' }), '');
  for (const name of ['memberAccess', 'equipmentQuery']) assert.equal(fs.readFileSync(`cloudfunctions/${name}/access.js`, 'utf8'), fs.readFileSync('cloudfunctions/_shared/access.js', 'utf8'));
});

test('joining never grants a role, never overwrites an existing member and cannot spoof the target user', async () => {
  const app = harness();
  const id = userId('owner');
  assert.equal((await app.member({ action: 'apply' })).code, 'PROFILE_REQUIRED');
  app.table('userProfiles').set(id, { name: '本人' });
  const result = await app.member({ action: 'apply', roles: ['super_admin'], status: 'active', id: userId('victim') });
  assert.equal(result.member.status, 'pending');
  assert.equal(result.member.roles.length, 0);
  assert.equal(result.accountCode, id);
  assert.equal(app.table('teamMembers').has(userId('victim')), false);
  assert.equal((await app.member({ action: 'set', id, status: 'active', roles: ['super_admin'], revision: 0 })).code, 'MEMBERSHIP_REQUIRED');
  app.table('teamMembers').set(id, { ...active(['super_admin']), status: 'disabled' });
  await app.member({ action: 'apply' });
  assert.equal(app.table('teamMembers').get(id).status, 'disabled');
});

test('member changes check revisions, prevent loss of the last super administrator and write an audit together', async () => {
  const app = harness();
  const owner = userId('owner');
  const other = userId('other');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(other, { ...active([]), status: 'pending' });
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  const update = { action: 'set', id: owner, roles: [], status: 'active', revision: 0 };
  assert.equal((await app.member(update)).code, 'LAST_SUPER_ADMIN');
  assert.equal(app.table('memberAudit').size, 0);
  assert.equal((await app.member({ ...update, id: other, roles: ['invalid'] })).code, 'INVALID_INPUT');
  assert.equal((await app.member({ ...update, id: other, roles: ['five_s_admin', 'weekly_admin'] })).ok, true);
  assert.equal(app.table('teamMembers').get(other).revision, 1);
  assert.equal(app.table('memberAudit').size, 1);
  assert.equal((await app.member({ ...update, id: other })).code, 'CONFLICT');
  assert.equal((await app.member({ ...update, id: other, roles: ['super_admin'], revision: 1 })).ok, true);
  assert.equal((await app.member(update)).ok, true);
  assert.equal(app.table('teamSecurity').get('IMC').superAdminIds.length, 1);
  assert.equal((await app.member({ action: 'list' })).code, 'FORBIDDEN');
});

test('equipment queries deny unapproved/disabled users and accept ordinary active members', async () => {
  const app = harness();
  const id = userId('owner');
  const event = { action: 'list', roles: ['super_admin'], OPENID: 'spoof' };
  assert.equal((await app.equipment(event)).code, 'MEMBERSHIP_REQUIRED');
  app.table('teamMembers').set(id, { ...active(['super_admin']), status: 'pending' });
  assert.equal((await app.equipment(event)).code, 'MEMBERSHIP_REQUIRED');
  app.table('teamMembers').set(id, { ...active(['super_admin']), status: 'disabled' });
  assert.equal((await app.equipment(event)).code, 'MEMBERSHIP_REQUIRED');
  app.table('teamMembers').set(id, active([]));
  assert.equal((await app.equipment(event)).ok, true);
});

function page(file, service) {
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value; }, require: name => name === '../../utils/member-page' ? value => value : service,
    wx: { showToast() {}, navigateTo() {}, setClipboardData() {} }
  });
  definition.setData = values => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = definition.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  };
  return definition;
}

test('my account displays administrator access only for an active authorized member and clears it after revocation', async () => {
  let member = { ...active(['super_admin']), roleLabels: ['超级管理员'], permissions: ['*'] };
  const service = { get: async () => ({ member, accountCode: userId('owner') }),
    can: (member, permission) => access.allowed(member, permission) };
  const mine = page('miniprogram/pages/profile/index.js', service);
  await mine.loadAccess();
  assert.equal(mine.data.canManage, true);
  assert.equal(mine.data.roleText, '超级管理员');
  member = { ...member, status: 'disabled' };
  await mine.loadAccess();
  assert.equal(mine.data.canManage, false);
  assert.equal(mine.data.statusLabel, '已停用');
  member = null;
  await mine.loadAccess();
  assert.equal(mine.data.status, 'not_joined');
});

test('only approved IMC members can read the limited directory; client identity and role claims cannot bypass approval', async () => {
  const app = harness();
  for (let index = 0; index < 52; index += 1) {
    const id = userId('member-' + index);
    app.table('teamMembers').set(id, active(index === 0 ? ['super_admin'] : []));
    app.table('userProfiles').set(id, { name: '成员' + index, avatarFileId: index === 0 ? 'cloud://env/avatar.png' : '', privateField: 'secret' });
  }
  app.table('teamMembers').set(userId('pending'), { ...active([]), status: 'pending' });
  app.table('teamMembers').set(userId('disabled'), { ...active([]), status: 'disabled' });
  app.table('teamMembers').set(userId('other-team'), { ...active([]), teamId: 'OTHER' });
  for (const status of [null, 'pending', 'disabled', 'active']) {
    app.as('viewer');
    if (status) app.table('teamMembers').set(userId('viewer'), { ...active([]), status, teamId: 'OTHER' });
    const denied = await app.member({ action: 'directory', teamId: 'IMC', status: 'active', roles: ['super_admin'], OPENID: 'member-0' });
    assert.equal(denied.code, 'MEMBERSHIP_REQUIRED');
    assert.equal(denied.members, undefined);
    if (status && status !== 'active') {
      app.table('teamMembers').set(userId('viewer'), { ...active(['super_admin']), status });
      assert.equal((await app.member({ action: 'directory' })).code, 'MEMBERSHIP_REQUIRED');
    }
  }
  for (const roles of [[], ['weekly_admin'], ['super_admin']]) {
    app.as('member-1');
    app.table('teamMembers').set(userId('member-1'), active(roles));
    const first = await app.member({ action: 'directory', teamId: 'OTHER', fields: ['permissions'] });
    assert.equal(first.ok, true);
    assert.equal(first.members.length, 50);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 50);
    assert.deepEqual(Object.keys(first.members[0]).sort(), ['avatarUrl', 'id', 'name', 'roleLabels']);
    assert.equal(first.members[0].avatarUrl, 'https://avatar.example/0.png');
    const second = await app.member({ action: 'directory', offset: 50 });
    assert.equal(second.members.length, 2);
    assert.equal(second.hasMore, false);
    if (!roles.includes('super_admin')) assert.equal((await app.member({ action: 'list' })).code, 'FORBIDDEN');
  }
  assert.equal((await app.member({ action: 'directory', offset: -1 })).code, 'INVALID_INPUT');
  app.as('');
  assert.equal((await app.member({ action: 'directory', OPENID: 'spoof', APPID })).code, 'AUTH_REQUIRED');
});

test('directory remains usable when an avatar cannot be signed', async () => {
  const app = harness({ avatarFailure: true });
  app.table('teamMembers').set(userId('member'), active([]));
  app.table('userProfiles').set(userId('member'), { name: '成员', avatarFileId: 'cloud://env/avatar.png' });
  app.as('member');
  const result = await app.member({ action: 'directory' });
  assert.equal(result.ok, true);
  assert.equal(result.members[0].name, '成员');
  assert.equal(result.members[0].avatarUrl, '');
});

test('directory page paginates without duplicates and failed avatars switch to initials', async () => {
  const first = { id: 'a', name: '张同学', avatarUrl: 'https://avatar.example/a.png', roleLabels: ['普通成员'] };
  const second = { id: 'b', name: '李同学', avatarUrl: '', roleLabels: ['周报管理员'] };
  const directory = page('miniprogram/pages/team-members/index.js', {
    directory: async offset => offset === 0
      ? { members: [first], nextOffset: 1, hasMore: true }
      : { members: [first, second], nextOffset: 3, hasMore: false }
  });
  await directory.loadMembers();
  assert.equal(directory.data.members[0].initials, '同学');
  directory.avatarFailed({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(directory.data.members[0].avatarUrl, '');
  await directory.loadMore();
  assert.equal(directory.data.members.length, 2);
  assert.equal(directory.data.members[1].roleText, '周报管理员');
  assert.equal(directory.data.hasMore, false);
});

test('member editor submits selected roles, status and the original revision; conflicts stay reviewable', async () => {
  let submitted;
  const member = { id: userId('member'), name: '成员', ...active([]), roleLabels: ['普通成员'], revision: 3 };
  const service = { set: async value => { submitted = structuredClone(value); throw new Error('此成员权限已更新'); } };
  const editor = page('miniprogram/pages/members/index.js', service);
  editor.setData({ members: [member], roleOptions: access.ROLES });
  editor.openEditor({ currentTarget: { dataset: { id: member.id } } });
  editor.changeRoles({ detail: { value: ['five_s_admin', 'weekly_admin'] } });
  editor.changeStatus({ detail: { value: 'active' } });
  await editor.saveMember();
  assert.deepEqual(submitted.roles, ['five_s_admin', 'weekly_admin']);
  assert.equal(submitted.revision, 3);
  assert.equal(editor.data.editor.id, member.id);
  assert.equal(editor.data.formError, '此成员权限已更新');
  assert.equal(editor.data.saving, false);
});

test('returning to the directory clears previously loaded members when membership has been revoked', async () => {
  let revoked = false;
  const directory = page('miniprogram/pages/team-members/index.js', {
    directory: async () => {
      if (revoked) throw new Error('通过 IMC 成员审核后才能查看团队成员。');
      return { members: [{ id: 'member', name: '成员', roleLabels: ['普通成员'] }], nextOffset: 1, hasMore: true };
    }
  });
  await directory.onShow();
  assert.equal(directory.data.members.length, 1);
  revoked = true;
  await directory.onShow();
  assert.equal(directory.data.members.length, 0);
  assert.equal(directory.data.hasMore, false);
  assert.match(directory.data.error, /成员审核/);
});

test('application alerts, per-admin read state and private approval results follow the actual membership transaction', async () => {
  const app = harness();
  const owner = userId('owner'), otherAdmin = userId('other-admin'), applicant = userId('applicant');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(otherAdmin, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner, otherAdmin] });
  app.table('userProfiles').set(applicant, { name: '申请人' });
  app.as('applicant');
  await app.member({ action: 'apply' });
  await app.member({ action: 'apply' });
  assert.equal(app.table('teamMessages').size, 1, 'A repeated application must not duplicate or reset notifications');
  assert.equal((await app.member({ action: 'messages' })).code, 'MEMBERSHIP_REQUIRED');
  const applicationId = [...app.table('teamMessages').keys()][0];
  assert.equal((await app.member({ action: 'readMessage', id: applicationId })).code, 'MEMBERSHIP_REQUIRED');
  app.as('owner');
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  const inbox = await app.member({ action: 'messages', recipientId: applicant });
  assert.equal(inbox.messages[0].body, '申请人申请加入 IMC');
  assert.equal('recipientKey' in inbox.messages[0], false);
  const opened = await app.member({ action: 'openMessage', id: applicationId });
  assert.equal(opened.url, '/pages/members/index?id=' + applicant);
  assert.equal((await app.member({ action: 'get' })).hasUnread, true, 'Opening a request must not mark its message as read');
  await app.member({ action: 'readMessage', id: applicationId });
  assert.equal(app.table('teamMessages').get(applicationId).readBy.length, 1);
  assert.equal((await app.member({ action: 'get' })).hasUnread, false);
  app.as('other-admin');
  assert.equal((await app.member({ action: 'get' })).hasUnread, true, 'One administrator reading a message does not read it for others');
  app.as('owner');
  assert.equal((await app.member({ action: 'set', id: applicant, status: 'active', roles: [], revision: 0 })).ok, true);
  app.as('other-admin');
  assert.equal((await app.member({ action: 'get' })).hasUnread, true, 'Processing a request must not clear another administrator\'s unread notification');
  assert.equal((await app.member({ action: 'messages' })).messages[0].resolved, true);
  assert.equal((await app.member({ action: 'messages' })).messages[0].read, false);
  await app.member({ action: 'readMessage', id: applicationId });
  assert.equal((await app.member({ action: 'get' })).hasUnread, false);
  app.as('applicant');
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  const approved = (await app.member({ action: 'messages' })).messages;
  assert.equal(approved.length, 1);
  assert.equal(approved[0].title, '入组申请已通过');
  app.as('owner');
  assert.equal((await app.member({ action: 'readMessage', id: approved[0].id })).code, 'FORBIDDEN');
  app.as('applicant');
  assert.equal((await app.member({ action: 'readMessage', id: approved[0].id })).ok, true);
  assert.equal((await app.member({ action: 'get' })).hasUnread, false);
});

test('a notification write failure rolls back the membership change and its audit', async () => {
  const options = {};
  const app = harness(options);
  const owner = userId('owner'), applicant = userId('applicant');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  app.table('userProfiles').set(applicant, { name: '申请人' });
  app.as('applicant');
  await app.member({ action: 'apply' });
  app.as('owner');
  options.failMessageWrite = true;
  const response = await app.member({ action: 'set', id: applicant, status: 'active', roles: [], revision: 0 });
  assert.equal(response.code, 'ACCESS_FAILED');
  assert.equal(app.table('teamMembers').get(applicant).status, 'pending');
  assert.equal(app.table('memberAudit').size, 0);
  assert.equal([...app.table('teamMessages').values()][0].state, 'open');
});

test('message page opens without reading and marks a message only through the explicit read action', async () => {
  const id = 'msg_' + 'a'.repeat(32);
  let read;
  const inbox = page('miniprogram/pages/messages/index.js', {
    messages: async () => ({ messages: [{ id, title: '成员申请', body: '申请人申请加入 IMC', createdMs: Date.now(), read: false }], nextOffset: 1, hasMore: false }),
    openMessage: async () => ({ ok: true }),
    readMessage: async value => { read = value; return { ok: true }; }
  });
  await inbox.loadMessages();
  assert.equal(inbox.data.messages[0].read, false);
  await inbox.openMessage({ currentTarget: { dataset: { id } } });
  assert.equal(read, undefined);
  assert.equal(inbox.data.messages[0].read, false);
  await inbox.markRead({ currentTarget: { dataset: { id } } });
  assert.equal(read, id);
  assert.equal(inbox.data.messages[0].read, true);
});

test('approval workbench collects pending member requests from every page and updates after processing', async () => {
  let approved = false;
  const offsets = [];
  const approvals = page('miniprogram/pages/approvals/index.js', {
    get: async () => ({ member: active(['super_admin']) }), can: access.allowed,
    approvals: async (scope, offset) => {
      assert.equal(scope, 'pending');
      offsets.push(offset);
      return offset === 0
        ? { requests: approved ? [] : [{ id: 'pending-a', memberId: 'pending-a' }], nextOffset: 2, hasMore: true }
        : { requests: [{ id: 'pending-b', memberId: 'pending-b' }], nextOffset: 4, hasMore: false };
    }
  });
  approvals.setData({ activeTab: 'pending' });
  await approvals.loadApprovals();
  assert.deepEqual(offsets, [0, 2]);
  assert.deepEqual(Array.from(approvals.data.requests, request => request.id), ['pending-a', 'pending-b']);
  approved = true;
  await approvals.loadApprovals();
  assert.deepEqual(Array.from(approvals.data.requests, request => request.id), ['pending-b']);
});

test('ordinary members cannot fetch member approval records through the new workbench', async () => {
  let reads = 0;
  const approvals = page('miniprogram/pages/approvals/index.js', {
    get: async () => ({ member: active([]) }), can: access.allowed,
    approvals: async () => { reads += 1; throw new Error('must not request administrator data'); }
  });
  approvals.setData({ activeTab: 'pending' });
  await approvals.loadApprovals();
  assert.equal(reads, 0);
  assert.equal(approvals.data.canReviewMembers, false);
  assert.equal(approvals.data.requests.length, 0);
});

test('approval scopes isolate own requests and actual decisions by the current reviewer without marking messages read', async () => {
  const app = harness();
  const owner = userId('owner'), other = userId('other'), applicant = userId('applicant');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(other, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner, other] });
  app.table('userProfiles').set(applicant, { name: '申请人' });
  app.as('applicant');
  await app.member({ action: 'apply' });
  const mine = await app.member({ action: 'approvals', scope: 'mine', id: owner });
  assert.equal(mine.code, 'MEMBERSHIP_REQUIRED');
  for (const scope of ['pending', 'done']) assert.equal((await app.member({ action: 'approvals', scope, roles: ['super_admin'] })).code, 'MEMBERSHIP_REQUIRED');
  app.as('owner');
  assert.equal((await app.member({ action: 'approvals', scope: 'mine', id: applicant })).requests.length, 0);
  assert.equal((await app.member({ action: 'approvals', scope: 'pending' })).requests[0].memberId, applicant);
  await app.member({ action: 'set', id: applicant, status: 'active', roles: [], revision: 0 });
  // A later role edit is not a second approval, and does not change the original application outcome.
  await app.member({ action: 'set', id: applicant, status: 'disabled', roles: [], revision: 1 });
  const done = await app.member({ action: 'approvals', scope: 'done', actorId: other });
  assert.equal(done.requests.length, 1);
  assert.equal(done.requests[0].title, '申请人');
  assert.equal(done.requests[0].statusLabel, '已通过');
  assert.equal('before' in done.requests[0], false);
  assert.equal((await app.member({ action: 'approvals', scope: 'pending' })).requests.length, 0);
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  app.as('other');
  assert.equal((await app.member({ action: 'approvals', scope: 'done', actorId: owner })).requests.length, 0);
  app.as('applicant');
  assert.equal((await app.member({ action: 'approvals', scope: 'mine' })).code, 'MEMBERSHIP_REQUIRED');
  app.table('teamMembers').set(applicant, active([]));
  assert.equal((await app.member({ action: 'approvals', scope: 'mine' })).requests[0].statusLabel, '已通过');
  assert.equal((await app.member({ action: 'approvals', scope: 'unknown' })).code, 'INVALID_INPUT');
  assert.equal((await app.member({ action: 'approvals', scope: 'mine', offset: -1 })).code, 'INVALID_INPUT');
  assert.equal((await app.member({ action: 'approvals', scope: 'mine', offset: 1 })).requests.length, 0);
  app.as('');
  assert.equal((await app.member({ action: 'approvals', scope: 'mine', OPENID: 'applicant' })).code, 'AUTH_REQUIRED');
});

test('switching approval tabs ignores late responses and ordinary members can load only their own application', async () => {
  let resolveMine;
  let started;
  const mineStarted = new Promise(resolve => { started = resolve; });
  const calls = [];
  const approvals = page('miniprogram/pages/approvals/index.js', {
    get: async () => ({ member: active(['super_admin']) }), can: access.allowed,
    approvals: async scope => {
      calls.push(scope);
      if (scope === 'mine') return new Promise(resolve => { resolveMine = resolve; started(); });
      return { requests: [{ id: 'done', title: '已处理的申请' }], nextOffset: 1, hasMore: false };
    }
  });
  const mine = approvals.loadApprovals();
  await mineStarted;
  await approvals.switchTab({ currentTarget: { dataset: { id: 'done' } } });
  resolveMine({ requests: [{ id: 'mine' }], nextOffset: 1, hasMore: false });
  await mine;
  assert.equal(approvals.data.activeTab, 'done');
  assert.equal(approvals.data.requests[0].id, 'done');
  assert.equal(approvals.data.loading, false);
  assert.deepEqual(calls, ['mine', 'done']);
  const ordinary = page('miniprogram/pages/approvals/index.js', {
    get: async () => ({ member: active([]) }), can: access.allowed,
    approvals: async scope => {
      assert.equal(scope, 'mine');
      return { requests: [{ id: 'own', statusLabel: '已通过' }], nextOffset: 1, hasMore: false };
    }
  });
  await ordinary.loadApprovals();
  assert.equal(ordinary.data.requests[0].id, 'own');
  await ordinary.switchTab({ currentTarget: { dataset: { id: 'done' } } });
  assert.equal(ordinary.data.requests.length, 0);
  assert.equal(ordinary.data.emptyText, '暂无已审批记录');
});

test('workbench usage is stored per platform identity, accepts known tools only and ignores client counts/user IDs', async () => {
  const app = harness();
  for (const name of ['alice', 'bob']) app.table('teamMembers').set(userId(name), active([]));
  app.as('alice');
  const first = await app.member({ action: 'workbenchUsage', id: userId('bob') });
  assert.equal(first.usage.finance.count, 0);
  await app.member({ action: 'recordToolOpen', toolId: 'finance', id: userId('bob'), count: 1000000 });
  await app.member({ action: 'recordToolOpen', toolId: 'finance' });
  assert.equal((await app.member({ action: 'workbenchUsage' })).usage.finance.count, 2);
  assert.equal((await app.member({ action: 'recordToolOpen', toolId: '__proto__' })).code, 'INVALID_INPUT');
  app.as('bob');
  assert.equal((await app.member({ action: 'workbenchUsage', id: userId('alice') })).usage.finance.count, 0);
  await app.member({ action: 'recordToolOpen', toolId: 'approvals' });
  assert.equal((await app.member({ action: 'workbenchUsage' })).usage.approvals.count, 1);
  assert.equal(app.table('workbenchUsage').size, 2);
  app.as('alice');
  assert.equal((await app.member({ action: 'workbenchUsage' })).usage.approvals.count, 0);
  assert.equal((await app.member({ action: 'workbenchUsage' })).usage.finance.count, 2);
  for (const toolId of ['leave', 'knowledge', 'weekly-sharing']) {
    assert.equal((await app.member({ action: 'recordToolOpen', toolId })).ok, true);
    const usage = (await app.member({ action: 'workbenchUsage' })).usage;
    assert.equal(usage[toolId].count, 1);
    assert.equal(usage.finance.count, 2);
  }
});

test('only a super administrator can remove members; removal revokes access, hides directory entries and retains audits', async () => {
  const app = harness();
  const owner = userId('owner'), member = userId('member');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(member, active(['weekly_admin']));
  app.table('userProfiles').set(member, { name: '测试成员' });
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  const event = { action: 'set', id: member, status: 'removed', roles: [], revision: 0 };
  app.as('member');
  assert.equal((await app.member(event)).code, 'FORBIDDEN');
  app.as('owner');
  assert.equal((await app.member({ ...event, id: owner })).code, 'LAST_SUPER_ADMIN');
  assert.equal((await app.member({ ...event, roles: ['super_admin'] })).code, 'INVALID_INPUT');
  assert.equal((await app.member(event)).ok, true);
  assert.equal(app.table('teamMembers').get(member).status, 'removed');
  assert.deepEqual(app.table('teamMembers').get(member).roles, []);
  assert.equal(app.table('memberAudit').size, 1);
  assert.equal([...app.table('memberAudit').values()][0].before.status, 'active');
  assert.equal((await app.member({ action: 'list' })).members.some(row => row.id === member), false);
  assert.equal((await app.member({ action: 'directory' })).members.some(row => row.id === member), false);
  assert.equal((await app.member({ action: 'member', id: member })).code, 'NOT_FOUND');
  app.as('member');
  assert.equal((await app.member({ action: 'get' })).member.permissions.length, 0);
  assert.equal((await app.equipment({ action: 'list' })).code, 'MEMBERSHIP_REQUIRED');
  assert.equal((await app.member({ action: 'directory' })).code, 'MEMBERSHIP_REQUIRED');
  const reapplication = await app.member({ action: 'apply' });
  assert.equal(reapplication.member.status, 'pending');
  assert.equal(reapplication.member.roles.length, 0);
  assert.equal(reapplication.member.permissions.length, 0);
  assert.equal((await app.member({ action: 'messages' })).code, 'MEMBERSHIP_REQUIRED');
  const message = [...app.table('teamMessages').values()][0];
  assert.equal(message.title, '已移出团队');
  assert.equal(message.readBy.length, 0);
});

test('removed members can reapply once; old approvals, read states and roles cannot carry into the new application', async () => {
  const app = harness({ sort: true }), owner = userId('owner'), member = userId('returning');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  app.table('userProfiles').set(member, { name: '重新申请的成员' });
  app.as('returning'); await app.member({ action: 'apply' });
  const initialId = app.table('teamMembers').get(member).applicationId;
  app.as('owner');
  await app.member({ action: 'readMessage', id: initialId });
  await app.member({ action: 'set', id: member, status: 'active', roles: ['weekly_admin'], revision: 0 });
  const originalMessage = structuredClone(app.table('teamMessages').get(initialId));
  const originalCreation = app.table('teamMembers').get(member).createdAt;
  // Existing installations have a fixed initial application and no audit/application linkage.
  delete app.table('teamMembers').get(member).applicationId;
  for (const row of app.table('memberAudit').values()) delete row.applicationId;
  await app.member({ action: 'set', id: member, status: 'removed', roles: [], revision: 1 });
  app.as('returning');
  const reapply = await app.member({ action: 'apply', roles: ['super_admin'], status: 'active', id: owner });
  assert.equal(reapply.member.status, 'pending'); assert.equal(reapply.member.revision, 3);
  assert.equal(reapply.member.roles.length, 0); assert.equal(reapply.member.permissions.length, 0);
  const next = app.table('teamMembers').get(member), latestId = next.applicationId;
  assert.notEqual(latestId, initialId); assert.equal(next.createdAt, originalCreation);
  assert.deepEqual(app.table('teamMessages').get(initialId), originalMessage);
  assert.deepEqual(app.table('teamMessages').get(latestId).readBy, []);
  assert.equal(app.table('teamMessages').get(latestId).state, 'open');
  assert.equal(app.table('teamMessages').get(latestId).title, '重新入组申请');
  assert.ok(app.table('memberAudit').size >= 3);
  const auditCount = app.table('memberAudit').size, messageCount = app.table('teamMessages').size;
  await app.member({ action: 'apply' });
  assert.equal(app.table('memberAudit').size, auditCount); assert.equal(app.table('teamMessages').size, messageCount);
  for (const action of ['home', 'directory', 'messages', 'list', 'notificationState']) assert.equal((await app.member({ action })).code, 'MEMBERSHIP_REQUIRED');
  assert.equal((await app.equipment({ action: 'list' })).code, 'MEMBERSHIP_REQUIRED');
  // Exercise the own-request projection separately from the entry point's membership gate.
  const messages = require('../cloudfunctions/memberAccess/messages')(app.db, access);
  const approvals = require('../cloudfunctions/memberAccess/approvals')(app.db, access, messages);
  assert.equal((await approvals.list(member, { scope: 'mine' })).requests[0].statusLabel, '待审批');
  app.as('owner');
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  const pending = await app.member({ action: 'approvals', scope: 'pending' });
  assert.ok(pending.requests.some(row => row.memberId === member));
  assert.equal((await app.member({ action: 'set', id: member, status: 'active', roles: [], revision: 1 })).code, 'CONFLICT');
  await app.member({ action: 'set', id: member, status: 'active', roles: [], revision: 3 });
  assert.equal(app.table('teamMessages').get(latestId).state, 'resolved');
  assert.equal(app.table('teamMessages').get(latestId).readBy.length, 0);
  app.as('returning');
  const mine = await app.member({ action: 'approvals', scope: 'mine' });
  assert.equal(mine.requests[0].id, latestId); assert.equal(mine.requests[0].statusLabel, '已通过');
  const self = await app.member({ action: 'get' });
  assert.equal(self.member.roles.length, 0); assert.equal(access.allowed(app.table('teamMembers').get(member), 'weekly.manage'), false);
  assert.equal((await app.equipment({ action: 'list' })).ok, true);
});

test('failed reapplication notification rolls back the pending state and audit; disabled or foreign-team users cannot rejoin', async () => {
  const app = harness({ failMessageWrite: true }), owner = userId('owner');
  app.table('teamMembers').set(owner, { ...active([]), status: 'removed', revision: 8 });
  app.table('userProfiles').set(owner, { name: '测试成员' });
  assert.equal((await app.member({ action: 'apply' })).code, 'ACCESS_FAILED');
  assert.equal(app.table('teamMembers').get(owner).status, 'removed');
  assert.equal(app.table('teamMembers').get(owner).revision, 8);
  assert.equal(app.table('memberAudit').size, 0); assert.equal(app.table('teamMessages').size, 0);
  app.table('teamMembers').set(owner, { ...active([]), status: 'disabled' });
  assert.equal((await app.member({ action: 'apply' })).member.status, 'disabled');
  app.table('teamMembers').set(owner, { ...active([]), status: 'removed', teamId: 'OTHER' });
  assert.equal((await app.member({ action: 'apply' })).code, 'FORBIDDEN');
});

test('failed removal notification rolls back membership, security registry and the audit', async () => {
  const app = harness({ failMessageWrite: true });
  const owner = userId('owner'), member = userId('member');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(member, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner, member] });
  assert.equal((await app.member({ action: 'set', id: member, status: 'removed', roles: [], revision: 0 })).code, 'ACCESS_FAILED');
  assert.equal(app.table('teamMembers').get(member).status, 'active');
  assert.equal(app.table('teamSecurity').get('IMC').superAdminIds.length, 2);
  assert.equal(app.table('memberAudit').size, 0);
});

test('announcements enforce membership, publisher permissions, content validation and revision conflicts', async () => {
  const app = harness({ sort: true });
  const owner = userId('owner'), reader = userId('reader');
  const id = 'ann_' + 'a'.repeat(32);
  const event = { action: 'saveAnnouncement', id, revision: 0, title: ' 实验室通知 ', body: '第一行\n第二行', pinned: true, authorName: '伪造发布者', teamId: 'OTHER' };
  for (const status of [null, 'pending', 'disabled', 'removed']) {
    if (status) app.table('teamMembers').set(owner, { ...active(['super_admin']), status });
    for (const action of ['syncConnect', 'syncState', 'home', 'announcements', 'announcement', 'saveAnnouncement', 'withdrawAnnouncement']) {
      assert.equal((await app.member({ ...event, action })).code, 'MEMBERSHIP_REQUIRED');
    }
  }
  app.table('teamMembers').set(owner, { ...active(['super_admin']), teamId: 'OTHER' });
  assert.equal((await app.member({ action: 'home' })).code, 'MEMBERSHIP_REQUIRED');
  for (const roles of [[], ['leader'], ['academic_admin'], ['finance_admin'], ['weekly_admin'], ['five_s_admin']]) {
    app.table('teamMembers').set(owner, active(roles));
    assert.equal((await app.member(event)).code, 'FORBIDDEN');
  }
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('userProfiles').set(owner, { name: '真实发布者' });
  assert.equal((await app.member({ ...event, title: '' })).code, 'INVALID_INPUT');
  assert.equal((await app.member({ ...event, body: 'x'.repeat(10001) })).code, 'INVALID_INPUT');
  assert.equal((await app.member(event)).ok, true);
  assert.equal((await app.member(event)).code, 'CONFLICT');
  assert.equal(app.table('teamAnnouncements').size, 1);
  app.table('teamMembers').set(reader, active([]));
  app.as('reader');
  const list = await app.member({ action: 'announcements', id: owner });
  assert.equal(list.canManage, false);
  assert.equal(list.announcements[0].title, '实验室通知');
  assert.equal(list.announcements[0].authorName, '真实发布者');
  assert.equal('body' in list.announcements[0], false);
  assert.equal('createdBy' in list.announcements[0], false);
  assert.equal((await app.member({ action: 'announcement', id })).announcement.body, '第一行\n第二行');
  assert.equal((await app.member({ action: 'withdrawAnnouncement', id, revision: 1 })).code, 'FORBIDDEN');
  app.as('owner');
  assert.equal((await app.member({ ...event, revision: 1, title: '新标题' })).ok, true);
  assert.equal((await app.member({ action: 'withdrawAnnouncement', id, revision: 1 })).code, 'CONFLICT');
  assert.equal((await app.member({ action: 'withdrawAnnouncement', id, revision: 2 })).ok, true);
  assert.equal((await app.member({ action: 'announcements' })).announcements.length, 0);
  assert.equal((await app.member({ action: 'announcement', id })).code, 'NOT_FOUND');
  assert.equal(app.table('teamAnnouncements').get(id).status, 'withdrawn');
});

test('home shows actual pending applications without marking messages read; announcements paginate pinned first', async () => {
  const app = harness({ sort: true });
  const owner = userId('owner'), applicant = userId('applicant');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  app.table('userProfiles').set(applicant, { name: '申请人' });
  app.as('applicant'); await app.member({ action: 'apply' }); app.as('owner');
  for (let i = 0; i < 25; i++) app.table('teamAnnouncements').set('ann_' + i.toString(16).padStart(32, '0'), {
    teamId: 'IMC', status: 'published', title: '公告' + i, body: '正文', pinned: i === 0, publishedMs: 100 + i, revision: 1
  });
  const first = await app.member({ action: 'announcements' });
  assert.equal(first.announcements[0].title, '公告0');
  assert.equal(first.announcements[1].title, '公告24');
  assert.equal(first.nextOffset, 20);
  assert.equal(first.hasMore, true);
  const second = await app.member({ action: 'announcements', offset: first.nextOffset });
  assert.equal(second.announcements.length, 5);
  assert.equal(second.hasMore, false);
  const home = await app.member({ action: 'home' });
  assert.equal(home.todos.length, 1);
  assert.equal(home.todos[0].memberId, applicant);
  assert.equal(home.announcements.length, 3);
  await app.member({ action: 'set', id: applicant, status: 'active', roles: [], revision: 0 });
  assert.equal((await app.member({ action: 'home' })).todos.length, 0);
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  app.as('applicant');
  assert.equal((await app.member({ action: 'home' })).canManage, false);
  assert.equal((await app.member({ action: 'home' })).todos.length, 0);
});

test('home rechecks permissions before returning sensitive pending applicants', async () => {
  const options = {};
  const app = harness(options), owner = userId('owner');
  app.table('teamMembers').set(owner, active(['super_admin']));
  app.table('teamMembers').set(userId('applicant'), { ...active([]), status: 'pending' });
  options.onRead = table => { if (table === 'teamAnnouncements') app.table('teamMembers').set(owner, active([])); };
  const result = await app.member({ action: 'home' });
  assert.equal(result.todos.length, 0);
  assert.equal(result.canManage, false);
});

test('weekly messages use targeted recipients, never auto-read on opening or submission, and route to the actual period', async () => {
  const app = harness({ sort: true }), owner = userId('owner'), other = userId('other');
  app.table('teamMembers').set(owner, active([])); app.table('teamMembers').set(other, active(['super_admin']));
  const mid = 'msg_' + 'd'.repeat(32), periodId = 'wp_' + 'a'.repeat(32);
  app.table('teamMessages').set(mid, { teamId: 'IMC', kind: 'weekly', recipientKey: [owner], subjectId: periodId, readBy: [], createdMs: 1 });
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  assert.equal((await app.member({ action: 'messages' })).messages.length, 1);
  assert.equal((await app.member({ action: 'openMessage', id: mid })).url, '/pages/module/index?id=weekly&period=' + periodId);
  assert.equal((await app.member({ action: 'get' })).hasUnread, true);
  await app.member({ action: 'readMessage', id: mid });
  assert.equal((await app.member({ action: 'get' })).hasUnread, false);
  app.as('other');
  assert.equal((await app.member({ action: 'messages' })).messages.length, 0);
  assert.equal((await app.member({ action: 'openMessage', id: mid })).code, 'FORBIDDEN');
});

test('home includes own real weekly tasks and excludes submitted, exempt, closed and unassigned work', async () => {
  const app = harness({ sort: true }), owner = userId('owner');
  app.table('teamMembers').set(owner, active([]));
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (let n = 0; n < 7; n++) {
    const periodId = 'wp_' + String(n).repeat(32);
    app.table('weeklyPeriods').set(periodId, { teamId: 'IMC', title: '周报' + n, startDate: date, status: n === 4 ? 'closed' : 'open', deadlineMs: Date.now() + 86400000,
      roster: n === 5 ? [] : [{ id: owner, exempt: n === 3 ? '免交' : '' }], allowLateSubmit: true });
    if (n === 1 || n === 2) app.table('weeklyReports').set('wr_' + n, { teamId: 'IMC', ownerId: owner, periodId, status: n === 1 ? 'draft' : 'submitted' });
  }
  const result = await app.member({ action: 'home' });
  assert.equal(result.todos.length, 3);
  assert.deepEqual(result.todos.map(t => t.statusLabel).sort(), ['未提交', '未提交', '草稿'].sort());
  assert.ok(result.todos.every(t => t.type === '周报提交' && t.periodId));
});

test('realtime registration is bound to platform identity, exposes opaque cursors only and revokes in the membership transaction', async () => {
  const a = harness(), owner = userId('owner'), person = userId('person');
  a.table('teamMembers').set(owner, active(['super_admin']));
  a.table('teamMembers').set(person, active([]));
  a.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  a.as('person');
  const result = await a.member({ action: 'syncConnect', id: owner, OPENID: 'owner' });
  assert.equal(result.ok, true);
  assert.equal(a.table('teamSyncAccess').get('person').memberId, person);
  assert.equal(a.table('teamSyncAccess').has('owner'), false);
  assert.equal(JSON.stringify(result).includes('memberId'), false);
  assert.deepEqual(Object.keys(result.state).sort(), ['approvals', 'home', 'members', 'messages', 'weekly']);
  a.as('owner');
  const before = structuredClone(a.table('teamSync').get('IMC'));
  assert.equal((await a.member({ action: 'set', id: person, status: 'removed', roles: [], revision: 0 })).ok, true);
  assert.equal(a.table('teamSyncAccess').get('person').active, false);
  for (const channel of ['home', 'messages', 'approvals', 'members', 'weekly']) assert.notEqual(a.table('teamSync').get('IMC')[channel], before[channel]);
  a.as('person');
  assert.equal((await a.member({ action: 'syncConnect' })).code, 'MEMBERSHIP_REQUIRED');
  assert.equal((await a.member({ action: 'syncState' })).code, 'MEMBERSHIP_REQUIRED');
});

test('failed membership changes roll back their live cursor and grant as well as the member and notification', async () => {
  const a = harness({ failMessageWrite: true }), owner = userId('owner'), person = userId('person');
  a.table('teamMembers').set(owner, active(['super_admin']));
  a.table('teamMembers').set(person, active([]));
  a.table('teamSecurity').set('IMC', { superAdminIds: [owner] });
  a.as('person'); await a.member({ action: 'syncConnect' }); a.as('owner');
  const before = structuredClone(a.table('teamSync').get('IMC'));
  assert.equal((await a.member({ action: 'set', id: person, status: 'removed', roles: [], revision: 0 })).ok, false);
  assert.equal(a.table('teamMembers').get(person).status, 'active');
  assert.equal(a.table('teamSyncAccess').get('person').active, true);
  assert.deepEqual(a.table('teamSync').get('IMC'), before);
});

test('all business endpoints reject unjoined, pending, disabled, removed and other-team identities', async () => {
  const app = harness();
  const id = userId('owner');
  const events = ['syncConnect', 'syncState', 'home', 'announcements', 'announcement', 'saveAnnouncement', 'withdrawAnnouncement', 'workbenchUsage', 'recordToolOpen', 'directory', 'messages', 'readMessage', 'openMessage', 'list', 'member', 'set']
    .map(action => ({ action, id: 'msg_' + 'a'.repeat(32), toolId: 'finance', roles: ['super_admin'], status: 'active', OPENID: 'spoof' }));
  for (const scope of ['mine', 'pending', 'done']) events.push({ action: 'approvals', scope });
  for (const member of [null, { ...active(['super_admin']), status: 'pending' }, { ...active(['super_admin']), status: 'disabled' },
    { ...active(['super_admin']), status: 'removed' }, { ...active(['super_admin']), teamId: 'OTHER' }]) {
    if (member) app.table('teamMembers').set(id, member); else app.table('teamMembers').delete(id);
    for (const event of events) assert.equal((await app.member(event)).code, 'MEMBERSHIP_REQUIRED', event.action);
    assert.equal((await app.check()).code, 'MEMBERSHIP_REQUIRED');
    assert.equal((await app.member({ action: 'get' })).hasUnread, false);
  }
  assert.equal(app.table('workbenchUsage').size, 0);
  assert.equal(app.table('teamAnnouncements').size, 0);
  app.as(''); assert.equal((await app.check()).code, 'AUTH_REQUIRED');
});
