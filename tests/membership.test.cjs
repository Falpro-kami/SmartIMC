const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function moduleAt(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => dependencies[name] });
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
  let state = { phase: 'active', approved: true };
  const publish = next => { state = next; listener(next); };
  const service = { subscribe: callback => { listener = callback; callback(state); return () => { listener = () => {}; }; },
    check: () => { publish({ phase: 'checking', approved: false }); return new Promise(resolve => { resolveCheck = resolve; }); } };
  const wrap = moduleAt('miniprogram/utils/member-page.js', { '../services/membership': service });
  const page = wrap({ data: {}, onLoad(value) { loads++; options = value; }, onShow() { shows++; }, onHide() { hides++; }, onReachBottom() { pages++; } });
  page.setData = values => Object.assign(page.data, values);
  page.onLoad({ id: 'private-detail' });
  const checking = page.onShow();
  assert.equal(loads, 0, 'A cached active identity must not unlock a new page before the new check');
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
