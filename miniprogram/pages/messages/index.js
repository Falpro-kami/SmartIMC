const access = require('../../services/access');
function timeLabel(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
Page(require('../../utils/member-page')({
  data: { loading: true, error: '', messages: [], hasMore: false, hasUnread: false, readingAll: false },
  onShow() {
    if (!this._unsubscribeUnread && access.subscribeUnread) this._unsubscribeUnread = access.subscribeUnread(value => { if (!this._unloaded) this.setData({ hasUnread: value }); });
    if (!this._unsubscribeLive && access.subscribeChanges) this._unsubscribeLive = access.subscribeChanges('messages', () => this.loadMessages(true));
    return this.loadMessages(this._loaded === true);
  },
  onHide() { if (this._unsubscribeLive) this._unsubscribeLive(); this._unsubscribeLive = null;
    if (this._unsubscribeUnread) this._unsubscribeUnread(); this._unsubscribeUnread = null;
    this._epoch = (this._epoch || 0) + 1; this._loading = false; this._refreshAgain = false; },
  onUnload() { this._unloaded = true; this.onHide(); },
  present(messages) { return messages.map(message => ({ ...message, timeLabel: timeLabel(message.createdMs), icon: /身份|权限|成员/.test(message.title) ? 'shield' : /公告/.test(message.title) ? 'megaphone' : 'file' })); },
  async loadMessages(quiet = false) {
    if (this._loading || this.data.readingAll) { this._refreshAgain = true; return; }
    this._loading = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    const current = () => !this._unloaded && this._epoch === epoch;
    if (!quiet) this.setData({ loading: !this._loaded, error: '' });
    try {
      const target = Math.max(50, this._offset || 0), rows = new Map();
      let result, offset = 0;
      do {
        result = await access.messages(offset);
        if (!current()) return;
        if (!Number.isSafeInteger(result.nextOffset) || (result.hasMore && result.nextOffset <= offset)) throw new Error('消息读取失败，请重试。');
        result.messages.forEach(message => rows.set(message.id, { ...message, read: message.read || !!(this._locallyRead && this._locallyRead.has(message.id)) }));
        offset = result.nextOffset;
      } while (result.hasMore && offset < target);
      this._offset = result.nextOffset;
      this._loaded = true;
      this.setData({ error: '', messages: this.present(Array.from(rows.values())), hasMore: result.hasMore,
        hasUnread: access.notificationCurrent ? access.notificationCurrent() === true : result.hasUnread === true });
    } catch (error) { if (current() && (!quiet || error.code === 'MEMBERSHIP_REQUIRED')) this.setData({ error: error.message }); }
    finally { if (current()) { this._loading = false; this.setData({ loading: false }); this.flushRefresh(); } }
  },
  flushRefresh() { if (this._refreshAgain) { this._refreshAgain = false; return this.loadMessages(true); } },
  onReachBottom() { this.loadMore(); },
  async loadMore() {
    if (this._loading || this.data.readingAll || !this.data.hasMore) return;
    this._loading = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    try {
      const result = await access.messages(this._offset);
      if (this._unloaded || epoch !== this._epoch) return;
      this._offset = result.nextOffset;
      const previous = new Set(this.data.messages.map(message => message.id));
      this.setData({ messages: this.data.messages.concat(this.present(result.messages.filter(message => !previous.has(message.id)))), hasMore: result.hasMore });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { if (epoch === this._epoch) { this._loading = false; this.flushRefresh(); } }
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
      if (!this._locallyRead) this._locallyRead = new Set();
      this._locallyRead.add(id);
      if (!this._unloaded) this.setData({ messages: this.data.messages.map(message => message.id === id ? { ...message, read: true } : message) });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally { this._reading = false; }
  },
  async markAllRead() {
    if (this._reading || !this.data.hasUnread) return;
    this._reading = true; this.setData({ readingAll: true });
    try {
      let result, readBeforeMs;
      do {
        result = await access.readAllMessages(readBeforeMs);
        readBeforeMs = result.readBeforeMs;
        if (!this._locallyRead) this._locallyRead = new Set();
        result.readIds.forEach(id => this._locallyRead.add(id));
        if (this._unloaded) return;
        this.setData({ hasUnread: result.hasUnread, messages: this.data.messages.map(message => this._locallyRead.has(message.id) ? { ...message, read: true } : message) });
        if (result.hasMore && !result.readIds.length) throw new Error('消息权限已变化，请刷新后重试。');
      } while (result.hasMore);
      wx.showToast({ title: '已全部标记为已读', icon: 'success' });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally {
      this._reading = false;
      if (!this._unloaded) { this.setData({ readingAll: false }); this._refreshAgain = false; this.loadMessages(true); }
    }
  }
}));
