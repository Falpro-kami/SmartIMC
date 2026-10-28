const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function component(name, deps = {}, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync('miniprogram/components/' + name + '/index.js', 'utf8'), { Component: value => { definition = value; }, require: name => deps[name] || {}, wx });
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
