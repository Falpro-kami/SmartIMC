const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const access = require('../cloudfunctions/_shared/access');
const createService = require('../cloudfunctions/weeklyReport/service');
const id = n => 'user_' + n.toString(16).padStart(32, '0');
const pid = n => 'wp_' + n.toString(16).padStart(32, '0');
const token = (p, n) => p + '_' + n.toString(16).padStart(32, '0');
const active = roles => ({ teamId: 'IMC', status: 'active', roles });
const sourceId = file => 'cloud://well-leopon-d5glrufc6e4fd4413.7765-well-leopon-d5glrufc6e4fd4413-1516940081/' + file.path;
function fixture() {
  let tables = Object.fromEntries(['teamSync', 'teamMembers', 'userProfiles', 'weeklyTemplates', 'weeklyPeriods', 'weeklyReports', 'weeklyVersions', 'weeklyFiles', 'weeklyAudit', 'teamMessages'].map(t => [t, new Map()]));
  tables.teamSync.set('IMC', Object.fromEntries(['home', 'messages', 'approvals', 'weekly', 'members'].map(k => [k, 'initial'])));
  let now = Date.parse('2026-10-27T10:00:00+08:00'), reads = 0, copies = 0;
  const objects = new Map();
  function collection(store, name) {
    const table = store[name], order = []; let query = {}, skip = 0, limit = 100;
    return { where(q) { query = q; return this; }, orderBy(k, d) { order.push([k, d]); return this; }, skip(n) { skip = n; return this; }, limit(n) { limit = n; return this; },
      async get() { return { data: [...table].map(([key, row]) => ({ ...structuredClone(row), _id: key })).filter(row => Object.entries(query).every(([key, val]) =>
        Array.isArray(val) ? (Array.isArray(row[key]) ? row[key] : [row[key]]).some(v => val.includes(v)) : val && typeof val === 'object' && '$lte' in val ? row[key] <= val.$lte : row[key] === val))
        .sort((a, b) => { for (const [key, direction] of order) { if (a[key] < b[key]) return direction === 'desc' ? 1 : -1; if (a[key] > b[key]) return direction === 'desc' ? -1 : 1; } return 0; }).slice(skip, skip + limit) }; },
      doc(key) { return { get: async () => ({ data: table.has(key) ? { ...structuredClone(table.get(key)), _id: key } : null }),
        set: async ({ data }) => table.set(key, structuredClone(data)), update: async ({ data }) => { assert.ok(table.has(key)); table.set(key, { ...table.get(key), ...structuredClone(data) }); } }; }
    };
  }
  const db = { collection: name => collection(tables, name), command: { in: values => values, lte: value => ({ $lte: value }) },
    async runTransaction(cb) { const next = structuredClone(tables); const result = await cb({ collection: name => collection(next, name) }); tables = next; return result; } };
  const cloud = { async getTempFileURL({ fileList }) { return { fileList: fileList.map(fileID => ({ fileID, tempFileURL: 'https://private.example/signed', status: 0 })) }; },
    async deleteFile({ fileList }) { fileList.forEach(f => objects.delete(f)); } };
  const storage = { read: async fileID => { reads++; return objects.get(fileID); }, slice: async (fileID, offset, length) => objects.get(fileID).subarray(offset, offset + length),
    freeze: async (bytes, ext) => { const fileID = 'cloud://private/server-' + ++copies + '.' + ext; objects.set(fileID, Buffer.from(bytes)); return fileID; } };
  const service = createService(db, cloud, access, () => now, storage);
  const send = (owner, action, data = {}) => service.dispatch(owner, { ...data, action });
  for (const [n, roles] of [[1, ['weekly_admin']], [2, []], [3, []], [4, ['leader']], [5, ['finance_admin']]]) {
    tables.teamMembers.set(id(n), active(roles)); tables.userProfiles.set(id(n), { name: '测试成员' + n });
  }
  const period = (extra = {}) => send(id(1), 'savePeriod', { id: pid(1), revision: 0, title: '本周周报', startDate: '2026-10-26', endDate: '2026-11-01', deadline: '2026-11-01T18:00',
    status: 'open', allowLateSubmit: true, allowLateEdit: false, roster: [2, 3].map(n => ({ id: id(n), exempt: '' })), ...extra });
  async function upload(owner = id(2), periodId = pid(1), data = Buffer.from('%PDF-1.7\nreport'), name = '周报.pdf', options = {}) {
    const p = await send(owner, 'prepareUpload', { periodId, name, size: data.length, ...options });
    const file = tables.weeklyFiles.get(p.id); objects.set(sourceId(file), data);
    const result = await send(owner, 'finishUpload', { fileId: p.id, fileID: sourceId(file) });
    return result.file;
  }
  return { send, period, upload, db, cloud, objects, table: name => tables[name], time: value => { now = value; }, clock: () => now,
    get reads() { return reads; }, get copies() { return copies; } };
}
const denied = (promise, code) => assert.rejects(promise, error => error.businessCode === code);
const saved = (a, fileIds, revision = 0, request = 1) => a.send(id(2), 'saveDraft', { periodId: pid(1), revision, fileIds, requestId: token('wd', request) });
const submitted = (a, fileIds, revision = 0, request = 1) => a.send(id(2), 'submit', { periodId: pid(1), revision, fileIds, requestId: token('ws', request) });

const formModel = require('../cloudfunctions/weeklyReport/form');
const schema = () => formModel.schema({ sections: [{ id: 'work', title: '工作汇报', fields: [
  { id: 'body', label: '本周工作', type: 'text', required: true, maxLength: 100, width: 'full' },
  { id: 'hours', label: '工时', type: 'number', required: true, width: 'half' },
  { id: 'date', label: '完成日期', type: 'date', required: false, width: 'half' },
  { id: 'stage', label: '阶段', type: 'single', required: false, options: ['进行中', '完成'] },
  { id: 'tags', label: '分类', type: 'multiple', required: false, options: ['研究', '实验'] },
  { id: 'docs', label: '附件', type: 'attachment', required: false, maxCount: 2, maxSizeMB: 1 }
] }] });
const text = value => ({ ops: [{ insert: value + '\n', attributes: { bold: true } }] });

