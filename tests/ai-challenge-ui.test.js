const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const challenge = require('../miniprogram/services/challenge');
function component(call, wx = {}, overrides = {}) {
  let definition;
  const service = { ...challenge, call, identityScope: () => 'same-account', subscribe: () => () => {}, subscribeMembers: () => () => {},
    download: async () => '/tmp/cover.png', removeLocal: async () => {}, ...overrides };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/ai-challenge/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: () => service, wx, setTimeout: () => null, clearTimeout() {}
  });
  const instance = { _visible: true, _eventId: 'ce_' + 'a'.repeat(32), _epoch: 1, properties: { initialEvent: '' }, data: structuredClone(definition.data),
    setData(values) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } }
  };
  for (const [name, method] of Object.entries(definition.methods)) instance[name] = method.bind(instance);
  for (const name of ['show', 'hide']) instance['_' + name] = definition.pageLifetimes[name].bind(instance);
  return instance;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = { id: 'ce_' + 'a'.repeat(32), name: '赛事', phase: 'open', startMs: 1793581200000, endMs: 1794758340000,
  canManage: false, canRegister: true, cover: { id: 'cf_' + 'a'.repeat(32), size: 100, ext: 'png' }, intro: { id: 'cf_' + 'b'.repeat(32), size: 100, ext: 'pdf' } };

test('作品覆盖须确认，取消不提交；成功只显示最新文件', async () => {
  let confirm = false; const calls = [];
  const previous = { file: { id: 'old', name: '旧作品.pdf', size: 10, ext: 'pdf' }, version: 1, uploadedMs: event.startMs };
  const updated = { ...previous, file: { ...previous.file, id: 'new', name: '新作品.pdf' }, version: 2 };
  const team = { id: 'ct_' + 'b'.repeat(32), name: '组', memberNames: [], memberIds: [], revision: 3, canUpload: true, work: previous };
  const page = component(async (action, data) => { calls.push({ action, data }); return { event, myTeam: { ...team, work: updated, revision: 4 } }; }, { showModal: async () => ({ confirm }), showToast() {} });
  page.render({ event, myTeam: team }); page.setData({ draftWork: { id: 'new', name: '新作品.pdf' } });
  await page.submitWork(); assert.equal(calls.length, 0);
  confirm = true; await page.submitWork();
  assert.equal(calls[0].action, 'submit'); assert.equal(calls[0].data.revision, 3);
  assert.equal(page.data.myTeam.work.file.name, '新作品.pdf'); assert.equal(page.data.draftWork, null);
});

test('截止后UI停止提交并清除待上传文件，后到达的私密下载不打开', async () => {
  let finish, opened = false, cleaned = '';
  const page = component(async () => {}, { openDocument: async () => { opened = true; } }, {
    download: () => new Promise(resolve => { finish = resolve; }), removeLocal: async path => { cleaned = path; }
  });
  const team = { id: 'ct_' + 'c'.repeat(32), memberNames: [], canUpload: true, work: { uploadedMs: event.startMs, file: { id: 'work', size: 100, ext: 'pdf' } } };
  page.setData({ selected: event, myTeam: team, draftWork: { id: 'draft' } });
  const request = page.openFile({ currentTarget: { dataset: { kind: 'work' } } });
  page._epoch++; finish('/tmp/private.pdf'); await request;
  assert.equal(opened, false); assert.equal(cleaned, '/tmp/private.pdf');
  page.render({ event: { ...event, phase: 'closed', canRegister: false }, myTeam: { ...team, canUpload: false } });
  assert.equal(page.data.draftWork, null);
});

test('挑战赛直达链接在组件创建时传入，界面无举办人、时间标准或报名方式展示', () => {
  const template = fs.readFileSync(require.resolve('../miniprogram/components/ai-challenge/index.wxml'), 'utf8');
  for (const text of ['举办人', '时间标准', '报名方式']) assert.equal(template.includes(text), false);
  let definition;
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/module/index.js'), 'utf8'), {
    Page: value => { definition = value; }, require: name => name.includes('member-page') ? value => value : {}, wx: { setNavigationBarTitle() {} }
  });
  let initial;
  const page = { data: {}, setData(values) { Object.assign(this.data, values); if (values.challengeMode) initial = this.data.challengeEvent; } };
  definition.onLoad.call(page, { id: 'ai-challenge', event: event.id }); assert.equal(initial, event.id);
});

