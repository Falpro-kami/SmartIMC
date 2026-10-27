const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function moduleAt(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => name === './session-cache' ? require('../miniprogram/services/session-cache') : dependencies[name], ...globals });
  return module.exports;
}
const active = { teamId: 'IMC', status: 'active', permissions: ['equipment.read'] };
const can = (member, permission) => !!(member && member.status === 'active' && member.permissions.includes(permission));
test('membership checks fail closed and submitting an application cannot approve a member', async () => {
  let member = null, fail = false, saves = 0, applies = 0, gets = 0;
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => { gets++; if (fail) throw new Error('离线'); return { member }; }, apply: async () => { applies++; member = { teamId: 'IMC', status: 'pending', permissions: [] }; return { member }; } },
    './profile': { save: async value => { assert.equal(value.name, '测试成员'); saves++; } }
  });
  const phases = []; service.subscribe(value => phases.push(value.phase));
  await Promise.all([service.check(), service.check()]);
  assert.equal(gets, 1); assert.equal(service.current().phase, 'apply');
  await service.submit({ name: '测试成员' });
  assert.equal(saves, 1); assert.equal(applies, 1);
  assert.equal(service.current().phase, 'pending'); assert.equal(service.current().approved, false);
  await service.submit({ name: '测试成员' }); assert.equal(applies, 1);
  member = active; await service.check(); assert.equal(service.current().approved, true);
  fail = true; await service.check(); assert.equal(service.current().approved, false); assert.equal(service.current().phase, 'error');
  fail = false;
  for (const status of ['pending', 'disabled', 'removed']) { member = { ...active, status }; await service.check(); assert.equal(service.current().approved, false); }
  member = { ...active, teamId: 'OTHER' }; await service.check(); assert.equal(service.current().approved, false);
  assert.ok(phases.includes('checking'));
});

test('guarded pages never load before verification and direct links remain locked until approved', async () => {
  let listener, resolveCheck, loads = 0, shows = 0, hides = 0, pages = 0, options;
  let state = { phase: 'checking', approved: false };
  const publish = next => { state = next; listener(next); };
  const service = { subscribe: callback => { listener = callback; callback(state); return () => { listener = () => {}; }; },
    current: () => state,
    ensure: () => { publish({ phase: 'checking', approved: false }); return new Promise(resolve => { resolveCheck = resolve; }); } };
  const wrap = moduleAt('miniprogram/utils/member-page.js', { '../services/membership': service });
  const page = wrap({ data: {}, onLoad(value) { loads++; options = value; }, onShow() { shows++; }, onHide() { hides++; }, onReachBottom() { pages++; } });
  page.setData = values => Object.assign(page.data, values);
  page.onLoad({ id: 'private-detail' });
  const checking = page.onShow();
  assert.equal(loads, 0, 'The first entry must remain locked until the server confirms membership');
  page.onReachBottom(); assert.equal(pages, 0);
  publish({ phase: 'pending', approved: false }); resolveCheck(state); await checking;
  assert.equal(loads, 0); assert.equal(page.data.membershipAllowed, false);
  publish({ phase: 'active', approved: true });
  assert.equal(loads, 1); assert.equal(shows, 1); assert.equal(options.id, 'private-detail');
  page.onReachBottom(); assert.equal(pages, 1);
  publish({ phase: 'removed', approved: false });
  assert.equal(hides, 1); assert.equal(page.data.membershipAllowed, false);
  page.onReachBottom(); assert.equal(pages, 1);
  const stale = page.onShow();
  publish({ phase: 'active', approved: true });
  publish({ phase: 'removed', approved: false });
  resolveCheck({ phase: 'active', approved: true }); await stale;
  assert.equal(page.data.membershipAllowed, false, 'A delayed active result cannot undo a newer revocation');
  page.onUnload(); publish({ phase: 'active', approved: true }); assert.equal(shows, 1);
});

test('every registered page excludes business markup before membership approval', () => {
  const app = JSON.parse(fs.readFileSync('miniprogram/app.json', 'utf8'));
  assert.equal(app.usingComponents['membership-gate'], '/components/membership-gate/index');
  for (const route of app.pages) {
    const js = fs.readFileSync('miniprogram/' + route + '.js', 'utf8');
    const wxml = fs.readFileSync('miniprogram/' + route + '.wxml', 'utf8');
    assert.match(js, /Page\(require\('\.\.\/\.\.\/utils\/member-page'\)\(/, route);
    assert.ok(wxml.startsWith('<block wx:if="{{membershipAllowed}}">'), route);
    assert.ok(wxml.trimEnd().endsWith('<membership-gate wx:else />'), route);
  }
  assert.match(fs.readFileSync('miniprogram/custom-tab-bar/index.wxml', 'utf8'), /wx:if="{{authorized}}"/);
});

test('switching between approved pages reuses session identity without verification screens or extra checks', async () => {
  let checks = 0;
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => { checks++; return { member: active }; } }, './profile': {}
  });
  const wrap = moduleAt('miniprogram/utils/member-page.js', { '../services/membership': service });
  let loads = 0, shows = 0;
  const makePage = () => {
    const page = wrap({ data: {}, onLoad() { loads++; }, onShow() { shows++; } });
    page.setData = values => Object.assign(page.data, values); page.onLoad({}); return page;
  };
  const first = makePage(), second = makePage();
  await first.onShow(); assert.equal(checks, 1);
  first.onHide(); assert.equal(first.data.membershipAllowed, true);
  const opening = second.onShow();
  assert.equal(second.data.membershipAllowed, true, 'Approved pages open directly without displaying the gate');
  await opening; second.onHide(); await first.onShow();
  assert.equal(checks, 1); assert.equal(loads, 2); assert.equal(shows, 3);
  service.accept({ member: { ...active, status: 'removed' } });
  assert.equal(first.data.membershipAllowed, false); assert.equal(second.data.membershipAllowed, false);
});

