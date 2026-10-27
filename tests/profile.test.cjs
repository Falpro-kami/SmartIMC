const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const APP_ID = 'wx875c04f31134c779';
const ENV = 'well-leopon-d5glrufc6e4fd4413';

function sandbox(file, dependencies, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, console, ...globals,
    require(name) { if (!(name in dependencies)) throw new Error('Unexpected require ' + name); return dependencies[name]; }
  }, { filename: file });
  return module.exports;
}

test('profile backend isolates users, validates avatar ownership and persists only the name/avatar', async () => {
  let context = {};
  let reads = 0;
  const records = new Map();
  const cloud = {
    init() {}, getWXContext: () => context,
    database: () => ({ serverDate: () => 'SERVER_TIME', collection: name => {
      assert.equal(name, 'userProfiles');
      return {
        where(filter) { return { limit() { return this; }, async get() {
          reads += 1; return { data: records.has(filter._id) ? [records.get(filter._id)] : [] };
        } }; },
        doc(id) { return { async set({ data }) { records.set(id, { ...data }); } }; }
      };
    } })
  };
  const createFunction = () => sandbox('cloudfunctions/userProfile/index.js', { 'wx-server-sdk': cloud, 'node:crypto': crypto }).main;
  let main = createFunction();
  assert.equal((await main({ action: 'get', OPENID: 'spoofed', APPID: APP_ID })).code, 'AUTH_REQUIRED');
  context = { OPENID: 'alice', APPID: 'different-app' };
  assert.equal((await main({ action: 'get' })).code, 'AUTH_REQUIRED');
  assert.equal(reads, 0);
  context = { OPENID: 'alice', APPID: APP_ID };
  const initial = await main({ action: 'get', id: 'someone-else' });
  assert.equal(initial.profile, null);
  assert.match(initial.avatarPrefix, /^avatars\/user_[a-f0-9]{32}\/$/);
  assert.equal((await main({ action: 'save', name: '   ' })).code, 'INVALID_NAME');
  assert.equal((await main({ action: 'save', name: 'A\nB' })).code, 'INVALID_NAME');
  assert.equal((await main({ action: 'save', name: 'A'.repeat(33) })).code, 'INVALID_NAME');
  assert.equal((await main({ action: 'save', name: '张同学', avatarFileId: 'https://example.com/avatar.png' })).code, 'INVALID_AVATAR');
  const foreignAvatar = `cloud://${ENV}.bucket/avatars/user_${'a'.repeat(32)}/avatar.jpg`;
  assert.equal((await main({ action: 'save', name: '张同学', avatarFileId: foreignAvatar })).code, 'INVALID_AVATAR');
  const ownAvatar = `cloud://${ENV}.bucket/${initial.avatarPrefix}avatar.jpg`;
  assert.equal((await main({ action: 'save', name: ' 张同学 ', avatarFileId: ownAvatar,
    OPENID: 'bob', role: 'admin', teamName: 'Forged team' })).ok, true);
  assert.equal(records.size, 1);
  assert.deepEqual(Object.keys([...records.values()][0]).sort(), ['avatarFileId', 'name', 'updatedAt']);
  main = createFunction();
  assert.equal((await main({ action: 'get' })).profile.name, '张同学');
  context = { OPENID: 'bob', APPID: APP_ID };
  const bob = await main({ action: 'get', id: initial.avatarPrefix });
  assert.equal(bob.profile, null);
  assert.notEqual(bob.avatarPrefix, initial.avatarPrefix);
  assert.equal((await main({ action: 'save', name: '李同学' })).ok, true);
  assert.equal(records.size, 2);
  context = { OPENID: 'alice', APPID: APP_ID };
  assert.equal((await main({ action: 'get' })).profile.name, '张同学');
});

