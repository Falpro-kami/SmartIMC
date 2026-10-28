const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(file, deps = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => deps[name], ...globals });
  return module.exports;
}
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function clock() {
  let now = 100000, next = 1;
  const jobs = new Map();
  return { Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = next++; jobs.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => jobs.delete(id),
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const first = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > until) break;
        now = first[1].at; jobs.delete(first[0]); await first[1].fn(); await settle();
      }
      now = until; await settle();
    }, count: () => jobs.size };
}
function server() {
  const channels = ['home', 'messages', 'approvals', 'weekly', 'members'];
  const value = { state: Object.fromEntries(channels.map(c => [c, 'initial'])), watchers: [], todos: [], messages: [], pending: [], done: [], serial: 0 };
  value.push = changes => {
    changes.forEach(c => { value.state[c] = String(++value.serial); });
    for (const w of value.watchers) if (!w.closed) w.options.onChange({ docs: [{ ...value.state }] });
  };
  return value;
}
function client(s, time, options = {}) {
  const calls = [], cache = load('miniprogram/services/session-cache.js', {}, time);
  let approved = true, superAdmin = true, network;
  const wx = { cloud: {
    callFunction: async ({ data }) => {
      calls.push(data.action);
      let result = { ok: true };
      if (data.action === 'get') result = { ...result, accountCode: 'test-user', member: { teamId: 'IMC', status: approved ? 'active' : 'removed', roles: superAdmin ? ['super_admin'] : [], revision: approved ? superAdmin ? 2 : 1 : 3, permissions: approved ? superAdmin ? ['*'] : ['equipment.read'] : [] }, hasUnread: s.messages.some(m => !m.read) };
      if (data.action === 'syncConnect' || data.action === 'syncState') result.state = { ...s.state };
      if (data.action === 'home') result = { ...result, todos: structuredClone(s.todos), announcements: [], canManage: true };
      if (data.action === 'notificationState') result.hasUnread = s.messages.some(m => !m.read);
      if (data.action === 'readMessage') { s.messages.find(m => m.id === data.id).read = true; result.hasUnread = s.messages.some(m => !m.read); }
      if (data.action === 'messages') result = { ...result, messages: structuredClone(s.messages.slice(data.offset, data.offset + 50)), nextOffset: Math.min(s.messages.length, data.offset + 50), hasMore: s.messages.length > data.offset + 50, hasUnread: s.messages.some(m => !m.read) };
      if (['get', 'notificationState', 'readMessage', 'messages'].includes(data.action)) result.unreadCount = Math.min(s.messages.filter(m => !m.read).length, 100);
      if (data.action === 'approvals') { const rows = data.scope === 'pending' ? s.pending : data.scope === 'done' ? s.done : []; result = { ...result, requests: structuredClone(rows), nextOffset: rows.length, hasMore: false }; }
      return { result };
    },
    database: () => ({ collection: name => ({ doc: id => ({ watch: options => {
      assert.equal(name, 'teamSync'); assert.equal(id, 'IMC');
      const watcher = { options, closed: false, close() { watcher.closed = true; } };
      s.watchers.push(watcher);
      if (!s.silent) Promise.resolve().then(() => options.onChange({ docs: [{ ...s.state }] }));
      return watcher;
    } }) }) })
  }, onNetworkStatusChange: fn => { network = fn; }, offNetworkStatusChange: () => { network = null; } };
  const globals = { ...time, wx, getApp: options.getApp || (() => ({ globalData: { cloudReady: true } })) };
  const access = load('miniprogram/services/access.js', { './session-cache': cache, '../config/cloud': {} }, globals);
  const membership = load('miniprogram/services/membership.js', { './access': access, './profile': {} });
  const realtime = load('miniprogram/services/realtime.js', { './access': access, './membership': membership, './session-cache': cache }, globals);
  const home = load('miniprogram/services/home.js', { './session-cache': cache, '../config/cloud': {} }, globals);
  function page(path, service) {
    let p;
    vm.runInNewContext(fs.readFileSync(path, 'utf8'), { Page: value => { p = value; }, require: name => name === '../../utils/member-page' ? x => x : service, wx });
    const updates = [];
    p.setData = values => { updates.push(values); Object.assign(p.data, values); };
    p.updates = updates;
    return p;
  }
  return { access, cache, realtime, membership, home, calls, page, wx, revoke: () => { approved = false; }, role: value => { superAdmin = value; }, network: () => network && network({ isConnected: true }) };
}

