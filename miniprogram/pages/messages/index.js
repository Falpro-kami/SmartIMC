const access = require('../../services/access');
function timeLabel(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', messages: [], hasMore: false },
  onShow() { this.loadMessages(); },
  onUnload() { this._unloaded = true; },
  present(messages) { return messages.map(message => ({ ...message, timeLabel: timeLabel(message.createdMs) })); },
  async loadMessages() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ loading: true, error: '', messages: [], hasMore: false });
    try {
      const result = await access.messages(0);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      this.setData({ messages: this.present(result.messages), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) this.setData({ error: error.message }); }
    finally { this._loading = false; if (!this._unloaded) this.setData({ loading: false }); }
  },
  onReachBottom() { this.loadMore(); },
  async loadMore() {
    if (this._loading || !this.data.hasMore) return;
    this._loading = true;
    try {
      const result = await access.messages(this._offset);
      if (this._unloaded) return;
      this._offset = result.nextOffset;
      const previous = new Set(this.data.messages.map(message => message.id));
      this.setData({ messages: this.data.messages.concat(this.present(result.messages.filter(message => !previous.has(message.id)))), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._loading = false; }
  },
  async openMessage(event) {
    if (this._opening) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.messages.some(message => message.id === id)) return;
    this._opening = true;
    try {
      const result = await access.openMessage(id);
      if (this._unloaded) return;
      if (result.url) wx.navigateTo({ url: result.url,
        fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); } });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._opening = false; }
  },
  async markRead(event) {
    const id = event.currentTarget.dataset.id;
    if (this._reading || !this.data.messages.some(message => message.id === id && !message.read)) return;
    this._reading = true;
    try {
      await access.readMessage(id);
      if (!this._unloaded) this.setData({ messages: this.data.messages.map(message => message.id === id ? { ...message, read: true } : message) });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._reading = false; }
  }
}));
