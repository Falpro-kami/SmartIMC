const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function component(name, deps = {}, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/' + name + '/index.js', 'utf8'), { Component: value => { definition = value; }, require: name => name === '../../utils/weekly-form' ? require('../miniprogram/utils/weekly-form') : deps[name] || {}, wx });
  return { ...definition.methods, data: structuredClone(definition.data), properties: {}, events: [],
    setData(values) { for (const [key, value] of Object.entries(values)) { const parts = key.split('.'); let obj = this.data; for (const key of parts.slice(0, -1)) obj = obj[key]; obj[parts.at(-1)] = value; } },
    triggerEvent(name, detail) { this.events.push({ name, detail }); } };
}
const fid = 'wf_' + 'a'.repeat(32);
test('native editor round trips portable image IDs, keeps the caret on saved echoes and strips editor-local metadata', () => {
  const p = component('weekly-editor'); let renders = 0;
  p.properties = { value: { ops: [{ insert: '正文\n' }, { insert: { image: 'imc-image:' + fid } }] }, imageUrls: { [fid]: 'https://private.example/old' }, maxLength: 5000 };
  p._editor = { setContents({ delta }) { renders++; assert.equal(delta.ops[1].insert.image, 'https://private.example/old'); } };
  p.renderValue(); p.renderValue(); assert.equal(renders, 1);
  p.properties.imageUrls[fid] = 'https://private.example/renewed'; p.renderValue();
  p.input({ detail: { delta: { ops: [{ insert: '正文\n' }, { insert: { image: 'https://private.example/old' }, attributes: { 'data-local': 'wxfile://temp', bold: true } }] } } });
  const value = p.events.at(-1).detail.value;
  assert.equal(value.ops[1].insert.image, 'imc-image:' + fid);
  assert.ok(!JSON.stringify(value).includes('https://')); assert.ok(!JSON.stringify(value).includes('wxfile://'));
  p.properties.value = value; p.renderValue(); assert.equal(renders, 1);
  p.properties.readonly = true; p.input({ detail: { delta: { ops: [] } } }); assert.equal(p.events.length, 1);
});
test('insert image uploads into its own field and emits a stable ID rather than a temporary URL', async () => {
  let content, uploaded;
  const p = component('weekly-editor', { '../../services/weekly': {
    upload: async (file, period, field, kind) => { uploaded = { file, period, field, kind }; return { id: fid }; },
    call: async () => ({ url: 'https://private.example/image' })
  } }, { chooseMedia: async () => ({ tempFiles: [{ tempFilePath: 'wxfile://image', size: 2048 }] }), getImageInfo: async () => ({ type: 'png' }) });
  p.properties = { value: { ops: [] }, imageUrls: {}, periodId: 'period', fieldId: 'body', maxLength: 5000 };
  p._editor = { insertImage(options) { content = { ops: [{ insert: { image: options.src } }, { insert: '\n' }] }; options.success(); }, getContents(options) { options.success({ delta: content }); } };
  await p.image();
  assert.equal(uploaded.field, 'body'); assert.equal(uploaded.kind, 'image');
  assert.equal(p.events.find(event => event.name === 'change').detail.value.ops[0].insert.image, 'imc-image:' + fid);
  assert.equal(p.events[0].detail.value, true); assert.equal(p.events.at(-1).detail.value, false);
  assert.equal(p.data.uploading, false);
});
test('rich formatting toggles native editor selection and readonly fields cannot be changed', () => {
  const p = component('weekly-editor'); const calls = [];
  p._editor = { format: (...args) => calls.push(args) };
  p.format({ currentTarget: { dataset: { name: 'bold' } } }); assert.equal(calls[0][1], true);
  p.data.formats.header = 2;
  p.format({ currentTarget: { dataset: { name: 'header', value: 2 } } }); assert.equal(calls[1][1], false);
  p.properties.readonly = true; p.format({ currentTarget: { dataset: { name: 'bold' } } }); assert.equal(calls.length, 2);
});
test('programmatic editor echoes do not trigger a save loop, including image sizing and unsupported default styles', () => {
  const p = component('weekly-editor');
  p.properties = { value: { ops: [{ insert: '正文\n' }, { insert: { image: 'imc-image:' + fid } }] }, imageUrls: { [fid]: 'https://private.example/image' }, maxLength: 5000 };
  p._editor = { setContents({ delta }) { p.input({ detail: { delta: { ops: delta.ops.map(op => ({ ...op, attributes: { ...op.attributes, fontSize: '16px', 'data-local': 'temporary' } })) } } }); } };
  p.renderValue(); assert.equal(p.events.length, 0);
});
test('form fields display zero values and multi-select labels without WXML method calls', () => {
  const p = component('weekly-fields', { '../../services/weekly': { fileView: f => f } });
  p.properties = { schema: { sections: [{ id: 's', title: '分区', fields: [{ id: 'n', type: 'number' }, { id: 'm', type: 'multiple', options: ['研究', '实验'] }] }] }, answers: { n: 0, m: ['研究', '实验'] }, files: [] };
  p.build(); assert.equal(p.data.sections[0].fields[0].displayValue, 0); assert.equal(p.data.sections[0].fields[1].displayValue, '研究、实验');
  assert.ok(!fs.readFileSync('miniprogram/components/weekly-fields/index.wxml', 'utf8').includes('.join('));
  const types = require('../miniprogram/utils/weekly-form'); assert.deepEqual(types.labels, ['文本', '数字', '日期', '单选', '多选', '附件']);
});

