const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { rankTools } = require('../miniprogram/utils/workbench');
function load(file, dependencies, globals) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => dependencies[name], ...globals });
  return module.exports;
}
test('common apps rank by frequency, recent use and default order, ignoring invalid stats and unknown apps', () => {
  const tools = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  assert.deepEqual(rankTools(tools).map(tool => tool.id), ['a', 'b', 'c', 'd']);
  const ranked = rankTools(tools, { e: { count: 4, lastOpenedMs: 10 }, c: { count: 4, lastOpenedMs: 20 },
    b: { count: -1, lastOpenedMs: 'invalid' }, unknown: { count: 10000 } });
  assert.deepEqual(ranked.map(tool => tool.id), ['c', 'e', 'a', 'b']);
  assert.deepEqual(tools.map(tool => tool.id), ['a', 'b', 'c', 'd', 'e']);
});
test('workbench records successful navigations only and a stale load cannot replace newer usage results', async () => {
  let page, navigation, completeLoad;
  const recorded = [];
  load('miniprogram/pages/workbench/index.js', {
    '../../utils/workbench': { rankTools },
    '../../services/workbench': {
      load: () => new Promise(resolve => { completeLoad = resolve; }),
      record: async id => { recorded.push(id); return { [id]: { count: 1, lastOpenedMs: 10 } }; }
    }
  }, { Page: value => { page = value; }, wx: { navigateTo: options => { navigation = options; }, showToast() {} } });
  page.setData = values => Object.assign(page.data, values);
  const initialLoad = page.loadUsage();
  page.openTool({ currentTarget: { dataset: { id: 'finance' } } });
  navigation.fail();
  assert.equal(recorded.length, 0);
  page.openTool({ currentTarget: { dataset: { id: 'approvals' } } });
  assert.equal(navigation.url, '/pages/approvals/index');
  await navigation.success();
  assert.deepEqual(recorded, ['approvals']);
  assert.equal(page.data.commonTools[0].name, '申请与审批');
  completeLoad({ finance: { count: 100, lastOpenedMs: 20 } });
  await initialLoad;
  assert.equal(page.data.commonTools[0].id, 'approvals');
  assert.equal(page.data.tools[0].id, 'lab-equipment');
});
test('usage reads wait for pending writes and a failed write does not block subsequent tracking', async () => {
  const calls = [];
  let release;
  const service = load('miniprogram/services/workbench.js', { '../config/cloud': { accessFunction: 'memberAccess' } }, {
    getApp: () => ({ globalData: { cloudReady: true } }),
    wx: { cloud: { async callFunction({ data }) {
      calls.push(data.action + ':' + (data.toolId || ''));
      if (data.toolId === 'finance') await new Promise(resolve => { release = resolve; });
      if (data.toolId === 'weekly') throw new Error('offline');
      return { result: { ok: true, usage: {} } };
    } } }
  });
  const write = service.record('finance');
  const read = service.load();
  await Promise.resolve();
  assert.deepEqual(calls, ['recordToolOpen:finance']);
  release();
  await write;
  await read;
  assert.deepEqual(calls, ['recordToolOpen:finance', 'workbenchUsage:']);
  await assert.rejects(service.record('weekly'), /offline/);
  await service.record('approvals');
  assert.equal(calls.at(-1), 'recordToolOpen:approvals');
});
