const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const createDatabase = require('./helpers/memory-db');
const createTimer = require('../cloudfunctions/weeklySharing/timer');

test('服务端定时触发可带 APPID；客户端伪造定时事件仍走成员鉴权', async () => {
  let context = { APPID: 'owning-application' }, timerCalls = 0, memberCalls = 0;
  const sandbox = { exports: {}, console, require(name) {
    if (name === 'wx-server-sdk') return { init() {}, database() { return {}; }, getWXContext() { return context; } };
    if (name === './access') return { identity(value) { return value.OPENID ? 'signed-in-member' : ''; } };
    if (name === './service') return () => ({ dispatch: async () => { memberCalls++; return { ok: false, code: 'INVALID_ACTION' }; } });
    if (name === './reminders') return () => async () => ({ ok: true });
    if (name === './timer') return () => async () => { timerCalls++; return { ok: true }; };
    throw new Error('Unexpected module: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/weeklySharing/index.js'), 'utf8'), sandbox);
  const event = { Type: 'Timer', TriggerName: 'weekly-sharing-reminders' };
  assert.equal((await sandbox.exports.main(event)).ok, true);
  context = { OPENID: 'trusted-client-openid', APPID: 'owning-application' };
  assert.equal((await sandbox.exports.main(event)).code, 'INVALID_ACTION');
  context = {};
  assert.equal((await sandbox.exports.main({ ...event, TriggerName: 'other-timer' })).code, 'AUTH_REQUIRED');
  assert.equal(timerCalls, 1);
  assert.equal(memberCalls, 1);
});

test('定时任务记录真实执行结果；失败记录错误码并继续抛错以便重试', async () => {
  const db = createDatabase();
  await createTimer(db, async () => ({ ok: true, processed: 1 }), () => 123)();
  let health = db.rows('sharingAudit')[0];
  assert.equal(health.state, 'success');
  assert.equal(health.processed, 1);
  const error = Object.assign(new Error('private error details'), { code: 'DATABASE_REQUEST_FAILED' });
  await assert.rejects(createTimer(db, async () => { throw error; }, () => 456)(), error);
  health = db.rows('sharingAudit')[0];
  assert.equal(health.state, 'failed');
  assert.equal(health.errorCode, error.code);
  assert.equal(JSON.stringify(health).includes('private error details'), false);
});

test('运行状态仅返回触发器和执行摘要，不返回函数代码、环境变量或凭据', async () => {
  const db = createDatabase();
  await createTimer(db, async () => ({ ok: true, processed: 2 }))();
  const manager = { functions: { getFunctionDetail: async () => ({ Status: 'Active', Environment: { secret: 'sensitive-value' },
    CodeInfo: 'private-source', Triggers: [{ TriggerName: 'weekly-sharing-reminders', Type: 'timer', Config: '0 */5 * * * * *', Enable: 1 }] }) } };
  const result = await require('../cloudfunctions/weeklySharing/setup').inspect(db, manager);
  assert.equal(result.triggers[0].enabled, 1);
  assert.equal(result.timer.processed, 2);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value|private-source|Environment|CodeInfo/);
});