test('文件选择器返回和成员重连同步不会清空赛事表单；上传中与上传后刷新均保留附件', async () => {
  const listeners = {}, picker = deferred(), transfer = deferred(), uploads = [];
  const page = component(async action => { throw new Error('编辑期间不应查询列表：' + action); }, {}, {
    subscribe: listener => { listeners.weekly = listener; return () => {}; },
    subscribeMembers: listener => { listeners.members = listener; return () => {}; },
    chooseFile: () => picker.promise,
    upload: (file, eventId, kind) => { uploads.push({ file, eventId, kind }); return transfer.promise; }
  });
  page._eventId = ''; page.startLive(); page.setData({ canManage: true }); await page.editEvent();
  page.changeForm({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '真实赛事草稿' } });
  const id = page.data.form.eventId;
  const request = page.chooseEventFile({ currentTarget: { dataset: { kind: 'intro' } } });
  page._hide(); page._show(); listeners.members(); listeners.weekly(); await page.refresh();
  assert.equal(page.data.mode, 'editor'); assert.equal(page.data.form.eventId, id);
  picker.resolve({ path: '/tmp/赛事说明.pdf', name: '赛事说明.pdf', size: 10 }); await tick();
  assert.equal(uploads[0].eventId, id);
  listeners.members(); listeners.weekly(); await page.refresh();
  transfer.resolve({ id: 'intro-ready', name: '赛事说明.pdf' }); await request;
  listeners.members(); listeners.weekly(); await page.refresh();
  assert.equal(page.data.form.name, '真实赛事草稿'); assert.equal(page.data.form.intro.id, 'intro-ready');
  assert.equal(page.data.mode, 'editor'); assert.equal(page.data.busy, false); assert.equal(page.data.actionError, '');
});

test('编辑开始前的后台列表响应不能覆盖编辑页，取消编辑后正常刷新列表', async () => {
  const reading = deferred(); let reads = 0;
  const page = component(async () => { reads++; return reads === 1 ? reading.promise : { events: [], canManage: true, hasMore: false }; });
  page._eventId = ''; page.setData({ canManage: true });
  const request = page.load(); await page.editEvent();
  page.changeForm({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '保留的赛事名称' } });
  reading.resolve({ events: [], canManage: true, hasMore: false }); await request;
  assert.equal(page.data.mode, 'editor'); assert.equal(page.data.form.name, '保留的赛事名称');
  await page.cancelEditor(); assert.equal(page.data.mode, 'list'); assert.equal(page.data.form, null); assert.equal(reads, 2);
});

test('发布产生的同步通知不打断发布，使用原表单的封面与介绍文件', async () => {
  const listeners = {}, sent = [];
  const page = component(async (action, data) => {
    sent.push({ action, data }); listeners.weekly();
    return { event: { ...event, canManage: true, id: data.eventId }, myTeam: null };
  }, { showToast() {} }, {
    subscribe: listener => { listeners.weekly = listener; return () => {}; }
  });
  page._eventId = ''; page.startLive(); page.setData({ canManage: true }); await page.editEvent();
  page.setData({ 'form.name': '准备发布', 'form.cover': { id: 'cover-ready' }, 'form.intro': { id: 'intro-ready' } });
  await page.saveEvent();
  assert.equal(sent[0].action, 'save'); assert.equal(sent[0].data.coverFileId, 'cover-ready'); assert.equal(sent[0].data.introFileId, 'intro-ready');
  assert.equal(page.data.mode, 'detail'); assert.equal(page.data.form, null); assert.equal(page.data.actionError, '');
});

test('真实权限变化立即清空编辑草稿，文件选择器的迟到结果不能继续上传', async () => {
  const listeners = {}, picker = deferred(); let scope = 'Gao-revision-1', uploaded = false;
  const page = component(async () => ({ events: [], canManage: false, hasMore: false }), {}, {
    identityScope: () => scope,
    subscribeMembers: listener => { listeners.members = listener; return () => {}; },
    chooseFile: () => picker.promise, upload: async () => { uploaded = true; return { id: 'late-file' }; }
  });
  page._eventId = ''; page.startLive(); page.setData({ canManage: true }); await page.editEvent();
  const request = page.chooseEventFile({ currentTarget: { dataset: { kind: 'intro' } } });
  scope = 'Gao-revision-2'; listeners.members(); await tick();
  picker.resolve({ name: '迟到文件.pdf' }); await request;
  assert.equal(uploaded, false); assert.equal(page.data.form, null); assert.equal(page.data.canManage, false);
  assert.equal(page.data.mode, 'list'); assert.equal(page.data.busy, false); assert.equal(page.data.actionError, '');
});

test('真实权限变化后的旧上传响应不会写回新身份页面', async () => {
  const listeners = {}, transfer = deferred(); let scope = 'Gao-revision-1';
  const page = component(async () => ({ events: [], canManage: false, hasMore: false }), {}, {
    identityScope: () => scope,
    subscribeMembers: listener => { listeners.members = listener; return () => {}; },
    chooseFile: async () => ({ name: '赛事说明.pdf' }), upload: () => transfer.promise
  });
  page._eventId = ''; page.startLive(); page.setData({ canManage: true }); await page.editEvent();
  const request = page.chooseEventFile({ currentTarget: { dataset: { kind: 'intro' } } }); await tick();
  scope = 'Gao-revision-2'; listeners.members(); await tick();
  transfer.resolve({ id: 'late-file' }); await request;
  assert.equal(page.data.form, null); assert.equal(page.data.mode, 'list'); assert.equal(page.data.canManage, false);
  assert.equal(page.data.actionError, ''); assert.equal(page.data.busy, false);
});