function launch(s, time, options = {}) {
  let app, instance, earlyReads = 0;
  const c = client(s, time, { getApp: () => { if (!app) earlyReads++; return app; } });
  c.wx.cloud.init = () => { if (options.cloudFailure) throw new Error('initialization failed'); };
  vm.runInNewContext(fs.readFileSync('miniprogram/app.js', 'utf8'), {
    ...time, wx: c.wx, console: { info() {}, error() {} },
    require: name => name === './services/realtime' ? c.realtime : { envId: 'test' },
    App(definition) {
      instance = definition;
      // WeChat can call both lifecycle hooks before App() returns/getApp() is available.
      instance.onLaunch(); instance.onShow();
      if (options.hideOnLaunch) instance.onHide();
    }
  });
  app = instance;
  return { ...c, app, earlyReads: () => earlyReads };
}

test('cold App registration defers realtime until getApp exists, then receives messages normally', async () => {
  const s = server(), t = clock(), c = launch(s, t);
  assert.equal(c.earlyReads(), 0);
  assert.equal(c.calls.length, 0);
  c.app.onShow(); c.app.onShow();
  await t.advance(0);
  assert.equal(c.calls.filter(action => action === 'get').length, 1);
  assert.equal(s.watchers.filter(w => !w.closed).length, 1);
  c.app.onShow(); await t.advance(0);
  assert.equal(c.calls.filter(action => action === 'get').length, 1);
  assert.equal(s.watchers.filter(w => !w.closed).length, 1);
  await t.advance(200);
  s.messages = [{ id: 'message', read: false }]; s.push(['messages']);
  await t.advance(200);
  assert.equal(c.access.notificationCurrent(), true);
  c.app.onHide();
  assert.equal(s.watchers.filter(w => !w.closed).length, 0);
  assert.equal(t.count(), 0);
});

test('hiding before deferred startup cancels all work and returning starts one watcher', async () => {
  const s = server(), t = clock(), c = launch(s, t, { hideOnLaunch: true });
  await t.advance(1000);
  assert.equal(c.earlyReads(), 0);
  assert.equal(c.calls.length, 0);
  assert.equal(t.count(), 0);
  c.app.onShow(); await t.advance(200);
  assert.equal(s.watchers.filter(w => !w.closed).length, 1);
  c.app.onHide(); assert.equal(t.count(), 0);
});

test('failed cloud initialization does not start realtime or issue identity requests', async () => {
  const s = server(), t = clock(), c = launch(s, t, { cloudFailure: true });
  await t.advance(200);
  assert.equal(c.earlyReads(), 0);
  assert.equal(c.calls.length, 0);
  assert.equal(s.watchers.length, 0);
  c.app.onHide(); assert.equal(t.count(), 0);
});

test('realtime safely ignores a start without an available App instance', () => {
  const s = server(), t = clock(), c = client(s, t, { getApp: () => undefined });
  assert.doesNotThrow(() => c.realtime.start());
  assert.equal(c.calls.length, 0);
  assert.equal(t.count(), 0);
});