test('optional selection persists in drafts and versions, ignores unchecked values, and never bypasses required validation', async () => {
  const a = fixture(); await a.period({ schema: schema() });
  const answers = { body: text('必填工作'), hours: 0, stage: '完成', tags: ['实验'] };
  const data = { periodId: pid(1), revision: 0, answers, selectedFields: ['stage'], requestId: token('wd', 1) };
  const draft = await a.send(id(2), 'saveDraft', data);
  assert.deepEqual(draft.report.selectedFields, ['stage']); assert.equal(draft.report.answers.tags, undefined);
  const first = await a.send(id(2), 'submit', { ...data, revision: 1, requestId: token('ws', 1) });
  assert.deepEqual((await a.send(id(4), 'getVersion', { versionId: first.versions[0].id })).version.selectedFields, ['stage']);
  const changed = await a.send(id(2), 'saveDraft', { ...data, revision: 2, selectedFields: [], requestId: token('wd', 2) });
  assert.equal(changed.report.hasChanges, true); assert.equal(changed.report.answers.stage, undefined);
  const leader = await a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) });
  assert.deepEqual(leader.report.selectedFields, ['stage']); assert.equal(leader.report.answers.stage, '完成');
  await denied(a.send(id(2), 'submit', { ...data, revision: 3, answers: { hours: 0 }, selectedFields: [], requestId: token('ws', 2) }), 'INVALID_FORM');
  for (const selectedFields of [['body'], ['missing'], ['stage', 'stage']]) assert.throws(() => formModel.answers(schema(), answers, true, selectedFields));
  const allOptional = schema(); allOptional.sections[0].fields.forEach(f => { f.required = false; });
  assert.deepEqual(formModel.answers(allOptional, {}, true, []).values, {});
});

test('legacy half widths normalize to full without invalidating published cycle settings or changing field contents', async () => {
  const a = fixture(); await a.period({ schema: schema() });
  const stored = a.table('weeklyPeriods').get(pid(1)); stored.schema.sections[0].fields[1].width = 'half';
  await a.period({ revision: 1, schema: stored.schema });
  const fields = a.table('weeklyPeriods').get(pid(1)).schema.sections[0].fields;
  assert.ok(fields.every(f => f.width === 'full')); assert.equal(fields[1].label, '工时'); assert.equal(fields[1].required, true);
});

test('nested schemas validate leaf permissions and required content, and keep image ownership through submission versions', async () => {
  const a = fixture(), s = schema(), original = s.sections[0].fields;
  s.sections[0].fields = [{ id: 'progress', label: '项目工作进展', type: 'group', children: [{ id: 'research', label: '研究工作', type: 'group', children: original.slice(0, 2) }, ...original.slice(2)] }];
  s.sections.push({ id: 'other', title: '其他', fields: [], required: false });
  await a.period({ schema: s });
  assert.equal(formModel.fields(s).length, 7);
  const image = await a.upload(id(2), pid(1), Buffer.from('89504e470d0a1a0a01020304', 'hex'), '实验.png', { kind: 'image', fieldId: 'body' });
  const values = { body: { ops: [{ insert: { image: 'imc-image:' + image.id } }] }, hours: 0, other: text('补充说明') };
  const result = await a.send(id(2), 'submit', { periodId: pid(1), revision: 0, answers: values, selectedFields: [], requestId: token('ws', 1) });
  assert.equal(result.report.files[0].id, image.id); assert.equal(result.report.answers.other.ops[0].insert, '补充说明\n');
  assert.equal((await a.send(id(4), 'getVersion', { versionId: result.versions[0].id })).version.answers.hours, 0);
  assert.throws(() => formModel.answers(s, values, true, ['progress']), e => e.businessCode === 'INVALID_FORM');
  assert.throws(() => formModel.answers(s, { hours: 0 }, true, []), e => e.businessCode === 'INVALID_FORM');
  await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'x.png', size: 100, kind: 'image', fieldId: 'progress' }), 'INVALID_FORM');
  const tooDeep = schema(); let node = tooDeep.sections[0].fields[0];
  for (let i = 0; i < 6; i++) node = { id: 'group' + i, label: '分组', type: 'group', children: [node] };
  tooDeep.sections[0].fields[0] = node;
  assert.throws(() => formModel.schema(tooDeep), e => e.businessCode === 'INVALID_FORM');
  const duplicate = schema(); duplicate.sections[0].fields.push({ id: 'g', label: '分组', type: 'group', children: [{ ...duplicate.sections[0].fields[0] }] });
  assert.throws(() => formModel.schema(duplicate), e => e.businessCode === 'INVALID_FORM');
});

