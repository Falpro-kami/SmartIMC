const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const createStorage = require('../cloudfunctions/weeklySharing/storage');
function storage(code, headers, data) {
  const cloud = { getTempFileURL: async () => ({ fileList: [{ fileID: 'file', status: 0, tempFileURL: 'https://example.invalid/file' }] }) };
  return createStorage(cloud, (url, options, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = error => request.emit('error', error);
    const response = Readable.from([Buffer.from(data)]); response.statusCode = code; response.headers = headers;
    process.nextTick(() => callback(response));
    return request;
  });
}
test('HTTPS 文件代理可在旧运行时读取完整文件及经校验的分块', async () => {
  assert.equal((await storage(200, { 'content-length': '3' }, 'pdf').read('file')).toString(), 'pdf');
  assert.equal((await storage(206, { 'content-range': 'bytes 1-2/3', 'content-length': '2' }, 'df').slice('file', 1, 2, 3)).toString(), 'df');
});
test('文件代理拒绝错误分块、截断内容及服务端重定向', async () => {
  await assert.rejects(storage(206, { 'content-range': 'bytes 0-1/3' }, 'ab').slice('file', 1, 2, 3));
  await assert.rejects(storage(206, { 'content-range': 'bytes 1-2/3' }, 'd').slice('file', 1, 2, 3));
  await assert.rejects(storage(302, {}, '').read('file'));
});
