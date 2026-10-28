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
function harness(origin = 'pages/workbench/index', manage = false, rightsOverride = {}) {
  const stack = [{ route: origin, options: {}, scrollTop: 0 }], reads = [], nav = [];
  let panelDefinition, pageDefinition, templateDefinition, confirm = true, failNavigation = false, heldAction = '', releaseRead, menuIndex = 0;
  const menus = [];
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: personId(i + 1), name: '测试同学' + (i + 1), status: i === 0 ? 'draft' : 'submitted', submittedMs: 1, files: [] }));
  const periods = Array.from({ length: 25 }, (_, i) => ({ id: periodId(i + 1), title: '周报' + (i + 1), status: 'open', ownStatus: 'outside', startDate: '2026-10-26', endDate: '2026-11-01', deadlineMs: 1793527200000 }));
  const rights = { isLeader: !manage, canManage: manage, canReadTeam: true, canRemind: false, canExport: false, ...rightsOverride };
  const templateId = 'wt_' + 'b'.repeat(32), templateRows = [{ id: templateId, name: '研究周报', revision: 1, schema: require('../miniprogram/utils/weekly-form').defaults() }];
  const cloud = { callFunction: async ({ data }) => {
    reads.push({ ...data });
    if (data.action === heldAction) await new Promise(resolve => { releaseRead = resolve; });
    const p = periods.find(p => p.id === data.periodId);
    if (data.action === 'list') return { result: { ok: true, ...rights, periods: periods.slice(data.offset, data.offset + 20), nextOffset: Math.min(periods.length, data.offset + 20), hasMore: data.offset + 20 < periods.length } };
    if (data.action === 'get') return { result: { ok: true, ...rights, period: { ...p }, own: !data.ownerId, report: data.ownerId ? { revision: 1, status: 'submitted', files: [{ id: 'file', name: '周报.pdf', size: 50 }] } : null, ownerName: data.ownerId ? rows.find(row => row.id === data.ownerId).name : '', versions: [] } };
    if (data.action === 'team') return { result: { ok: true, period: { ...p }, rows: structuredClone(rows), total: 20, submitted: 19 } };
    if (data.action === 'roster') return { result: { ok: true, members: rows.map(r => ({ id: r.id, name: r.name })) } };
    if (data.action === 'configuration') return { result: { ok: true, period: { ...p, revision: 1, roster: rows.map(r => ({ id: r.id, name: r.name, exempt: '' })) } } };
    if (data.action === 'templates') return { result: { ok: true, templates: structuredClone(templateRows) } };
    if (data.action === 'saveTemplate') { const template = { ...data, revision: data.revision + 1 }; const index = templateRows.findIndex(t => t.id === data.id); if (index < 0) templateRows.push(template); else templateRows[index] = template; return { result: { ok: true, template } }; }
    if (data.action === 'deletePeriod') { periods.splice(periods.findIndex(p => p.id === data.periodId), 1); return { result: { ok: true, id: data.periodId } }; }
    if (data.action === 'savePeriod') { const p = { ...periods[0], ...data }; const index = periods.findIndex(p => p.id === data.id); if (index < 0) periods.unshift(p); else periods[index] = p; return { result: { ok: true, id: data.id } }; }
    throw new Error('Unexpected action ' + data.action);
  } };
  function hide(frame) { if (frame.panel) panelDefinition.pageLifetimes.hide.call(frame.panel); }
  function show(frame) { if (frame.panel) panelDefinition.pageLifetimes.show.call(frame.panel); if (frame.template) templateDefinition.pageLifetimes.show.call(frame.template); }
  function setData(target, values) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let data = target.data; for (const part of parts.slice(0, -1)) data = data[part]; data[parts.at(-1)] = value; } }
  function push(url, events = {}) {
    hide(stack.at(-1));
    const options = Object.fromEntries(new URL('https://test.local' + url).searchParams);
    const listeners = new Map(), queued = new Map();
    const eventChannel = { emit(name, value) { if (listeners.has(name)) listeners.get(name)(value); else if (events[name]) events[name](value); else queued.set(name, value); },
      on(name, fn) { listeners.set(name, fn); if (queued.has(name)) { fn(queued.get(name)); queued.delete(name); } }, off(name) { listeners.delete(name); } };
    const frame = { route: 'pages/module/index', options, scrollTop: 0, eventChannel, getOpenerEventChannel: () => eventChannel }; stack.push(frame);
    const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(values) { Object.assign(this.data, values); } };
    frame.page = page; page.onLoad(options);
    const panel = { ...panelDefinition.methods, properties: { initialPeriod: page.data.weeklyPeriod, initialView: page.data.weeklyView, initialOwner: page.data.weeklyOwner, initialTemplate: page.data.weeklyTemplate, chooseTemplate: page.data.weeklyChooseTemplate },
      data: structuredClone(panelDefinition.data), updates: [], selectComponent: () => frame.template, setData(values) {
        this.updates.push(values); setData(this, values);
        if (values.templatesOpen && !frame.template) {
          const child = { ...templateDefinition.methods, properties: { editId: this.properties.initialTemplate, choose: this.properties.chooseTemplate, localTemplate: this.data.periodTemplate }, data: structuredClone(templateDefinition.data),
            setData(values) { setData(this, values); }, triggerEvent(name, detail) { const method = { edit: 'editTemplate', preview: 'previewTemplate', select: 'selectTemplate', done: 'closeTemplates', close: 'closeTemplates' }[name]; if (method) panel[method]({ detail }); } };
          frame.template = child; templateDefinition.lifetimes.attached.call(child);
        }
      } };
    frame.panel = panel; panelDefinition.lifetimes.attached.call(panel); show(frame);
    return frame;
  }
  const wx = { cloud,
    setNavigationBarTitle: ({ title }) => { stack.at(-1).title = title; },
    showModal: async () => ({ confirm }),
    showActionSheet: async ({ itemList }) => { menus.push(itemList); if (menuIndex < 0) throw { errMsg: 'showActionSheet:fail cancel' }; return { tapIndex: menuIndex }; },
    navigateTo(options) { nav.push(options.url); if (failNavigation) { options.fail({ errMsg: 'navigateTo:fail' }); options.complete(); return; } const frame = push(options.url, options.events); if (options.success) options.success({ eventChannel: frame.eventChannel }); options.complete(); },
    navigateBack(options = {}) {
      const delta = options.delta || 1;
      for (let i = 0; i < delta; i++) { const frame = stack.pop(); if (frame.template) templateDefinition.lifetimes.detached.call(frame.template); if (frame.panel) panelDefinition.lifetimes.detached.call(frame.panel); }
      show(stack.at(-1)); if (options.success) options.success(); if (options.complete) options.complete({ errMsg: 'navigateBack:ok' });
    },
    redirectTo(options) { const frame = stack.pop(); if (frame.panel) panelDefinition.lifetimes.detached.call(frame.panel); push(options.url); options.complete(); }
  };
  const cache = moduleAt('miniprogram/services/session-cache.js', {});
  const weekly = moduleAt('miniprogram/services/weekly.js', { './session-cache': cache, './access': { notifications: async () => false }, '../config/cloud': { weeklyFunction: 'weeklyReport' } }, { wx, getApp: () => ({ globalData: { cloudReady: true } }) });
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/module/index.js', 'utf8'), { Page: value => { pageDefinition = value; }, require: name => name === '../../utils/member-page' ? x => x : {}, wx });
  vm.runInNewContext(fs.readFileSync('miniprogram/components/weekly-reports/index.js', 'utf8'), { Component: value => { panelDefinition = value; }, require: name => name === '../../utils/weekly-form' ? require('../miniprogram/utils/weekly-form') : name === '../../services/profile' ? { load: async () => ({ profile: { name: '测试同学' } }) } : weekly, wx, getCurrentPages: () => stack, setTimeout, clearTimeout });
  vm.runInNewContext(fs.readFileSync('miniprogram/components/weekly-template/index.js', 'utf8'), { Component: value => { templateDefinition = value; }, require: name => name === '../../utils/weekly-form' ? require('../miniprogram/utils/weekly-form') : weekly, wx });
  return { stack, reads, nav, push, wx, cache, top: () => stack.at(-1), confirm: value => { confirm = value; }, fail: value => { failNavigation = value; },
    templateId, periods, menus, menu: index => { menuIndex = index; }, hold: action => { heldAction = action; }, release: () => { heldAction = ''; releaseRead(); }, background: () => hide(stack.at(-1)), foreground: () => show(stack.at(-1)) };
}
const tap = id => ({ currentTarget: { dataset: { id } } });