test('instructions are validated at each hierarchy level and remain fixed in published snapshots', async () => {
  const a = fixture(), s = schema();
  s.sections[0].help = '  总体说明\r\n第二行  ';
  s.sections[0].fields = [{ id: 'group', label: '实验', type: 'group', help: '分组说明', children: s.sections[0].fields }];
  s.sections[0].fields[0].children[0].help = '<b>按纯文本显示</b>\n实验过程';
  s.sections.push({ id: 'other', title: '其他', fields: [], help: '补充内容' });
  const data = { id: token('wt', 1), revision: 0, name: '说明模板', schema: s };
  const saved = await a.send(id(1), 'saveTemplate', data);
  assert.equal(saved.template.schema.sections[0].help, '总体说明\n第二行');
  assert.equal(saved.template.schema.sections[0].fields[0].children[0].help, '<b>按纯文本显示</b>\n实验过程');
  await a.period({ schema: saved.template.schema });
  const changed = structuredClone(saved.template.schema); changed.sections[0].fields[0].help = '新说明';
  await a.send(id(1), 'saveTemplate', { ...data, revision: 1, schema: changed });
  const read = await a.send(id(2), 'get', { periodId: pid(1) });
  assert.equal(read.period.schema.sections[0].fields[0].help, '分组说明');
  for (const getNode of [s => s.sections[0], s => s.sections[0].fields[0], s => s.sections[0].fields[0].children[0], s => s.sections[1]]) {
    for (const invalid of ['长'.repeat(1001), '\u0000', { html: '不接受对象' }]) {
      const bad = structuredClone(s); getNode(bad).help = invalid;
      assert.throws(() => formModel.schema(bad), e => e.businessCode === 'INVALID_FORM');
    }
  }
  assert.equal(formModel.schema({ sections: [{ id: 'old', title: '旧模板', fields: [] }] }).sections[0].help, '');
});

test('template management is server authorized, revision checked and snapshotted into each period', async () => {
  const a = fixture(), data = { id: token('wt', 1), revision: 0, name: '研究周报', schema: schema() };
  for (const n of [2, 4, 5]) for (const action of ['templates', 'saveTemplate']) await denied(a.send(id(n), action, data), 'FORBIDDEN');
  const saved = await a.send(id(1), 'saveTemplate', data);
  assert.equal(saved.template.schema.sections[0].fields[0].type, 'text');
  await denied(a.send(id(1), 'saveTemplate', data), 'CONFLICT');
  await a.period({ schema: saved.template.schema, templateName: saved.template.name });
  const changed = schema(); changed.sections[0].fields[0].label = '新的字段';
  await a.send(id(1), 'saveTemplate', { ...data, revision: 1, schema: changed });
  assert.equal((await a.send(id(1), 'templates')).templates[0].revision, 2);
  assert.equal((await a.send(id(2), 'get', { periodId: pid(1) })).period.schema.sections[0].fields[0].label, '本周工作');
  await denied(a.period({ revision: 1, schema: changed }), 'INVALID_FORM');
  a.table('teamMembers').set(id(5), active(['super_admin']));
  assert.equal((await a.send(id(5), 'templates')).templates.length, 1);
});

test('form validation merges text types, strips unsafe styles and enforces every field rule on submit', () => {
  assert.deepEqual(formModel.types, ['text', 'number', 'date', 'single', 'multiple', 'attachment']);
  const s = schema();
  assert.equal(formModel.answers(s, { body: text(''), hours: 0 }).values.hours, 0);
  const base = { body: text('进展'), hours: 0, date: '2026-10-28', stage: '完成', tags: ['实验'] };
  assert.equal(formModel.answers(s, base, true).values.hours, 0);
  const invalid = [{ ...base, body: text('') }, { ...base, body: text('字'.repeat(101)) }, { ...base, hours: 'NaN' }, { ...base, date: '2026-02-30' }, { ...base, stage: '未知' }, { ...base, tags: ['研究', '研究'] }, { ...base, docs: [token('wf', 1), token('wf', 2), token('wf', 3)] }, { ...base, injected: 'x' }, { ...base, body: { ops: [{ insert: { image: 'https://external.example/image.png' } }] } }];
  for (const value of invalid) assert.throws(() => formModel.answers(s, value, true), e => e.businessCode === 'INVALID_FORM');
  const safe = formModel.answers(s, { ...base, body: { ops: [{ insert: '<script>plain text</script>\n', attributes: { bold: true, link: 'javascript:alert(1)', onload: 'alert(1)' } }] } }).values.body;
  assert.deepEqual(safe.ops[0].attributes, { bold: true });
  assert.throws(() => formModel.schema({ sections: [null] }));
  assert.throws(() => formModel.schema({ sections: [{ id: 'x', title: 'x', fields: [{ id: 'x', label: 'x', type: 'text', required: false }] }] }));
});

test('rich reports preserve submitted text and private inline images while later draft changes stay private', async () => {
  const a = fixture(); await a.period({ schema: schema() });
  const image = await a.upload(id(2), pid(1), Buffer.from('89504e470d0a1a0a01020304', 'hex'), '实验.png', { kind: 'image', fieldId: 'body' });
  const attachment = await a.upload(id(2), pid(1), undefined, '周报.pdf', { fieldId: 'docs' });
  const answers = { body: { ops: [{ insert: '实验结果\n', attributes: { header: 2 } }, { insert: { image: 'imc-image:' + image.id } }, { insert: '\n' }] }, hours: 0, docs: [attachment.id] };
  assert.ok((await a.send(id(2), 'imageURL', { fileId: image.id })).url);
  await denied(a.send(id(3), 'imageURL', { fileId: image.id }), 'FORBIDDEN');
  await denied(a.send(id(4), 'download', { fileId: image.id }), 'FORBIDDEN');
  await a.send(id(2), 'saveDraft', { periodId: pid(1), revision: 0, answers, requestId: token('wd', 1) });
  await denied(a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) }), 'NOT_FOUND');
  const first = await a.send(id(2), 'submit', { periodId: pid(1), revision: 1, answers, requestId: token('ws', 1) });
  assert.equal(first.versions[0].answers, undefined, 'history content is loaded on demand');
  assert.equal((await a.send(id(4), 'getVersion', { versionId: first.versions[0].id })).version.answers.body.ops[1].insert.image, 'imc-image:' + image.id);
  await denied(a.send(id(3), 'getVersion', { versionId: first.versions[0].id }), 'FORBIDDEN');
  assert.equal(first.report.files.length, 2); assert.ok(first.imageURLs[image.id]);
  const changed = { ...answers, body: text('新的草稿') };
  const draft = await a.send(id(2), 'saveDraft', { periodId: pid(1), revision: 2, answers: changed, requestId: token('wd', 2) });
  assert.equal(draft.report.hasChanges, true);
  const leader = await a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) });
  assert.deepEqual(leader.report.answers, answers); assert.equal(leader.report.hasChanges, false);
  assert.equal((await a.send(id(4), 'download', { fileId: image.id })).file.id, image.id);
  await a.send(id(2), 'submit', { periodId: pid(1), revision: 3, answers: changed, requestId: token('ws', 2) });
  await denied(a.send(id(4), 'download', { fileId: image.id }), 'FORBIDDEN');
  assert.equal((await a.send(id(4), 'download', { fileId: image.id, versionId: first.versions[0].id })).file.id, image.id);
  for (const r of a.table('weeklyReports').values()) assert.ok(!JSON.stringify(r).includes('https://'));
  for (const message of a.table('teamMessages').values()) assert.deepEqual(message.readBy, []);
});

