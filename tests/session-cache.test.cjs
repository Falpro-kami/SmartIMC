const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function moduleAt(file, deps = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => deps[name], ...globals });
  return module.exports;
}
const freshCache = () => moduleAt('miniprogram/services/session-cache.js');
function accessFixture() {
  const cache = freshCache(), calls = [];
  let result = { ok: true, accountCode: 'account', member: { teamId: 'IMC', status: 'active', roles: [], revision: 1 }, hasUnread: false };
  let unreadResponse = null, messageResponse = null, identityResponse = null;
  const service = moduleAt('miniprogram/services/access.js', { './session-cache': cache, '../config/cloud': {} }, {
    getApp: () => ({ globalData: { cloudReady: true } }), wx: { cloud: { callFunction: async ({ data }) => {
      calls.push(data.action);
      if (data.action === 'get') return identityResponse ? identityResponse() : { result };
      if (data.action === 'notificationState' && unreadResponse) return unreadResponse();
      if (data.action === 'messages') return messageResponse ? messageResponse() : { result: { ok: true, messages: [{ id: 'message', read: false }], hasUnread: true } };
      return { result: { ok: true, hasUnread: false } };
    } } }
  });
  return { service, cache, calls, identity: value => { result = value; }, pendingUnread: fn => { unreadResponse = fn; },
    pendingMessages: fn => { messageResponse = fn; }, pendingIdentity: fn => { identityResponse = fn; } };
}
test('session cache shares reads, reuses results and cannot restore invalidated data from an old request', async () => {
  const c = freshCache(); let reads = 0, release;
  const loader = async () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const one = c.load('weekly:list', loader), two = c.load('weekly:list', loader);
  await Promise.resolve(); assert.equal(reads, 1);
  release({ title: '周期' }); await Promise.all([one, two]);
  await c.load('weekly:list', loader); assert.equal(reads, 1);
  const stale = c.load('weekly:list', loader, 60000, true); await Promise.resolve();
  c.invalidate('weekly:'); release({ title: '旧数据' }); await stale;
  assert.equal(c.peek('weekly:list'), null);
  c.set('home:dashboard', { value: 'private' }); c.clear(); assert.equal(c.peek('home:dashboard'), null);
});

test('a message push during an earlier unread read always requests post-commit state', async () => {
  const a = accessFixture(); await a.service.get();
  let release, queries = 0;
  a.pendingUnread(() => ++queries === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ result: { ok: true, hasUnread: true } }));
  const old = a.service.notifications(true);
  const pushed = a.service.refreshUnread();
  release({ result: { ok: true, hasUnread: false } });
  await Promise.all([old, pushed]);
  assert.equal(queries, 2);
  assert.equal(a.service.notificationCurrent(), true);
});

test('a membership push waits past an old in-flight identity response before fetching current permissions', async () => {
  const a = accessFixture(); await a.service.get();
  let release, reads = 0;
  const old = { ok: true, accountCode: 'account', member: { teamId: 'IMC', status: 'active', roles: [], revision: 1 }, hasUnread: false };
  const current = { ...old, member: { ...old.member, roles: ['super_admin'], revision: 2 } };
  a.pendingIdentity(() => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ result: current }));
  const pending = a.service.get(true), pushed = a.service.refreshIdentity();
  release({ result: old }); await pending;
  const result = await pushed;
  assert.equal(reads, 2); assert.equal(result.member.roles[0], 'super_admin');
});
test('message list and explicit read synchronize unread badges across headers without deleting unrelated page caches', async () => {
  const a = accessFixture(), seen = [];
  a.service.subscribeUnread(value => seen.push(value));
  await a.service.get(); assert.equal(seen.at(-1), false);
  await a.service.messages(0); assert.equal(seen.at(-1), true);
  assert.equal((await a.service.get()).hasUnread, true);
  a.cache.set('home:dashboard', { todos: [] });
  await a.service.readMessage('message'); assert.equal(seen.at(-1), false);
  assert.ok(a.cache.peek('home:dashboard'));
  assert.equal(a.calls.filter(action => action === 'get').length, 1);
});
test('late unread requests cannot turn a read message red again and role changes clear business caches', async () => {
  const a = accessFixture(); await a.service.get();
  let release;
  a.pendingUnread(() => new Promise(resolve => { release = resolve; }));
  const pending = a.service.notifications(true);
  await a.service.readMessage('message'); release({ result: { ok: true, hasUnread: true } }); await pending;
  assert.equal(a.service.notificationCurrent(), false);
  a.cache.set('weekly:list', { private: true });
  a.identity({ ok: true, accountCode: 'account', member: { teamId: 'IMC', status: 'active', roles: ['weekly_admin'], revision: 2 }, hasUnread: false });
  await a.service.get(true); assert.equal(a.cache.peek('weekly:list'), null);
});