test('weekly list grouping and entry actions respect period state and additive role permissions', () => {
  const weekly = require('../miniprogram/services/weekly'), now = Date.parse('2026-10-28T12:00:00+08:00');
  const p = { id: periodId(1), title: '2026-10-26 至 2026-11-01 周报', startDate: '2026-10-26', endDate: '2026-11-01', status: 'open', canEdit: true, ownStatus: 'draft', deadlineMs: Date.parse('2026-11-01T18:00:00+08:00') };
  const examples = [
    [{}, 'detail', '继续填写', false, true],
    [{ isLeader: true, canReadTeam: true }, 'team', '查看团队提交', false, false],
    [{ canManage: true, canReadTeam: true }, 'detail', '继续填写', true, true],
    [{ isLeader: true, canManage: true, canReadTeam: true }, 'team', '查看团队提交', false, false]
  ];
  for (const [rights, action, label, secondary, ownStatus] of examples) {
    const group = weekly.listLayout([weekly.periodView(p)], rights, now)[0], row = group.rows[0];
    assert.equal(group.id, 'current'); assert.equal(row.entryAction, action); assert.equal(row.entryLabel, label);
    assert.equal(row.secondaryTeam, secondary); assert.equal(row.showOwnStatus, ownStatus);
    assert.equal(row.displayTitle, '10月26日—11月1日'); assert.equal(row.deadlineShort, '11月1日 18:00');
  }
  const planned = { ...p, id: periodId(2), status: 'scheduled', canEdit: false }, old = { ...p, id: periodId(3), status: 'closed', canEdit: false, ownStatus: 'submitted' };
  const groups = weekly.listLayout([weekly.periodView(planned), weekly.periodView(old), weekly.periodView(p)], { canManage: true }, now);
  assert.deepEqual(groups.map(g => g.id), ['current','planned','history']);
  assert.equal(groups[1].rows[0].entryLabel, '周期设置'); assert.equal(groups[2].rows[0].entryLabel, '查看周报');
  assert.equal(weekly.listLayout([planned], {}, now).length, 0);
  const upcoming = weekly.listLayout([{ ...p, startDate: '2026-11-02', endDate: '2026-11-08', canEdit: false }], {}, now)[0];
  assert.equal(upcoming.id, 'upcoming'); assert.equal(upcoming.rows[0].entryLabel, '查看详情');
  assert.equal(weekly.listEntry({ ...p, canEdit: false, ownStatus: 'outside' }, { canReadTeam: true }).action, 'team');
  assert.equal(weekly.listLayout([{ ...old, title: '自定义研究汇报', supersededBy: periodId(9) }], {}, now)[0].rows[0].displayTitle, '自定义研究汇报');
});