test('structured drafts cannot borrow files across owners, periods or fields, or forge inline images', async () => {
  const a = fixture(); await a.period({ schema: schema() }); await a.period({ id: pid(2), schema: schema() });
  const f = await a.upload(id(2), pid(1), undefined, '周报.pdf', { fieldId: 'docs' });
  const base = { periodId: pid(1), revision: 0, requestId: token('wd', 1), answers: { body: text('工作'), hours: 1, docs: [f.id] } };
  await denied(a.send(id(3), 'saveDraft', base), 'FORBIDDEN');
  await denied(a.send(id(2), 'saveDraft', { ...base, periodId: pid(2) }), 'FORBIDDEN');
  await denied(a.send(id(2), 'saveDraft', { ...base, answers: { body: { ops: [{ insert: { image: 'imc-image:' + f.id } }] }, hours: 1 } }), 'FORBIDDEN');
  await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'picture.png', size: 100, kind: 'image', fieldId: 'hours' }), 'INVALID_FORM');
  await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'big.pdf', size: 2 * 1024 * 1024, fieldId: 'docs' }), 'FILE_LIMIT');
});

test('publication, submission and the scheduled worker commit live cursors without marking messages read', async () => {
  const a = fixture();
  await a.period();
  const published = structuredClone(a.table('teamSync').get('IMC'));
  for (const channel of ['home', 'messages', 'weekly']) assert.notEqual(published[channel], 'initial');
  assert.equal(published.approvals, 'initial');
  const file = await a.upload();
  await submitted(a, [file.id]);
  assert.notEqual(a.table('teamSync').get('IMC').home, published.home);
  assert.notEqual(a.table('teamSync').get('IMC').weekly, published.weekly);
  assert.equal(a.table('teamSync').get('IMC').messages, published.messages);
  for (const message of a.table('teamMessages').values()) assert.deepEqual(message.readBy, []);
  await a.period({ id: pid(2), status: 'scheduled', publishAt: '2026-10-27T11:00' });
  const before = structuredClone(a.table('teamSync').get('IMC'));
  a.time(Date.parse('2026-10-27T11:01:00+08:00'));
  const publish = require('../cloudfunctions/weeklyReport/publisher')(a.db, access, a.clock);
  assert.equal((await publish()).published, 1);
  for (const channel of ['home', 'messages', 'weekly']) assert.notEqual(a.table('teamSync').get('IMC')[channel], before[channel]);
  const after = structuredClone(a.table('teamSync').get('IMC'));
  assert.equal((await publish()).published, 0);
  assert.deepEqual(a.table('teamSync').get('IMC'), after);
});

test('weekly actions enforce real membership and business permissions before returning data', async () => {
  const a = fixture();
  for (const status of ['pending', 'disabled', 'removed']) {
    a.table('teamMembers').set(id(9), { ...active(['super_admin']), status });
    for (const action of ['list', 'get', 'roster', 'savePeriod', 'prepareUpload', 'finishUpload', 'saveDraft', 'submit', 'team', 'remind', 'download', 'downloadChunk', 'exportStats']) await denied(a.send(id(9), action, { roles: ['super_admin'], ownerId: id(2) }), 'MEMBERSHIP_REQUIRED');
  }
  a.table('teamMembers').set(id(9), { ...active(['super_admin']), teamId: 'OTHER' });
  await denied(a.send(id(9), 'list'), 'MEMBERSHIP_REQUIRED');
  await a.period();
  for (const n of [2, 5]) for (const action of ['roster', 'configuration', 'savePeriod', 'team', 'remind', 'exportStats']) await denied(a.send(id(n), action, { periodId: pid(1) }), 'FORBIDDEN');
  assert.equal((await a.send(id(4), 'team', { periodId: pid(1) })).total, 2);
  await denied(a.send(id(4), 'exportStats', { periodId: pid(1) }), 'FORBIDDEN');
});

test('leader presentation follows the authorized viewer role while keeping member files and additive permissions', async () => {
  const a = fixture(); await a.period();
  const file = await a.upload(); await submitted(a, [file.id]);
  assert.equal((await a.send(id(4), 'list', { isLeader: false })).isLeader, true);
  const own = await a.send(id(4), 'get', { periodId: pid(1) });
  assert.equal(own.isLeader, true); assert.equal(own.own, true); assert.equal(own.canReadTeam, true);
  const student = await a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) });
  assert.equal(student.isLeader, true); assert.equal(student.own, false);
  assert.equal(student.report.files[0].id, file.id); assert.equal(student.versions.length, 1);
  assert.equal((await a.send(id(2), 'list', { isLeader: true })).isLeader, false);
  assert.equal((await a.send(id(1), 'get', { periodId: pid(1) })).isLeader, false);
  a.table('teamMembers').set(id(5), active(['super_admin']));
  const superAdmin = await a.send(id(5), 'list');
  assert.equal(superAdmin.isLeader, false); assert.equal(superAdmin.canManage, true);
  a.table('teamMembers').set(id(5), active(['leader', 'weekly_admin', 'super_admin']));
  const combined = await a.send(id(5), 'get', { periodId: pid(1) });
  assert.equal(combined.isLeader, true); assert.equal(combined.canManage, true); assert.equal(combined.canRemind, true);
});

