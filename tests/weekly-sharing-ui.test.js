const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sharing = require('../miniprogram/services/sharing');
function component(call, wx = {}, overrides = {}) {
  let definition;
  const context = { wx, Component: value => { definition = value; }, require: () => ({ ...sharing, call, subscribe: () => () => {}, subscribeMembers: () => () => {}, ...overrides }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/weekly-sharing/index.js'), 'utf8'), context);
  const instance = { data: structuredClone(definition.data), properties: { initialTask: '' },
    setData(data) { for (const [key, value] of Object.entries(data)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } } };
  for (const [name, method] of Object.entries(definition.methods)) instance[name] = method.bind(instance);
  return instance;
}
const task = canUpload => ({ id: 'sh_20261102', weekStart: '2026-11-02', endDate: '2026-11-08', status: 'pending', reviewState: 'none', reminderMs: Date.parse('2026-11-02T09:00:00+08:00'), canUpload });
test('月历按北京时间显示42天，正确处理跨年、闰年和权限范围之外的空日期', () => {
  const now = Date.parse('2026-11-02T00:30:00+08:00');
  const calendar = sharing.calendar('2026-11', [task(false)], '', now);
  assert.equal(calendar.days.length, 42); assert.equal(calendar.days[0].date, '2026-10-26');
  assert.equal(calendar.days[41].date, '2026-12-06');
  assert.equal(calendar.days.find(day => day.date === '2026-11-02').classes.includes('is-today'), true);
  assert.equal(calendar.days.find(day => day.date === '2026-11-09').hasTask, false);
  assert.equal(sharing.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(sharing.shiftMonth('2027-01', -1), '2026-12');
  assert.equal(sharing.calendar('2028-02', [], '', now).days.some(day => day.date === '2028-02-29'), true);
});
test('不可见的日期不触发排班查询，点击已排班日期按周筛选且保留月历范围', async () => {
  const calls = [], row = task(false);
  const page = component(async (action, data) => { calls.push(data); return { tasks: [row], nextOffset: 1, hasMore: false, canManage: false, isReviewer: false }; });
  page.setData({ calendarMonth: '2026-11', calendar: sharing.calendar('2026-11', [row]) });
  await page.selectDay({ currentTarget: { dataset: { date: '2026-11-16' } } });
  assert.equal(calls.length, 0);
  await page.selectDay({ currentTarget: { dataset: { date: '2026-11-04' } } });
  assert.equal(calls.find(data => data.weekStart).weekStart, '2026-11-02');
  assert.equal(calls.find(data => data.month).month, '2026-11');
  assert.equal(page.data.selectedWeek, '2026-11-02');
});
test('公开内容没有排班元数据时仍可展示，不生成无效的首次提醒日期', () => {
  const shown = sharing.taskView({ id: 'sh_20261102', status: 'completed', reviewState: 'approved', canViewSchedule: false });
  assert.equal(shown.current, false); assert.equal(shown.reminderLabel, ''); assert.equal(shown.rangeLabel, '');
});
test('归档取消不修改任务，确认后显示可恢复的归档详情', async () => {
  let confirm = false, calls = 0;
  const page = component(async (action, data) => {
    calls++; assert.equal(action, 'setArchived'); assert.equal(data.archived, true);
    return { task: { ...task(false), archived: true, archivedMs: Date.now(), canRestore: true }, canManage: true, isReviewer: true };
  }, { showModal: async () => ({ confirm }), showToast() {} });
  page.setData({ mode: 'detail', selected: { ...task(false), revision: 1, canArchive: true } });
  await page.changeArchive(); assert.equal(calls, 0);
  confirm = true; await page.changeArchive();
  assert.equal(calls, 1); assert.equal(page.data.selected.archived, true);
  assert.equal(page.data.selected.canRestore, true); assert.equal(page.data.busy, false);
});
test('自动刷新保留本人未提交输入，上传权限撤销时清除私有编辑内容', () => {
  const page = component(); page._dirty = true;
  page.setData({ title: '未保存的主题', note: '草稿', files: [{ id: 'temporary-file' }], cover: { id: 'draft-cover' }, coverPath: 'local-cover' });
  page.renderDetail({ task: task(true), canManage: false, isReviewer: false });
  assert.equal(page.data.title, '未保存的主题'); assert.equal(page.data.files.length, 1);
  assert.equal(page.data.cover.id, 'draft-cover'); assert.equal(page.data.coverPath, 'local-cover');
  page.renderDetail({ task: task(false), canManage: false, isReviewer: false });
  assert.equal(page.data.title, ''); assert.equal(page.data.files.length, 0); assert.equal(page._dirty, false);
  assert.equal(page.data.cover, null); assert.equal(page.data.coverPath, '');
});

test('负责人上传封面后提交携带封面ID，没有封面不能提交', async () => {
  const calls = [];
  const page = component(async (action, data) => { calls.push({ action, data }); return { task: task(false) }; }, { showToast() {} }, {
    chooseCover: async () => ({ path: '/tmp/photo.jpg', size: 500, name: 'cover.jpg' }),
    upload: async (file, id, kind) => { assert.equal(id, 'sh_20261102'); assert.equal(kind, 'cover'); return { id: 'sf_' + 'c'.repeat(32) }; }
  });
  page.renderDetail({ task: { ...task(true), revision: 1 } });
  page.setData({ title: '分享主题', files: [{ id: 'sf_' + 'd'.repeat(32) }] });
  await page.submit(); assert.equal(calls.length, 0);
  await page.chooseCover(); assert.equal(page.data.coverPath, '/tmp/photo.jpg');
  await page.submit(); assert.equal(calls.length, 1); assert.equal(calls[0].data.coverFileId, 'sf_' + 'c'.repeat(32));
});
test('绑定重试按钮的事件对象不会触发分页或切错详情页', async () => {
  const calls = [], page = component(async (action, data) => { calls.push(action); return { task: task(false), canManage: false, isReviewer: false }; });
  page._taskId = 'sh_20261102';
  await page.load({ type: 'tap' });
  assert.deepEqual(calls, ['get']); assert.equal(page.data.mode, 'detail');
});
test('旧的列表请求不会覆盖后来打开的页面', async () => {
  let resolveFirst, calls = 0;
  const page = component(async () => { calls++; if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; }); return { tasks: [], nextOffset: 0, hasMore: false, canManage: false, isReviewer: false }; });
  const first = page.load(); await Promise.resolve();
  await page.load();
  resolveFirst({ tasks: [{ ...task(false), id: 'stale' }], nextOffset: 1, hasMore: false, canManage: true, isReviewer: true });
  await first;
  assert.equal(page.data.tasks.length, 0); assert.equal(page.data.canManage, false);
});
test('周跨月、跨年及北京时间周日起止日期正确', () => {
  assert.equal(sharing.monday('2026-11-08'), '2026-11-02');
  assert.equal(sharing.monday('2027-01-01'), '2026-12-28');
  assert.equal(sharing.dateLabel(Date.parse('2026-11-04T16:00:00Z')), '2026-11-05 00:00');
});

test('消息和审批的任务链接在分享组件首次创建时已传入任务，避免落回列表', () => {
  let definition;
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/module/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: name => name.includes('member-page') ? value => value : {},
    wx: { setNavigationBarTitle() {} }
  });
  for (const suppliedTask of ['sh_20261102', 'invalid']) {
    let initialTask;
    const page = { data: {}, setData(update) {
      const wasSharing = this.data.sharingMode;
      Object.assign(this.data, update);
      if (!wasSharing && this.data.sharingMode) initialTask = this.data.sharingTask;
    } };
    definition.onLoad.call(page, { id: 'weekly-sharing', task: suppliedTask });
    assert.equal(initialTask, suppliedTask.startsWith('sh_') ? suppliedTask : '');
  }
});