test('member, leader, administrator and mixed roles enter the appropriate native page directly from list actions', async () => {
  for (const rights of [
    { isLeader: false, canManage: false, canReadTeam: false },
    { isLeader: true, canManage: false, canReadTeam: true },
    { isLeader: false, canManage: true, canReadTeam: true },
    { isLeader: true, canManage: true, canReadTeam: true }
  ]) {
    const a = harness('pages/workbench/index', rights.canManage, rights); a.periods[0].canEdit = true; a.periods[0].ownStatus = 'draft';
    a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
    list.panel.enterPeriod(tap(periodId(1))); await settle();
    assert.equal(a.top().panel.data.mode, rights.isLeader ? 'team' : 'detail');
    a.wx.navigateBack(); await settle(); assert.equal(a.top(), list);
    await list.panel.periodMenu(tap(periodId(1))); await settle();
    assert.equal(a.menus.length, rights.canManage ? 1 : 0);
    if (rights.canManage) { assert.equal(a.top().title, '周期设置'); a.wx.navigateBack(); await settle(); assert.equal(a.top(), list); }
  }
});

test('planned-period and management-menu navigation preserve the list; cancellation and old editions retain safeguards', async () => {
  const a = harness('pages/workbench/index', true); a.periods[0].status = 'scheduled';
  a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  list.panel.enterPeriod(tap(periodId(1))); await settle(); assert.equal(a.top().title, '周期设置');
  a.wx.navigateBack(); await settle(); a.menu(-1); await list.panel.periodMenu(tap(periodId(1)));
  assert.equal(a.top(), list); assert.equal(list.panel._menuOpen, false); assert.equal(list.panel.data.actionError, '');
  a.menu(0); a.periods[0].supersededBy = periodId(2); await list.panel.loadList(false, true);
  a.confirm(false); await list.panel.periodMenu(tap(periodId(1)));
  assert.equal(a.menus.at(-1).length, 1); assert.equal(a.menus.at(-1)[0], '删除周报');
  assert.equal(a.reads.some(r => r.action === 'deletePeriod'), false);
});

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

