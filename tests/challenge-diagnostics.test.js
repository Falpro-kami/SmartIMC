const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('挑战赛部署错误仅向高创返回诊断，普通成员保持通用提示', async () => {
  const filename = require.resolve('../cloudfunctions/weeklySharing/index');
  const source = fs.readFileSync(filename, 'utf8');
  for (const manager of [true, false]) {
    const exports = {};
    const modules = { 'wx-server-sdk': { init() {}, database: () => ({}), getWXContext: () => ({ OPENID: 'trusted' }) },
      './access': { identity: () => 'caller', readMember: async () => ({}) }, './policy': { manager: () => manager },
      './service': () => ({ dispatch: async () => { throw new Error('Cannot find module challenge/service'); } }), './reminders': () => ({}), './timer': () => () => {} };
    vm.runInNewContext(source, { exports, require: name => modules[name], console: { error() {} } });
    const result = await exports.main({ action: 'challenge.initialize' });
    assert.equal(result.code, manager ? 'CHALLENGE_SETUP_FAILED' : 'CHALLENGE_FAILED');
    assert.equal(result.message.includes('Cannot find module'), manager);
  }
});
