const equipment = require('../../services/equipment');
const { buildView, PAGE_SIZE } = require('../../utils/equipment');

Page({
  data: {
    loading: true, refreshing: false, loaded: false, error: '',
    keyword: '', status: '', location: '',
    total: 0, filteredCount: 0, visibleRecords: [], hasMore: false,
    hasFilters: false, statusOptions: [], locationOptions: [],
    filterOpen: false, draftStatus: '', draftLocation: '', filterCount: 0,
    locationLabel: '', viewMode: 'card'
  },

  onLoad() {
    this._records = [];
    this._failedImages = new Set();
    this._limit = PAGE_SIZE;
    try {
      const savedMode = wx.getStorageSync('equipment-view-mode');
      if (savedMode === 'card' || savedMode === 'table') this.setData({ viewMode: savedMode });
    } catch (_) { /* Display preference must not prevent loading equipment. */ }
    this.loadRecords();
  },

  onUnload() { this._unloaded = true; },

  async loadRecords(force = false) {
    if (this._loading) return this._loading;
    this.setData({ loading: !this.data.loaded, refreshing: this.data.loaded, error: '' });
    this._loading = (async () => {
      try {
        const records = await equipment.loadAll(force);
        if (this._unloaded) return;
        this._records = records;
        this._failedImages = new Set();
        this._limit = PAGE_SIZE;
        this.setData({ loaded: true });
        this.updateView();
      } catch (error) {
        if (!this._unloaded) this.setData({ error: error.message || '设备加载失败，请重试。' });
      } finally {
        if (!this._unloaded) this.setData({ loading: false, refreshing: false });
        wx.stopPullDownRefresh();
        this._loading = null;
      }
    })();
    return this._loading;
  },

  onPullDownRefresh() { return this.loadRecords(true); },
  retry() { return this.loadRecords(true); },

  updateView() {
    const view = buildView(this._records, this.data, this._limit);
    view.visibleRecords = view.visibleRecords.map(record => this._failedImages.has(record._id)
      ? Object.assign({}, record, { imageUrl: '' }) : record);
    this.setData(view);
  },

  changeFilters(values) {
    this._limit = PAGE_SIZE;
    this.setData(values);
    this.updateView();
  },

  onSearch(event) { this.changeFilters({ keyword: event.detail.value }); },
  clearSearch() { this.changeFilters({ keyword: '' }); },
  resetFilters() { this.changeFilters({ keyword: '', status: '', location: '' }); },

  chooseView() {
    if (this._choosingView) return;
    this._choosingView = true;
    wx.showActionSheet({
      itemList: ['卡片显示', '表格显示'],
      success: result => { if (!this._unloaded) this.setViewMode(['card', 'table'][result.tapIndex]); },
      complete: () => { this._choosingView = false; }
    });
  },

  setViewMode(mode) {
    if ((mode !== 'card' && mode !== 'table') || mode === this.data.viewMode) return;
    this.setData({ viewMode: mode });
    try { wx.setStorageSync('equipment-view-mode', mode); } catch (_) { /* Keep the current selection. */ }
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  imageFailed(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this._failedImages.has(id)) return;
    this._failedImages.add(id);
    this.updateView();
  },

  openFilter() {
    this.setData({ filterOpen: true, draftStatus: this.data.status, draftLocation: this.data.location });
  },
  closeFilter() { this.setData({ filterOpen: false }); },
  stopTap() {},
  setDraftStatus(event) { this.setData({ draftStatus: event.currentTarget.dataset.value }); },
  setDraftLocation(event) { this.setData({ draftLocation: event.currentTarget.dataset.value }); },
  resetDraft() { this.setData({ draftStatus: '', draftLocation: '' }); },
  applyFilter() {
    this.changeFilters({ status: this.data.draftStatus, location: this.data.draftLocation, filterOpen: false });
  },

  onReachBottom() { this.loadMore(); },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return;
    this._limit += PAGE_SIZE;
    this.updateView();
  },

  openDetail(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/equipment/detail?id=' + encodeURIComponent(id),
      fail() { wx.showToast({ title: '页面打开失败，请重试', icon: 'none' }); } });
  }
});
