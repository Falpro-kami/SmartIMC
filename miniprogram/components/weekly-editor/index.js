const weekly = require('../../services/weekly');
const empty = () => ({ ops: [{ insert: '\n' }] });
const tools = [
  { icon: 'bullet', label: '无序列表', name: 'list', value: 'bullet' },
  { icon: 'ordered', label: '有序列表', name: 'list', value: 'ordered' },
  { icon: 'bold', label: '粗体', name: 'bold', separator: true },
  { icon: 'strike', label: '中划线', name: 'strike' },
  { icon: 'underline', label: '下划线', name: 'underline' },
  { icon: 'italic', label: '斜体', name: 'italic' },
  { icon: 'color', label: '文字颜色', name: 'color', panel: 'color' },
  { icon: 'highlight', label: '高亮颜色', name: 'backgroundColor', panel: 'highlight' }
];
const extras = [
  { icon: 'image', label: '插入图片', action: 'image' },
  { icon: 'checklist', label: '任务列表', name: 'list', value: 'check' },
  { icon: 'indent', label: '增加缩进', name: 'indent', value: '+1' },
  ...['left', 'center', 'right', 'justify'].map((value, i) => ({ icon: 'align-' + value, label: ['左对齐', '居中', '右对齐', '两端对齐'][i], name: 'align', value }))
];
const colorRows = [
  ['ffffff', '4c9aff', '17c917', '9254ff', 'ffff00', 'ff2600'],
  ['f5f5f5', 'c9daf8', 'd9ead3', 'd9d2e9', 'fff2cc', 'f4cccc'],
  ['e5e5e5', 'a4c2f4', 'b6d7a8', 'b4a7d6', 'ffe599', 'ea9999'],
  ['999999', '3c78d8', '6aa84f', '674ea7', 'f1c232', 'e06666'],
  ['434343', '1155cc', '38761d', '351c75', 'bf9000', '990000'],
  ['000000', '1c4587', '274e13', '20124d', '7f6000', '660000']
];
const colors = colorRows.map((row, index) => ({ id: 'colors-' + index, items: row.map(value => {
  const channels = value.match(/../g).map(c => parseInt(c, 16));
  return { value: '#' + value, label: '#' + value, dark: .299 * channels[0] + .587 * channels[1] + .114 * channels[2] < 155 };
}) }));
function hexColor(value) {
  if (typeof value !== 'string') return null;
  if (/^#[a-f0-9]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = value.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/);
  return rgb && rgb.slice(1).every(n => Number(n) <= 255) ? '#' + rgb.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('') : null;
}
Component({
  properties: { value: { type: Object, value: null }, imageUrls: { type: Object, value: {} }, readonly: Boolean, disabled: Boolean,
    periodId: String, fieldId: String, maxLength: { type: Number, value: 5000 } },
  data: { formats: {}, error: '', uploading: false, panel: '', tip: '', tools, extras, colors,
    textColor: '#000000', highlightColor: '#f1c232',
    headings: [{ icon: 'font', label: '正文', value: 0 }, ...[1, 2, 3].map(value => ({ icon: 'h' + value, label: value + '级标题', value }))],
    history: [{ name: 'undo', icon: 'undo', label: '撤销' }, { name: 'redo', icon: 'redo', label: '重做' }, { name: 'removeFormat', icon: 'clear', label: '清除格式' }] },
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
            return ['color', 'background', 'backgroundColor'].includes(key) && !!hexColor(value);
          }));
          for (const key of ['color', 'background', 'backgroundColor']) if (attributes[key]) { const value = hexColor(attributes[key]); delete attributes[key]; attributes[key === 'color' ? 'color' : 'background'] = value; }
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
    status(e) {
      const formats = { ...e.detail }, mark = item => ({ ...item, active: item.name === 'align' ? (formats.align || 'left') === item.value : item.value === undefined ? !!formats[item.name] : formats[item.name] === item.value });
      this.setData({ formats, tools: tools.map(mark), extras: extras.map(mark),
        textColor: hexColor(formats.color) || this.data.textColor, highlightColor: hexColor(formats.backgroundColor || formats.background) || this.data.highlightColor });
    },
    closePanel() { this._panelRequest = (this._panelRequest || 0) + 1; this._selection = null; if (this.data.panel || this.data.tip) this.setData({ panel: '', tip: '' }); },
    touchStart(e) { this._toolMoved = false; this._toolTouch = e.touches && e.touches[0]; },
    touchMove(e) { const start = this._toolTouch, point = e.touches && e.touches[0]; if (start && point && Math.abs(start.clientX - point.clientX) + Math.abs(start.clientY - point.clientY) > 8) this._toolMoved = true; },
    showTip(e) { if (!this.properties.disabled && !this.properties.readonly) { this._tipUntil = Date.now() + 500; this.setData({ tip: e.currentTarget.dataset.label || '', panel: '' }); } },
    async openPanel(e) {
      if (this.properties.disabled || this.properties.readonly || this._toolMoved || Date.now() < (this._tipUntil || 0)) return;
      const panel = e.currentTarget.dataset.panel;
      if (!['heading', 'color', 'highlight', 'more'].includes(panel)) return;
      if (this.data.panel === panel) { this.closePanel(); return; }
      const request = this._panelRequest = (this._panelRequest || 0) + 1;
      if (!this.data.panel) {
        this._selection = null;
        if (this._editor && this._editor.getSelection) await new Promise(resolve => this._editor.getSelection({ success: result => { const range = result.range; if (request === this._panelRequest && range && Number.isInteger(range.index) && range.index >= 0 && Number.isInteger(range.length) && range.length >= 0) this._selection = { index: range.index, length: range.length }; resolve(); }, fail: resolve }));
      }
      if (!this._detached && request === this._panelRequest) this.setData({ panel, tip: '' });
    },
    tool(e) {
      if (this.properties.disabled || this.properties.readonly || this._toolMoved || Date.now() < (this._tipUntil || 0)) return;
      if (e.currentTarget.dataset.panel) return this.openPanel(e);
      if (e.currentTarget.dataset.action === 'image') { const range = this._selection; this.closePanel(); this._selection = range; return this.image(); }
      return this.format(e);
    },
    chooseHeading(e) {
      if (![0, 1, 2, 3].includes(e.currentTarget.dataset.value)) return;
      if (Number(this.data.formats.header || 0) === e.currentTarget.dataset.value) { this.closePanel(); return; }
      return this.format(e);
    },
    chooseColor(e) {
      if (this.properties.disabled || this.properties.readonly || !['color', 'highlight'].includes(this.data.panel)) return;
      const value = e.currentTarget.dataset.color;
      if (!colors.some(row => row.items.some(c => c.value === value))) return;
      const name = this.data.panel === 'color' ? 'color' : 'backgroundColor';
      this.setData({ [name === 'color' ? 'textColor' : 'highlightColor']: value });
      this.format({ currentTarget: { dataset: { name, value, exact: true } } });
    },
    withSelection(action, failure) {
      const range = this._selection; this._selection = null;
      if (range && this._editor.setSelection) this._editor.setSelection({ ...range, success: () => { if (!this._detached && !this.properties.readonly && !this.properties.disabled) action(); else if (failure) failure(new Error('编辑已结束。')); }, fail: () => { const error = new Error('选区已变化，请重新选择文字。'); if (!this._detached) this.setData({ error: error.message }); if (failure) failure(error); } });
      else action();
    },
    format(e) {
      if (!this._editor || this.properties.disabled || this.properties.readonly || this._toolMoved || Date.now() < (this._tipUntil || 0)) return;
      const { name, value, exact } = e.currentTarget.dataset;
      if (!['bold', 'strike', 'underline', 'italic', 'header', 'list', 'align', 'indent', 'color', 'backgroundColor', 'undo', 'redo', 'removeFormat'].includes(name)) return;
      const range = this._selection; this.closePanel(); this._selection = range;
      this.withSelection(() => {
        if (['undo', 'redo', 'removeFormat'].includes(name)) this._editor[name]();
        else if (exact) { if (hexColor(this.data.formats[name] || this.data.formats[name === 'backgroundColor' ? 'background' : name]) !== value) this._editor.format(name, value); }
        else if (name === 'indent') this._editor.format(name, value);
        else this._editor.format(name, value === 0 ? false : value ? this.data.formats[name] === value ? false : value : !this.data.formats[name]);
      });
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
        await new Promise((resolve, reject) => this.withSelection(() => this._editor.insertImage({ src: link.url, width: '100%', alt: '周报图片', success: resolve, fail: reject }), reject));
        await new Promise((resolve, reject) => this._editor.getContents({ success: result => { this.input({ detail: result }); resolve(); }, fail: reject }));
      } catch (error) { if (!this._detached && !/cancel/i.test(error.errMsg || '')) this.setData({ error: error.message || '图片上传失败，请重试。' }); }
      finally { if (!this._detached) this.setData({ uploading: false }); this.triggerEvent('uploading', { value: false }); }
    }
  }
});
