const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const createFinance = require('../cloudfunctions/finance/service');
const access = require('../cloudfunctions/finance/access');
const { createRequire } = require('node:module');
const requireFinance = createRequire(require.resolve('../cloudfunctions/finance/package.json'));
let archive, JSZip, Excel;
try {
  JSZip = requireFinance('jszip');
  Excel = requireFinance('exceljs');
  archive = requireFinance('./archive');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const memoryDatabase = require('./helpers/memory-db');
const user = number => 'user_' + number.toString(16).padStart(32, '0');
const [student, peer, officer, assistant, otherAdmin] = [1, 2, 3, 4, 5].map(user);
const week = '2026-11-09';
const request = () => randomUUID().replace(/-/g, '');
const pdf = Buffer.from('%PDF-1.7\nTest invoice');
const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
const prefix = 'cloud://test.bucket/';

function fixture(feishu, studentOnly = false, studentSubmit = false, financeDesk = false) {
  let now = Date.parse(week + 'T09:00:00+08:00');
  const accounts = [[student, [], '同名同学'], [peer, [], '同名同学'], [officer, ['finance_admin'], '财务专员'],
    [assistant, ['academic_admin'], '导师助理'], [otherAdmin, ['academic_admin', 'super_admin'], '其他管理员']];
  const db = memoryDatabase({
    teamMembers: Object.fromEntries(accounts.map(([id, roles]) => [id, { teamId: 'IMC', status: 'active', roles }])),
    userProfiles: Object.fromEntries(accounts.map(([id, , name]) => [id, { name }])),
    teamSync: { IMC: {} }
  });
  const objects = new Map();
  const storage = { read: async id => {
    if (!objects.has(id)) throw new Error('Missing object');
    return objects.get(id);
  }, freeze: async (data, ext, name) => {
    const id = prefix + request() + (name ? '/' + name : '');
    objects.set(id, data);
    return id;
  }, remove: async id => objects.delete(id), slice: async (id, offset, length) => objects.get(id).subarray(offset, offset + length) };
  const service = createFinance(db, storage, access, { prefix, reviewerIds: [assistant], makeArchive: archive, feishu, studentOnly, studentSubmit, financeDesk, clock: () => ++now });
  const call = (id, action, data) => service.dispatch(id, { ...data, action });
  async function upload(actor, kind, claimId = '', name, naming) {
    const screenshot = kind === 'payment' || kind === 'purchase' || kind === 'photo';
    const bytes = screenshot ? png : pdf;
    const { cloudPath, id } = await call(actor, 'prepare', { kind, claimId, size: bytes.length,
      name: name || (screenshot ? '凭证.png' : '材料.pdf'), ...naming });
    const fileID = prefix + cloudPath;
    objects.set(fileID, bytes);
    const { file } = await call(actor, 'finish', { fileId: id, fileID });
    assert.equal(file.fileID, undefined);
    return file.id;
  }
  async function submit(actor, { ownerId, category = '其他', cents = 49999, fileIds, requestId = request() } = {}) {
    const data = { category, cents, ownerId, fileIds: fileIds || [await upload(actor, 'invoice')], requestId };
    return (await call(actor, 'submit', data)).claim;
  }
  async function verify(row) {
    return (await call(officer, 'review', { claimId: row.id, revision: row.revision, pass: true })).claim;
  }
  return { call, upload, submit, verify, db, objects, tick: service.tick };
}

test('checks the 500 yuan boundary and taxi trip requirement on the server', async () => {
  const { upload, submit } = fixture();
  const invoice = await upload(student, 'invoice');
  await assert.rejects(submit(student, { cents: 50000, fileIds: [invoice] }), { businessCode: 'MISSING_MATERIALS' });
  await assert.rejects(submit(student, { category: '打车', fileIds: [invoice] }), /行程单/);
  assert.equal((await submit(student, { fileIds: [invoice] })).cents, 49999);
  const receipts = await Promise.all(['invoice', 'payment', 'purchase', 'trip'].map(kind => upload(student, kind)));
  assert.equal((await submit(student, { category: '打车', cents: 50000, fileIds: receipts })).files.length, 4);
  await assert.rejects(submit(peer, { fileIds: receipts }), { businessCode: 'INVALID_FILE' });
});

test('restricts applicant, reviewer, private downloads and preserves exact student stages', async () => {
  const { call, submit, verify } = fixture();
  await assert.rejects(submit(student, { ownerId: peer }), { businessCode: 'FORBIDDEN' });
  const row = await submit(officer, { ownerId: student });
  assert.equal((await call(officer, 'weekView', { week })).inbox[0].id, row.id);
  assert.equal((await call(assistant, 'weekView', { week })).inbox.length, 0);
  assert.equal((await call(student, 'list')).claims[0].id, row.id);
  assert.equal((await call(peer, 'list')).claims.length, 0);
  assert.deepEqual((await call(student, 'list')).stages.slice(1), ['已核验', '已制单', '已签字', '已提交财务处', '已到账']);
  await assert.rejects(call(peer, 'chunk', { claimId: row.id, fileId: row.files[0].id, offset: 0 }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(assistant, 'get', { claimId: row.id }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(officer, 'sendWeek', { week, ids: [row.id] }), { businessCode: 'CONFLICT' });
  let current = await verify(row);
  await call(officer, 'sendWeek', { week, ids: [row.id] });
  await assert.rejects(call(otherAdmin, 'weekView', { week }), { businessCode: 'FORBIDDEN' });
  current = (await call(assistant, 'get', { claimId: row.id })).claim;
  await assert.rejects(call(assistant, 'move', { claimId: row.id, revision: current.revision, stage: 3 }), { businessCode: 'CONFLICT' });
  for (const stage of [2, 3, 4]) current = (await call(assistant, 'move', { claimId: row.id, revision: current.revision, stage })).claim;
  await assert.rejects(call(officer, 'move', { claimId: row.id, revision: current.revision, stage: 5 }), { businessCode: 'CONFLICT' });
  await call(officer, 'move', { claimId: row.id, revision: current.revision, stage: 5, received: true });
  assert.equal((await call(student, 'get', { claimId: row.id })).claim.stageLabel, '已到账');
});

test('exports original materials and XLSX by member with stable, versioned, private week bundles', { skip: !archive && 'Install finance dependencies to verify ZIP and XLSX files' }, async () => {
  const { call, upload, submit, verify, db } = fixture();
  const first = await verify(await submit(student));
  const second = await verify(await submit(officer, { ownerId: peer }));
  await call(officer, 'sendWeek', { week, ids: [first.id, second.id] });
  await call(officer, 'sendWeek', { week, ids: [first.id, second.id] });
  const { file } = await call(assistant, 'openArchive', { week });
  assert.equal((await call(officer, 'openArchive', { week })).file.id, file.id);
  await assert.rejects(call(student, 'chunk', { fileId: file.id, offset: 0 }), { businessCode: 'FORBIDDEN' });
  const result = await call(assistant, 'chunk', { fileId: file.id, offset: 0 });
  const zip = await JSZip.loadAsync(Buffer.from(result.data, 'base64'));
  const attachments = Object.keys(zip.files).filter(name => name.endsWith('材料.pdf'));
  assert.equal(attachments.length, 2);
  assert.notEqual(attachments[0].split('/')[1], attachments[1].split('/')[1]);
  for (const name of attachments) assert.deepEqual(await zip.file(name).async('nodebuffer'), pdf);
  const workbook = new Excel.Workbook();
  await workbook.xlsx.load(await zip.file(week + '_报销材料/本周报销汇总.xlsx').async('nodebuffer'));
  assert.equal(workbook.getWorksheet('报销明细').rowCount, 3);
  assert.equal(workbook.getWorksheet('报销明细').getCell('D2').value, 499.99);
  let row = (await call(assistant, 'get', { claimId: first.id })).claim;
  row = (await call(assistant, 'review', { claimId: row.id, revision: row.revision, pass: false, reason: '请补清晰文件' })).claim;
  const fileId = await upload(student, 'invoice', first.id, '补件.pdf'), requestId = request();
  const args = { claimId: row.id, revision: row.revision, fileIds: [fileId], removeIds: [row.files[0].id], requestId };
  row = (await call(student, 'supplement', args)).claim;
  assert.deepEqual(row.files.map(item => item.id), [fileId]);
  assert.equal((await call(student, 'supplement', args)).claim.revision, row.revision);
  assert.equal((await call(assistant, 'openArchive', { week })).file.id, file.id);
  await verify(row);
  assert.notEqual((await call(assistant, 'openArchive', { week })).file.id, file.id);
  assert.equal(db.rows('financeWeeks')[0].claimIds.length, 2);
});

test('Feishu progress and supplement requests do not regress or duplicate and closure is sent back', async () => {
  let remote = { id: 'rec1', stage: 2, needs: '' }, previousWrite;
  const { call, submit, verify, tick, db } = fixture({ exchange: async row => { previousWrite = row; return remote; } });
  const row = await verify(await submit(student));
  await call(officer, 'sendWeek', { week, ids: [row.id] });
  assert.equal((await tick()).synced, 1);
  assert.equal((await call(student, 'get', { claimId: row.id })).claim.stageLabel, '已制单');
  remote = { id: 'rec1', stage: 1, needs: '需补凭证' };
  await tick();
  const revision = (await call(student, 'get', { claimId: row.id })).claim.revision;
  await tick();
  assert.equal((await call(student, 'get', { claimId: row.id })).claim.revision, revision);
  assert.equal(db.rows('financeClaims')[0].stage, 2);

  const { call: close, submit: submitClosed, verify: verifyClosed, tick: syncClosed } =
    fixture({ exchange: async claim => { previousWrite = claim; return { id: 'rec2', stage: 4, needs: '' }; } });
  const ready = await verifyClosed(await submitClosed(peer));
  await close(officer, 'sendWeek', { week, ids: [ready.id] });
  await syncClosed();
  const processing = (await close(peer, 'get', { claimId: ready.id })).claim;
  await close(officer, 'move', { claimId: ready.id, revision: processing.revision, stage: 5, received: true });
  assert.equal((await syncClosed()).synced, 1);
  assert.equal(previousWrite.stage, 5);
  assert.equal((await syncClosed()).synced, 0);
});

test('Feishu adapter uses the claim number, creates with an idempotency key and writes closure without changing progress', async () => {
  const makeFeishu = require('../cloudfunctions/finance/feishu');
  const claimId = 'fc_' + 'a'.repeat(32);
  const calls = [];
  let record;
  const adapter = makeFeishu({ appId: 'test', appSecret: 'secret', appToken: 'base', tableId: 'table' }, async (url, request) => {
    const path = new URL(url).pathname;
    const body = request.body && JSON.parse(request.body);
    const ok = data => ({ ok: true, json: async () => ({ code: 0, ...data }) });
    calls.push({ url, method: request.method, body });
    if (path.includes('tenant_access_token')) return ok({ tenant_access_token: 'token', expire: 7200 });
    assert.equal(request.headers.Authorization, 'Bearer token');
    if (path.endsWith('/search')) {
      assert.deepEqual(body.filter.conditions[0].value, [claimId]);
      return ok({ data: { items: record ? [record] : [], has_more: false } });
    }
    if (request.method === 'POST') {
      const key = new URL(url).searchParams.get('client_token');
      assert.match(key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
      record = { record_id: 'recA', fields: { ...body.fields } };
    }
    if (request.method === 'PUT') Object.assign(record.fields, body.fields);
    return ok({ data: { record } });
  });
  const row = { _id: claimId, ownerName: '测试同学', category: '打车', cents: 49999, weekStart: week, materialVersion: 1, stage: 1 };
  assert.deepEqual(await adapter.exchange(row), { id: 'recA', stage: 1, needs: '' });
  record.fields['处理进度'] = '已提交财务处';
  assert.deepEqual(await adapter.exchange({ ...row, feishuId: 'recA', stage: 5 }), { id: 'recA', stage: 4, needs: '' });
  assert.equal(record.fields['报销金额'], 499.99);
  assert.equal(record.fields['到账确认'], '已到账');
  assert.equal(calls.filter(call => call.url.includes('client_token=')).length, 1);
  assert.deepEqual(calls.find(call => call.method === 'PUT').body, { fields: { 到账确认: '已到账' } });
});

test('student-only release denies uploads and management even to finance officers', async () => {
  const full = fixture();
  const own = await full.verify(await full.submit(student));
  const other = await full.submit(peer);
  const { call, db } = fixture(undefined, true);
  for (const row of full.db.rows('financeClaims')) {
    const { _id, ...data } = row;
    db.put('financeClaims', _id, data);
  }
  const response = await call(student, 'list');
  assert.equal(response.studentOnly, true);
  assert.deepEqual(response.claims.map(row => row.id), [own.id]);
  assert.equal((await call(student, 'get', { claimId: own.id })).claim.stageLabel, '已核验');
  await assert.rejects(call(student, 'get', { claimId: other.id }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(officer, 'get', { claimId: other.id }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(officer, 'list', { scope: 'queue' }), { businessCode: 'FORBIDDEN' });
  for (const action of ['prepare', 'finish', 'submit', 'supplement', 'review', 'sendWeek', 'move', 'weekView', 'openArchive', 'syncWeek']) {
    await assert.rejects(call(student, action), { businessCode: 'INVALID_INPUT' });
    await assert.rejects(call(officer, action), { businessCode: 'INVALID_INPUT' });
  }
});

test('student list filters across pages and reflects manual Chinese status updates', async () => {
  const { db, call } = fixture(undefined, true);
  const id = index => 'fc_' + index.toString(16).padStart(32, '0');
  const record = { teamId: 'IMC', ownerId: student, category: '材料费', amount: 12.34,
    status: '已签字', updatedAt: '2026-11-12 09:30', number: '第九周-1', createdMs: 1794447000000 };
  for (let index = 1; index <= 32; index++) db.put('financeClaims', id(index), { ...record, createdMs: record.createdMs + index });
  db.put('financeClaims', id(33), { ...record, ownerId: peer, category: '差旅费' });
  db.put('financeClaims', id(34), { ...record, category: '差旅费', amount: 6315, status: '已提交财务处' });

  const all = await call(student, 'list');
  assert.deepEqual(all.categories, ['材料费', '加工费', '交通费', '餐饮票', '网络服务使用费', '论文专利费', '差旅费']);
  assert.equal(all.hasMore, true);
  const page = await call(student, 'list', { category: '材料费', offset: 30 });
  assert.deepEqual(page.claims.map(row => row.id), [id(2), id(1)]);
  const trip = await call(student, 'list', { category: '差旅费' });
  assert.deepEqual(trip.claims.map(row => row.id), [id(34)]);
  assert.equal(trip.claims[0].cents, 631500);
  assert.equal(trip.claims[0].stage, 4);
  assert.deepEqual(trip.claims[0].files, []);

  db.put('financeClaims', id(34), { ...record, category: '差旅费', amount: 6315, status: '已到账' });
  const { claim } = await call(student, 'get', { claimId: id(34) });
  assert.equal(claim.stageLabel, '已到账');
  assert.equal(claim.number, '第九周-1');
  assert.equal(claim.updatedAt, '2026-11-12 09:30');
  await assert.rejects(call(student, 'list', { category: '自行填写' }), { businessCode: 'INVALID_INPUT' });
});

test('student uploads a private PDF, gets a renamed receipt and can retry submission safely', async () => {
  const { call, upload, db, objects } = fixture(undefined, true, true);
  const { studentRules } = await call(student, 'list');
  assert.equal(studentRules.length, 7);
  await assert.rejects(call(student, 'prepare', { kind: 'invoice', name: '发票.png', size: png.length }), { businessCode: 'INVALID_FILE' });
  const naming = { category: '材料费', cents: 50000, ordinal: 1 };
  const prepared = await call(student, 'prepare', { kind: 'invoice', name: '发票.pdf', size: png.length, ...naming });
  const source = prefix + prepared.cloudPath;
  objects.set(source, png);
  await assert.rejects(call(student, 'finish', { fileId: prepared.id, fileID: source }), { businessCode: 'INVALID_FILE' });

  const fileIds = await Promise.all(['invoice', 'payment', 'photo'].map(kind => upload(student, kind, '', undefined, naming)));
  const data = { category: '材料费', cents: 50000, invoiceDate: week, description: '实验耗材', requestId: request(), fileIds };
  await assert.rejects(call(peer, 'submit', data), { businessCode: 'INVALID_FILE' });
  await assert.rejects(call(student, 'submit', { ...data, ownerId: peer }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(student, 'submit', { ...data, fileIds: fileIds.slice(0, 2) }), /实物图/);
  db.failNextWrite('teamMessages');
  await assert.rejects(call(student, 'submit', data), /Injected/);
  assert.equal(db.rows('financeClaims').length, 0);
  const [{ claim }, retry] = await Promise.all([call(student, 'submit', data), call(student, 'submit', data)]);
  assert.equal(retry.claim.id, claim.id);
  assert.match(claim.number, /^BX-20261109-[0-9A-F]{12}$/);
  assert.equal(claim.stageLabel, '等待核验');
  assert.deepEqual(claim.files.map(file => file.name), ['材料费_500.00元.pdf', '材料费_500.00元_支付记录.png', '材料费_500.00元_实物图.png']);
  assert.equal(claim.files[0].fileID, undefined);
  assert.ok([...objects.keys()].some(key => key.endsWith('/材料费_500.00元.pdf')));
  assert.equal(db.rows('teamMessages').length, 1);
  assert.equal(db.rows('teamMessages')[0].recipientKey, student);
  const args = { claimId: claim.id, fileId: claim.files[0].id, offset: 0 };
  await assert.rejects(call(peer, 'chunk', args), { businessCode: 'FORBIDDEN' });
  assert.deepEqual(Buffer.from((await call(student, 'chunk', args)).data, 'base64'), pdf);
  await assert.rejects(call(officer, 'move', {}), { businessCode: 'INVALID_INPUT' });
  const { _id, ...row } = db.rows('financeClaims')[0];
  db.put('financeClaims', _id, { ...row, status: '已制单' });
  assert.equal((await call(student, 'get', { claimId: _id })).claim.stageLabel, '已制单');
});

test('finance desk groups authorized claims by Beijing submission week with stable pages', async () => {
  const { call, db } = fixture(undefined, true, true, true);
  const id = number => 'fc_' + number.toString(16).padStart(32, '0');
  const start = Date.parse(week + 'T00:00:00+08:00');
  const end = start + 7 * 86400000;
  const row = { teamId: 'IMC', ownerId: student, category: '材料费', amount: 12.34, status: '已签字', createdMs: start };
  for (let index = 1; index <= 32; index++) db.put('financeClaims', id(index), { ...row, ownerId: index === 1 ? peer : student });
  db.put('financeClaims', id(33), { ...row, createdMs: start - 1 });
  db.put('financeClaims', id(34), { ...row, createdMs: end });
  db.put('financeClaims', id(35), { ...row, createdMs: end - 1 });
  db.put('financeClaims', id(36), { ...row, teamId: 'other' });
  for (const account of [student, assistant, otherAdmin]) {
    assert.equal((await call(account, 'list')).current.financeDesk, false);
    await assert.rejects(call(account, 'deskWeek', { week }), { businessCode: 'FORBIDDEN' });
    await assert.rejects(call(account, 'deskArchive', { week }), { businessCode: 'FORBIDDEN' });
  }
  const own = await call(officer, 'list');
  assert.equal(own.current.financeDesk, true);
  assert.deepEqual(own.claims, []);
  assert.equal(own.studentRules.length, 7);
  const first = await call(officer, 'deskWeek', { week });
  const second = await call(officer, 'deskWeek', { week, cursor: first.nextCursor });
  assert.deepEqual(first.weekInfo, { start: '2026-11-09', end: '2026-11-15', label: '第十一周' });
  const following = await call(officer, 'deskWeek', { week: '2026-11-16' });
  assert.deepEqual(following.weekInfo, { start: '2026-11-16', end: '2026-11-22', label: '第十二周' });
  assert.deepEqual(following.claims.map(claim => claim.id), [id(34)]);
  const beforeTerm = await call(officer, 'deskWeek', { week: '2026-08-24' });
  assert.deepEqual(beforeTerm.weekInfo, { start: '2026-08-24', end: '2026-08-30', label: '' });
  assert.equal(first.claims.length, 30);
  assert.deepEqual(second.claims.map(claim => claim.id), [id(3), id(2), id(1)]);
  assert.equal(second.nextCursor, null);
  assert.equal(first.claims[0].id, id(35));
  assert.equal(first.claims[0].submission, '已登记 · 无线上附件');
  assert.equal(first.claims[0].stageLabel, '已签字');
  assert.equal(first.claims[0].cents, 1234);
  assert.equal(first.claims[0].ownerName, '同名同学');
  assert.equal(second.claims.at(-1).ownerId, peer);
  assert.equal((await call(officer, 'get', { claimId: id(1) })).claim.ownerName, '同名同学');
  await assert.rejects(call(student, 'get', { claimId: id(1) }), { businessCode: 'FORBIDDEN' });
  await assert.rejects(call(officer, 'deskWeek', { week: '2026-11-10' }), { businessCode: 'INVALID_INPUT' });
  await assert.rejects(call(officer, 'deskWeek', { week, cursor: { id: id(35), createdMs: end } }), { businessCode: 'INVALID_INPUT' });
  await assert.rejects(call(officer, 'move', {}), { businessCode: 'INVALID_INPUT' });
});

test('only a finance officer can update progress, with private notices, audit, and stale update protection', async () => {
  const { call, db } = fixture(undefined, true, true, true);
  const claimId = 'fc_' + '4'.repeat(32);
  const manual = { teamId: 'IMC', ownerId: student, category: '材料费', amount: 19.2, status: '已制单',
    createdMs: Date.parse(week + 'T09:00:00+08:00'), updatedAt: '2026-11-08 17:00' };
  db.put('financeClaims', claimId, manual);
  const { claim } = await call(officer, 'get', { claimId });
  assert.match(claim.progressVersion, /^[a-f0-9]{64}$/);
  assert.equal((await call(student, 'get', { claimId })).claim.progressVersion, undefined);
  const args = { claimId, stage: 3, version: claim.progressVersion };
  for (const account of [student, peer, assistant, otherAdmin]) {
    await assert.rejects(call(account, 'deskProgress', args), { businessCode: 'FORBIDDEN' });
  }
  await assert.rejects(call(officer, 'deskProgress', { ...args, stage: 6 }), { businessCode: 'INVALID_INPUT' });
  await assert.rejects(call(officer, 'deskProgress', { ...args, stage: 5 }), { businessCode: 'INVALID_INPUT' });
  db.put('financeClaims', claimId, { ...manual, status: '已核验' });
  await assert.rejects(call(officer, 'deskProgress', args), { businessCode: 'CONFLICT' });
  db.put('financeClaims', claimId, manual);
  db.failNextWrite('teamMessages');
  await assert.rejects(call(officer, 'deskProgress', args), /Injected/);
  assert.equal(db.rows('financeClaims')[0].status, '已制单');
  assert.equal(db.rows('financeAudit').length, 0);
  const [saved, retry] = await Promise.all([call(officer, 'deskProgress', args), call(officer, 'deskProgress', args)]);
  assert.equal(saved.claim.stageLabel, '已签字');
  assert.equal(saved.claim.revision, 1);
  assert.equal(saved.claim.updatedAt, '2026-11-09 09:00');
  assert.equal(retry.claim.progressVersion, saved.claim.progressVersion);
  assert.equal(db.rows('teamMessages').length, 1);
  assert.equal(db.rows('teamMessages')[0].recipientKey, student);
  assert.match(db.rows('teamMessages')[0].body, /已签字/);
  assert.equal(db.rows('financeAudit')[0].actorId, officer);
  assert.equal(db.rows('financeAudit')[0].stage, 3);
  assert.equal((await call(student, 'list')).claims[0].stageLabel, '已签字');
  assert.equal((await call(officer, 'deskWeek', { week })).claims[0].stageLabel, '已签字');
  const paid = await call(officer, 'deskProgress', { claimId, version: saved.claim.progressVersion, stage: 5, received: true });
  assert.ok(paid.claim.paidMs > 0);
  const corrected = await call(officer, 'deskProgress', { claimId, version: paid.claim.progressVersion, stage: 2 });
  assert.equal(corrected.claim.paidMs, 0);
  assert.equal(corrected.claim.stageLabel, '已制单');
  db.put('teamMembers', officer, { teamId: 'IMC', status: 'active', roles: [] });
  await assert.rejects(call(officer, 'deskProgress', { ...args, version: corrected.claim.progressVersion }), { businessCode: 'FORBIDDEN' });
});

test('finance desk exports all or one member with current progress, even before verification', { skip: !archive && 'Install finance dependencies to verify ZIP and XLSX files' }, async () => {
  const { call, upload, db, objects } = fixture(undefined, true, true, true);
  const fileId = await upload(student, 'invoice', '', '发票.pdf', { category: '材料费', cents: 123, ordinal: 1 });
  const { claim } = await call(student, 'submit', { fileIds: [fileId], category: '材料费', cents: 123, invoiceDate: week, description: '耗材', requestId: request() });
  const id = 'fc_' + 'f'.repeat(32);
  const manual = { teamId: 'IMC', ownerId: peer, category: '交通费', amount: 50, status: '已制单',
    number: '手工-1', createdMs: Date.parse(week + 'T10:00:00+08:00') };
  db.put('financeClaims', id, manual);
  const list = await call(officer, 'deskWeek', { week });
  assert.equal(list.claims[1].submission, '已提交发票');
  assert.equal(list.claims[1].invoiceCount, 1);
  assert.equal(list.claims[1].stageLabel, '等待核验');
  assert.deepEqual(list.claims[1].files, []);
  const bytes = await call(officer, 'chunk', { claimId: claim.id, fileId, offset: 0 });
  assert.deepEqual(Buffer.from(bytes.data, 'base64'), pdf);
  async function exported(ownerId) {
    const { file } = await call(officer, 'deskArchive', { week, ownerId });
    const chunks = [];
    for (let offset = 0; offset < file.size;) {
      const chunk = await call(officer, 'chunk', { fileId: file.id, offset });
      chunks.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
    }
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(await zip.file('第十一周_' + week + '_报销材料/本周报销汇总.xlsx').async('nodebuffer'));
    return { file, zip, sheet: workbook.getWorksheet('报销明细'), summary: workbook.getWorksheet('按人汇总') };
  }
  const full = await exported();
  assert.equal(full.file.name, '第十一周_2026-11-09_全部成员_报销材料.zip');
  assert.equal(full.sheet.rowCount, 3);
  assert.equal(full.sheet.getCell('A2').value, '手工-1');
  assert.equal(full.sheet.getCell('H2').value, '已登记 · 无线上附件');
  assert.equal(full.sheet.getCell('I2').value, '已制单');
  assert.equal(full.sheet.getCell('I3').value, '等待核验');
  assert.equal(full.summary.rowCount, 3);
  assert.notEqual(full.summary.getCell('G2').value, full.summary.getCell('G3').value);
  const paths = Object.keys(full.zip.files).filter(path => path.endsWith('.pdf'));
  assert.equal(paths.length, 1);
  assert.ok(paths[0].endsWith('/材料费_1.23元.pdf'));
  assert.deepEqual(await full.zip.file(paths[0]).async('nodebuffer'), pdf);
  assert.equal((await call(officer, 'deskArchive', { week })).file.id, full.file.id);
  const single = await exported(peer);
  assert.equal(single.file.name, '第十一周_2026-11-09_同名同学_报销材料.zip');
  assert.equal(single.sheet.rowCount, 2);
  assert.equal(single.sheet.getCell('D2').value, 50);
  assert.equal(Object.keys(single.zip.files).filter(path => path.endsWith('.pdf')).length, 0);
  for (const account of [student, assistant, otherAdmin]) {
    await assert.rejects(call(account, 'chunk', { fileId: full.file.id, offset: 0 }), { businessCode: 'FORBIDDEN' });
  }
  const { claim: manualClaim } = await call(officer, 'get', { claimId: id });
  await call(officer, 'deskProgress', { claimId: id, version: manualClaim.progressVersion, stage: 5, received: true });
  const refreshed = await exported();
  assert.notEqual(refreshed.file.id, full.file.id);
  assert.equal(refreshed.sheet.getCell('I2').value, '已到账');
  const uploaded = db.rows('financeClaims').find(row => row._id === claim.id);
  objects.delete(uploaded.files[0].fileID);
  await assert.rejects(call(officer, 'deskArchive', { week, ownerId: student }), { businessCode: 'ARCHIVE_FILES_MISSING' });
  db.put('teamMembers', officer, { teamId: 'IMC', status: 'active', roles: [] });
  await assert.rejects(call(officer, 'chunk', { fileId: full.file.id, offset: 0 }), { businessCode: 'FORBIDDEN' });
});

test('student submissions validate the category-specific material and information requirements', async () => {
  const { call, upload } = fixture(undefined, true, true);
  async function submit(category, cents, kinds, fields = {}) {
    const fileIds = await Promise.all(kinds.map(kind => upload(student, kind, '', undefined, { category, cents, ordinal: 1 })));
    return call(student, 'submit', { category, cents, invoiceDate: week, description: '项目实验', requestId: request(), fileIds, ...fields });
  }
  const ride = { transportMode: 'ride', origin: '学校', destination: '实验点', wuhan: true, school: true, nonHub: true };
  await submit('材料费', 49999, ['invoice', 'payment']);
  await assert.rejects(submit('加工费', 49999, ['invoice']), /发票明细/);
  await submit('加工费', 49999, ['invoice', 'detail']);
  await assert.rejects(submit('加工费', 50000, ['invoice', 'payment']), /加工清单/);
  await submit('加工费', 50000, ['invoice', 'workList', 'payment']);
  await assert.rejects(submit('交通费', 1500, ['invoice'], ride), /行程单/);
  await assert.rejects(submit('交通费', 1500, ['invoice', 'trip'], { ...ride, destination: '武汉机场' }), /目的地/);
  await assert.rejects(submit('交通费', 1500, ['invoice', 'trip'], { ...ride, wuhan: false }), /武汉市内/);
  const { claim } = await submit('交通费', 1500, ['invoice', 'trip'], ride);
  assert.equal(claim.transport.mode, 'ride');
  await submit('交通费', 1500, ['invoice'], { ...ride, transportMode: 'taxi', destination: '武汉机场' });
  await assert.rejects(submit('餐饮票', 200001, ['invoice']), /节假日/);
  await submit('餐饮票', 200001, ['invoice'], { confirmed: true });
  await assert.rejects(submit('网络服务使用费', 50000, ['invoice']), /报备/);
  await submit('网络服务使用费', 50000, ['invoice'], { confirmed: true });
  await assert.rejects(submit('网络服务使用费', 50001, ['invoice'], { confirmed: true }), /支付记录/);
  await submit('网络服务使用费', 50001, ['invoice', 'payment'], { confirmed: true });
  await assert.rejects(submit('论文专利费', 200, ['invoice']), /缴费通知/);
  await submit('论文专利费', 200, ['invoice', 'paymentNotice']);
  await assert.rejects(submit('差旅费', 1000, ['invoice']), /提前沟通/);
  await assert.rejects(submit('差旅费', 1000, ['invoice'], { confirmed: true, invoiceDate: '2026-02-30' }), /开票日期/);
  await submit('差旅费', 1000, ['invoice'], { confirmed: true });
});
