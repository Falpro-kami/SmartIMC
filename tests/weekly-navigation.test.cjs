const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const periodId = n => 'wp_' + n.toString(16).padStart(32, '0');
const personId = n => 'user_' + n.toString(16).padStart(32, '0');
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function moduleAt(file, deps, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => deps[name], ...globals });
  return module.exports;
}
function harness(origin = 'pages/workbench/index') {
  const stack = [{ route: origin, options: {}, scrollTop: 0 }], reads = [], nav = [];
  let panelDefinition, pageDefinition, confirm = true, failNavigation = false, heldAction = '', releaseRead;
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: personId(i + 1), name: '测试同学' + (i + 1), status: i === 0 ? 'draft' : 'submitted', submittedMs: 1, files: [] }));
  const periods = Array.from({ length: 25 }, (_, i) => ({ id: periodId(i + 1), title: '周报' + (i + 1), status: 'open', ownStatus: 'outside', startDate: '2026-10-26', endDate: '2026-11-01', deadlineMs: 1793527200000 }));
  const rights = { canManage: false, canReadTeam: true, canRemind: false, canExport: false };
  const cloud = { callFunction: async ({ data }) => {
    reads.push({ ...data });
    if (data.action === heldAction) await new Promise(resolve => { releaseRead = resolve; });
    const p = periods.find(p => p.id === data.periodId);
    if (data.action === 'list') return { result: { ok: true, ...rights, periods: periods.slice(data.offset, data.offset + 20), nextOffset: Math.min(periods.length, data.offset + 20), hasMore: data.offset + 20 < periods.length } };
    if (data.action === 'get') return { result: { ok: true, ...rights, period: { ...p }, own: !data.ownerId, report: data.ownerId ? { revision: 1, status: 'submitted', files: [{ id: 'file', name: '周报.pdf', size: 50 }] } : null, ownerName: data.ownerId ? rows.find(row => row.id === data.ownerId).name : '', versions: [] } };
    if (data.action === 'team') return { result: { ok: true, period: { ...p }, rows: structuredClone(rows), total: 20, submitted: 19 } };
    if (data.action === 'savePeriod') { periods.unshift({ ...periods[0], id: data.id, title: data.title }); return { result: { ok: true, id: data.id } }; }
    throw new Error('Unexpected action ' + data.action);
  } };
  function hide(frame) { if (frame.panel) panelDefinition.pageLifetimes.hide.call(frame.panel); }
  function show(frame) { if (frame.panel) panelDefinition.pageLifetimes.show.call(frame.panel); }
  function push(url) {
    hide(stack.at(-1));
    const options = Object.fromEntries(new URL('https://test.local' + url).searchParams);
    const frame = { route: 'pages/module/index', options, scrollTop: 0 }; stack.push(frame);
    const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(values) { Object.assign(this.data, values); } };
    frame.page = page; page.onLoad(options);
    const panel = { ...panelDefinition.methods, properties: { initialPeriod: page.data.weeklyPeriod, initialView: page.data.weeklyView, initialOwner: page.data.weeklyOwner },
      data: structuredClone(panelDefinition.data), updates: [], setData(values) { this.updates.push(values); Object.assign(this.data, values); } };
    frame.panel = panel; panelDefinition.lifetimes.attached.call(panel); show(frame);
  }
  const wx = { cloud,
    setNavigationBarTitle: ({ title }) => { stack.at(-1).title = title; },
    showModal: async () => ({ confirm }),
    navigateTo(options) { nav.push(options.url); if (failNavigation) { options.fail({ errMsg: 'navigateTo:fail' }); options.complete(); return; } push(options.url); if (options.success) options.success(); options.complete(); },
    navigateBack(options = {}) {
      const delta = options.delta || 1;
      for (let i = 0; i < delta; i++) { const frame = stack.pop(); if (frame.panel) panelDefinition.lifetimes.detached.call(frame.panel); }
      show(stack.at(-1)); if (options.success) options.success(); if (options.complete) options.complete({ errMsg: 'navigateBack:ok' });
    },
    redirectTo(options) { const frame = stack.pop(); if (frame.panel) panelDefinition.lifetimes.detached.call(frame.panel); push(options.url); options.complete(); }
  };
  const cache = moduleAt('miniprogram/services/session-cache.js', {});
  const weekly = moduleAt('miniprogram/services/weekly.js', { './session-cache': cache, './access': { notifications: async () => false }, '../config/cloud': { weeklyFunction: 'weeklyReport' } }, { wx, getApp: () => ({ globalData: { cloudReady: true } }) });
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/module/index.js', 'utf8'), { Page: value => { pageDefinition = value; }, require: name => name === '../../utils/member-page' ? x => x : {}, wx });
  vm.runInNewContext(fs.readFileSync('miniprogram/components/weekly-reports/index.js', 'utf8'), { Component: value => { panelDefinition = value; }, require: () => weekly, wx, getCurrentPages: () => stack });
  return { stack, reads, nav, push, wx, cache, top: () => stack.at(-1), confirm: value => { confirm = value; }, fail: value => { failNavigation = value; },
    hold: action => { heldAction = action; }, release: () => { heldAction = ''; releaseRead(); }, background: () => hide(stack.at(-1)), foreground: () => show(stack.at(-1)) };
}
const tap = id => ({ currentTarget: { dataset: { id } } });

