const types = ['text', 'number', 'date', 'single', 'multiple', 'attachment'];
const labels = ['文本', '数字', '日期', '单选', '多选', '附件'];
const unique = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
function field(type = 'text') { return { id: unique('field_'), label: labels[types.indexOf(type)], type, required: false, width: 'full', maxLength: 5000, options: ['选项一', '选项二'], optionsText: '选项一\n选项二', maxCount: 5, maxSizeMB: 5 }; }
function defaults() { return { sections: [{ id: 'work', title: '工作汇报', fields: [
  { ...field(), id: 'progress', label: '本周工作', required: true },
  { ...field(), id: 'plan', label: '下周计划', required: true },
  { ...field('attachment'), id: 'attachments', label: '附件' }
] }] }; }
module.exports = { types, labels, unique, field, defaults };