test('periods validate dates and revisions, snapshot names, preserve exemptions and target notifications only', async () => {
  const a = fixture();
  await denied(a.period({ startDate: '2026-02-30' }), 'INVALID_INPUT');
  await denied(a.period({ deadline: '2026-02-30T18:00' }), 'INVALID_INPUT');
  await denied(a.period({ roster: [{ id: id(99), exempt: '' }] }), 'INVALID_INPUT');
  await a.period({ roster: [{ id: id(2), exempt: '' }, { id: id(3), exempt: '外出交流' }] });
  const p = a.table('weeklyPeriods').get(pid(1));
  assert.equal(p.roster[0].name, '测试成员2');
  assert.equal(p.roster[1].exempt, '外出交流');
  assert.deepEqual([...a.table('teamMessages').values()][0].recipientKey, [id(2)]);
  await denied(a.period(), 'CONFLICT');
  assert.equal(a.table('weeklyAudit').size, 1);
  await denied(a.upload(id(3)), 'NOT_REQUIRED');
  await denied(a.upload(id(1)), 'NOT_REQUIRED');
});

test('scheduled periods stay private until the cloud timer publishes them once, with an audited notification', async () => {
  const a = fixture();
  const publishAt = '2026-10-27T10:02';
  await denied(a.period({ status: 'scheduled', publishAt: '2026-10-27T09:59' }), 'INVALID_INPUT');
  await a.period({ status: 'scheduled', publishAt });
  assert.equal(a.table('teamMessages').size, 0);
  assert.equal((await a.send(id(2), 'list')).periods.length, 0);
  assert.equal((await a.send(id(1), 'list')).periods[0].status, 'scheduled');
  await denied(a.send(id(2), 'get', { periodId: pid(1) }), 'NOT_FOUND');
  await denied(a.send(id(4), 'team', { periodId: pid(1) }), 'NOT_FOUND');
  const publish = require('../cloudfunctions/weeklyReport/publisher')(a.db, access, a.clock);
  assert.equal((await publish()).published, 0);
  a.time(Date.parse(publishAt + ':00+08:00'));
  assert.equal((await publish()).published, 1);
  assert.equal((await publish()).published, 0);
  assert.equal(a.table('teamMessages').size, 1);
  assert.equal(a.table('weeklyPeriods').get(pid(1)).status, 'open');
  assert.equal((await a.send(id(2), 'list')).periods.length, 1);
  assert.equal([...a.table('weeklyAudit').values()].filter(row => row.action === 'period.scheduledPublish').length, 1);
  await denied(a.period({ revision: 2, status: 'scheduled', publishAt: '2026-10-27T11:00' }), 'INVALID_INPUT');
});

test('timer rechecks the scheduling administrator and client-forged timer events never run the worker', async () => {
  const a = fixture();
  await a.period({ status: 'scheduled', publishAt: '2026-10-27T10:02' });
  a.table('teamMembers').set(id(1), active([]));
  a.time(Date.parse('2026-10-27T10:03:00+08:00'));
  const publish = require('../cloudfunctions/weeklyReport/publisher')(a.db, access, a.clock);
  assert.equal((await publish()).blocked, 1);
  assert.equal(a.table('weeklyPeriods').get(pid(1)).status, 'scheduled');
  assert.equal(a.table('teamMessages').size, 0);
  assert.match(a.table('weeklyPeriods').get(pid(1)).publishError, /权限/);
  let context = { APPID: access.APP_ID, OPENID: 'client' }, runs = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('cloudfunctions/weeklyPublish/index.js', 'utf8'), { module, exports: module.exports,
    require: name => name === 'wx-server-sdk' ? { init() {}, database: () => ({}), getWXContext: () => context } : name === './publisher' ? () => async () => { runs++; return { ok: true }; } : access });
  const event = { Type: 'Timer', TriggerName: 'weekly-publish-minute' };
  assert.equal((await module.exports.main(event)).code, 'TRIGGER_ONLY'); assert.equal(runs, 0);
  context = {};
  assert.equal((await module.exports.main({ action: 'publishDue' })).code, 'TRIGGER_ONLY');
  assert.equal((await module.exports.main(event)).ok, true); assert.equal(runs, 1);
});

test('scheduled publishing can be cancelled or moved without notifying members early', async () => {
  const a = fixture();
  await a.period({ status: 'scheduled', publishAt: '2026-10-27T10:02' });
  await a.period({ revision: 1, status: 'cancelled' });
  a.time(Date.parse('2026-10-27T10:03:00+08:00'));
  const publish = require('../cloudfunctions/weeklyReport/publisher')(a.db, access, a.clock);
  assert.equal((await publish()).published, 0);
  assert.equal((await a.send(id(2), 'list')).periods.length, 0);
  await a.period({ revision: 2, status: 'scheduled', publishAt: '2026-10-27T10:05' });
  assert.equal(a.table('teamMessages').size, 0);
  a.time(Date.parse('2026-10-27T10:05:00+08:00'));
  assert.equal((await publish()).published, 1);
  assert.equal(a.table('teamMessages').size, 1);
});

test('weekly document chooser accepts Word/PDF only; images fail server validation', async () => {
  const a = fixture(); await a.period();
  for (const name of ['report.jpg', 'report.png', 'report.xlsx']) await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name, size: 10 }), 'INVALID_FILE');
  let options;
  const p = component(uiService(), { chooseMessageFile: async value => { options = value; return { tempFiles: [] }; } });
  p.accept(uiResult(0, [])); await p.addFiles();
  assert.equal(options.type, 'file'); assert.deepEqual(Array.from(options.extension), ['doc', 'docx', 'pdf']);
  const code = fs.readFileSync('miniprogram/components/weekly-reports/index.js', 'utf8');
  assert.ok(!code.includes('chooseMedia')); assert.ok(!code.includes('拍照'));
});