test('publish, templates and template editing each have a native back level and retain the original weekly list', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top(); list.scrollTop = 500;
  list.panel.newPeriod(); await settle(); const publish = a.top();
  assert.notEqual(publish, list); assert.equal(publish.title, '发布周报'); assert.equal(publish.panel.data.mode, 'form');
  assert.equal(list.panel.data.mode, 'list');
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), list); assert.equal(list.scrollTop, 500);
  list.panel.manageTemplates(); await settle(); const templates = a.top();
  assert.equal(templates.title, '表单模板'); assert.ok(templates.template); assert.equal(templates.template.data.templates.length, 1);
  templates.template.newTemplate(); await settle();
  assert.equal(a.top().title, '新建模板'); assert.ok(a.top().template.data.editing);
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), templates);
  templates.template.edit(tap(a.templateId)); await settle();
  assert.equal(a.top().title, '编辑模板'); assert.equal(a.top().template.data.editing.id, a.templateId);
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), templates);
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), list); assert.equal(list.scrollTop, 500);
});

test('selecting an edited template returns to the same publish form without losing title, deadline or selected members', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle();
  a.top().panel.newPeriod(); await settle(); const publish = a.top();
  publish.panel.formInput({ currentTarget: { dataset: { field: 'title' } }, detail: { value: '自定义标题' } });
  publish.panel.formInput({ currentTarget: { dataset: { field: 'deadlineTime' } }, detail: { value: '20:30' } });
  publish.panel.toggleMember(tap(personId(1))); const selected = publish.panel.data.members.filter(m => m.selected).length;
  publish.panel.manageTemplates(); await settle(); const templates = a.top();
  assert.equal(templates.panel.properties.chooseTemplate, true);
  templates.template.edit(tap(a.templateId)); await settle();
  a.top().template.name({ detail: { value: '更新后的模板' } });
  await a.top().template.save(); await settle(); assert.equal(a.top(), templates);
  assert.equal(templates.template.data.templates[0].name, '更新后的模板');
  templates.template.chooseTemplate(tap(a.templateId)); await settle();
  assert.equal(a.top(), publish); assert.equal(publish.panel.data.form.templateName, '更新后的模板');
  assert.equal(publish.panel.data.form.title, '自定义标题'); assert.equal(publish.panel.data.form.deadlineTime, '20:30');
  assert.equal(publish.panel.data.members.filter(m => m.selected).length, selected);
  assert.equal(publish.panel.data.mode, 'form');
});

test('a successful publication replaces the editor with detail so back returns directly to the original list', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  list.panel.newPeriod(); await settle(); const publish = a.top(), newId = publish.panel.data.form.id;
  await publish.panel.savePeriod(); await settle();
  assert.equal(a.stack.length, 3); assert.equal(a.top().panel.data.mode, 'detail'); assert.equal(a.top().panel.data.selected.id, newId);
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), list); assert.equal(list.panel.data.periods[0].id, newId);
});

test('cycle settings return to the existing detail page after editing, without replacing it with a form', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle();
  a.top().panel.choosePeriod(tap(periodId(1))); await settle(); const detail = a.top();
  detail.panel.editCurrentPeriod(); await settle(); assert.equal(a.top().title, '周期设置'); assert.equal(a.top().panel.data.mode, 'form');
  await a.top().panel.savePeriod(); await settle(); assert.equal(a.top(), detail); assert.equal(detail.panel.data.mode, 'detail');
});

