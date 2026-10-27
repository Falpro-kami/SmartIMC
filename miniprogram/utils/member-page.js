const membership = require('../services/membership');
function wrap(definition, service = membership) {
  const wrapped = { ...definition, data: { ...definition.data, membershipAllowed: false } };
  const activate = page => {
    if (!page._memberVisible || page._memberActive || page._memberUnloaded) return;
    page._memberActive = true;
    page.setData({ membershipAllowed: true });
    if (!page._memberLoaded) {
      page._memberLoaded = true;
      page._memberEverLoaded = true;
      if (definition.onLoad) definition.onLoad.call(page, page._memberOptions || {});
    }
    return definition.onShow && definition.onShow.call(page);
  };
  wrapped.onLoad = function(options) { this._memberOptions = options; };
  wrapped.onShow = function() {
    this._memberVisible = true;
    this._memberActive = false;
    this._memberChecking = !service.current().approved;
    this.setData({ membershipAllowed: service.current().approved });
    if (!this._memberUnsubscribe) this._memberUnsubscribe = service.subscribe(state => {
      if (this._memberUnloaded) return;
      this._memberAllowed = state.approved;
      if (!state.approved) {
        if (state.phase !== 'checking') this._memberLoaded = false;
        this.setData({ membershipAllowed: false });
        if (this._memberActive && definition.onHide) definition.onHide.call(this);
        this._memberActive = false;
      } else if (this._memberVisible && !this._memberChecking) activate(this);
    });
    return service.ensure().then(state => { this._memberChecking = false; return state.approved && this._memberAllowed ? activate(this) : undefined; });
  };
  wrapped.onHide = function() {
    this._memberVisible = false;
    if (this._memberActive && definition.onHide) definition.onHide.call(this);
    this._memberActive = false;
  };
  wrapped.onUnload = function() {
    this._memberUnloaded = true;
    if (this._memberUnsubscribe) this._memberUnsubscribe();
    if (this._memberEverLoaded && definition.onUnload) definition.onUnload.call(this);
  };
  for (const [name, method] of Object.entries(definition)) {
    if (typeof method !== 'function' || !['onReachBottom', 'onPullDownRefresh', 'onShareAppMessage', 'onReady'].includes(name)) continue;
    wrapped[name] = function(...args) { if (this.data.membershipAllowed && this._memberActive) return method.apply(this, args); };
  }
  return wrapped;
}
module.exports = wrap;
