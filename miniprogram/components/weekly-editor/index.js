const weekly = require('../../services/weekly');
const empty = () => ({ ops: [{ insert: '\n' }] });
Component({
  properties: { value: { type: Object, value: null }, imageUrls: { type: Object, value: {} }, readonly: Boolean, disabled: Boolean,
    periodId: String, fieldId: String, maxLength: { type: Number, value: 5000 } },
  data: { formats: {}, error: '', uploading: false, more: false },
  observers: { 'value,imageUrls': function () { this.renderValue(); } },
  lifetimes: { detached() { this._detached = true; } },
  methods: {
    ready() { this.createSelectorQuery().select('#body').context(result => { if (result && result.context) { this._editor = result.context; this.renderValue(); } }).exec(); },
    renderValue() {
      if (!this._editor) return;
      const value = this.properties.value || empty(), stamp = JSON.stringify(value);
      const urls = { ...this._localURLs, ...this.properties.imageUrls };
      this._urlHistory = { ...this._urlHistory, ...Object.fromEntries(Object.entries(urls).map(([id, url]) => [url, 'imc-image:' + id])) };
      if (stamp === this._stamp && !this.properties.readonly) return;
      this._stamp = stamp;
      const delta = { ops: (value.ops || []).map(op => typeof op.insert === 'object' && op.insert.image ? { ...op, attributes: { ...op.attributes, width: '100%' }, insert: { image: urls[op.insert.image.slice(10)] || '' } } : op) };
      this._editor.setContents({ delta, fail: () => { if (!this._detached) this.setData({ error: '正文加载失败，请重新打开。' }); } });
    },
    input(e) {
      if (this.properties.readonly || this.properties.disabled) return;
      const urls = { ...this._localURLs, ...this.properties.imageUrls };
      const reverse = { ...this._urlHistory, ...Object.fromEntries(Object.entries(urls).map(([id, url]) => [url, 'imc-image:' + id])) };
      const delta = { ops: (e.detail.delta && e.detail.delta.ops || []).map(op => {
        const clean = { insert: typeof op.insert === 'object' ? { image: reverse[op.insert.image] || op.insert.image } : op.insert };
        if (op.attributes) {
          const attributes = Object.fromEntries(Object.entries(op.attributes).filter(([key, value]) => {
            if (['bold', 'italic', 'underline', 'strike'].includes(key)) return typeof value === 'boolean';
            if (key === 'header') return [1, 2, 3].includes(value);
            if (key === 'list') return ['ordered', 'bullet', 'check'].includes(value);
            if (key === 'align') return ['left', 'center', 'right', 'justify'].includes(value);
            if (key === 'indent') return Number.isSafeInteger(value) && value >= 0 && value <= 8;
            return ['color', 'background'].includes(key) && typeof value === 'string' && /^#[a-fA-F0-9]{6}$/.test(value);
          }));
          if (Object.keys(attributes).length) clean.attributes = attributes;
        }
        return clean;
      }) };
      const length = delta.ops.reduce((n, op) => n + (typeof op.insert === 'string' ? op.insert.length : 0), 0) - 1;
      this.setData({ error: length > this.properties.maxLength ? '文字超出' + this.properties.maxLength + '字限制' : '' });
      const stamp = JSON.stringify(delta); if (stamp === this._stamp) return;
      this._stamp = stamp;
      this.triggerEvent('change', { value: delta });
    },
    status(e) { this.setData({ formats: e.detail || {} }); },
    more() { this.setData({ more: !this.data.more }); },
    format(e) {
      if (!this._editor || this.properties.disabled || this.properties.readonly) return;
      const { name, value } = e.currentTarget.dataset;
      if (['undo', 'redo', 'removeFormat'].includes(name)) this._editor[name]();
      else this._editor.format(name, value ? this.data.formats[name] === value ? false : value : !this.data.formats[name]);
    },
    async image() {
      if (!this._editor || this.data.uploading || this.properties.disabled || this.properties.readonly) return;
      const images = (this.properties.value && this.properties.value.ops || []).filter(op => typeof op.insert === 'object');
      if (images.length >= 10) { this.setData({ error: '每个文本框最多插入10张图片。' }); return; }
      this.triggerEvent('uploading', { value: true });
      this.setData({ uploading: true, error: '' });
      try {
        const chosen = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
        const file = chosen.tempFiles[0], info = await wx.getImageInfo({ src: file.tempFilePath });
        if (!['jpg', 'jpeg', 'png'].includes(info.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择5MB以内的 JPG 或 PNG 图片。');
        const uploaded = await weekly.upload({ path: file.tempFilePath, size: file.size, name: 'image-' + Date.now() + '.' + info.type }, this.properties.periodId, this.properties.fieldId, 'image');
        const link = await weekly.call('imageURL', { fileId: uploaded.id });
        if (this._detached) return;
        this._localURLs = { ...this._localURLs, [uploaded.id]: link.url };
        await new Promise((resolve, reject) => this._editor.insertImage({ src: link.url, width: '100%', alt: '周报图片', success: resolve, fail: reject }));
        await new Promise((resolve, reject) => this._editor.getContents({ success: result => { this.input({ detail: result }); resolve(); }, fail: reject }));
      } catch (error) { if (!this._detached && !/cancel/i.test(error.errMsg || '')) this.setData({ error: error.message || '图片上传失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ uploading: false }); this.triggerEvent('uploading', { value: false }); }
    }
  }
});
