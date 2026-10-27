const tabs = require('../config/tabs');
const membership = require('../services/membership');

Component({
  data: { selected: 0, list: tabs, authorized: false },
  lifetimes: { attached() { this.syncRoute(); this._unsubscribe = membership.subscribe(state => this.setData({ authorized: state.approved })); }, detached() { if (this._unsubscribe) this._unsubscribe(); } },
  pageLifetimes: { show() { this.syncRoute(); } },
  methods: {
    syncRoute() {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      const selected = current ? tabs.findIndex(tab => tab.pagePath === current.route) : -1;
      if (selected >= 0) this.setData({ selected });
    },
    switchTab(event) {
      if (!this.data.authorized) return;
      const index = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(index) || !tabs[index] || index === this.data.selected || this._switching) return;
      this._switching = true;
      wx.switchTab({
        url: '/' + tabs[index].pagePath,
        fail() { wx.showToast({ title: '页面切换失败，请重试', icon: 'none' }); },
        complete: () => { this._switching = false; }
      });
    }
  }
});