test('late identity and message-list responses cannot overwrite a newer unread or read result', async () => {
  const a = accessFixture(); await a.service.get(); let releaseIdentity, releaseMessages;
  a.pendingIdentity(() => new Promise(resolve => { releaseIdentity = resolve; }));
  const get = a.service.get(true); await a.service.messages(0);
  releaseIdentity({ result: { ok: true, accountCode: 'account', member: { status: 'active', roles: [], revision: 1 }, hasUnread: false } });
  await get; assert.equal(a.service.notificationCurrent(), true);
  a.pendingMessages(() => new Promise(resolve => { releaseMessages = resolve; }));
  const messages = a.service.messages(0); await a.service.readMessage('message');
  releaseMessages({ result: { ok: true, messages: [], hasUnread: true } }); await messages;
  assert.equal(a.service.notificationCurrent(), false);
});
test('returning to home displays cached content immediately without another cloud read or loading screen', async () => {
  const cache = freshCache(); let reads = 0, page;
  const data = { ok: true, todos: [], announcements: [], canManage: false };
  const home = moduleAt('miniprogram/services/home.js', { './session-cache': cache, '../config/cloud': {} }, {
    getApp: () => ({ globalData: { cloudReady: true } }), wx: { cloud: { callFunction: async () => { reads++; return { result: data }; } } }
  });
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/index/index.js', 'utf8'), {
    Page: value => { page = value; }, require: name => name === '../../utils/member-page' ? value => value : home
  });
  page.setData = values => Object.assign(page.data, values);
  await page.loadHome(); assert.equal(reads, 1); page.onHide();
  const returning = page.loadHome(); assert.equal(page.data.loading, false); await returning; assert.equal(reads, 1);
});

test('a mounted header receives unread changes immediately and a cached identity cannot hide its red dot', async () => {
  const a = accessFixture(); let definition;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/user-header/index.js', 'utf8'), {
    Component: value => { definition = value; }, setInterval: () => 1, clearInterval() {},
    require: name => name.endsWith('/access') ? a.service : name.endsWith('/membership') ? { accept() {} } : name.endsWith('/profile') ? {
      subscribe: () => () => {}, load: async () => ({ profile: { name: '测试成员' } })
    } : { name: 'IMC' },
    wx: { getWindowInfo: () => ({ windowWidth: 390, statusBarHeight: 24 }), getMenuButtonBoundingClientRect: () => ({ left: 290, top: 30, height: 32 }) }
  });
  const header = { ...definition.methods, data: structuredClone(definition.data) };
  header.setData = values => Object.assign(header.data, values);
  definition.lifetimes.attached.call(header); await a.service.get();
  await a.service.messages(0); assert.equal(header.data.hasUnread, true);
  await header.loadIdentity(); assert.equal(header.data.hasUnread, true);
  await a.service.readMessage('message'); assert.equal(header.data.hasUnread, false);
  definition.lifetimes.detached.call(header);
});