test('pending session state remains locked across navigation without repeating the identity request', async () => {
  let checks = 0;
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => { checks++; return { member: { ...active, status: 'pending' } }; } }, './profile': {}
  });
  await service.ensure(); await service.ensure(); await service.ensure();
  assert.equal(checks, 1); assert.equal(service.current().approved, false);
  await service.check(); assert.equal(checks, 2, 'The explicit review-status button still fetches current approval');
});

test('identity reads share the session result and explicit refresh or a mutation fetches fresh data', async () => {
  let gets = 0;
  const access = moduleAt('miniprogram/services/access.js', { '../config/cloud': { accessFunction: 'memberAccess' } }, {
    getApp: () => ({ globalData: { cloudReady: true } }), wx: { cloud: { callFunction: async ({ data }) => {
      if (data.action === 'get') { gets++; return { result: { ok: true, member: active, hasUnread: true } }; }
      return { result: { ok: true } };
    } } }
  });
  await Promise.all([access.get(), access.get()]); await access.get(); assert.equal(gets, 1);
  await access.get(true); assert.equal(gets, 2);
  await access.readMessage('message'); await access.get(); assert.equal(gets, 3);
});

test('a lost application response recovers the pending state without granting access or resubmitting', async () => {
  let submitted = false, applications = 0;
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => ({ member: submitted ? { teamId: 'IMC', status: 'pending', permissions: [] } : null }),
      apply: async () => { applications++; submitted = true; throw new Error('网络超时'); } },
    './profile': { save: async () => {} }
  });
  await service.check(); await service.submit({ name: '测试成员' });
  assert.equal(service.current().phase, 'pending'); assert.equal(service.current().approved, false);
  await service.submit({ name: '测试成员' }); assert.equal(applications, 1);
});

test('removed users can submit a new request and lost responses recover pending without unlocking business pages', async () => {
  let member = { ...active, status: 'removed' }, applications = 0;
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => ({ member }), apply: async () => { applications++; member = { ...active, status: 'pending', permissions: [] }; throw new Error('网络超时'); } },
    './profile': { save: async () => {} }
  });
  service.accept({ member });
  assert.equal(service.current().phase, 'removed'); assert.equal(service.current().approved, false);
  await service.submit({ name: '重新申请的成员' });
  assert.equal(service.current().phase, 'pending'); assert.equal(service.current().approved, false);
  await service.submit({ name: '重新申请的成员' }); assert.equal(applications, 1);
  member = { ...active }; await service.check(); assert.equal(service.current().approved, true);
});

test('a rejected reapplication keeps its form usable and displays the error instead of hiding it as a removed state', async () => {
  const member = { ...active, status: 'removed' };
  const service = moduleAt('miniprogram/services/membership.js', {
    './access': { can, get: async () => ({ member }), apply: async () => { throw new Error('申请暂时无法提交'); } }, './profile': { save: async () => {} }
  });
  service.accept({ member });
  await assert.rejects(service.submit({ name: '测试成员' }), /暂时无法提交/);
  assert.equal(service.current().phase, 'removed'); assert.equal(service.current().approved, false);
});

test('removed membership gate pre-fills the personal profile and submits the reapplication form', async () => {
  let definition, submitted;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/membership-gate/index.js', 'utf8'), {
    Component: value => { definition = value; }, require: name => name.endsWith('/membership') ? {
      submit: async value => { submitted = value; }
    } : { load: async () => ({ profile: { name: '原有姓名', avatarFileId: 'cloud://own/avatar' } }) }
  });
  const gate = { data: { ...definition.data, phase: 'removed' }, ...definition.methods };
  gate.setData = values => Object.assign(gate.data, values);
  await gate.loadProfile(); assert.equal(gate.data.name, '原有姓名');
  assert.equal(gate.data.avatar, 'cloud://own/avatar');
  await gate.submitApplication(); assert.equal(submitted.name, '原有姓名');
  assert.equal(gate.data.saving, false);
  const template = fs.readFileSync('miniprogram/components/membership-gate/index.wxml', 'utf8');
  assert.ok(template.includes("phase === 'apply' || phase === 'removed'"));
  assert.ok(template.includes('重新申请加入 IMC'));
});

test('enrollment validates the name, prevents duplicate submissions and does not request business data', async () => {
  let definition, resolve, calls = 0;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/membership-gate/index.js', 'utf8'), {
    Component: value => { definition = value; }, require: name => name.endsWith('/membership') ? {
      submit: async item => { calls++; assert.equal(item.name, '测试成员'); return new Promise(done => { resolve = done; }); }
    } : {}
  });
  const gate = { data: { ...definition.data, phase: 'apply' }, ...definition.methods };
  gate.setData = values => Object.assign(gate.data, values);
  await gate.submitApplication(); assert.equal(calls, 0); assert.equal(gate.data.error, '请填写姓名');
  gate.changeName({ detail: { value: ' 测试成员 ' } });
  const pending = gate.submitApplication(); await gate.submitApplication(); assert.equal(calls, 1);
  resolve(); await pending; assert.equal(gate.data.saving, false);
});
