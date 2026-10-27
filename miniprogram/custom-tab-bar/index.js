const tabs = require('../config/tabs');

Component({
  data: { selected: 0, list: tabs },
  lifetimes: { attached() { this.syncRoute(); } },
  pageLifetimes: { show() { this.syncRoute(); } },
  methods: {
    syncRoute() {
      const pages = getCurrentPages();
      const current = pages[pages.length - 1];
      const selected = current ? tabs.findIndex(tab => tab.pagePath === current.route) : -1;
      if (selected >= 0) this.setData({ selected });
    },
    switchTab(event) {
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
