const access = require('../../services/access');
const EMPTY = { mine: '暂无申请记录', pending: '暂无待审批事项', done: '暂无已审批记录' };
function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
Page({
  data: { loading: true, error: '', requests: [], canReviewMembers: false,
    activeTab: 'mine', emptyText: EMPTY.mine,
    tabs: [{ id: 'mine', label: '我的申请' }, { id: 'pending', label: '待我审批' }, { id: 'done', label: '我已审批' }] },
  onShow() { return this.loadApprovals(); },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; },
  switchTab(event) {
    const tab = event.currentTarget.dataset.id;
    if (!this.data.tabs.some(item => item.id === tab) || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, emptyText: EMPTY[tab] });
    return this.loadApprovals();
  },
  async loadApprovals() {
    const epoch = this._epoch = (this._epoch || 0) + 1;
    const tab = this.data.activeTab;
    const currentRequest = () => !this._unloaded && this._epoch === epoch;
    this.setData({ loading: true, error: '', requests: [], canReviewMembers: false });
    try {
      const current = await access.get();
      if (!currentRequest()) return;
      const canReviewMembers = access.can(current.member, 'members.manage');
      this.setData({ canReviewMembers });
      if (tab !== 'mine' && !canReviewMembers) return;
      const requests = new Map();
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const result = await access.approvals(tab, offset);
        if (!currentRequest()) return;
        if (!Array.isArray(result.requests) || !Number.isSafeInteger(result.nextOffset) ||
          result.nextOffset < offset || (result.hasMore && result.nextOffset <= offset)) {
          throw new Error('申请与审批读取失败，请重试。');
        }
        for (const request of result.requests) requests.set(request.id, { ...request, dateLabel: dateLabel(request.createdMs) });
        offset = result.nextOffset;
        hasMore = result.hasMore === true;
      }
      this.setData({ requests: Array.from(requests.values()) });
    } catch (error) { if (currentRequest()) this.setData({ error: error.message }); }
    finally { if (currentRequest()) this.setData({ loading: false }); }
  },
  openApproval(event) {
    const request = this.data.requests.find(item => item.id === event.currentTarget.dataset.id);
    if (this.data.activeTab !== 'pending' || !this.data.canReviewMembers || !request || !request.memberId) return;
    wx.navigateTo({ url: '/pages/members/index?id=' + encodeURIComponent(request.memberId),
      fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); } });
  }
});
