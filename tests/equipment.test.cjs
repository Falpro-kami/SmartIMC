const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { buildView, display, EMPTY_LOCATION } = require('../miniprogram/utils/equipment');

const fixtures = [
  { _id: 'eq_' + 'a'.repeat(24), name: '工控机', equipmentNumber: '00809485', model: 'IPC (A+)',
    inventoryNumber: 'IN01', status: '闲置', ledger: 'registered', location: 'E308', user: '' },
  { _id: 'eq_' + 'b'.repeat(24), name: '服务器', equipmentNumber: '', model: 'GPU',
    inventoryNumber: 'IN01', status: '正在使用', ledger: 'unregistered', location: 'C412', user: '张老师' },
  { _id: 'eq_' + 'c'.repeat(24), name: '示波器', equipmentNumber: '00000003', model: '',
    inventoryNumber: 'IN03', status: '外借', ledger: 'registered', location: '', user: '' }
];

test('search keeps identifier zeroes, uses literal text and matches model/user/internal code', () => {
  for (const [keyword, id] of [['00809', fixtures[0]._id], ['ipc (a+)', fixtures[0]._id],
    ['张老师', fixtures[1]._id], ['in03', fixtures[2]._id]]) {
    assert.deepEqual(buildView(fixtures, { keyword }).visibleRecords.map(row => row._id), [id]);
  }
  assert.equal(buildView(fixtures, { keyword: '.*' }).filteredCount, 0);
  assert.equal(display(fixtures[0]).equipmentNumberLabel, '00809485');
  assert.equal(display(fixtures[1]).equipmentNumberLabel, '-');
});

test('status and location filters combine; blank location remains selectable', () => {
  assert.equal(buildView(fixtures, { status: '闲置', location: 'C412' }).filteredCount, 0);
  const empty = buildView(fixtures, { location: EMPTY_LOCATION });
  assert.equal(empty.filteredCount, 1);
  assert.equal(empty.visibleRecords[0]._id, fixtures[2]._id);
  assert.equal(empty.locationLabel, '-');
  const all = buildView(fixtures, {});
  assert.equal(all.statusOptions.find(item => item.value === '正在使用').count, 1);
  assert.equal(all.statusOptions.find(item => item.value === '闲置').count, 1);
  assert.equal('ledgerTabs' in all, false);
});

test('incomplete source rows keep their identity and display missing card fields as dashes', () => {
  const record = { _id: 'eq_' + 'd'.repeat(24), inventoryNumber: 'IN20251221130' };
  const shown = display(record);
  for (const key of ['statusLabel', 'nameLabel', 'equipmentNumberLabel', 'modelLabel', 'locationLabel', 'userLabel']) {
    assert.equal(shown[key], '-', key);
  }
  const found = buildView([record], { keyword: 'IN20251221130' });
  assert.equal(found.filteredCount, 1);
  assert.equal(found.visibleRecords[0]._id, record._id);
});

test('pagination retains counts and handles empty results', () => {
  const first = buildView(fixtures, {}, 2);
  assert.equal(first.filteredCount, 3);
  assert.equal(first.visibleRecords.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(buildView(fixtures, {}, 20).hasMore, false);
  assert.equal(buildView([], {}).total, 0);
});

function sandbox(file, requires, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports,
    require: name => {
      if (name === '../../utils/member-page') return value => value;
      if (/services\/membership$/.test(name)) return { accept() {}, subscribe(listener) { listener({ approved: true }); return () => {}; } };
      if (!(name in requires)) throw new Error('Unexpected require: ' + name);
      return requires[name];
    }, console, ...globals
  }, { filename: file });
  return module.exports;
}

