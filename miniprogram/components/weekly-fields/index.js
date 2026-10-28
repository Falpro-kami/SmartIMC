const weekly = require('../../services/weekly');
const formModel = require('../../utils/weekly-form');
Component({
  properties: { schema: Object, answers: { type: Object, value: {} }, files: { type: Array, value: [] }, imageUrls: Object,
    selectedFields: { type: Array, value: null }, readonly: Boolean, outline: Boolean, disabled: Boolean, embedded: Boolean, periodId: String, versionId: String, formKey: String },
  data: { sections: [], error: '', uploading: false, helpOpen: {} },
  observers: { 'schema,answers,files,selectedFields,readonly,outline': function () { this.build(); } },
  methods: {
    build() {
      const answers = this.properties.answers || {}, files = new Map([...this.properties.files, ...Object.values(this._files || {})].map(f => [f.id, f]));
      this.setData({ sections: formModel.view(this.properties.schema, answers, this.properties.selectedFields, this.properties.readonly, this.properties.outline).map(s => ({ ...s, fields: s.fields.map(f => {
        const value = answers[f.id];
        return { ...f,
          attachments: f.type === 'attachment' ? (value || []).map(id => weekly.fileView(files.get(id) || { id, name: '附件', size: 0 })) : [] };
      }) })) });
    },
    change(id, value) {
      const field = formModel.fields(this.properties.schema).find(f => f.id === id);
      const selectedFields = formModel.selected(this.properties.schema, this.properties.answers, this.properties.selectedFields);
      if (this.properties.readonly || this.properties.disabled || !field || !field.required && !field.root && !selectedFields.includes(id)) return;
      this.triggerEvent('change', { answers: { ...this.properties.answers, [id]: value }, selectedFields });
    },
    toggleHelp(e) { const id = e.currentTarget.dataset.id; if (!this.properties.readonly || this.properties.outline) this.setData({ helpOpen: { ...this.data.helpOpen, [id]: !this.data.helpOpen[id] } }); },
    toggle(e) {
      if (this.properties.readonly || this.properties.disabled || this.data.uploading) return;
      const id = e.currentTarget.dataset.id, field = formModel.fields(this.properties.schema).find(f => f.id === id);
      if (!field || field.required || field.root) return;
      const selectedFields = formModel.selected(this.properties.schema, this.properties.answers, this.properties.selectedFields).filter(key => key !== id), answers = { ...this.properties.answers };
      if (e.detail.value.includes(id)) { selectedFields.push(id); if (this._inactive && this._inactive[id] !== undefined) answers[id] = this._inactive[id]; }
      else { this._inactive = { ...this._inactive, [id]: answers[id] }; delete answers[id]; }
      this.triggerEvent('change', { answers, selectedFields });
    },
    input(e) { if (!this.properties.readonly && !this.properties.disabled) this.change(e.currentTarget.dataset.id, e.detail.value); },
    textChange(e) { this.change(e.currentTarget.dataset.id, e.detail.value); },
    uploading(e) { this._imageUploads = Math.max(0, (this._imageUploads || 0) + (e.detail.value ? 1 : -1)); this.setData({ uploading: this._imageUploads > 0 }); this.triggerEvent('uploading', e.detail); },
    async addFiles(e) {
      if (this.properties.readonly || this.properties.disabled || this.data.uploading) return;
      const field = formModel.fields(this.properties.schema).find(f => f.id === e.currentTarget.dataset.id);
      const ids = [...(this.properties.answers[field.id] || [])];
      if (ids.length >= field.maxCount) return;
      this.setData({ uploading: true, error: '' }); this.triggerEvent('uploading', { value: true });
      try {
        const chosen = await wx.chooseMessageFile({ count: field.maxCount - ids.length, type: 'file', extension: ['doc', 'docx', 'pdf'] });
        for (const file of chosen.tempFiles) {
          if (file.size > field.maxSizeMB * 1024 * 1024) throw new Error('文件不能超过' + field.maxSizeMB + 'MB。');
          const uploaded = await weekly.upload(file, this.properties.periodId, field.id, 'attachment', this.properties.formKey);
          this._files = { ...this._files, [uploaded.id]: uploaded }; ids.push(uploaded.id);
          this.change(field.id, ids.slice());
        }
      } catch (error) { if (!/cancel/i.test(error.errMsg || '')) this.setData({ error: error.message || '文件上传失败。' }); }
      finally { this.setData({ uploading: false }); this.triggerEvent('uploading', { value: false }); }
    },
    removeFile(e) { if (!this.properties.readonly && !this.properties.disabled) this.change(e.currentTarget.dataset.field, (this.properties.answers[e.currentTarget.dataset.field] || []).filter(id => id !== e.currentTarget.dataset.id)); },
    useFile(e) { this.triggerEvent('file', { ...e.currentTarget.dataset, version: this.properties.versionId }); }
  }
});