test('native back returns student → the same filtered team → period → the same paginated list → workbench', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly'); await settle();
  const list = a.top(); await list.panel.loadMore(); list.scrollTop = 600;
  assert.equal(list.panel.data.periods.length, 25);
  list.panel.choosePeriod(tap(periodId(1))); await settle();
  assert.equal(a.top().panel.data.mode, 'detail'); assert.equal(a.top().title, '周报详情');
  const detail = a.top(); detail.panel.openTeam(); await settle();
  const team = a.top(); assert.equal(team.panel.data.mode, 'team'); assert.equal(team.panel.data.rows.length, 20);
  team.panel.setFilter({ currentTarget: { dataset: { value: 'submitted' } } }); team.scrollTop = 840;
  const teamReads = a.reads.filter(row => row.action === 'team').length;
  for (const n of [17, 18, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    team.panel.openTeamReport(tap(personId(n))); await settle();
    assert.equal(a.stack.length, 5);
    assert.equal(a.top().panel.properties.initialOwner, personId(n));
    assert.equal(a.top().panel.data.own, false); assert.equal(a.top().panel.data.ownerName, '测试同学' + n);
    assert.equal(team.panel.data.mode, 'team', 'the parent is preserved rather than replaced with a member report');
    a.wx.navigateBack(); await settle();
    assert.equal(a.top(), team); assert.equal(team.scrollTop, 840);
    assert.equal(team.panel.data.filter, 'submitted'); assert.equal(team.panel.data.filteredRows.length, 19);
    assert.equal(team.panel.data.loading, false);
  }
  assert.equal(a.reads.filter(row => row.action === 'team').length, teamReads, 'returning reuses the current team result');
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), detail); assert.equal(detail.panel.data.mode, 'detail');
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), list);
  assert.equal(list.scrollTop, 600); assert.equal(list.panel.data.periods.length, 25);
  a.wx.navigateBack(); assert.equal(a.top().route, 'pages/workbench/index');
});

test('a member report returns to its existing team through either native back or the team button, without duplicate stacks', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly&period=' + periodId(1) + '&view=team'); await settle();
  const team = a.top();
  team.panel.openTeamReport(tap(personId(1))); await settle(); assert.equal(a.top(), team, 'an unsubmitted report is not navigable');
  team.panel.openTeamReport(tap(personId(2))); await settle();
  a.top().panel.openTeam(); await settle(); assert.equal(a.top(), team); assert.equal(a.stack.length, 2);
  const before = a.nav.length;
  a.fail(true); team.panel.openTeamReport(tap(personId(3))); assert.equal(team.panel._navigating, false);
  assert.equal(team.panel.data.actionError, '页面打开失败，请重试。'); assert.equal(a.top(), team);
  a.fail(false); team.panel.openTeamReport(tap(personId(3))); await settle(); assert.equal(a.nav.length, before + 2);
});

