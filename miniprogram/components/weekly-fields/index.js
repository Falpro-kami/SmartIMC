const weekly = require('../../services/weekly');
Component({
  properties: { schema: Object, answers: { type: Object, value: {} }, files: { type: Array, value: [] }, imageUrls: Object,
    readonly: Boolean, disabled: Boolean, embedded: Boolean, periodId: String, versionId: String },
  data: { sections: [], error: '', uploading: false },
  observers: { 'schema,answers,files': function () { this.build(); } },
  methods: {
    build() {
      const answers = this.properties.answers || {}, files = new Map([...this.properties.files, ...Object.values(this._files || {})].map(f => [f.id, f]));
      this.setData({ sections: (this.properties.schema && this.properties.schema.sections || []).map(s => ({ ...s, fields: s.fields.map(f => {
        const value = answers[f.id];
        return { ...f, value: value === undefined ? '' : value, displayValue: Array.isArray(value) ? value.join('、') : value === undefined || value === '' ? '-' : value, delta: value || { ops: [{ insert: '\n' }] },
          optionsView: (f.options || []).map(option => ({ label: option, checked: f.type === 'multiple' ? (value || []).includes(option) : value === option })),
          attachments: f.type === 'attachment' ? (value || []).map(id => weekly.fileView(files.get(id) || { id, name: '附件', size: 0 })) : [] };
      }) })) });
    },
    change(id, value) { this.triggerEvent('change', { answers: { ...this.properties.answers, [id]: value } }); },
    input(e) { if (!this.properties.readonly && !this.properties.disabled) this.change(e.currentTarget.dataset.id, e.detail.value); },
    textChange(e) { this.change(e.currentTarget.dataset.id, e.detail.value); },
    uploading(e) { this.triggerEvent('uploading', e.detail); },
    async addFiles(e) {
      if (this.properties.readonly || this.properties.disabled || this.data.uploading) return;
      const field = this.properties.schema.sections.flatMap(s => s.fields).find(f => f.id === e.currentTarget.dataset.id);
      const ids = [...(this.properties.answers[field.id] || [])];
      if (ids.length >= field.maxCount) return;
      this.setData({ uploading: true, error: '' }); this.triggerEvent('uploading', { value: true });
      try {
        const chosen = await wx.chooseMessageFile({ count: field.maxCount - ids.length, type: 'file', extension: ['doc', 'docx', 'pdf'] });
        for (const file of chosen.tempFiles) {
          if (file.size > field.maxSizeMB * 1024 * 1024) throw new Error('文件不能超过' + field.maxSizeMB + 'MB。');
          const uploaded = await weekly.upload(file, this.properties.periodId, field.id);
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