test('required fields are always open, only optional fields toggle, and unchecked drafts can be restored during the same edit', () => {
  const p = component('weekly-fields');
  p.properties = { schema: { sections: [{ id: 's', title: '项目工作进展', fields: [{ id: 'must', label: '本周工作', required: true, type: 'text' }, { id: 'optional', label: '其他工作', required: false, type: 'text' }] }] }, answers: { optional: { ops: [{ insert: '已有内容\n' }] } }, selectedFields: ['optional'], files: [] };
  p.build(); assert.equal(p.data.sections[0].titleLabel, '1. 项目工作进展');
  assert.equal(p.data.sections[0].fields[0].enabled, true); assert.equal(p.data.sections[0].fields[1].labelLabel, '（2）其他工作');
  p.toggle({ currentTarget: { dataset: { id: 'must' } }, detail: { value: [] } }); assert.equal(p.events.length, 0);
  p.toggle({ currentTarget: { dataset: { id: 'optional' } }, detail: { value: [] } });
  assert.equal(p.events[0].detail.answers.optional, undefined); assert.equal(p.events[0].detail.selectedFields.length, 0);
  p.properties.answers = p.events[0].detail.answers; p.properties.selectedFields = [];
  p.toggle({ currentTarget: { dataset: { id: 'optional' } }, detail: { value: ['optional'] } });
  assert.equal(p.events[1].detail.answers.optional.ops[0].insert, '已有内容\n');
  p.properties.readonly = true; p.toggle({ currentTarget: { dataset: { id: 'optional' } }, detail: { value: [] } }); assert.equal(p.events.length, 2);
});

test('reader hides unfilled siblings, retains numeric zero/images and collapses an empty root to one 无', () => {
  const p = component('weekly-fields'); const fields = ['text', 'number', 'date', 'single', 'multiple', 'attachment'].map((type, i) => ({ id: 'f' + i, label: type, type, required: false, options: ['A'] }));
  fields.push({ id: 'image', label: '图片', type: 'text', required: false });
  p.properties = { schema: { sections: [{ id: 's', title: '1. 实验室工作', fields }] }, answers: { f0: { ops: [{ insert: '  \n' }] }, f1: 0, f4: [], image: { ops: [{ insert: { image: 'imc-image:' + fid } }] } }, selectedFields: ['f0', 'f1', 'f4', 'image'], files: [], readonly: true };
  p.build(); const result = p.data.sections[0].fields;
  assert.equal(result.length, 2); assert.equal(p.data.sections[0].titleLabel, '1. 实验室工作');
  assert.equal(result[0].id, 'f1'); assert.equal(result[0].displayValue, 0); assert.equal(result[1].id, 'image');
  p.properties.answers = {}; p.properties.selectedFields = []; p.build(); assert.equal(p.data.sections[0].empty, true); assert.equal(p.data.sections[0].fields.length, 0);
  const wxml = fs.readFileSync('miniprogram/components/weekly-fields/index.wxml', 'utf8'); assert.ok(wxml.includes('>无</text>'));
  assert.ok(!fs.readFileSync('miniprogram/components/weekly-template/index.wxml', 'utf8').includes('并排展示'));
  assert.ok(!fs.readFileSync('miniprogram/components/weekly-fields/index.wxss', 'utf8').includes('.half'));
});