test('notification deep links load only the requested report; list shortcuts leave a coherent native return path', async () => {
  const a = harness('pages/messages/index'); a.push('/pages/module/index?id=weekly&period=' + periodId(1)); await settle();
  assert.equal(a.reads.some(row => row.action === 'list'), false, 'deep links do not fetch every period first');
  a.top().panel.openTeam(); await settle(); a.top().panel.openTeamReport(tap(personId(7))); await settle();
  await a.top().panel.backToList(); await settle();
  assert.equal(a.stack.length, 2); assert.equal(a.top().panel.data.mode, 'list');
  a.wx.navigateBack(); assert.equal(a.top().route, 'pages/messages/index');
});

test('list shortcut returns to the existing root and leaving an unsaved draft still requires its existing confirmation', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  list.panel.choosePeriod(tap(periodId(1))); await settle(); a.top().panel.openTeam(); await settle();
  a.top().panel.openTeamReport(tap(personId(4))); await settle(); const student = a.top();
  student.panel._unsaved = { requestId: 'unsaved' }; a.confirm(false);
  await student.panel.backToList(); assert.equal(a.top(), student); assert.ok(student.panel._unsaved);
  a.confirm(true); await student.panel.backToList(); await settle(); assert.equal(a.top(), list); assert.equal(a.stack.length, 2);
});

test('module routes validate period/owner parameters and page re-entry retains team updates without a loading screen', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly&period=invalid&view=team&owner=invalid'); await settle();
  assert.equal(a.top().panel.data.mode, 'list'); assert.equal(a.top().panel.properties.initialOwner, '');
  a.top().panel.choosePeriod(tap(periodId(1))); await settle(); a.top().panel.openTeam(); await settle();
  const team = a.top(); team.panel.setFilter({ currentTarget: { dataset: { value: 'submitted' } } });
  team.panel.openTeamReport(tap(personId(9))); await settle();
  a.cache.publish(['weekly']); const before = team.panel.updates.length;
  a.wx.navigateBack(); await settle();
  assert.equal(team.panel.data.filter, 'submitted'); assert.equal(team.panel.data.rows.length, 20);
  assert.equal(team.panel.updates.slice(before).some(values => values.loading === true), false);
  assert.equal(a.top(), team);
});

test('backgrounding and resuming during a first team load cannot leave the new route stuck loading', async () => {
  const a = harness(); a.hold('get'); a.push('/pages/module/index?id=weekly&period=' + periodId(1) + '&view=team'); await settle();
  a.background(); a.foreground(); a.release(); await settle();
  assert.equal(a.top().panel.data.mode, 'team'); assert.equal(a.top().panel.data.rows.length, 20);
  assert.equal(a.top().panel.data.loading, false); assert.equal(a.top().panel.data.error, '');
});

test('publishing from the list preserves the list underneath the new period detail', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  list.panel.update({ mode: 'form', canManage: true, form: { id: periodId(26), revision: 0, title: '新周期', startDate: '2026-10-26', endDate: '2026-11-01', deadlineDate: '2026-11-01', deadlineTime: '18:00', status: 'open', allowLateSubmit: true, allowLateEdit: false }, members: [{ id: personId(2), selected: true, exempt: '' }] });
  await list.panel.savePeriod(); await settle();
  assert.notEqual(a.top(), list); assert.equal(a.top().panel.data.selected.id, periodId(26));
  a.wx.navigateBack(); await settle();
  assert.equal(a.top(), list); assert.equal(list.panel.data.mode, 'list'); assert.equal(list.panel.data.periods[0].id, periodId(26));
});