test('service reads multiple cloud pages, reuses cache and rejects partial/duplicate results', async () => {
  let calls = 0;
  const makeService = responder => sandbox('miniprogram/services/equipment.js', {
    '../config/cloud': { equipmentFunction: 'equipmentQuery' }
  }, { getApp: () => ({ globalData: { cloudReady: true } }),
    wx: { cloud: { callFunction: async ({ data }) => { calls += 1; return { result: responder(data) }; } } } });
  const service = makeService(data => data.offset === 0
    ? { ok: true, records: fixtures.slice(0, 2), nextOffset: 2, hasMore: true }
    : { ok: true, records: fixtures.slice(2), nextOffset: 3, hasMore: false });
  assert.equal((await service.loadAll()).length, 3);
  await service.loadAll();
  assert.equal(calls, 2);
  await service.loadAll(true);
  assert.equal(calls, 4);
  const stuck = makeService(() => ({ ok: true, records: [], nextOffset: 0, hasMore: true }));
  await assert.rejects(stuck.loadAll(), /分页/);
  const duplicate = makeService(() => ({ ok: true, records: [fixtures[0], fixtures[0]], nextOffset: 2, hasMore: false }));
  await assert.rejects(duplicate.loadAll(), /清单发生变化/);
  const denied = makeService(() => ({ ok: false, message: '拒绝访问' }));
  await assert.rejects(denied.loadAll(), /拒绝访问/);
});

test('service explains native WeChat -601034 without mislabeling other errors', async () => {
  for (const [cause, expected] of [
    [{ errCode: -601034, errMsg: '没有权限，请先开通云开发或者云托管' }, 'CLOUD_NOT_ENABLED'],
    [{ errCode: -1, errMsg: 'cloud.callFunction:fail Error: errCode: -601034 | errMsg: 没有权限' }, 'CLOUD_NOT_ENABLED'],
    [{ errCode: -501005, errMsg: 'function not exists' }, undefined]
  ]) {
    const service = sandbox('miniprogram/services/equipment.js', {
      '../config/cloud': { equipmentFunction: 'equipmentQuery' }
    }, { getApp: () => ({ globalData: { cloudReady: true } }),
      console: { error() {} },
      wx: { cloud: { callFunction: async () => { throw cause; } } } });
    await assert.rejects(service.loadAll(), error => {
      assert.equal(error.code, expected);
      if (expected) assert.match(error.message, /关联已有环境.*-601034/);
      else assert.equal(error.message, 'function not exists');
      return true;
    });
  }
});

test('cloud function rejects spoofed identity and writes, exposes only allowed fields', async () => {
  let identity = {};
  let reads = 0;
  const query = {
    orderBy() { return this; }, skip(offset) { this.offset = offset; return this; },
    limit(limit) { this.max = limit; return this; }, where(filter) { this.filter = filter; return this; },
    async get() { reads += 1; return { data: [Object.assign({ sourceFile: 'private.xlsx', sourceHash: 'private' }, fixtures[0])] }; }
  };
  const main = sandbox('cloudfunctions/equipmentQuery/index.js', {
    './access': require('../cloudfunctions/equipmentQuery/access'),
    'wx-server-sdk': { init() {}, database: () => ({ collection: name => name === 'teamMembers'
      ? { where() { return this; }, limit() { return this; }, async get() { return { data: [{ teamId: 'IMC', status: 'active', roles: [] }] }; } }
      : query }), getWXContext: () => identity }
  }).main;
  assert.equal((await main({ action: 'list', APPID: 'wx875c04f31134c779', OPENID: 'spoof' })).code, 'AUTH_REQUIRED');
  identity = { APPID: 'other-app', OPENID: 'user' };
  assert.equal((await main({ action: 'list' })).code, 'AUTH_REQUIRED');
  assert.equal(reads, 0);
  identity = { APPID: 'wx875c04f31134c779', OPENID: 'user' };
  assert.equal((await main({ action: 'delete' })).code, 'INVALID_ACTION');
  assert.equal((await main({ action: 'list', offset: -1 })).code, 'INVALID_OFFSET');
  assert.equal((await main({ action: 'list', offset: '0' })).code, 'INVALID_OFFSET');
  assert.equal((await main({ action: 'detail', id: 'bad' })).code, 'INVALID_ID');
  const response = await main({ action: 'list' });
  assert.equal(response.ok, true);
  assert.equal(query.max, 100);
  assert.equal(response.records[0].equipmentNumber, '00809485');
  assert.equal('sourceFile' in response.records[0], false);
  assert.equal('sourceHash' in response.records[0], false);
  assert.equal((await main({ action: 'detail', id: fixtures[0]._id })).record.name, '工控机');
});