test('client saves a selected avatar to cloud storage and cleans only a failed new upload', async () => {
  const prefix = `avatars/user_${'b'.repeat(32)}/`;
  let profile = { name: '李同学', avatarFileId: `cloud://${ENV}.bucket/${prefix}old.jpg` };
  let failSave = false;
  let uploaded = '';
  const deleted = [];
  const calls = [];
  const service = sandbox('miniprogram/services/profile.js', { '../config/cloud': { profileFunction: 'userProfile' } }, {
    getApp: () => ({ globalData: { cloudReady: true } }),
    wx: { cloud: {
      async callFunction({ data }) {
        calls.push(data);
        if (data.action === 'get') return { result: { ok: true, profile, avatarPrefix: prefix } };
        if (failSave === 'unknown') throw new Error('网络超时');
        if (failSave) return { result: { ok: false, code: 'INVALID_AVATAR', message: '保存失败' } };
        profile = { name: data.name, avatarFileId: data.avatarFileId };
        return { result: { ok: true, profile, avatarPrefix: prefix } };
      },
      async uploadFile({ cloudPath, filePath }) {
        assert.ok(cloudPath.startsWith(prefix));
        assert.equal(filePath, 'wxfile://selected.png');
        uploaded = `cloud://${ENV}.bucket/${cloudPath}`;
        return { fileID: uploaded };
      },
      async deleteFile({ fileList }) { deleted.push(...fileList); }
    } }
  });
  const notifications = [];
  service.subscribe(result => notifications.push(result));
  await service.load();
  assert.equal(calls.length, 1);
  await service.load();
  assert.equal(calls.length, 1);
  const saved = await service.save({ name: ' 王同学 ', avatarPath: 'wxfile://selected.png' });
  assert.equal(saved.profile.name, '王同学');
  assert.equal(saved.profile.avatarFileId, uploaded);
  assert.equal(deleted.length, 0);
  const goodAvatar = uploaded;
  failSave = true;
  await assert.rejects(service.save({ name: '未保存', avatarPath: 'wxfile://selected.png' }), /保存失败/);
  assert.equal(deleted.length, 1);
  assert.equal((await service.load()).profile.avatarFileId, goodAvatar);
  failSave = 'unknown';
  await assert.rejects(service.save({ name: '不确定结果', avatarPath: 'wxfile://selected.png' }), /网络超时/);
  assert.equal(deleted.length, 1, 'Do not delete an upload after a save with an unknown outcome');
  assert.equal(notifications.length, 2);
  assert.ok(calls.every(call => !('openid' in call) && !('role' in call)));
});

test('avatar opens a team drawer for every user, closes on navigation/hide and follows profile updates', async () => {
  let definition;
  let listener;
  let navigation;
  let navigations = 0;
  const result = { profile: null, avatarPrefix: 'avatars/own/' };
  sandbox('miniprogram/components/user-header/index.js', {
    '../../config/team': require('../miniprogram/config/team'),
    '../../services/access': { get: async () => ({ member: null, hasUnread: false }) },
    '../../services/profile': {
      subscribe(fn) { listener = fn; return () => {}; },
      async load() { return result; },
    }
  }, { Component(value) { definition = value; }, setInterval: () => 1, clearInterval() {}, wx: {
    getWindowInfo: () => ({ statusBarHeight: 24, windowWidth: 375 }),
    getMenuButtonBoundingClientRect: () => ({ left: 280 }), showToast() {},
    navigateTo(options) { navigation = options; navigations += 1; }
  } });
  const component = { data: { ...definition.data }, ...definition.methods };
  component.setData = values => Object.assign(component.data, values);
  definition.lifetimes.attached.call(component);
  await component.loadProfile();
  assert.equal(component.data.drawerOpen, false);
  assert.equal('editorOpen' in component.data, false);
  component.openDrawer();
  assert.equal(component.data.drawerOpen, true);
  component.openTeamMembers();
  component.openTeamMembers();
  assert.equal(navigations, 1);
  assert.equal(navigation.url, '/pages/team-members/index');
  assert.equal(component.data.drawerOpen, false);
  navigation.complete();
  component.openDrawer();
  definition.pageLifetimes.hide.call(component);
  assert.equal(component.data.drawerOpen, false);
  listener({ profile: { name: '王同学', avatarFileId: 'cloud://saved/avatar.png' } });
  assert.equal(component.data.name, '王同学');
  assert.equal(component.data.teamName, 'IMC');
  assert.equal(component.data.avatar, 'cloud://saved/avatar.png');
});