test('editor routes validate template IDs and reject non-managers before mounting the management UI', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly&view=templates'); await settle();
  assert.equal(a.top().panel.data.templatesOpen, false); assert.equal(a.top().template, undefined); assert.match(a.top().panel.data.error, /管理权限/);
  const b = harness('pages/workbench/index', true); b.push('/pages/module/index?id=weekly&view=template-edit&template=invalid&owner=' + personId(2)); await settle();
  assert.equal(b.top().panel.properties.initialTemplate, 'new'); assert.equal(b.top().panel.properties.initialOwner, '');
  assert.equal(b.top().template.data.editing.revision, 0);
});

test('backgrounding the first publish load resumes it; a failed editor navigation leaves the weekly list usable', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  a.fail(true); list.panel.newPeriod(); assert.equal(a.top(), list); assert.equal(list.panel._navigating, false);
  a.fail(false); a.hold('roster'); list.panel.newPeriod(); await settle();
  a.background(); a.foreground(); a.release(); await settle();
  assert.equal(a.top().panel.data.mode, 'form'); assert.equal(a.top().panel.data.loading, false); assert.ok(a.top().panel.data.form);
});

test('template preview receives unsaved hierarchy through the page channel and returns to the exact editor without cloud writes', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle();
  a.top().panel.manageTemplates(); await settle(); a.top().template.newTemplate(); await settle(); const editor = a.top();
  editor.template.name({ detail: { value: '尚未保存的模板' } });
  editor.template.sectionInput({ currentTarget: { dataset: { section: 0 } }, detail: { value: '项目工作进展' } });
  editor.scrollTop = 680;
  const before = JSON.stringify(editor.template.data.editing), writes = a.reads.filter(r => ['saveTemplate', 'savePeriod', 'saveDraft', 'submit'].includes(r.action)).length;
  for (let i = 0; i < 3; i++) {
    editor.template.preview(); await settle();
    assert.equal(a.top().title, '周报预览'); assert.equal(a.top().panel.data.mode, 'preview');
    assert.equal(a.top().panel.data.preview.name, '尚未保存的模板');
    assert.equal(a.top().panel.data.preview.memberName, '测试同学');
    assert.equal(a.top().panel.data.preview.schema.sections[0].title, '项目工作进展');
    assert.equal(a.top().panel.data.error, ''); assert.equal(a.stack.length, 5);
    a.wx.navigateBack(); await settle(); assert.equal(a.top(), editor); assert.equal(editor.scrollTop, 680);
    assert.equal(JSON.stringify(editor.template.data.editing), before);
  }
  assert.equal(a.reads.filter(r => ['saveTemplate', 'savePeriod', 'saveDraft', 'submit'].includes(r.action)).length, writes);
});

test('a member can preview current content on a separate page and return to the same draft without submitting', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly&period=' + periodId(1)); await settle(); const editor = a.top();
  const schema = require('../miniprogram/utils/weekly-form').defaults();
  Object.assign(editor.panel.data, { isLeader: false, own: true, ownerName: '示例同学', answers: { progress: { ops: [{ insert: '本周完成实验。\n' }] } }, selectedFields: ['progress'], files: [], imageURLs: { sample: 'private-image' } });
  editor.panel.data.selected.schema = schema; editor.scrollTop = 630;
  a.cache.set('weekly:get:' + JSON.stringify({ periodId: periodId(1) }), { ok: true, isLeader: false, own: true, ownerName: '示例同学', period: editor.panel.data.selected,
    report: { revision: 1, status: 'draft', files: [], answers: editor.panel.data.answers, selectedFields: ['progress'] }, imageURLs: editor.panel.data.imageURLs, versions: [] });
  const snapshot = JSON.stringify(editor.panel.data.answers), before = a.reads.length;
  await editor.panel.previewSubmission(); await settle();
  assert.equal(a.top().title, '周报预览'); assert.equal(a.top().panel.properties.initialView, 'submission-preview');
  assert.equal(a.top().panel.data.previewKind, 'submission'); assert.equal(a.top().panel.data.previewMode, 'reading');
  assert.equal(a.top().panel.data.preview.memberName, '示例同学'); assert.equal(JSON.stringify(a.top().panel.data.preview.answers), snapshot);
  assert.equal(a.reads.length, before, 'preview only receives the authorized local snapshot, without cloud writes or manager checks');
  a.top().panel.closeTemplates(); await settle();
  assert.equal(a.top(), editor); assert.equal(editor.scrollTop, 630); assert.equal(JSON.stringify(editor.panel.data.answers), snapshot);
  a.fail(true); await editor.panel.previewSubmission(); assert.equal(a.top(), editor); assert.equal(editor.panel._navigating, false);
  assert.match(editor.panel.data.actionError, /预览打开失败/);
  editor.panel.data.formUploading = true; const count = a.nav.length; await editor.panel.previewSubmission(); assert.equal(a.nav.length, count);
});

