const access = require('./access');
const membership = require('./membership');
const cache = require('./session-cache');
const CHANNELS = ['home', 'messages', 'approvals', 'weekly', 'members'];
let running = false, epoch = 0, watcher = null, timer = null, flushTimer = null;
let connecting = false, polling = false, lastState = null, lastCheck = 0, retryAt = 0, failures = 0;
let active = false, identityRequest = null, unsubscribe = null, networkListener = null, watchEpoch = 0, lastPoll = 0;
let watchReady = false, watchStarted = 0;
const queued = new Set();
function closeWatch() {
  watchEpoch++;
  watchReady = false;
  const previous = watcher; watcher = null;
  if (previous) { try { Promise.resolve(previous.close()).catch(() => {}); } catch (_) {} }
}
function notify(channels) {
  channels.forEach(channel => queued.add(channel));
  if (flushTimer) return;
  const version = epoch;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!running || version !== epoch) return;
    const changes = Array.from(queued); queued.clear();
    // Refresh roles before visible lists decide whether the viewer can review/team-read.
    if (changes.includes('members')) {
      if (identityRequest) await identityRequest;
      if (!running || version !== epoch) return;
      await checkIdentity(true, true);
    }
    if (!running || version !== epoch || !active) return;
    cache.publish(changes);
    if (changes.includes('messages')) access.refreshUnread().catch(() => {});
  }, 150);
}
function accept(state, initial = false) {
  if (!state || CHANNELS.some(channel => typeof state[channel] !== 'string')) return;
  const changed = CHANNELS.filter(channel => initial || !lastState || lastState[channel] !== state[channel]);
  lastState = state;
  if (changed.length) notify(changed);
}
function watchFailed(version) {
  if (!running || version !== epoch) return;
  closeWatch();
  retryAt = Date.now() + Math.min(30000, 1000 * Math.pow(2, failures++));
  checkIdentity(true);
}
async function connect() {
  if (!running || !active || connecting || watcher || Date.now() < retryAt) return;
  connecting = true;
  const version = epoch;
  const connection = ++watchEpoch;
  try {
    const result = await access.sync('syncConnect');
    if (!running || version !== epoch || connection !== watchEpoch || !active) return;
    accept(result.state, !lastState);
    let failed = false;
    watchStarted = Date.now();
    const next = wx.cloud.database().collection('teamSync').doc('IMC').watch({
      onChange(snapshot) {
        if (!running || version !== epoch || connection !== watchEpoch || failed) return;
        failures = 0;
        watchReady = true;
        const row = snapshot.docs && snapshot.docs[0];
        if (row) accept(row); else { failed = true; watchFailed(version); }
      },
      onError() { if (connection !== watchEpoch) return; failed = true; watchFailed(version); }
    });
    if (failed || !running || version !== epoch || connection !== watchEpoch) { try { Promise.resolve(next.close()).catch(() => {}); } catch (_) {} }
    else watcher = next;
  } catch (_) { if (connection === watchEpoch) watchFailed(version); }
  finally { if (version === epoch) connecting = false; }
}
function checkIdentity(force = false, afterChange = false) {
  if (identityRequest) return identityRequest;
  const version = epoch;
  lastCheck = Date.now();
  identityRequest = (afterChange ? access.refreshIdentity() : access.get(force)).then(result => {
    if (!running || version !== epoch) return;
    membership.accept(result);
  }).catch(() => {}).finally(() => { if (version === epoch) identityRequest = null; });
  return identityRequest;
}
async function tick() {
  const version = epoch;
  if (!running) return;
  if (Date.now() - lastCheck >= 30000) checkIdentity(true);
  if (watcher && !watchReady && Date.now() - watchStarted >= 10000) watchFailed(version);
  // A failed watch falls back to one small authorized cursor read, never a full page reload.
  if (active && (!watcher || !watchReady || Date.now() - lastPoll >= 30000) && !polling) {
    polling = true;
    lastPoll = Date.now();
    try {
      const result = await access.sync('syncState');
      if (running && version === epoch) accept(result.state);
    } catch (_) { checkIdentity(true); }
    finally { if (version === epoch) polling = false; }
  }
  if (!running || version !== epoch) return;
  connect();
  timer = setTimeout(tick, 5000);
}
function start() {
  if (running || !getApp().globalData.cloudReady) return;
  running = true; epoch++; lastCheck = 0; retryAt = 0; lastPoll = Date.now();
  unsubscribe = membership.subscribe(state => {
    const wasActive = active; active = state.approved;
    if (active) { if (!wasActive) { lastState = null; connect(); } }
    else { closeWatch(); lastState = null; }
  });
  networkListener = status => { if (status.isConnected && running) { retryAt = 0; closeWatch(); notify(CHANNELS); checkIdentity(true); connect(); } };
  if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(networkListener);
  checkIdentity(false); tick();
}
function stop() {
  running = false; epoch++; closeWatch();
  clearTimeout(timer); clearTimeout(flushTimer); timer = flushTimer = null;
  queued.clear(); lastState = null; connecting = polling = false; identityRequest = null; active = false;
  if (unsubscribe) unsubscribe(); unsubscribe = null;
  if (networkListener && wx.offNetworkStatusChange) wx.offNetworkStatusChange(networkListener);
  networkListener = null;
}
module.exports = { start, stop };