test('file reports auto-save a draft, submit without approval, version replacements and hide private draft changes', async () => {
  const a = fixture(); await a.period();
  const f1 = await a.upload();
  let own = await saved(a, [f1.id]);
  assert.equal(own.report.status, 'draft'); assert.equal(own.report.revision, 1);
  assert.equal(a.table('weeklyVersions').size, 0);
  assert.equal((await saved(a, [f1.id])).report.revision, 1); // Lost autosave response retry.
  await denied(a.send(id(1), 'get', { periodId: pid(1), ownerId: id(2) }), 'NOT_FOUND');
  assert.equal((await a.send(id(1), 'team', { periodId: pid(1) })).rows[0].files.length, 0);
  own = await submitted(a, [f1.id], 1);
  assert.equal(own.report.status, 'submitted'); assert.equal(own.report.version, 1);
  assert.equal(a.table('weeklyVersions').size, 1);
  assert.equal((await submitted(a, [f1.id], 1)).report.revision, 2); // Idempotent submit.
  const f2 = await a.upload();
  own = await saved(a, [f2.id], 2, 2);
  assert.equal(own.report.status, 'submitted'); assert.equal(own.report.hasChanges, true);
  const team = await a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) });
  assert.equal(team.report.files[0].id, f1.id); assert.equal(team.report.hasChanges, false);
  await denied(a.send(id(4), 'download', { fileId: f2.id }), 'FORBIDDEN');
  await denied(a.send(id(4), 'downloadChunk', { fileId: f2.id, offset: 0 }), 'FORBIDDEN');
  await submitted(a, [f2.id], 3, 2);
  assert.equal(a.table('weeklyVersions').size, 2);
  assert.equal([...a.table('weeklyVersions').values()].find(v => v.version === 1).files[0].id, f1.id);
  const history = await a.send(id(4), 'get', { periodId: pid(1), ownerId: id(2) });
  assert.equal((await a.send(id(4), 'download', { fileId: f1.id, versionId: history.versions[1].id })).ok, true);
  const chunk = await a.send(id(4), 'downloadChunk', { fileId: f1.id, versionId: history.versions[1].id, offset: 0 });
  assert.match(Buffer.from(chunk.data, 'base64').toString(), /^%PDF-/); assert.equal(chunk.complete, true);
  await denied(a.send(id(3), 'get', { periodId: pid(1), ownerId: id(2) }), 'FORBIDDEN');
  await denied(saved(a, [], 0, 8), 'CONFLICT');
  // No approval documents or auto-read updates are part of report submission.
  assert.ok([...a.table('teamMessages').values()].every(m => !m.readBy.length));
});

test('uploads reject foreign IDs, unsupported content, pending files and crossed periods; finalized bytes are server-owned', async () => {
  const a = fixture(); await a.period();
  await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name: '../test.pdf', size: 10 }), 'INVALID_FILE');
  await denied(a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'test.pdf', size: 6 * 1024 * 1024 }), 'INVALID_FILE');
  await denied(a.upload(id(2), pid(1), Buffer.from('fake pdf')), 'INVALID_FILE');
  const p = await a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'test.pdf', size: 5 });
  await denied(saved(a, [p.id]), 'FORBIDDEN');
  const reads = a.reads;
  await denied(a.send(id(2), 'finishUpload', { fileId: p.id, fileID: 'cloud://other/private.pdf' }), 'FORBIDDEN');
  assert.equal(a.reads, reads);
  const f = await a.upload(); const record = a.table('weeklyFiles').get(f.id);
  assert.ok(!f.fileID); assert.notEqual(record.fileID, sourceId(record));
  a.objects.set(sourceId(record), Buffer.from('changed by uploader'));
  assert.match(a.objects.get(record.fileID).toString(), /^%PDF-/);
  await denied(a.send(id(3), 'saveDraft', { periodId: pid(1), revision: 0, requestId: token('wd', 1), fileIds: [f.id] }), 'FORBIDDEN');
  await a.period({ id: pid(2) });
  await denied(a.send(id(2), 'saveDraft', { periodId: pid(2), revision: 0, requestId: token('wd', 1), fileIds: [f.id] }), 'FORBIDDEN');
});

test('deadlines, late submission flags, archived periods and membership revocation apply on every write and file read', async () => {
  const a = fixture(); await a.period({ allowLateSubmit: false });
  const f = await a.upload(); await saved(a, [f.id]);
  a.time(Date.parse('2026-11-01T18:00:01+08:00'));
  await denied(submitted(a, [f.id], 1), 'DEADLINE');
  await a.period({ revision: 1, allowLateSubmit: true });
  const result = await submitted(a, [f.id], 1);
  assert.equal(result.report.late, true);
  await denied(saved(a, [], 2, 2), 'DEADLINE');
  await a.period({ revision: 2, allowLateEdit: true });
  await saved(a, [f.id], 2, 2);
  await a.period({ revision: 3, status: 'archived' });
  await denied(submitted(a, [f.id], 3, 2), 'CLOSED');
  a.table('teamMembers').set(id(2), { ...active([]), status: 'removed' });
  await denied(a.send(id(2), 'download', { fileId: f.id }), 'MEMBERSHIP_REQUIRED');
});