test('page resets pagination when searching, discards cancelled draft filters and navigates', async () => {
  let page;
  let navigation;
  sandbox('miniprogram/pages/equipment/index.js', {
    '../../services/equipment': { loadAll: async () => fixtures },
    '../../utils/equipment': require('../miniprogram/utils/equipment')
  }, { Page: definition => { page = definition; },
    wx: { stopPullDownRefresh() {}, navigateTo: options => { navigation = options.url; } } });
  page.setData = values => { Object.assign(page.data, values); };
  page.onLoad();
  await page._loading;
  assert.equal(page.data.total, 3);
  page._limit = 80;
  page.onSearch({ detail: { value: '00809' } });
  assert.equal(page._limit, 20);
  assert.equal(page.data.filteredCount, 1);
  page.openFilter();
  page.setDraftLocation({ currentTarget: { dataset: { value: 'C412' } } });
  page.closeFilter();
  assert.equal(page.data.location, '');
  page.openDetail({ currentTarget: { dataset: { id: fixtures[0]._id } } });
  assert.equal(navigation, '/pages/equipment/detail?id=' + fixtures[0]._id);
  page.resetFilters();
  assert.equal(page.data.filteredCount, 3);
});

test('detail fields use dashes and show device location without ledger classification', async () => {
  let page;
  const record = { _id: 'eq_' + 'd'.repeat(24), inventoryNumber: 'IN20251221130', ledger: 'registered' };
  sandbox('miniprogram/pages/equipment/detail.js', {
    '../../services/equipment': { getDetail: async () => record },
    '../../utils/equipment': require('../miniprogram/utils/equipment')
  }, { Page: definition => { page = definition; } });
  page.setData = values => { Object.assign(page.data, values); };
  await page.loadRecord();
  const rows = page.data.groups.flatMap(group => group.rows);
  assert.equal(rows.find(row => row.label === '设备位置').value, '-');
  assert.equal(rows.some(row => row.label === '建账状态'), false);
  assert.ok(rows.filter(row => row.label !== '台账流水号').every(row => row.value === '-'));
  assert.equal(rows.find(row => row.label === '设备编号').copy, false);
  assert.equal(rows.find(row => row.label === '台账流水号').copy, true);
});