test('two independent visible clients receive a new weekly task and unread badge without navigation or a loading screen', async () => {
  const s = server(), t = clock(), a = client(s, t), b = client(s, t);
  const p = b.page('miniprogram/pages/index/index.js', b.home);
  a.realtime.start(); b.realtime.start(); b.realtime.start(); await p.onShow(); await settle(); await t.advance(200);
  assert.equal(s.watchers.filter(w => !w.closed).length, 2);
  assert.equal(p.data.todos.length, 0);
  const before = p.updates.length, identityReads = b.calls.filter(c => c === 'get').length;
  s.todos = [{ id: 'weekly', title: '本周周报', periodId: 'wp_' + 'a'.repeat(32) }];
  s.messages = [{ id: 'message', title: '周报待提交', read: false }];
  s.push(['home', 'weekly', 'messages']);
  await t.advance(200);
  assert.equal(p.data.todos[0].title, '本周周报');
  assert.equal(b.access.notificationCurrent(), true);
  assert.equal(p.updates.slice(before).some(row => row.loading === true), false);
  assert.equal(b.calls.filter(c => c === 'get').length, identityReads, 'ordinary business pushes do not revalidate identity');
  assert.equal(s.messages[0].read, false);
  assert.equal(b.access.notificationCountCurrent(), 1);
  s.messages.push(...Array.from({ length: 102 }, (_, i) => ({ id: 'extra-' + i, title: '新通知', read: false })));
  s.push(['messages']); await t.advance(200); assert.equal(b.access.notificationCountCurrent(), 100);
  s.messages.slice(0, 5).forEach(m => { m.read = true; });
  s.push(['messages']); await t.advance(200); assert.equal(b.access.notificationCountCurrent(), 98);
  p.onHide(); s.todos = []; s.push(['home']); await t.advance(200);
  assert.equal(p.data.todos.length, 1, 'hidden pages stop refreshing but lose their stale cache');
  await p.onShow(); assert.equal(p.data.todos.length, 0);
  a.realtime.stop(); b.realtime.stop(); assert.equal(t.count(), 0);
});

test('approval changes update the open pending/done tabs while the message remains unread until explicit marking', async () => {
  const s = server(), t = clock(), c = client(s, t);
  s.pending = [{ id: 'request', title: '成员申请', createdMs: 1 }];
  s.messages = [{ id: 'message', title: '成员申请', read: false }];
  c.realtime.start(); await settle(); await t.advance(200);
  const p = c.page('miniprogram/pages/approvals/index.js', c.access);
  p.onLoad({ scope: 'pending' }); await p.onShow(); assert.equal(p.data.requests.length, 1);
  s.done = s.pending; s.pending = []; s.push(['approvals', 'home', 'messages']); await t.advance(200);
  assert.equal(p.data.requests.length, 0); assert.equal(c.access.notificationCurrent(), true);
  await p.switchTab({ currentTarget: { dataset: { id: 'done' } } }); assert.equal(p.data.requests.length, 1);
  await c.access.readMessage('message'); assert.equal(c.access.notificationCurrent(), false);
  p.onUnload(); c.realtime.stop();
});

test('disconnected watches fall back, reconnect, ignore old callbacks and stop in the background', async () => {
  const s = server(), t = clock(), c = client(s, t);
  let homeChanges = 0; c.home.subscribe(() => { homeChanges++; });
  c.realtime.start(); await settle(); await t.advance(200);
  const old = s.watchers.at(-1); old.options.onError(new Error('offline')); await settle();
  s.state.home = 'missed'; const before = homeChanges;
  await t.advance(5200);
  assert.ok(homeChanges > before); assert.ok(c.calls.includes('syncState'));
  assert.equal(s.watchers.filter(w => !w.closed).length, 1);
  old.options.onError(new Error('late close error'));
  assert.equal(s.watchers.at(-1).closed, false);
  c.realtime.stop(); const reads = c.calls.length;
  s.watchers.at(-1).options.onChange({ docs: [{ ...s.state, home: 'late' }] });
  await t.advance(60000); assert.equal(c.calls.length, reads); assert.equal(t.count(), 0);
  c.realtime.start(); await settle(); await t.advance(200);
  assert.equal(s.watchers.filter(w => !w.closed).length, 1);
  c.realtime.stop();
});

test('revocation closes realtime access and locks the membership gate without trusting a pushed identity', async () => {
  const s = server(), t = clock(), c = client(s, t);
  c.realtime.start(); await settle(); await t.advance(200);
  c.revoke(); s.push(['members']); await t.advance(200);
  assert.equal(c.membership.current().approved, false);
  assert.equal(s.watchers.filter(w => !w.closed).length, 0);
  c.realtime.stop();
});

