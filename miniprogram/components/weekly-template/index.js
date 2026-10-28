const weekly = require('../../services/weekly');
const model = require('../../utils/weekly-form');
Component({
  properties: { choose: Boolean },
  data: { templates: [], loading: true, busy: false, error: '', editing: null, types: model.labels },
  lifetimes: { attached() { this.load(); }, detached() { this._detached = true; } },
  methods: {
    async load() { this.setData({ loading: true, error: '' }); try { const r = await weekly.call('templates', {}, true); if (!this._detached) this.setData({ templates: r.templates }); } catch (e) { if (!this._detached) this.setData({ error: e.message }); } finally { if (!this._detached) this.setData({ loading: false }); } },
    newTemplate() { this.setData({ editing: { id: weekly.newId('wt'), revision: 0, name: '', schema: model.defaults() }, error: '' }); },
    edit(e) { const t = this.data.templates.find(t => t.id === e.currentTarget.dataset.id); if (t) { const editing = JSON.parse(JSON.stringify(t)); editing.schema.sections.forEach(s => s.fields.forEach(f => { f.optionsText = (f.options || []).join('\n'); })); this.setData({ editing, error: '' }); } },
    chooseTemplate(e) { const t = this.data.templates.find(t => t.id === e.currentTarget.dataset.id); if (t) this.triggerEvent('select', t); },
    name(e) { this.setData({ 'editing.name': e.detail.value }); },
    mutate(e, callback) {
      if (this.data.busy || !this.data.editing) return;
      const sections = JSON.parse(JSON.stringify(this.data.editing.schema.sections));
      const { section, field } = e.currentTarget.dataset;
      callback(sections, Number(section), Number(field));
      sections.forEach(s => s.fields.forEach(f => { f.optionsText = (f.options || []).join('\n'); }));
      this.setData({ 'editing.schema.sections': sections });
    },
    sectionInput(e) { this.mutate(e, (s, i) => { s[i].title = e.detail.value; }); },
    fieldInput(e) { const key = e.currentTarget.dataset.key; this.mutate(e, (s, i, j) => {
      let value = e.detail.value;
      if (['maxLength', 'maxCount', 'maxSizeMB'].includes(key)) value = Number(value);
      if (key === 'options') value = value.split('\n');
      if (key === 'width') value = value ? 'half' : 'full';
      s[i].fields[j][key] = value;
    }); },
    addSection() { const s = this.data.editing.schema.sections; if (s.length < 10) this.setData({ 'editing.schema.sections': s.concat({ id: model.unique('section_'), title: '新分区', fields: [model.field()] }) }); },
    removeSection(e) { this.mutate(e, (s, i) => { s.splice(i, 1); }); },
    moveSection(e) { this.mutate(e, (s, i) => { const target = i + Number(e.currentTarget.dataset.step); if (target >= 0 && target < s.length) [s[i], s[target]] = [s[target], s[i]]; }); },
    addField(e) { this.mutate(e, (s, i) => { if (s.reduce((n, r) => n + r.fields.length, 0) < 30) s[i].fields.push(model.field()); }); },
    removeField(e) { this.mutate(e, (s, i, j) => { s[i].fields.splice(j, 1); }); },
    moveField(e) { this.mutate(e, (s, i, j) => { const target = j + Number(e.currentTarget.dataset.step); if (target >= 0 && target < s[i].fields.length) [s[i].fields[j], s[i].fields[target]] = [s[i].fields[target], s[i].fields[j]]; }); },
    type(e) { this.mutate(e, (s, i, j) => { const previous = s[i].fields[j]; s[i].fields[j] = { ...model.field(model.types[Number(e.detail.value)]), id: previous.id, label: previous.label, required: previous.required, width: previous.width }; }); },
    async save() {
      if (this.data.busy || !this.data.editing) return;
      this.setData({ busy: true, error: '' });
      try { const r = await weekly.call('saveTemplate', this.data.editing); if (!this._detached) { this.setData({ editing: null }); await this.load(); this.triggerEvent('saved', r.template); } }
      catch (e) { if (!this._detached) this.setData({ error: e.message }); }
      finally { if (!this._detached) this.setData({ busy: false }); }
    },
    async back() {
      if (this.data.busy) return;
      if (this.data.editing) { const r = await wx.showModal({ title: '离开模板编辑', content: '放弃尚未保存的模板修改？', confirmText: '离开' }); if (r.confirm) this.setData({ editing: null, error: '' }); }
      else this.triggerEvent('close');
    }
  }
});