test('reminders are targeted and idempotent by China day; exporting produces safe CSV without draft attachments', async () => {
  const a = fixture(); await a.period();
  const f = await a.upload(); await saved(a, [f.id]);
  const result = await a.send(id(1), 'remind', { periodId: pid(1) });
  assert.equal(result.count, 2);
  const reminders = [...a.table('teamMessages')].filter(([, m]) => m.title === '周报提交提醒');
  reminders[0][1].readBy = [id(2)];
  await a.send(id(1), 'remind', { periodId: pid(1) });
  assert.equal(a.table('teamMessages').size, 2);
  assert.deepEqual(a.table('teamMessages').get(reminders[0][0]).readBy, [id(2)]);
  a.table('weeklyPeriods').get(pid(1)).roster[0].name = '=HYPERLINK("x")';
  const csv = await a.send(id(1), 'exportStats', { periodId: pid(1) });
  assert.ok(csv.name.endsWith('.csv')); assert.ok(csv.csv.startsWith('\uFEFF'));
  assert.match(csv.csv, /'=HYPERLINK/); assert.ok(!csv.csv.includes(f.name));
  await submitted(a, [f.id], 1);
  const stats = await a.send(id(1), 'team', { periodId: pid(1) });
  assert.equal(stats.submitted, 1); assert.equal(stats.total, 2);
});

test('member roster and period lists paginate rather than truncating at database default limits', async () => {
  const a = fixture();
  for (let n = 10; n < 151; n++) { a.table('teamMembers').set(id(n), active([])); a.table('userProfiles').set(id(n), { name: '成员' + n }); }
  assert.equal((await a.send(id(1), 'roster')).members.length, 146);
  for (let n = 1; n <= 25; n++) await a.period({ id: pid(n) });
  const first = await a.send(id(2), 'list'); assert.equal(first.periods.length, 20); assert.equal(first.hasMore, true);
  assert.equal((await a.send(id(2), 'list', { offset: first.nextOffset })).periods.length, 5);
});

test('backup file references point only to real immutable objects, including abandoned upload reservations', async () => {
  const a = fixture(); await a.period();
  await a.send(id(2), 'prepareUpload', { periodId: pid(1), name: 'abandoned.pdf', size: 99 });
  const file = await a.upload(); await saved(a, [file.id]); await submitted(a, [file.id], 1);
  function check(value) {
    if (typeof value === 'string' && value.startsWith('cloud://')) assert.ok(a.objects.has(value), 'backup must not reference missing staging files');
    else if (Array.isArray(value)) value.forEach(check);
    else if (value && typeof value === 'object') Object.values(value).forEach(check);
  }
  for (const name of ['weeklyFiles', 'weeklyReports', 'weeklyVersions', 'weeklyAudit']) [...a.table(name).values()].forEach(check);
});

function component(service, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/weekly-reports/index.js', 'utf8'), { Component: d => { definition = d; }, require: name => name === '../../utils/weekly-form' ? require('../miniprogram/utils/weekly-form') : service, wx, setTimeout, clearTimeout });
  const panel = { ...definition.methods, data: structuredClone(definition.data), properties: { initialPeriod: '' } };
  panel.setData = values => { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let object = panel.data; for (const part of parts.slice(0, -1)) object = object[part]; object[parts.at(-1)] = value; } };
  return panel;
}
const uiService = extra => ({ newId: prefix => token(prefix, 1), dateLabel: () => '2026-10-27 10:00', fileView: f => f, periodView: p => p, statusLabel: s => s, ...extra });
const uiResult = (revision, files, submitted = false) => ({ period: { id: pid(1), canEdit: true }, own: true, report: { revision, status: submitted ? 'submitted' : 'draft', files }, versions: [] });

test('weekly components use the server leader flag for list and detail and discard it after a role change', async () => {
  const p = component(uiService({ call: async () => ({ periods: [], nextOffset: 0, hasMore: false, isLeader: true, canReadTeam: true }) }));
  await p.loadList(); assert.equal(p.data.isLeader, true); assert.equal(p.data.canReadTeam, true);
  p.accept({ ...uiResult(1, [], true), own: false, isLeader: true, canReadTeam: true });
  assert.equal(p.data.own, false); assert.equal(p.data.isLeader, true);
  p.accept({ ...uiResult(1, [], true), isLeader: false, canReadTeam: false });
  assert.equal(p.data.isLeader, false); assert.equal(p.data.own, true);
});
test('upload and removal save drafts automatically with stable retry IDs and block submission while unsaved', async () => {
  let fail = true, draftCalls = 0, submitCalls = 0;
  const f = { id: token('wf', 1), name: 'report.pdf', size: 30 };
  const calls = [];
  const p = component(uiService({ upload: async () => f, call: async (action, data) => {
    calls.push([action, data]);
    if (action === 'saveDraft') { draftCalls++; if (fail) throw new Error('网络中断'); return uiResult(draftCalls, data.fileIds.map(id => ({ ...f, id }))); }
    submitCalls++; return uiResult(3, [f], true);
  } }), { chooseMessageFile: async () => ({ tempFiles: [{ name: f.name, size: 30, path: 'temp' }] }), showToast() {} });
  p.accept(uiResult(0, []));
  await p.addFiles(); assert.equal(draftCalls, 1); assert.equal(p.data.saveState, '自动保存失败');
  await p.submit(); assert.equal(submitCalls, 0);
  const requestId = p._unsaved.requestId;
  fail = false; await p.retrySave();
  assert.equal(calls[1][1].requestId, requestId); assert.equal(p.data.saveState, '已自动保存');
  await p.submit(); assert.equal(submitCalls, 1);
  await p.removeFile({ currentTarget: { dataset: { id: f.id } } });
  assert.equal(calls.at(-1)[0], 'saveDraft'); assert.equal(calls.at(-1)[1].fileIds.length, 0);
  assert.equal(p._unsaved, null);
});