test('submission previews need the opener snapshot and do not turn into a public report or a list route', async () => {
  const a = harness(); a.push('/pages/module/index?id=weekly&period=' + periodId(1) + '&view=submission-preview'); await settle();
  assert.equal(a.top().panel.data.preview, null); assert.match(a.top().panel.data.error, /本人周报/); assert.equal(a.reads.length, 0);
  const source = fs.readFileSync('miniprogram/components/weekly-reports/index.wxml', 'utf8');
  assert.match(source, /class="preview-name">{{preview.memberName/); assert.doesNotMatch(source, /{{preview.name/);
  assert.match(source, /readonly embedded outline=/);
});

test('preview opened without an editor has a readable error and a failed navigation keeps template edits intact', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly&view=template-preview'); await settle();
  assert.equal(a.top().panel.data.loading, false); assert.match(a.top().panel.data.error, /模板编辑页面/);
  const b = harness('pages/workbench/index', true); b.push('/pages/module/index?id=weekly'); await settle();
  b.top().panel.manageTemplates(); await settle(); b.top().template.newTemplate(); await settle(); const editor = b.top();
  b.fail(true); editor.template.preview(); await settle(); assert.equal(b.top(), editor); assert.equal(editor.panel._navigating, false); assert.ok(editor.template.data.editing);
  const c = harness(); c.push('/pages/module/index?id=weekly&view=template-preview'); await settle();
  assert.equal(c.top().panel.data.preview, null); assert.match(c.top().panel.data.error, /管理权限/);
});

test('editing the period snapshot uses a separate native page and does not save or mutate a shared template', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly&period=' + periodId(1)); await settle();
  a.top().panel.editCurrentPeriod(); await settle(); const settings = a.top(); settings.scrollTop = 420;
  settings.panel.editPeriodForm(); await settle(); const editor = a.top();
  assert.equal(editor.title, '编辑本期表单'); assert.ok(editor.template.data.editing);
  editor.template.fieldInput({ currentTarget: { dataset: { path: '0.0', key: 'label' } }, detail: { value: '本期修正的字段' } });
  editor.template.preview(); await settle(); assert.equal(a.top().title, '周报预览');
  a.wx.navigateBack(); await settle(); assert.equal(a.top(), editor);
  assert.equal(editor.template.data.editing.schema.sections[0].fields[0].label, '本期修正的字段');
  editor.template.save(); await settle();
  assert.equal(a.top(), settings); assert.equal(settings.scrollTop, 420);
  assert.equal(settings.panel.data.form.schema.sections[0].fields[0].label, '本期修正的字段');
  assert.equal(a.reads.filter(r => ['saveTemplate', 'savePeriod'].includes(r.action)).length, 0);
  a.push('/pages/module/index?id=weekly&view=templates'); await settle();
  assert.notEqual(a.top().template.data.templates[0].schema.sections[0].fields[0].label, '本期修正的字段');
});

test('cancelling deletion preserves the current detail and confirming returns to the same refreshed list', async () => {
  const a = harness('pages/workbench/index', true); a.push('/pages/module/index?id=weekly'); await settle(); const list = a.top();
  list.panel.choosePeriod(tap(periodId(1))); await settle(); const detail = a.top();
  a.confirm(false); await detail.panel.deletePeriod(tap(periodId(1))); await settle();
  assert.equal(a.top(), detail); assert.equal(a.reads.filter(r => r.action === 'deletePeriod').length, 0);
  a.confirm(true); await detail.panel.deletePeriod(tap(periodId(1))); await settle();
  assert.equal(a.top(), list); assert.ok(!list.panel.data.periods.some(p => p.id === periodId(1)));
  assert.equal(a.reads.filter(r => r.action === 'deletePeriod').length, 1);
  assert.equal(list.panel.data.busy, false);
});