test('multilevel selection affects leaves only and activates every ancestor while reading retains only filled branches', () => {
  const model = require('../miniprogram/utils/weekly-form');
  const text = (id, label) => ({ id, label, type: 'text', required: false });
  const schema = { sections: [{ id: 'project', title: '项目工作进展', fields: [{ id: 'work', label: '本周工作汇报', type: 'group', children: [text('done', '已完成工作'), { id: 'deep', label: '研究工作', type: 'group', children: [text('experiment', '实验分析'), text('paper', '论文阅读')] }] }, text('plan', '下周工作规划')] }, { id: 'lab', title: '实验室工作', fields: [text('teaching', '助教工作')] }] };
  const answers = { experiment: { ops: [{ insert: '完成实验分析。\n' }] }, plan: { ops: [{ insert: '未勾选的旧草稿\n' }] } };
  const edit = model.view(schema, answers, ['experiment']);
  assert.equal(edit[0].enabled, true); assert.equal(edit[1].enabled, false);
  assert.deepEqual(edit[0].fields.filter(f => f.isGroup && f.enabled).map(f => f.id), ['work', 'deep']);
  assert.deepEqual(edit[0].fields.filter(f => !f.isGroup && f.enabled).map(f => f.id), ['experiment']);
  const read = model.view(schema, answers, ['experiment'], true);
  assert.deepEqual(read[0].fields.map(f => f.id), ['work', 'deep', 'experiment']);
  assert.equal(read[1].empty, true); assert.equal(read[1].fields.length, 0);
  assert.equal(read[0].fields[2].labelLabel, '1.1.2.1 实验分析');
  const outline = model.view(schema, {}, [], true, true);
  assert.equal(outline[0].fields.length, edit[0].fields.length, 'structure preview retains the full hierarchy');
});

test('template editor can subdivide, reorder, promote/demote and remove whole branches without changing leaf IDs', async () => {
  const model = require('../miniprogram/utils/weekly-form'), schema = model.defaults();
  const p = component('weekly-template', { '../../services/weekly': { call: async () => ({ templates: [{ id: 'template', name: '周报', schema }] }) } });
  p.properties = { editId: 'template' }; await p.load();
  const original = p.data.editing.schema.sections[0].fields[0].id;
  const tap = path => ({ currentTarget: { dataset: { path } } });
  p.addChild(tap('0.0')); assert.equal(p.data.editing.schema.sections[0].fields[0].type, 'group');
  assert.equal(p.data.editing.schema.sections[0].fields[0].children[0].id, original);
  p.addChild(tap('0.0.0')); assert.equal(p.data.editorSections[0].editorRows[2].level, 4);
  p.demote(tap('0.1')); assert.equal(p.data.editing.schema.sections[0].fields[0].children.length, 2);
  p.promote(tap('0.0.1')); assert.equal(p.data.editing.schema.sections[0].fields[1].id, 'plan');
  p.moveField({ currentTarget: { dataset: { path: '0.1', step: -1 } } }); assert.equal(p.data.editing.schema.sections[0].fields[0].id, 'plan');
  p.removeField(tap('0.1')); assert.deepEqual(Array.from(model.fields(p.data.editing.schema), f => f.id), ['plan', 'attachments']);
});

test('optional instructions survive template edits and expand independently of leaf selection', async () => {
  const model = require('../miniprogram/utils/weekly-form'), schema = model.defaults();
  const p = component('weekly-template', { '../../services/weekly': { call: async () => ({ templates: [{ id: 'template', name: '周报', schema }] }) } });
  p.properties = { editId: 'template' }; await p.load();
  p.rootInput({ currentTarget: { dataset: { section: 0, key: 'help' } }, detail: { value: '介绍项目背景\n说明本周目标' } });
  p.fieldInput({ currentTarget: { dataset: { path: '0.0', key: 'help' } }, detail: { value: '请说明实验过程和结果。' } });
  p.type({ currentTarget: { dataset: { path: '0.0' } }, detail: { value: 1 } });
  assert.equal(p.data.editing.schema.sections[0].fields[0].help, '请说明实验过程和结果。');
  p.addChild({ currentTarget: { dataset: { path: '0.0' } } });
  const group = p.data.editing.schema.sections[0].fields[0];
  assert.equal(group.help, '请说明实验过程和结果。'); assert.equal(group.children[0].help, '');
  p.preview(); assert.equal(p.events.at(-1).detail.schema.sections[0].help, '介绍项目背景\n说明本周目标');
  const fill = component('weekly-fields');
  fill.properties = { schema: p.data.editing.schema, answers: {}, selectedFields: [], files: [] };
  fill.build();
  const tap = { currentTarget: { dataset: { id: group.id } } };
  fill.toggleHelp(tap); assert.equal(fill.data.helpOpen[group.id], true);
  assert.equal(fill.events.length, 0, 'reading instructions must not change answers or selection');
  fill.toggleHelp(tap); assert.equal(fill.data.helpOpen[group.id], false);
  fill.properties.readonly = true; fill.toggleHelp(tap); assert.equal(fill.data.helpOpen[group.id], false);
  fill.properties.outline = true; fill.toggleHelp(tap); assert.equal(fill.data.helpOpen[group.id], true);
});