test('rich autosave serializes edits, preserves the latest typing and submits the saved revision without a draft button', async t => {
  const calls = []; let release;
  const p = component(uiService({ call: async (action, payload) => {
    calls.push([action, structuredClone(payload)]);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { ...uiResult(payload.revision + 1, [], action === 'submit'), period: { id: pid(1), canEdit: true, schema: schema() }, report: { revision: payload.revision + 1, status: action === 'submit' ? 'submitted' : 'draft', files: [], answers: payload.answers } };
  } }), { showToast() {} });
  t.after(() => clearTimeout(p._draftTimer));
  p.accept({ ...uiResult(0, []), period: { id: pid(1), canEdit: true, schema: schema() } });
  p.answersChange({ detail: { answers: { body: text('第一版'), hours: 1 } } });
  const saving = p.flushForm();
  p.answersChange({ detail: { answers: { body: text('继续输入的内容'), hours: 2 } } });
  release(); await saving;
  while (p._formSave) await p._formSave;
  assert.equal(p.data.answers.body.ops[0].insert, '继续输入的内容\n');
  assert.equal(calls.filter(([action]) => action === 'saveDraft').length, 2);
  assert.equal(calls[1][1].revision, 1);
  await p.submit();
  assert.equal(calls.at(-1)[0], 'submit'); assert.equal(calls.at(-1)[1].revision, 2);
  assert.equal(calls.at(-1)[1].answers.hours, 2);
});

test('rich autosave retries lost responses with the same ID and allows correction after validation errors', async t => {
  let failure = 'network'; const requests = [];
  const p = component(uiService({ call: async (_action, payload) => {
    requests.push(structuredClone(payload));
    if (failure) { const e = new Error('保存失败'); if (failure === 'invalid') e.code = 'INVALID_FORM'; throw e; }
    return { ...uiResult(1, []), period: { id: pid(1), canEdit: true, schema: schema() }, report: { revision: 1, files: [], status: 'draft', answers: payload.answers } };
  } }));
  t.after(() => clearTimeout(p._draftTimer));
  p.accept({ ...uiResult(0, []), period: { id: pid(1), canEdit: true, schema: schema() } });
  p.answersChange({ detail: { answers: { body: text('输入'), hours: 1 } } }); await p.flushForm();
  const token = p._formPending.requestId;
  failure = ''; await p.retrySave(); assert.equal(requests.at(-1).requestId, token);
  failure = 'invalid'; p.answersChange({ detail: { answers: { body: text('字'.repeat(101)), hours: 1 } } }); await p.flushForm();
  assert.equal(p._formPending, null);
  failure = ''; p.answersChange({ detail: { answers: { body: text('已修正'), hours: 1 } } }); await p.flushForm();
  assert.equal(p.data.saveState, '已自动保存'); assert.equal(p.data.answers.body.ops[0].insert, '已修正\n');
});

test('new component and module routes are complete without new native pages or a save-draft button', () => {
  const template = fs.readFileSync('miniprogram/components/weekly-reports/index.wxml', 'utf8');
  assert.ok(!template.includes('保存草稿')); assert.ok(template.includes('表单模板'));
  const pages = JSON.parse(fs.readFileSync('miniprogram/app.json')).pages;
  assert.ok(!pages.some(p => p.includes('weekly')));
  assert.equal(fs.readFileSync('cloudfunctions/weeklyReport/access.js', 'utf8'), fs.readFileSync('cloudfunctions/_shared/access.js', 'utf8'));
});

test('storage caps bytes before buffering and rejects partial large objects instead of freezing truncated uploads', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const fileID = 'cloud://private/upload.pdf';
  const storage = require('../cloudfunctions/weeklyReport/storage')({
    getTempFileURL: async () => ({ fileList: [{ fileID, status: 0, tempFileURL: 'https://private.example/signed' }] })
  });
  const bytes = Buffer.from('%PDF-1.7\nreport');
  let options;
  global.fetch = async (url, config) => { options = config; return new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-14/' + bytes.length, 'content-length': String(bytes.length) } }); };
  assert.deepEqual(await storage.read(fileID), bytes);
  assert.equal(options.headers.Range, 'bytes=0-5242880'); assert.equal(options.redirect, 'error');
  global.fetch = async () => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-14/9999999' } });
  await assert.rejects(storage.read(fileID), /Incomplete upload/);
  global.fetch = async () => new Response(bytes, { headers: { 'content-length': '9999999' } });
  await assert.rejects(storage.read(fileID), /file limit/);
});

test('client falls back to authorized cloud chunks when download domains are unavailable and cleans partial files', async () => {
  let fail = false, output = Buffer.alloc(0), removed = 0, calls = 0;
  const fileId = token('wf', 1), bytes = Buffer.from('%PDF-1.7\nreport');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('miniprogram/services/weekly.js', 'utf8'), { module, require: () => ({ weeklyFunction: 'weeklyReport' }),
    getApp: () => ({ globalData: { cloudReady: true } }), wx: {
      env: { USER_DATA_PATH: 'test' }, base64ToArrayBuffer: value => { const b = Buffer.from(value, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
      downloadFile: async () => { throw { errMsg: 'url not in domain list' }; },
      cloud: { callFunction: async ({ data }) => {
        if (data.action === 'download') return { result: { ok: true, url: 'https://private.example/signed', file: { id: fileId, name: 'report.pdf', size: bytes.length, ext: 'pdf' } } };
        calls++; if (fail) return { result: { ok: false, code: 'MEMBERSHIP_REQUIRED', message: '权限已失效' } };
        return { result: { ok: true, data: bytes.toString('base64'), nextOffset: bytes.length, total: bytes.length, complete: true } };
      } },
      getFileSystemManager: () => ({ writeFile: options => { output = Buffer.alloc(0); options.success(); }, appendFile: options => { output = Buffer.concat([output, Buffer.from(options.data)]); options.success(); }, unlink: options => { removed++; options.success(); } })
    } });
  const result = await module.exports.download(fileId);
  assert.equal(result.ext, 'pdf'); assert.deepEqual(output, bytes); assert.equal(calls, 1);
  fail = true; await assert.rejects(module.exports.download(fileId), /权限已失效/); assert.equal(removed, 1);
});
