const previews = require('../../services/home-previews');
Component({
  data: { slides: previews.slides(), current: 0, autoplay: true, error: '' },
  lifetimes: {
    attached() { this._visible = true; this.startLive(); this.load(); },
    detached() { this._detached = true; this._epoch = (this._epoch || 0) + 1; this.stopLive(); this.clearCovers(); }
  },
  pageLifetimes: {
    show() { this._visible = true; this.setData({ autoplay: true }); this.startLive(); if (this._initialized) this.load(); },
    hide() { this._visible = false; this._epoch = (this._epoch || 0) + 1; this.setData({ autoplay: false }); this.stopLive(); this.clearCovers(); }
  },
  methods: {
    startLive() {
      if (!this._unsubscribe) this._unsubscribe = previews.subscribe(() => this.load(true));
      if (!this._unsubscribeMembers) this._unsubscribeMembers = previews.subscribeMembers(() => {
        this._epoch = (this._epoch || 0) + 1; this.clearCovers(); this.setData({ slides: previews.slides(), current: 0 }); this.load(true);
      });
    },
    stopLive() {
      if (this._unsubscribe) this._unsubscribe();
      if (this._unsubscribeMembers) this._unsubscribeMembers();
      this._unsubscribe = this._unsubscribeMembers = null;
    },
    async clearCovers() {
      const paths = this._paths || []; this._paths = []; this._covers = new Map(); this._pending = new Set();
      for (const path of paths) await previews.removeLocal(path);
    },
    async load(force = false) {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      try {
        const result = await previews.load(force === true);
        if (this._detached || !this._visible || epoch !== this._epoch) return;
        const slides = previews.slides(result.items), previous = this.data.slides[this.data.current];
        const index = slides.findIndex(row => previous && row.id === previous.id);
        for (const row of slides) if (row.cover && this._covers && this._covers.has(row.cover.id)) row.image = this._covers.get(row.cover.id);
        this.setData({ slides, current: index < 0 ? 0 : index, error: result.warning || '' });
        this._initialized = true; this.loadVisibleCovers();
      } catch (error) {
        if (!this._detached && this._visible && epoch === this._epoch) {
          this.clearCovers(); this.setData({ slides: previews.slides(), current: 0, error: error.message || '分享预览暂时无法加载。' });
          this._initialized = true;
        }
      }
    },
    async loadCover(row) {
      if (!row || !row.cover || this._detached || !this._visible) return;
      this._pending = this._pending || new Set(); this._covers = this._covers || new Map();
      if (this._pending.has(row.cover.id) || this._covers.has(row.cover.id)) return;
      const pending = this._pending, epoch = this._epoch; pending.add(row.cover.id);
      try {
        const path = await previews.download(row.id, row.cover, row.type);
        if (this._detached || !this._visible || epoch !== this._epoch) { await previews.removeLocal(path); return; }
        this._covers.set(row.cover.id, path); this._paths = (this._paths || []).concat(path);
        const index = this.data.slides.findIndex(item => item.id === row.id && item.cover && item.cover.id === row.cover.id);
        if (index >= 0) this.setData({ ['slides[' + index + '].image']: path });
      } catch (_) { /* The local illustration keeps the card readable if the cover cannot load. */ }
      finally {
        pending.delete(row.cover.id);
        if (!this._detached && this._visible && epoch !== this._epoch) this.loadVisibleCovers();
      }
    },
    loadVisibleCovers() {
      const { slides, current } = this.data;
      this.loadCover(slides[current]); this.loadCover(slides[(current + 1) % slides.length]);
    },
    changeSlide(event) {
      const current = event.detail.current;
      if (!Number.isInteger(current) || current < 0 || current >= this.data.slides.length) return;
      this.setData({ current }); this.loadVisibleCovers();
    },
    retry() { return this.load(true); },
    openSlide(event) {
      const row = this.data.slides.find(item => item.id === event.currentTarget.dataset.id);
      if (!row) return;
      if (row.type === 'challenge') wx.navigateTo({ url: '/pages/module/index?id=ai-challenge' + (/^ce_[a-f0-9]{32}$/.test(row.id) ? '&event=' + row.id : '') });
      else if (row.empty) wx.navigateTo({ url: '/pages/module/index?id=weekly-sharing' });
      else if (/^sh_20\d{6}$/.test(row.id)) wx.navigateTo({ url: '/pages/module/index?id=weekly-sharing&task=' + row.id });
    }
  }
});
