const access = require('../../services/access');

function labels(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { timeLabel: '-', dateLabel: '-' };
  const pad = value => String(value).padStart(2, '0');
  const dateLabel = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { timeLabel: `${dateLabel} ${time}`, dateLabel };
}
function checkPage(result, offset) {
  if (!result || !Array.isArray(result.messages) || !Number.isSafeInteger(result.nextOffset) ||
      result.nextOffset < offset || (result.hasMore && result.nextOffset <= offset)) throw new Error('消息读取失败，请重试。');
}

Page(require('../../utils/member-page')({
  data: {
    loading: true, loadingMore: false, error: '', moreError: '', messages: [], visibleMessages: [],
    filter: 'all', allCountLabel: '', unreadCount: 0, unreadLabel: '', hasMore: false, hasUnread: false,
    readingAll: false, readingId: ''
  },
  onShow() {
    this._visible = true;
    if (!this._unsubscribeUnread && access.subscribeUnread) {
      this._unsubscribeUnread = access.subscribeUnread((value, count) => {
        if (this._unloaded) return;
        this.receiveUnread({ hasUnread: value, unreadCount: count });
        this.updateView();
      });
    }
    if (!this._unsubscribeLive && access.subscribeChanges) this._unsubscribeLive = access.subscribeChanges('messages', () => this.loadMessages(true));
    return this.loadMessages(this._loaded === true);
  },
  onHide() {
    this._visible = false;
    if (this._unsubscribeLive) this._unsubscribeLive();
    if (this._unsubscribeUnread) this._unsubscribeUnread();
    this._unsubscribeLive = null; this._unsubscribeUnread = null;
    this._epoch = (this._epoch || 0) + 1;
    this._loading = false; this._refreshAgain = false;
    if (this._targets) this._targets.forEach((target, id) => { if (target.loading) this._targets.delete(id); });
  },
  onUnload() { this._unloaded = true; this.onHide(); },
  receiveUnread(result = {}) {
    if (Number.isSafeInteger(result.unreadCount) && result.unreadCount >= 0) this._unreadCount = Math.min(100, result.unreadCount);
    else if (typeof result.hasUnread === 'boolean') this._unreadCount = result.hasUnread ? Math.max(this._unreadCount || 0, 1) : 0;
  },
  present(messages) {
    return messages.map(message => {
      const body = typeof message.body === 'string' ? message.body : '';
      const target = this._targets && this._targets.get(message.id);
      return { ...message, body, ...labels(message.createdMs),
        summary: body.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '暂无正文',
        read: message.read || !!(this._locallyRead && this._locallyRead.has(message.id)),
        expanded: !!(this._expanded && this._expanded.has(message.id)),
        targetAvailable: !!(target && target.url), targetLoading: !!(target && target.loading), targetError: !!(target && target.error) };
    });
  },
  updateView(patch = {}) {
    if (this._unloaded) return;
    const next = { ...this.data, ...patch }, messages = this.present(next.messages);
    const unreadCount = Math.max(this._unreadCount || 0, messages.filter(message => !message.read).length);
    this.setData({ ...patch, messages, visibleMessages: next.filter === 'unread' ? messages.filter(message => !message.read) : messages,
      unreadCount, unreadLabel: unreadCount ? unreadCount > 99 ? '99+' : String(unreadCount) : '',
      hasUnread: unreadCount > 0, allCountLabel: this._loaded ? `${messages.length}${next.hasMore ? '+' : ''}` : '' });
  },
  changeFilter(event) {
    const filter = event.currentTarget.dataset.filter;
    if (!['all', 'unread'].includes(filter) || filter === this.data.filter) return;
    this.updateView({ filter });
    return this.ensureUnread();
  },
  toggleMessage(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.messages.some(message => message.id === id)) return;
    if (!this._expanded) this._expanded = new Set();
    if (this._expanded.has(id)) this._expanded.delete(id); else this._expanded.add(id);
    this.updateView();
    if (this._expanded.has(id)) return this.resolveTarget(id);
  },
  async resolveTarget(id) {
    if (!this._visible || this._unloaded || !this.data.messages.some(message => message.id === id)) return;
    if (!this._targets) this._targets = new Map();
    const previous = this._targets.get(id);
    if (previous && !previous.error) return;
    const target = { loading: true };
    this._targets.set(id, target); this.updateView();
    try {
      // Resolve the permission-checked destination without marking the message read.
      const result = await access.openMessage(id);
      if (this._targets.get(id) !== target || this._unloaded || !this._visible) return;
      this._targets.set(id, { url: result.url || '' });
    } catch (error) {
      if (this._targets.get(id) !== target || this._unloaded || !this._visible) return;
      this._targets.set(id, { error: true });
    }
    this.updateView();
  },
  retryTarget(event) { return this.resolveTarget(event.currentTarget.dataset.id); },
  openMessage(event) {
    if (this._opening || this._unloaded || !this._visible) return;
    const id = event.currentTarget.dataset.id, target = this._targets && this._targets.get(id);
    if (!target || !target.url || !this.data.messages.some(message => message.id === id)) return;
    this._opening = true;
    wx.navigateTo({ url: target.url,
      fail: () => { if (!this._unloaded) wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); },
      complete: () => { this._opening = false; }
    });
  },
  retryMessages() { return this.loadMessages(false); },
  async loadMessages(quiet = false) {
    if (!this._visible || this._unloaded) return;
    if (this._loading || this._reading) { this._refreshAgain = true; return; }
    this._loading = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    const current = () => !this._unloaded && this._visible && this._epoch === epoch;
    this.setData({ loadingMore: false, ...(!quiet ? { loading: !this._loaded, error: '' } : {}) });
    try {
      const target = Math.max(50, this._offset || 0), rows = new Map();
      let result, offset = 0;
      do {
        result = await access.messages(offset);
        if (!current()) return;
        checkPage(result, offset);
        result.messages.forEach(message => rows.set(message.id, message));
        offset = result.nextOffset;
      } while (result.hasMore && offset < target);
      this._offset = result.nextOffset; this._loaded = true;
      this.receiveUnread({ hasUnread: access.notificationCurrent ? access.notificationCurrent() : result.hasUnread,
        unreadCount: access.notificationCountCurrent ? access.notificationCountCurrent() : result.unreadCount });
      this.updateView({ error: '', moreError: '', messages: Array.from(rows.values()), hasMore: result.hasMore });
      this.data.visibleMessages.filter(message => message.expanded).forEach(message => this.resolveTarget(message.id));
    } catch (error) { if (current()) this.setData({ error: error.message }); }
    finally { if (current()) { this._loading = false; this.setData({ loading: false }); this.flushRefresh(); } }
  },
  flushRefresh() {
    if (!this._visible || this._unloaded) return;
    if (this._refreshAgain) { this._refreshAgain = false; return this.loadMessages(true); }
    return this.ensureUnread();
  },
  ensureUnread() {
    if (this._visible && this.data.filter === 'unread' && this.data.hasUnread && this.data.hasMore && !this.data.visibleMessages.length && !this.data.error && !this.data.moreError) return this.loadMore();
  },
  onReachBottom() { return this.loadMore(); },
  async loadMore() {
    if (!this._visible || this._unloaded || this._loading || this._reading || !this.data.hasMore) return;
    this._loading = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    const current = () => !this._unloaded && this._visible && epoch === this._epoch;
    const visibleCount = this.data.visibleMessages.length;
    this.setData({ loadingMore: true, moreError: '' });
    try {
      do {
        const offset = this._offset || 0, result = await access.messages(offset);
        if (!current()) return;
        checkPage(result, offset);
        this._offset = result.nextOffset;
        const rows = new Map(this.data.messages.map(message => [message.id, message]));
        result.messages.forEach(message => rows.set(message.id, message));
        this.receiveUnread({ hasUnread: access.notificationCurrent ? access.notificationCurrent() : result.hasUnread,
          unreadCount: access.notificationCountCurrent ? access.notificationCountCurrent() : result.unreadCount });
        this.updateView({ messages: Array.from(rows.values()), hasMore: result.hasMore });
        // Skip fully read pages so older unread messages remain discoverable.
      } while (current() && this.data.filter === 'unread' && this.data.hasUnread && this.data.visibleMessages.length <= visibleCount && this.data.hasMore);
    } catch (error) { if (current()) this.setData({ moreError: error.message }); }
    finally { if (current()) { this._loading = false; this.setData({ loadingMore: false }); this.flushRefresh(); } }
  },
  async markRead(event) {
    const id = event.currentTarget.dataset.id;
    if (this._reading || !this.data.messages.some(message => message.id === id && !message.read)) return;
    this._reading = true; this.setData({ readingId: id });
    try {
      const result = await access.readMessage(id);
      if (!this._locallyRead) this._locallyRead = new Set();
      this._locallyRead.add(id); this.receiveUnread(result); this.updateView();
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally {
      this._reading = false;
      if (!this._unloaded) { this.setData({ readingId: '' }); this.flushRefresh(); }
    }
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
        this.receiveUnread(result); this.updateView();
        if (result.hasMore && !result.readIds.length) throw new Error('消息权限已变化，请刷新后重试。');
      } while (result.hasMore);
      wx.showToast({ title: result.hasUnread ? '原有消息已读' : '已全部标记为已读', icon: 'success' });
    } catch (error) { if (!this._unloaded) wx.showToast({ title: error.message, icon: 'none' }); }
    finally {
      this._reading = false;
      if (!this._unloaded) { this.setData({ readingAll: false }); this._refreshAgain = false; this.loadMessages(true); }
    }
  }
}));