test('a watch that never completes its initial handshake still refreshes through the five-second fallback', async () => {
  const s = server(), t = clock(), c = client(s, t); s.silent = true;
  const p = c.page('miniprogram/pages/index/index.js', c.home);
  c.realtime.start(); await p.onShow(); await settle(); await t.advance(200);
  s.state.home = 'changed-without-watch'; s.todos = [{ id: 'new', title: '待办' }];
  await t.advance(5100);
  assert.equal(p.data.todos[0].title, '待办'); assert.ok(c.calls.includes('syncState'));
  p.onUnload(); c.realtime.stop();
});

test('new review permissions are refreshed before the open approval page decides what it can fetch', async () => {
  const s = server(), t = clock(), c = client(s, t); c.role(false);
  c.realtime.start(); await settle(); await t.advance(200);
  const p = c.page('miniprogram/pages/approvals/index.js', c.access);
  p.onLoad({ scope: 'pending' }); await p.onShow(); assert.equal(p.data.canReviewMembers, false);
  c.role(true); s.pending = [{ id: 'request', title: '新申请', createdMs: 1 }];
  s.push(['members', 'approvals']); await t.advance(200);
  assert.equal(p.data.canReviewMembers, true); assert.equal(p.data.requests.length, 1);
  p.onUnload(); c.realtime.stop();
});

test('the metadata rule denies anonymous, inactive and foreign-team reads and every client write', () => {
  const rules = require('../scripts/lib/sync-rules.cjs');
  const read = (auth, grant, id = 'IMC') => vm.runInNewContext(rules.read, { auth, doc: { _id: id }, get: () => grant });
  assert.equal(rules.write, false);
  assert.equal(read(null, null), false);
  assert.equal(read({ openid: 'person' }, { active: false, teamId: 'IMC' }), false);
  assert.equal(read({ openid: 'person' }, { active: true, teamId: 'OTHER' }), false);
  assert.equal(read({ openid: 'person' }, { active: true, teamId: 'IMC' }, 'OTHER'), false);
  assert.equal(read({ openid: 'person' }, { active: true, teamId: 'IMC' }), true);
});

test('live message refresh retains loaded pages and does not read messages just by opening them', async () => {
  const s = server(), t = clock(), c = client(s, t);
  s.messages = Array.from({ length: 120 }, (_, i) => ({ id: String(i), title: '通知', read: false, createdMs: 120 - i }));
  const p = c.page('miniprogram/pages/messages/index.js', c.access);
  await p.onShow(); await p.loadMore(); assert.equal(p.data.messages.length, 100);
  s.messages.unshift({ id: 'new', title: '新通知', createdMs: 121, read: false });
  c.cache.publish(['messages']); await settle();
  assert.equal(p.data.messages.length, 100); assert.equal(p.data.messages[0].id, 'new');
  assert.equal(s.messages.every(m => !m.read), true);
  assert.equal(c.calls.includes('readMessage'), false);
  p.onUnload();
});

test('a weekly push is deferred during editing and an in-flight read cannot overwrite an upload', async () => {
  let definition, listener, release, calls = 0;
  const weekly = { subscribe: fn => { listener = fn; return () => {}; }, periodView: x => x, fileView: x => x, dateLabel: () => '',
    call: async () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  vm.runInNewContext(fs.readFileSync('miniprogram/components/weekly-reports/index.js', 'utf8'), { require: () => weekly, Component: value => { definition = value; } });
  const p = { ...definition.methods, properties: { initialPeriod: '', initialView: 'detail', initialOwner: '' }, data: { ...structuredClone(definition.data), loading: false, mode: 'form', form: { title: '正在编辑' } }, setData(values) { Object.assign(this.data, values); } };
  p.startLive(); listener(); await settle();
  assert.equal(calls, 0); assert.equal(p.data.form.title, '正在编辑');
  p.data.mode = 'detail'; p.data.selected = { id: 'period' }; p.data.files = [{ id: 'local' }];
  p.refreshLive(); await settle(); assert.equal(calls, 1);
  p._choosing = true;
  release({ period: { id: 'period' }, report: { files: [] }, own: true, versions: [] }); await settle();
  assert.equal(p.data.files[0].id, 'local'); assert.equal(p._livePending, true);
  p.stopLive();
});
