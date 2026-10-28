// Store a small, validated Delta document, never client-supplied HTML or temporary URLs.
const types = ['text', 'number', 'date', 'single', 'multiple', 'attachment'];
const fid = value => typeof value === 'string' && /^wf_[a-f0-9]{32}$/.test(value);
const key = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(value);
function fail(message) { const error = new Error(message); error.businessCode = 'INVALID_FORM'; throw error; }
function name(value, limit = 60) { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) fail('请检查分区和字段名称。'); return value.trim(); }
function integer(value, low, high, fallback) { const n = value === undefined ? fallback : value; if (!Number.isSafeInteger(n) || n < low || n > high) fail('字段限制超出允许范围。'); return n; }
function schema(value) {
  if (!value || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > 10) fail('请设置1至10个分区。');
  const ids = new Set(); let count = 0;
  const unique = id => { if (!key(id) || ids.has(id)) fail('分区或字段标识重复。'); ids.add(id); return id; };
  if (value.sections.some(s => !s || typeof s !== 'object')) fail('分区格式不正确。');
  return { sections: value.sections.map(section => ({ id: unique(section.id), title: name(section.title), fields: (() => {
    if (!Array.isArray(section.fields) || !section.fields.length || (count += section.fields.length) > 30) fail('每个分区至少有一个字段，合计不超过30个。');
    return section.fields.map(f => {
      if (!f || typeof f !== 'object') fail('字段格式不正确。');
      if (!types.includes(f.type) || !['full', 'half'].includes(f.width || 'full') || typeof f.required !== 'boolean') fail('字段类型或填写规则不正确。');
      const result = { id: unique(f.id), label: name(f.label), type: f.type, required: f.required, width: f.width || 'full' };
      if (f.type === 'text') result.maxLength = integer(f.maxLength, 1, 10000, 5000);
      if (['single', 'multiple'].includes(f.type)) {
        if (!Array.isArray(f.options) || !f.options.length || f.options.length > 30) fail('请选择1至30个选项。');
        result.options = f.options.map(option => name(option, 80));
        if (new Set(result.options).size !== result.options.length) fail('选项不能重复。');
      }
      if (f.type === 'attachment') { result.maxCount = integer(f.maxCount, 1, 5, 5); result.maxSizeMB = integer(f.maxSizeMB, 1, 5, 5); }
      return result;
    });
  })() })) };
}
function delta(value, limit) {
  if (!value || !Array.isArray(value.ops) || value.ops.length > 3000 || JSON.stringify(value).length > 200000) fail('文本内容过长。');
  let text = '', images = 0;
  const ops = value.ops.map(op => {
    if (!op || typeof op !== 'object') fail('文本格式不正确。');
    const out = {};
    if (typeof op.insert === 'string') { text += op.insert; out.insert = op.insert; }
    else if (op.insert && typeof op.insert.image === 'string' && /^imc-image:wf_[a-f0-9]{32}$/.test(op.insert.image)) {
      if (++images > 10) fail('每个文本框最多插入10张图片。'); out.insert = { image: op.insert.image };
    } else fail('文本包含不支持的内容或图片。');
    if (op.attributes) {
      const attrs = {};
      for (const [k, v] of Object.entries(op.attributes)) {
        if (['bold', 'italic', 'underline', 'strike'].includes(k) && typeof v === 'boolean') attrs[k] = v;
        if (k === 'header' && [1, 2, 3].includes(v)) attrs[k] = v;
        if (k === 'list' && ['ordered', 'bullet', 'check'].includes(v)) attrs[k] = v;
        if (k === 'align' && ['left', 'center', 'right', 'justify'].includes(v)) attrs[k] = v;
        if (k === 'indent' && Number.isSafeInteger(v) && v >= 0 && v <= 8) attrs[k] = v;
        if (['color', 'background'].includes(k) && typeof v === 'string' && /^#[a-fA-F0-9]{6}$/.test(v)) attrs[k] = v;
      }
      if (Object.keys(attrs).length) out.attributes = attrs;
    }
    return out;
  });
  if (text.replace(/\n$/, '').length > limit) fail('文本超过字段字数限制。');
  return { ops };
}
function answers(definition, input, submit = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 500000) fail('表单内容不正确。');
  const result = {}, files = [], imageFields = {};
  const fields = definition.sections.flatMap(section => section.fields);
  if (Object.keys(input).some(id => !fields.some(f => f.id === id))) fail('表单字段已变更，请重新打开。');
  for (const field of fields) {
    const value = input[field.id]; let empty = value === undefined || value === null || value === '';
    if (empty) { if (submit && field.required) fail('请填写“' + field.label + '”。'); continue; }
    if (field.type === 'text') {
      result[field.id] = delta(value, field.maxLength);
      const images = result[field.id].ops.filter(op => typeof op.insert !== 'string').map(op => op.insert.image.slice(10));
      files.push(...images); images.forEach(id => { if (imageFields[id] && imageFields[id] !== field.id) fail('图片不能跨字段复用。'); imageFields[id] = field.id; });
      empty = !images.length && !result[field.id].ops.some(op => typeof op.insert === 'string' && op.insert.trim());
    } else if (field.type === 'attachment') {
      if (!Array.isArray(value) || value.length > field.maxCount || value.some(id => !fid(id)) || new Set(value).size !== value.length) fail('请检查“' + field.label + '”附件数量。');
      result[field.id] = value; files.push(...value); empty = !value.length;
    } else if (field.type === 'number') {
      if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e15) fail('请检查“' + field.label + '”数字。');
      result[field.id] = Number(value);
    } else if (field.type === 'date') {
      if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('请检查“' + field.label + '”日期。');
      result[field.id] = value;
    } else if (field.type === 'single') {
      if (!field.options.includes(value)) fail('请选择有效选项。'); result[field.id] = value;
    } else {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(option => !field.options.includes(option))) fail('请选择有效选项。');
      result[field.id] = value; empty = !value.length;
    }
    if (submit && field.required && empty) fail('请填写“' + field.label + '”。');
  }
  if (new Set(files).size > 50) fail('表单附件和图片合计最多50个。');
  return { values: result, fileIds: [...new Set(files)], imageFields };
}
module.exports = { schema, answers, types };
