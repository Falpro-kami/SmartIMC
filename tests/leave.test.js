const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const memoryDb = require('./helpers/memory-db');
const access = require('../cloudfunctions/memberAccess/access');
const owner = 'user_' + '1'.repeat(32), leader = 'user_' + '2'.repeat(32), alternate = 'user_' + '3'.repeat(32);
const admin = 'user_' + '4'.repeat(32), outsider = 'user_' + '5'.repeat(32);
const date = '2026-11-12';
const denied = (promise, code) => assert.rejects(promise, error => error.businessCode === code);
function fixture() {
  const member = roles => ({ teamId: 'IMC', status: 'active', roles });
  const db = memoryDb({
    teamMembers: { [owner]: member([]), [leader]: member(['leader']), [alternate]: member(['leader']), [admin]: member(['super_admin']) },
    userProfiles: { [owner]: { name: '成员甲' }, [leader]: { name: '领导甲' }, [alternate]: { name: '领导乙' } },
    teamSync: { IMC: { home: 'h', approvals: 'a', messages: 'm' } }
  });
  let now = Date.parse('2026-11-09T10:00:00+08:00');
  const messages = require('../cloudfunctions/memberAccess/messages')(db, access);
  const leave = require('../cloudfunctions/memberAccess/leave')(db, access, messages, () => now);
  const approvals = require('../cloudfunctions/memberAccess/approvals')(db, access, messages, leave);
  const home = require('../cloudfunctions/memberAccess/home')(db, access, approvals, leave);
  const form = { reviewerId: leader, leaveType: '病假', allDay: false, startDate: date, endDate: date, startTime: '09:00',
    endTime: '11:00', reason: '私密事由', requestId: 'request000001' };
  return { db, leave, messages, approvals, home, form, submit: patch => leave.submit(owner, { ...form, ...patch }),
    now: time => { now = Date.parse(time); },
    change: (actor, id, revision, action, extra = {}) => leave.change(actor, { id, revision, action, ...extra }) };
}
function page(f, id) {
  let definition;
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/leave/index.js'), 'utf8'), {
    Page: value => { definition = value; },
    require: name => name.includes('member-page') ? input => input : {
      subscribeChanges: () => () => {},
      leave: event => event.action === 'leaveDetail' ? f.leave.detail(id, event) : event.action === 'leaveReviewers' ? f.leave.reviewers(id) : f.leave.list(id, event),
      changeLeave: event => event.action === 'leaveSubmit' ? f.leave.submit(id, event) : f.leave.change(id, event)
    },
    wx: { setNavigationBarTitle() {} }
  });
  return { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data); } };
}
const tap = action => ({ currentTarget: { dataset: { action } } });

test('member submits from the form; assigned leader finds and approves it; result message opens the detail', async () => {
  const f = fixture(), applicant = page(f, owner);
  applicant.onLoad({ mode: 'new' }); await applicant.onShow();
  assert.equal(applicant.data.reviewers.length, 2);
  applicant.changeReviewer({ detail: { value: '0' } });
  applicant.updateForm(f.form);
  await applicant.submit();
  const id = applicant.data.detail.id;
  assert.equal(applicant.data.detail.statusLabel, '待审批');
  assert.equal((await f.home.dashboard(leader)).todos.find(row => row.leaveId).leaveId, id);
  assert.equal((await f.approvals.list(leader, { source: 'leave', scope: 'pending' })).requests[0].id, id);
  assert.equal((await f.home.dashboard(alternate)).todos.some(row => row.leaveId), false);
  const leaderMessage = (await f.messages.list(leader, {})).messages[0];
  assert.equal((await f.messages.open(leader, { id: leaderMessage.id })).url, '/pages/leave/index?id=' + id);
  const reviewer = page(f, leader);
  reviewer.onLoad({ id }); await reviewer.onShow();
  assert.equal(reviewer.data.detail.reason, f.form.reason);
  await reviewer.change('approve');
  assert.equal(reviewer.data.detail.statusLabel, '已通过');
  assert.equal((await f.home.dashboard(leader)).todos.some(row => row.leaveId), false);
  assert.equal((await f.approvals.list(leader, { source: 'leave', scope: 'done' })).requests[0].statusLabel, '已通过');
  const resultMessage = (await f.messages.list(owner, {})).messages[0];
  assert.equal(resultMessage.title, '请假已通过');
  assert.ok(!JSON.stringify(f.db.rows('teamMessages')).includes(f.form.reason));
  assert.equal((await f.messages.open(owner, { id: resultMessage.id })).url, '/pages/leave/index?id=' + id);
  assert.equal((await f.leave.detail(owner, { id })).request.statusLabel, '已通过');
});