test('view preference restores safely and switching keeps filters, pagination and record identity', async () => {
  for (const saved of ['table', 'card', 'unexpected']) {
    let page;
    let reads = 0;
    const writes = [];
    let navigation;
    let choice;
    sandbox('miniprogram/pages/equipment/index.js', {
      '../../services/equipment': { loadAll: async () => { reads += 1; return fixtures; } },
      '../../utils/equipment': require('../miniprogram/utils/equipment')
    }, { Page: definition => { page = definition; }, wx: {
      getStorageSync: () => saved,
      setStorageSync: (key, mode) => writes.push([key, mode]),
      stopPullDownRefresh() {}, pageScrollTo() {},
      showActionSheet: options => { choice = options; },
      navigateTo: options => { navigation = options.url; }
    } });
    page.setData = values => Object.assign(page.data, values);
    page.onLoad();
    await page._loading;
    assert.equal(page.data.viewMode, saved === 'table' ? 'table' : 'card');
    page.changeFilters({ keyword: '00809', status: '闲置', location: 'E308' });
    page._limit = 40;
    const before = page.data.visibleRecords;
    const mode = page.data.viewMode === 'card' ? 'table' : 'card';
    page.chooseView();
    assert.deepEqual(Array.from(choice.itemList), ['卡片显示', '表格显示']);
    assert.notEqual(page.data.viewMode, mode);
    choice.success({ tapIndex: mode === 'table' ? 1 : 0 });
    choice.complete();
    assert.equal(page.data.viewMode, mode);
    assert.equal(page.data.keyword, '00809');
    assert.equal(page.data.status, '闲置');
    assert.equal(page.data.location, 'E308');
    assert.equal(page.data.visibleRecords, before);
    assert.equal(page._limit, 40);
    assert.equal(reads, 1);
    assert.deepEqual(writes, [['equipment-view-mode', mode]]);
    page.openDetail({ currentTarget: { dataset: { id: before[0]._id } } });
    assert.equal(navigation, '/pages/equipment/detail?id=' + fixtures[0]._id);
    page.setViewMode('invalid');
    page.chooseView();
    choice.complete(); // Cancelling the native menu must not change the saved preference.
    assert.equal(page.data.viewMode, mode);
    assert.equal(writes.length, 1);
  }
});

test('missing and failed device photos fall back without changing records; refresh can retry photos', async () => {
  const photo = 'cloud://environment/images/device.png';
  assert.equal(display({ image: '  ' }).imageUrl, '');
  assert.equal(display({ image: null }).imageUrl, '');
  assert.equal(display({ image: ' ' + photo + ' ' }).imageUrl, photo);
  const records = fixtures.map((record, index) => ({ ...record, image: index === 0 ? photo : '' }));
  let page;
  sandbox('miniprogram/pages/equipment/index.js', {
    '../../services/equipment': { loadAll: async () => records },
    '../../utils/equipment': require('../miniprogram/utils/equipment')
  }, { Page: definition => { page = definition; }, wx: {
    getStorageSync() { throw new Error('storage unavailable'); }, stopPullDownRefresh() {}
  } });
  page.setData = values => Object.assign(page.data, values);
  page.onLoad();
  await page._loading;
  assert.equal(page.data.visibleRecords[0].imageUrl, photo);
  page.imageFailed({ currentTarget: { dataset: { id: records[0]._id } } });
  assert.equal(page.data.visibleRecords[0].imageUrl, '');
  page.onSearch({ detail: { value: '00809' } });
  assert.equal(page.data.visibleRecords[0].imageUrl, '');
  assert.equal(records[0].image, photo);
  await page.loadRecords(true);
  assert.equal(page.data.visibleRecords[0].imageUrl, photo);
});

test('workbook retains all 128 registered rows including 2 incomplete rows and excludes the other sheet', () => {
  const importPath = path.join(__dirname, '../.local/equipment-import.json');
  if (!fs.existsSync(importPath)) return;
  const records = JSON.parse(fs.readFileSync(importPath, 'utf8'));
  assert.equal(records.length, 128);
  assert.equal(new Set(records.map(record => record._id)).size, 128);
  assert.equal(records.filter(record => record.ledger === 'registered').length, 128);
  assert.equal(records.filter(record => record.ledger === 'unregistered').length, 0);
  assert.equal(records[0].equipmentNumber, '00809485');
  const incomplete = records.filter(record => !record.name && !record.equipmentNumber);
  assert.equal(incomplete.length, 2);
  assert.deepEqual(incomplete.map(record => record.inventoryNumber), ['IN20251221130', 'IN20260507131']);
  const overlaps = records.filter(record => record.inventoryNumber === 'IN20231201001');
  assert.equal(overlaps.length, 1);
  assert.equal(buildView(records, { status: '闲置' }).filteredCount, 95);
  assert.equal(buildView(records, { status: '正在使用' }).filteredCount, 30);
  assert.equal(buildView(records, { status: '外借' }).filteredCount, 1);
});
