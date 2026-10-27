const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tabs = require('../miniprogram/config/tabs');

function load(file, globals, dependencies = {}) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    ...globals, require: name => {
      if (name === '../../utils/member-page') return value => value;
      if (/services\/membership$/.test(name)) return { accept() {}, subscribe(listener) { listener({ approved: true }); return () => {}; } };
      if (!(name in dependencies)) throw new Error('Unexpected require ' + name);
      return dependencies[name];
    }
  }, { filename: file });
}

test('navigation registration matches the rendered tabs and does not depend on image files', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'));
  assert.equal(app.tabBar.custom, true);
  assert.deepEqual(app.tabBar.list.map(tab => ({ pagePath: tab.pagePath, text: tab.text })),
    tabs.map(tab => ({ pagePath: tab.pagePath, text: tab.text })));
  assert.ok(tabs.every(tab => app.pages.includes(tab.pagePath)));
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxml'), 'utf8');
  assert.doesNotMatch(template, /<(?:cover-)?image\b|\bsrc=/);
});

test('custom tab state follows the active page and survives returning from a secondary page', () => {
  let definition;
  let route = tabs[1].pagePath;
  load('miniprogram/custom-tab-bar/index.js', {
    Component: value => { definition = value; }, getCurrentPages: () => [{ route }]
  }, { '../config/tabs': tabs });
  const component = { data: { ...definition.data }, ...definition.methods };
  component.setData = values => Object.assign(component.data, values);
  component.data.authorized = true;
  definition.lifetimes.attached.call(component);
  assert.equal(component.data.selected, 1);
  route = 'pages/equipment/index';
  component.syncRoute();
  assert.equal(component.data.selected, 1);
  route = tabs[2].pagePath;
  definition.pageLifetimes.show.call(component);
  assert.equal(component.data.selected, 2);
  for (const [index, tab] of tabs.entries()) {
    let page;
    load('miniprogram/' + tab.pagePath + '.js', { Page: value => { page = value; } }, {
      '../../services/access': { get: async () => ({ member: null }), can: () => false },
      '../../services/admin-data': {},
      '../../services/home': { dashboard: async () => ({ todos: [], announcements: [] }), present: value => value },
      '../../services/workbench': { load: async () => ({}) },
      '../../utils/workbench': require('../miniprogram/utils/workbench')
    });
    page.setData = () => {};
    page.getTabBar = () => component;
    page.onShow();
    assert.equal(component.data.selected, index);
  }
});

test('switching rejects invalid taps, prevents duplicates, and does not highlight a failed destination', () => {
  let definition;
  let pending;
  let calls = 0;
  let errors = 0;
  load('miniprogram/custom-tab-bar/index.js', {
    Component: value => { definition = value; },
    getCurrentPages: () => [{ route: tabs[0].pagePath }],
    wx: { switchTab(options) { calls += 1; pending = options; }, showToast() { errors += 1; } }
  }, { '../config/tabs': tabs });
  const component = { data: { ...definition.data }, ...definition.methods };
  component.setData = values => Object.assign(component.data, values);
  const tap = index => component.switchTab({ currentTarget: { dataset: { index } } });
  tap(1); assert.equal(calls, 0, 'Unapproved identities cannot switch tabs');
  component.data.authorized = true;
  tap(-1); tap(99); tap('invalid'); tap(0);
  assert.equal(calls, 0);
  tap('1'); tap('2');
  assert.equal(calls, 1);
  assert.equal(pending.url, '/pages/workbench/index');
  pending.fail(); pending.complete();
  assert.equal(errors, 1);
  assert.equal(component.data.selected, 0);
  tap(2);
  assert.equal(calls, 2);
  assert.equal(pending.url, '/pages/profile/index');
});