test('only the assigned active leader can see or decide, including against admin wildcard and self-approval', async () => {
  const f = fixture(), { id } = await f.submit();
  for (const viewer of [alternate, admin]) {
    await denied(f.leave.detail(viewer, { id }), 'NOT_FOUND');
    await denied(f.change(viewer, id, 1, 'leaveReview', { decision: 'approve' }), 'FORBIDDEN');
  }
  await denied(f.leave.detail(outsider, { id }), 'MEMBERSHIP_REQUIRED');
  await denied(f.change(owner, id, 1, 'leaveReview', { decision: 'approve' }), 'FORBIDDEN');
  await denied(f.leave.submit(leader, f.form), 'NO_REVIEWER');
  assert.deepEqual((await f.leave.reviewers(leader)).reviewers.map(item => item.id), [alternate]);
  await denied(f.leave.list(admin, { scope: 'pending' }), 'FORBIDDEN');
});

test('rejection requires a reason; withdrawal releases the time slot and resolves the original notification', async () => {
  const f = fixture(), { id } = await f.submit();
  await denied(f.change(leader, id, 1, 'leaveReview', { decision: 'reject' }), 'INVALID_INPUT');
  const reviewer = page(f, leader);
  reviewer.onLoad({ id }); await reviewer.onShow();
  await reviewer.openAction(tap('reject'));
  reviewer.updateNote({ detail: { value: '请确认日期' } }); await reviewer.confirmAction();
  assert.equal((await f.leave.detail(owner, { id })).request.decisionNote, '请确认日期');
  const replacement = await f.submit({ requestId: 'request000002' });
  await f.change(owner, replacement.id, 1, 'leaveWithdraw');
  assert.equal((await f.leave.detail(owner, { id: replacement.id })).request.statusLabel, '已撤回');
  assert.equal((await f.leave.todos(leader)).length, 0);
  assert.ok(f.db.rows('teamMessages').every(row => row.state === 'resolved'));
  await f.submit({ requestId: 'request000003' });
});

test('cancel rejection or withdrawal keeps the original leave; approval releases the interval', async () => {
  const f = fixture(), { id } = await f.submit();
  await f.change(leader, id, 1, 'leaveReview', { decision: 'approve' });
  const applicant = page(f, owner);
  applicant.onLoad({ id }); await applicant.onShow(); await applicant.openAction(tap('cancel'));
  applicant.updateNote({ detail: { value: '行程变更' } }); await applicant.confirmAction();
  assert.equal(applicant.data.detail.statusLabel, '取消待审批');
  await denied(f.submit({ requestId: 'request000002' }), 'OVERLAP');
  await f.change(leader, id, 3, 'leaveReview', { decision: 'reject', note: '原安排保留' });
  assert.equal((await f.leave.detail(owner, { id })).request.statusLabel, '已通过');
  await f.change(owner, id, 4, 'leaveCancel', { note: '调整' });
  await f.change(owner, id, 5, 'leaveWithdraw');
  assert.equal((await f.leave.detail(owner, { id })).request.statusLabel, '已通过');
  await f.change(owner, id, 6, 'leaveCancel', { note: '确认调整' });
  await f.change(leader, id, 7, 'leaveReview', { decision: 'approve' });
  assert.equal((await f.leave.detail(owner, { id })).request.statusLabel, '已取消');
  await f.submit({ requestId: 'request000003' });
});