test('custom page title stays inside the capsule safe area with different status bars', () => {
  for (const [windowWidth, statusBarHeight, menu] of [
    [320, 20, { left: 223, top: 26, height: 32 }],
    [390, 44, { left: 285, top: 52, height: 40 }],
    [430, 54, { left: 325, top: 60, height: 32 }]
  ]) {
    let definition;
    sandbox('miniprogram/components/user-header/index.js', {
      '../../config/team': require('../miniprogram/config/team'),
      '../../services/profile': { subscribe: () => () => {} },
      '../../services/access': {}
    }, { Component: value => { definition = value; }, wx: {
      getWindowInfo: () => ({ windowWidth, statusBarHeight }),
      getMenuButtonBoundingClientRect: () => menu
    } });
    const header = { data: { ...definition.data }, loadProfile() {}, startNotifications() {},
      setData(value) { Object.assign(this.data, value); } };
    definition.lifetimes.attached.call(header);
    assert.equal(header.data.statusBarHeight, statusBarHeight);
    assert.ok(header.data.navHeight >= menu.top - statusBarHeight + menu.height);
    assert.ok(windowWidth / 2 + header.data.titleWidth / 2 <= menu.left - 12);
    assert.equal(definition.properties.title.type.name, 'String');
  }
});

test('personal profile editor validates the name and saves a selected avatar through the existing service', async () => {
  let page;
  let saved;
  sandbox('miniprogram/pages/profile/edit.js', {
    '../../config/team': require('../miniprogram/config/team'),
    '../../services/profile': {
      async load() { return { profile: null }; },
      async save(value) {
        saved = value;
        return { profile: { name: value.name, avatarFileId: 'cloud://saved/avatar.png' } };
      }
    }
  }, { Page: value => { page = value; }, wx: { showToast() {} } });
  page.setData = values => Object.assign(page.data, values);
  await page.loadProfile();
  await page.saveProfile();
  assert.equal(page.data.error, '请先填写姓名');
  assert.equal(saved, undefined);
  page.onNameInput({ detail: { value: ' 王同学 ' } });
  page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://chosen.png' } });
  await page.saveProfile();
  assert.equal(saved.name, '王同学');
  assert.equal(saved.avatarPath, 'wxfile://chosen.png');
  assert.equal(page.data.teamName, 'IMC');
  assert.equal(page.data.avatar, 'cloud://saved/avatar.png');
  assert.equal(page.data.draftAvatar, '');
  assert.equal(page.data.saving, false);
});

test('header shows actual role badges and unread status, polls only while visible and opens the message page', async () => {
  const policy = require('../cloudfunctions/_shared/access');
  let definition, interval, cleared = 0, navigation;
  let result = { member: { status: 'active', roles: ['weekly_admin', 'super_admin'] }, roleOptions: policy.ROLES, hasUnread: true };
  sandbox('miniprogram/components/user-header/index.js', {
    '../../config/team': require('../miniprogram/config/team'),
    '../../services/profile': {}, '../../services/access': { get: async () => result }
  }, { Component: value => { definition = value; },
    setInterval: callback => { interval = callback; return 1; }, clearInterval: () => { cleared += 1; },
    wx: { navigateTo: options => { navigation = options.url; options.complete(); } }
  });
  const header = { data: { ...definition.data }, ...definition.methods };
  header.setData = values => Object.assign(header.data, values);
  await header.loadIdentity();
  assert.deepEqual(Array.from(header.data.roleTags, tag => tag.label), ['周报管理员', '超级管理员']);
  assert.equal(header.data.hasUnread, true);
  await header.startNotifications();
  assert.equal(typeof interval, 'function');
  definition.pageLifetimes.hide.call(header);
  assert.equal(header._notificationTimer, null);
  assert.equal(cleared, 1);
  await Promise.resolve();
  result = { member: { status: 'active', roles: [] }, roleOptions: policy.ROLES, hasUnread: false };
  await header.loadIdentity();
  assert.equal(header.data.roleTags[0].label, '普通成员');
  assert.equal(header.data.hasUnread, false);
  header.openMessages();
  assert.equal(navigation, '/pages/messages/index');
});

test('registered pages and their local components have complete source files', () => {
  const root = path.join(__dirname, '../miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const visited = new Set();
  function check(route) {
    route = path.posix.normalize(route.replace(/^\//, ''));
    if (visited.has(route)) return;
    visited.add(route);
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(root, route + '.' + extension)), route + '.' + extension + ' missing');
    }
    const config = JSON.parse(fs.readFileSync(path.join(root, route + '.json'), 'utf8'));
    for (const component of Object.values(config.usingComponents || {})) {
      if (component.startsWith('plugin:')) continue;
      check(component.startsWith('/') ? component : path.posix.join(path.posix.dirname(route), component));
    }
  }
  for (const route of app.pages) check(route);
  if (app.tabBar.custom) check('custom-tab-bar/index');
  assert.ok(app.pages.includes('pages/module/index'));
  assert.ok(!app.pages.includes('pages/settings/index'));
});

