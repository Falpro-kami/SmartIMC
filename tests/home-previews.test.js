const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const previews = require('../miniprogram/services/home-previews');
function widget(service = {}, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/home-preview/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: () => ({ ...previews, ...service }), wx
  });
  const instance = { data: structuredClone(definition.data), _visible: true,
    setData(data) { for (const [key, value] of Object.entries(data)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value;
    } }
  };
  for (const [name, method] of Object.entries(definition.methods)) instance[name] = method.bind(instance);
  return { instance, definition };
}
const entry = { id: 'sh_20261102', type: 'sharing', title: '负责人确定的主题', cover: { id: 'sf_' + 'a'.repeat(32), size: 100, ext: 'png' } };

test('没有已审批分享时保留空态与赛事示意图，真实分享使用负责人提交的标题', () => {
  const empty = previews.slides([]);
  assert.equal(empty.length, 2); assert.equal(empty[0].empty, true); assert.equal(empty[1].empty, true);
  assert.equal(empty[1].category, '赛事动态');
  const actual = previews.slides([entry]);
  assert.equal(actual[0].title, entry.title); assert.equal(actual[0].empty, undefined);
  assert.equal(previews.slides([{ ...entry, id: 'unsafe' }])[0].empty, true);
});

test('轮播变化按当前及下一张加载封面，封面失败不影响标题或首页其他模块', async () => {
  let downloads = 0;
  const { instance } = widget({ download: async () => { downloads++; throw new Error('offline'); } });
  instance.setData({ slides: previews.slides([entry]) });
  await instance.loadCover(instance.data.slides[0]);
  assert.equal(downloads, 1); assert.equal(instance.data.slides[0].title, entry.title);
  instance.changeSlide({ detail: { current: 1 } });
  assert.equal(instance.data.current, 1);
});

test('离开首页后停止自动播放并删除封面；延迟完成的下载不会恢复图片', async () => {
  const removed = []; let finish;
  const { instance, definition } = widget({ download: () => new Promise(resolve => { finish = resolve; }), removeLocal: async path => removed.push(path) });
  instance.setData({ slides: previews.slides([entry]) });
  const request = instance.loadCover(instance.data.slides[0]);
  definition.pageLifetimes.hide.call(instance);
  assert.equal(instance.data.autoplay, false);
  finish('/tmp/late-cover.png'); await request;
  assert.deepEqual(removed, ['/tmp/late-cover.png']);
  assert.match(instance.data.slides[0].image, /^\/assets\//);
});

test('旧查询不覆盖刷新结果，读取失败移除旧的分享预览', async () => {
  let finish, calls = 0;
  const { instance } = widget({ load: () => { calls++; return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ items: [] }); } });
  const old = instance.load(); await instance.load(true);
  finish({ items: [entry] }); await old;
  assert.equal(instance.data.slides[0].empty, true);
  const failed = widget({ load: async () => { throw new Error('denied'); } }).instance;
  failed.setData({ slides: previews.slides([entry]) }); await failed.load();
  assert.equal(failed.data.slides[0].empty, true); assert.equal(failed.data.error, 'denied');
});

test('分享预览直达审批内容，赛事示意图进入现有挑战赛入口', () => {
  const urls = [], { instance } = widget({}, { navigateTo: value => urls.push(value.url) });
  instance.setData({ slides: previews.slides([entry]) });
  instance.openSlide({ currentTarget: { dataset: { id: entry.id } } });
  instance.openSlide({ currentTarget: { dataset: { id: 'challenge-placeholder' } } });
  instance.openSlide({ currentTarget: { dataset: { id: 'unknown' } } });
  assert.deepEqual(urls, ['/pages/module/index?id=weekly-sharing&task=sh_20261102', '/pages/module/index?id=ai-challenge']);
});

test('真实挑战赛封面与标题进入轮播并直达赛事，替代空态', () => {
  const urls = [], row = { id: 'ce_' + 'f'.repeat(32), type: 'challenge', title: '实际赛事标题', cover: { id: 'cf_' + 'a'.repeat(32), size: 100, ext: 'png' } };
  const { instance } = widget({}, { navigateTo: value => urls.push(value.url) });
  instance.setData({ slides: previews.slides([entry, row]) });
  assert.equal(instance.data.slides.length, 2); assert.equal(instance.data.slides[1].title, row.title);
  instance.openSlide({ currentTarget: { dataset: { id: row.id } } });
  assert.equal(urls[0], '/pages/module/index?id=ai-challenge&event=' + row.id);
});