test('removing the leader role revokes approval and message link; applicant can reassign to another leader', async () => {
  const f = fixture(), { id } = await f.submit();
  const messageId = f.db.rows('teamMessages')[0]._id;
  await denied(f.change(owner, id, 1, 'leaveReassign', { reviewerId: alternate }), 'INVALID_STATE');
  f.db.put('teamMembers', leader, { teamId: 'IMC', status: 'active', roles: [] });
  assert.equal((await f.messages.open(leader, { id: messageId })).url, '');
  await denied(f.change(leader, id, 1, 'leaveReview', { decision: 'approve' }), 'FORBIDDEN');
  assert.equal((await f.leave.detail(owner, { id })).request.canReassign, true);
  await f.change(owner, id, 1, 'leaveReassign', { reviewerId: alternate });
  assert.equal((await f.leave.todos(alternate))[0].id, id);
  await f.change(alternate, id, 2, 'leaveReview', { decision: 'approve' });
  assert.equal((await f.leave.detail(owner, { id })).request.statusLabel, '已通过');
});

test('duplicate requests return the same id and competing overlap or review cannot write twice', async () => {
  const f = fixture();
  const [first, retry] = await Promise.all([f.submit(), f.submit()]);
  assert.equal(first.id, retry.id);
  assert.equal(f.db.rows('teamMessages').length, 1);
  await denied(f.submit({ requestId: 'request000002' }), 'OVERLAP');
  const adjacent = await f.submit({ requestId: 'request000003', startTime: '11:00', endTime: '12:00' });
  const results = await Promise.allSettled([
    f.change(leader, adjacent.id, 1, 'leaveReview', { decision: 'approve' }),
    f.change(leader, adjacent.id, 1, 'leaveReview', { decision: 'reject', note: '稍后再申请' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.businessCode, 'CONFLICT');
  const competing = fixture();
  const overlapping = await Promise.allSettled([competing.submit(), competing.submit({ requestId: 'request000005' })]);
  assert.equal(overlapping.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.db.rows('leaveRequests').length, 1);
});

test('all-day range uses Beijing dates and cancellation cannot be approved after it starts', async () => {
  const f = fixture();
  await denied(f.submit({ startDate: '2026-02-30' }), 'INVALID_RANGE');
  const { id } = await f.submit({ allDay: true, startDate: '2026-11-08', endDate: date });
  const detail = (await f.leave.detail(owner, { id })).request;
  assert.equal(detail.retroactive, true);
  assert.equal(detail.timeRange, '2026-11-08 至 2026-11-12 · 全天');
  await f.change(leader, id, 1, 'leaveReview', { decision: 'approve' });
  await denied(f.change(owner, id, 2, 'leaveCancel', { note: '已开始' }), 'INVALID_STATE');
  const later = await f.submit({ requestId: 'request000002', startDate: '2026-11-13', endDate: '2026-11-13' });
  await f.change(leader, later.id, 1, 'leaveReview', { decision: 'approve' });
  await f.change(owner, later.id, 2, 'leaveCancel', { note: '计划有变' });
  f.now('2026-11-13T09:00:00+08:00');
  await denied(f.change(leader, later.id, 3, 'leaveReview', { decision: 'approve' }), 'INVALID_STATE');
  await f.change(leader, later.id, 3, 'leaveReview', { decision: 'reject', note: '已开始' });
});

test('audit write failure rolls back the request, overlap lock, and message', async () => {
  const f = fixture(); f.db.failNextWrite('leaveAudit');
  await assert.rejects(f.submit(), /Injected/);
  for (const table of ['leaveRequests', 'leaveLocks', 'teamMessages']) assert.equal(f.db.rows(table).length, 0);
  assert.ok((await f.submit()).ok);
});
