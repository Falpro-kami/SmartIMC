const types = ['text', 'number', 'date', 'single', 'multiple', 'attachment'];
const labels = ['文本', '数字', '日期', '单选', '多选', '附件'];
const unique = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
function field(type = 'text') { return { id: unique('field_'), label: labels[types.indexOf(type)], type, required: false, help: '', maxLength: 5000, options: ['选项一', '选项二'], optionsText: '选项一\n选项二', maxCount: 5, maxSizeMB: 5 }; }
function defaults() { return { sections: [{ id: 'work', title: '工作汇报', fields: [
  { ...field(), id: 'progress', label: '本周工作', required: true },
  { ...field(), id: 'plan', label: '下周计划', required: true },
  { ...field('attachment'), id: 'attachments', label: '附件' }
] }] }; }
function selected(schema, answers = {}, ids) {
  const optional = fields(schema).filter(f => !f.required && !f.root).map(f => f.id);
  return optional.filter(id => Array.isArray(ids) ? ids.includes(id) : Object.prototype.hasOwnProperty.call(answers, id));
}
function empty(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return !value.length;
  if (value && Array.isArray(value.ops)) return !value.ops.some(op => typeof op.insert === 'string' ? op.insert.trim() : op.insert && op.insert.image);
  return false;
}
function heading(label, index, depth = 1, path = []) {
  const clean = String(label || '').replace(/^\s*(?:\d+[.、．]\s*|[（(]\d+[)）]\s*)/, '');
  if (depth === true) depth = 2;
  return (depth > 2 ? path.map(i => i + 1).join('.') + ' ' : depth === 2 ? '（' + (index + 1) + '）' : (index + 1) + '. ') + clean;
}
function fields(schema) {
  const visit = nodes => (nodes || []).flatMap(node => node.type === 'group' ? visit(node.children) : [node]);
  return (schema && schema.sections || []).flatMap(s => s.fields.length ? visit(s.fields) : [{ ...s, label: s.title, type: 'text', root: true }]);
}
function editorSections(schema) {
  function rows(nodes, parent) {
    return (nodes || []).flatMap((node, index) => {
      const path = parent.concat(index), level = path.length, isGroup = node.type === 'group';
      return [{ ...node, path: path.join('.'), level, indent: Math.min(36, (level - 2) * 12), isGroup, titleLabel: heading(node.label, index, level, path), optionsText: (node.options || []).join('\n') }, ...(isGroup ? rows(node.children, path) : [])];
    });
  }
  return (schema && schema.sections || []).map((section, index) => ({ ...section, index, titleLabel: heading(section.title, index), editorRows: rows(section.fields, [index]) }));
}
function view(schema, answers = {}, selectedFields, readonly = false, outline = false) {
  const chosen = selected(schema, answers, selectedFields);
  function node(f, index, parent) {
    const path = parent.concat(index), level = path.length, isGroup = f.type === 'group';
    const base = { ...f, isGroup, level, indent: Math.min(36, (level - 2) * 12), labelLabel: heading(f.label, index, level, path) };
    if (isGroup) {
      const children = (f.children || []).map((child, i) => node(child, i, path));
      const enabled = children.some(c => c.enabled), filled = children.some(c => c.filled);
      return { enabled, filled, rows: readonly && !outline && !filled ? [] : [{ ...base, enabled, empty: !filled }, ...children.flatMap(c => c.rows)] };
    }
    const value = answers[f.id], enabled = f.required || f.root || chosen.includes(f.id), blank = empty(value), filled = enabled && !blank;
    const row = { ...base, enabled, empty: !filled, value: value === undefined ? '' : value,
      displayValue: Array.isArray(value) ? value.join('、') : blank ? '无' : value, delta: value || { ops: [{ insert: '\n' }] },
      optionsView: (f.options || []).map(option => ({ label: option, checked: f.type === 'multiple' ? (value || []).includes(option) : value === option })) };
    return { enabled, filled, rows: readonly && !outline && !filled ? [] : [row] };
  }
  return (schema && schema.sections || []).map((s, index) => {
    const children = s.fields.length ? s.fields.map((f, i) => node(f, i, [index])) : [node({ ...s, label: s.title, type: 'text', root: true }, 0, [index])];
    const filled = children.some(c => c.filled);
    return { ...s, titleLabel: heading(s.title, index), enabled: children.some(c => c.enabled), empty: !filled,
      fields: readonly && !outline && !filled ? [] : children.flatMap(c => c.rows) };
  });
}
module.exports = { types, labels, unique, field, defaults, selected, empty, heading, fields, editorSections, view };
