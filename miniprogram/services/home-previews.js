const sharing = require('./sharing');
const cache = require('./session-cache');
const challengeService = require('./challenge');
const WEEKLY_IMAGE = '/assets/home/weekly-preview.png';
const CHALLENGE_IMAGE = '/assets/home/challenge-preview.png';
const challenge = { id: 'challenge-placeholder', type: 'challenge', title: 'AI 挑战赛', category: '赛事动态',
  subtitle: '暂无进行中的赛事', image: CHALLENGE_IMAGE, empty: true };
function slides(items = []) {
  const weekly = items.filter(item => item.type === 'sharing' && /^sh_20\d{6}$/.test(item.id) && typeof item.title === 'string' && item.title.trim())
    .slice(0, 4).map(item => ({ ...item, category: '每周分享', subtitle: '团队新分享 · 点击查看', image: WEEKLY_IMAGE }));
  if (!weekly.length) weekly.push({ id: 'sharing-empty', type: 'sharing', category: '每周分享', title: '新的分享，正在准备中',
    subtitle: '发现新想法，一起交流与成长', image: WEEKLY_IMAGE, empty: true });
  const events = items.filter(item => item.type === 'challenge' && /^ce_[a-f0-9]{32}$/.test(item.id) && typeof item.title === 'string' && item.title.trim())
    .slice(0, 4).map(item => ({ ...item, category: 'AI 挑战赛', subtitle: '进行中 · 点击查看赛事', image: CHALLENGE_IMAGE }));
  return weekly.concat(events.length ? events : [{ ...challenge }]);
}
module.exports = { slides,
  load: (force = false) => cache.load('home:previews', async () => {
    const results = await Promise.allSettled([sharing.call('previews'), challengeService.call('previews')]);
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    return { items: results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []), warning: results.some(result => result.status === 'rejected') ? '部分动态暂时无法加载。' : '' };
  }, 30000, force),
  download: (id, cover, type) => type === 'challenge' ? challengeService.download(id, cover) : sharing.download(id, cover), removeLocal: sharing.removeLocal,
  subscribe: listener => cache.subscribe('home', listener), subscribeMembers: sharing.subscribeMembers };
