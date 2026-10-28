const weekly = require('../../services/weekly');
const model = require('../../utils/weekly-form');
function locate(sections, path) {
  if (!Array.isArray(path) || path.length < 2 || path.some(i => !Number.isInteger(i) || i < 0) || !sections[path[0]]) return null;
  let list = sections[path[0]].fields;
  for (const index of path.slice(1, -1)) { if (!list[index] || list[index].type !== 'group') return null; list = list[index].children; }
  const index = path[path.length - 1]; return list[index] ? { list, index, node: list[index] } : null;
}
function depth(node) { return node.type === 'group' && node.children.length ? 1 + Math.max(...node.children.map(depth)) : 1; }
Component({
  properties: { choose: Boolean, editId: String },
  data: { templates: [], loading: true, busy: false, error: '', editing: null, editorSections: [], types: model.labels },
  lifetimes: { attached() { this.load(); }, detached() { this._detached = true; } },
  pageLifetimes: { show() { if (!this.properties.editId) this.load(); } },
  methods: {
    async load() {
      if (this._loading) return;
      this._loading = true; this.setData({ loading: true, error: '' });
      try {
        const r = await weekly.call('templates', {}, true);
        if (this._detached) return;
        this.setData({ templates: r.templates });
        if (this.properties.editId && !this._loaded) {
          const found = this.properties.editId === 'new' ? { id: weekly.newId('wt'), revision: 0, name: '', schema: model.defaults() } : r.templates.find(t => t.id === this.properties.editId);
          if (!found) throw new Error('模板不存在，请返回后重新打开。');
          const editing = JSON.parse(JSON.stringify(found));
          editing.schema.sections.forEach(s => s.fields.forEach(f => { f.optionsText = (f.options || []).join('\n'); }));
          this.setData({ editing });
          this.buildSections();
        }
        this._loaded = true;
      } catch (e) { if (!this._detached) this.setData({ error: e.message }); }
      finally { this._loading = false; if (!this._detached) this.setData({ loading: false }); }
    },
    newTemplate() { this.triggerEvent('edit', { id: 'new' }); },
    edit(e) { const t = this.data.templates.find(t => t.id === e.currentTarget.dataset.id); if (t) this.triggerEvent('edit', { id: t.id }); },
    chooseTemplate(e) { const t = this.data.templates.find(t => t.id === e.currentTarget.dataset.id); if (t) this.triggerEvent('select', t); },
    name(e) { this.setData({ 'editing.name': e.detail.value }); },
    buildSections() { this.setData({ editorSections: model.editorSections(this.data.editing && this.data.editing.schema) }); },
    preview() { if (!this.data.busy && this.data.editing) this.triggerEvent('preview', JSON.parse(JSON.stringify({ name: this.data.editing.name, schema: this.data.editing.schema }))); },
    mutate(e, callback) {
      if (this.data.busy || !this.data.editing) return;
      const sections = JSON.parse(JSON.stringify(this.data.editing.schema.sections));
      const { section, field } = e.currentTarget.dataset;
      callback(sections, Number(section), Number(field));
      this.setData({ 'editing.schema.sections': sections });
      this.buildSections();
    },
    node(e, callback) { this.mutate(e, (sections, i, j) => { const path = e.currentTarget.dataset.path ? e.currentTarget.dataset.path.split('.').map(Number) : [i, j]; const found = locate(sections, path); if (found) callback(found, path, sections); }); },
    sectionInput(e) { this.mutate(e, (s, i) => { s[i].title = e.detail.value; }); },
    fieldInput(e) { const key = e.currentTarget.dataset.key; this.node(e, ({ node }) => {
      let value = e.detail.value;
      if (['maxLength', 'maxCount', 'maxSizeMB'].includes(key)) value = Number(value);
      if (key === 'options') value = value.split('\n');
      node[key] = value;
    }); },
    rootInput(e) { this.mutate(e, (s, i) => { const key = e.currentTarget.dataset.key; if (['required', 'maxLength', 'help'].includes(key)) s[i][key] = key === 'maxLength' ? Number(e.detail.value) : e.detail.value; }); },
    addSection() { const s = this.data.editing.schema.sections; if (s.length < 10) { this.setData({ 'editing.schema.sections': s.concat({ id: model.unique('section_'), title: '新分区', fields: [model.field()] }) }); this.buildSections(); } },
    removeSection(e) { this.mutate(e, (s, i) => { s.splice(i, 1); }); },
    moveSection(e) { this.mutate(e, (s, i) => { const target = i + Number(e.currentTarget.dataset.step); if (target >= 0 && target < s.length) [s[i], s[target]] = [s[target], s[i]]; }); },
    addField(e) { this.mutate(e, (s, i) => { if (model.fields({ sections: s }).length < 30 || !s[i].fields.length) s[i].fields.push(model.field()); }); },
    addChild(e) { this.node(e, ({ list, index, node }, path, sections) => {
      if (path.length >= 6) { this.setData({ error: '标题最多支持6级。' }); return; }
      if (node.type === 'group') { if (model.fields({ sections }).length < 30) node.children.push(model.field()); }
      else list[index] = { id: model.unique('group_'), label: node.label, help: node.help || '', type: 'group', children: [{ ...node, label: '内容', help: '' }] };
    }); },
    removeField(e) { this.node(e, ({ list, index }) => { list.splice(index, 1); }); },
    moveField(e) { this.node(e, ({ list, index }) => { const target = index + Number(e.currentTarget.dataset.step); if (target >= 0 && target < list.length) [list[index], list[target]] = [list[target], list[index]]; }); },
    promote(e) { this.node(e, ({ list, index, node }, path, sections) => { if (path.length <= 2) return; const parent = locate(sections, path.slice(0, -1)); if (parent) { list.splice(index, 1); parent.list.splice(parent.index + 1, 0, node); } }); },
    demote(e) { this.node(e, ({ list, index, node }, path) => { const previous = list[index - 1]; if (previous && previous.type === 'group' && path.length + depth(node) <= 6) { list.splice(index, 1); previous.children.push(node); } }); },
    type(e) { this.node(e, ({ list, index, node }) => { if (node.type !== 'group') list[index] = { ...model.field(model.types[Number(e.detail.value)]), id: node.id, label: node.label, help: node.help || '', required: node.required }; }); },
    async save() {
      if (this.data.busy || !this.data.editing) return;
      this.setData({ busy: true, error: '' });
      try { const r = await weekly.call('saveTemplate', this.data.editing); if (!this._detached) { this.triggerEvent('saved', r.template); this.triggerEvent('done'); } }
      catch (e) { if (!this._detached) this.setData({ error: e.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async back() {
      if (this.data.busy) return;
      if (this.data.editing) { const r = await wx.showModal({ title: '离开模板编辑', content: '放弃尚未保存的模板修改？', confirmText: '离开' }); if (r.confirm) this.triggerEvent('close'); }
      else this.triggerEvent('close');
    }
  }
});