test('personal framework keeps existing routes, gates management and opens only registered placeholder sections', () => {
  let profile;
  const navigation = [];
  sandbox('miniprogram/pages/profile/index.js', { '../../services/access': {}, '../../services/admin-data': {} }, {
    Page: value => { profile = value; }, wx: { navigateTo: options => navigation.push(options.url) }
  });
  profile.openProfile();
  profile.openTeamMembers();
  profile.openSettings();
  assert.deepEqual(navigation, ['/pages/profile/edit', '/pages/team-members/index', '/pages/module/index?id=settings']);
  profile.openMembers();
  assert.equal(navigation.length, 3);
  profile.data.canManage = true;
  profile.openMembers();
  assert.equal(navigation.at(-1), '/pages/members/index');
  assert.deepEqual(Array.from(profile.data.personalEntries, entry => entry.title), ['我的设备', '我的提交', '我的收藏']);
  const placeholders = [];
  for (const entry of profile.data.personalEntries) {
    profile.openPersonal({ currentTarget: { dataset: { id: entry.id } } });
    assert.equal(navigation.at(-1), '/pages/module/index?id=' + entry.id);
    placeholders.push(entry);
  }
  const previous = navigation.length;
  profile.openPersonal({ currentTarget: { dataset: { id: 'https://example.com' } } });
  assert.equal(navigation.length, previous);
  let settings;
  sandbox('miniprogram/pages/module/index.js', { '../../services/admin-data': {} }, {
    Page: value => { settings = value; }, wx: { navigateTo: options => navigation.push(options.url), setNavigationBarTitle() {} }
  });
  settings.setData = values => Object.assign(settings.data, values);
  settings.onLoad({ id: 'settings' });
  for (const entry of settings.data.entries) {
    settings.openEntry({ currentTarget: { dataset: { id: entry.id } } });
    assert.equal(navigation.at(-1), '/pages/module/index?id=' + entry.id);
    placeholders.push(entry);
  }
  const beforeUnknown = navigation.length;
  settings.openEntry({ currentTarget: { dataset: { id: '__proto__' } } });
  assert.equal(navigation.length, beforeUnknown);
  for (const entry of placeholders) {
    let modulePage, title;
    sandbox('miniprogram/pages/module/index.js', { '../../services/admin-data': {} }, {
      Page: value => { modulePage = value; }, wx: { setNavigationBarTitle: value => { title = value.title; } }
    });
    modulePage.setData = value => Object.assign(modulePage.data, value);
    modulePage.onLoad({ id: entry.id });
    assert.equal(title, entry.title);
  }
});

test('workbench app entries navigate to their corresponding titled pages', () => {
  let workbench;
  let navigated;
  sandbox('miniprogram/pages/workbench/index.js', {
    '../../services/workbench': { load: async () => ({}), record: async () => ({}) },
    '../../utils/workbench': require('../miniprogram/utils/workbench')
  }, { Page: value => { workbench = value; },
    wx: { navigateTo: ({ url }) => { navigated = url; } } });
  assert.deepEqual(Array.from(workbench.data.tools, tool => tool.name), ['实验室设备', '财务报销', '周报', '文娱活动', 'AI挑战赛', '申请与审批', '请假', '团队知识库', '每周分享']);
  for (const tool of workbench.data.tools) {
    assert.ok(fs.existsSync(path.join(__dirname, '../miniprogram', tool.icon)));
    workbench.openTool({ currentTarget: { dataset: { url: tool.url } } });
    assert.equal(navigated, tool.url);
    if (!tool.url.includes('?')) continue;
    let page;
    let title;
    sandbox('miniprogram/pages/module/index.js', { '../../services/admin-data': {} }, { Page: value => { page = value; },
      wx: { setNavigationBarTitle: value => { title = value.title; } } });
    page.setData = values => Object.assign(page.data, values);
    page.onLoad({ id: tool.id });
    assert.equal(title, tool.name);
  }
});
