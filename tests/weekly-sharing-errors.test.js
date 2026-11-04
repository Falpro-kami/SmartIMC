const test = require('node:test');
const assert = require('node:assert/strict');
const { cloudError } = require('../miniprogram/services/sharing-errors');
const roster = require('../cloudfunctions/weeklySharing/roster-source.json');

test('未部署、执行失败、环境错误和真实网络故障分别提示', () => {
  const missing = cloudError({ errCode: -501000, errMsg: 'cloud.callFunction:fail Error: FunctionName parameter could not be found' });
  assert.equal(missing.code, 'SHARING_NOT_DEPLOYED');
  assert.doesNotMatch(missing.message, /网络/);
  assert.equal(cloudError({ errMsg: 'FUNCTIONS_EXECUTE_FAIL: Cannot find module' }).code, 'SHARING_SERVICE_FAILED');
  assert.equal(cloudError({ errMsg: 'ENV_NOT_FOUND' }).code, 'SHARING_ENV_UNAVAILABLE');
  assert.equal(cloudError({ errMsg: 'request:fail timeout' }).code, 'SHARING_TIMEOUT');
  assert.equal(cloudError({ errMsg: 'request:fail network disconnected' }).code, 'SHARING_NETWORK_FAILED');
  assert.equal(cloudError({ errMsg: 'unexpected cloud provider error' }).code, 'SHARING_CALL_FAILED');
});

test('Excel 排班包含连续14周、每周两人且跨年日期完整', () => {
  assert.equal(roster.weeks.length, 14);
  assert.equal(roster.weeks[0].weekStart, '2026-10-26');
  assert.equal(roster.weeks.at(-1).endDate, '2027-01-31');
  assert.deepEqual(roster.weeks[1].assigneeNames, ['敖家俊', '罗杰文']);
  assert.equal(roster.weeks[9].weekStart, '2026-12-28');
  assert.equal(roster.weeks[9].endDate, '2027-01-03');
  for (let i = 0; i < roster.weeks.length; i++) {
    const row = roster.weeks[i];
    assert.equal(row.assigneeNames.length, 2);
    assert.equal(new Set(row.assigneeNames).size, 2);
    const start = Date.parse(row.weekStart + 'T00:00:00+08:00');
    const end = Date.parse(row.endDate + 'T00:00:00+08:00');
    assert.equal(end - start, 6 * 86400000);
    if (i) assert.equal(start - Date.parse(roster.weeks[i - 1].weekStart + 'T00:00:00+08:00'), 7 * 86400000);
  }
});
