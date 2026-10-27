const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(file, service, wx = {}, component = false) {
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: () => service, wx,
    Page: value => { definition = value; }, Component: value => { definition = value; } });
  const target = component ? { data: structuredClone(definition.data), properties: { initialId: '', compose: false }, ...definition.methods } : definition;
  target.setData = values => { for (const [key, value] of Object.entries(values)) {
    const parts = key.split('.'); let object = target.data;
    for (const part of parts.slice(0, -1)) object = object[part];
    object[parts.at(-1)] = value;
  } };
  return target;
}
const id = 'ann_' + 'a'.repeat(32), memberId = 'user_' + 'b'.repeat(32);
const present = row => ({ ...row, dateLabel: '2026-10-27' });
test('home navigation uses real data and late or revoked responses cannot restore team contents', async () => {
  let pending;
  let fail = false;
  const navigation = [];
  const service = { present, dashboard: async () => {
    if (fail) throw new Error('通过成员审核后才能查看团队内容。');
    return new Promise(resolve => { pending = resolve; });
  } };
  const home = load('miniprogram/pages/index/index.js', service, { navigateTo: value => navigation.push(value.url) });
  const request = home.loadHome();
  home.onHide();
  pending({ todos: [{ id: memberId, memberId }], announcements: [{ id }], canManage: true });
  await request;
  assert.equal(home.data.todos.length, 0);
  assert.equal(home.data.canManage, false);
  const next = home.loadHome(); pending({ todos: [{ id: memberId, memberId }], announcements: [{ id }], canManage: true }); await next;
  home.openTodo({ currentTarget: { dataset: { id: memberId } } });
  assert.equal(navigation.at(-1), '/pages/members/index?id=' + memberId);
  home.openApprovals(); assert.equal(navigation.at(-1), '/pages/approvals/index?scope=pending');
  home.openAnnouncement({ currentTarget: { dataset: { id } } });
  assert.equal(navigation.at(-1), '/pages/module/index?id=announcements&announcement=' + id);
  home.publishAnnouncement(); assert.equal(navigation.at(-1), '/pages/module/index?id=announcements&compose=1');
  fail = true; await home.loadHome();
  assert.equal(home.data.todos.length, 0); assert.equal(home.data.announcements.length, 0);
  assert.equal(home.data.canManage, false);
  const count = navigation.length;
  home.publishAnnouncement(); home.openTodo({ currentTarget: { dataset: { id: memberId } } });
  assert.equal(navigation.length, count);
});

test('announcement editing preserves conflict drafts, blocks duplicate clicks, and cancellation never withdraws', async () => {
  let writes = 0, withdrawals = 0, resolveSave;
  let conflict = false;
  const service = { present, save: async () => {
    writes++;
    if (conflict) throw new Error('公告已更新，请重新打开后操作。');
    return new Promise(resolve => { resolveSave = resolve; });
  }, get: async () => ({ announcement: { id, title: '公告', body: '正文', revision: 1 }, canManage: true }),
  withdraw: async () => { withdrawals++; } };
  const panel = load('miniprogram/components/team-announcements/index.js', service,
    { showToast() {}, showModal: async () => ({ confirm: false }) }, true);
  panel.newAnnouncement(); assert.equal(panel.data.draft, null);
  panel.setData({ canManage: true }); panel.newAnnouncement();
  await panel.saveAnnouncement(); assert.equal(writes, 0); assert.ok(panel.data.formError);
  panel.onTitle({ detail: { value: '公告' } }); panel.onBody({ detail: { value: '正文' } });
  panel.onPinned({ detail: { value: true } });
  const saving = panel.saveAnnouncement(); await panel.saveAnnouncement(); assert.equal(writes, 1);
  resolveSave({ ok: true }); await saving;
  assert.equal(panel.data.mode, 'detail'); assert.equal(panel.data.draft, null);
  await panel.withdrawAnnouncement(); assert.equal(withdrawals, 0);
  panel.editAnnouncement(); conflict = true; await panel.saveAnnouncement();
  assert.equal(panel.data.mode, 'edit'); assert.equal(panel.data.draft.body, '正文');
  assert.match(panel.data.formError, /公告已更新/); assert.equal(panel.data.saving, false);
});

test('announcement refresh removes content and publishing controls after membership is revoked', async () => {
  let revoked = false;
  const panel = load('miniprogram/components/team-announcements/index.js', {
    present, list: async () => {
      if (revoked) throw new Error('通过成员审核后才能查看团队内容。');
      return { announcements: [{ id, title: '团队公告' }], nextOffset: 1, hasMore: false, canManage: true };
    }
  }, {}, true);
  await panel.loadAnnouncements(); assert.equal(panel.data.announcements.length, 1);
  panel.newAnnouncement(); revoked = true; await panel.refresh();
  assert.equal(panel.data.mode, 'list'); assert.equal(panel.data.draft, null);
  assert.equal(panel.data.canManage, false); assert.equal(panel.data.announcements.length, 0);
});

test('member removal requires an explicit confirmation and submits the stored revision with no roles', async () => {
  let confirm = false, submitted, calls = 0;
  const members = load('miniprogram/pages/members/index.js', { set: async value => { submitted = value; calls++; } },
    { showModal: async () => ({ confirm }), showToast() {} });
  members.data.editor = { id: memberId, name: '测试成员', status: 'active', roles: ['weekly_admin'], revision: 7 };
  members.loadMembers = async () => { members.setData({ editor: null }); };
  await members.removeMember(); assert.equal(calls, 0); assert.ok(members.data.editor);
  confirm = true; await members.removeMember();
  assert.equal(submitted.id, memberId); assert.equal(submitted.revision, 7);
  assert.equal(submitted.status, 'removed'); assert.equal(submitted.roles.length, 0);
  assert.equal(members.data.editor, null); assert.equal(members.data.saving, false);
});
