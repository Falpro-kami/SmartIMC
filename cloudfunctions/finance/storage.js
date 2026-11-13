const { randomUUID } = require('node:crypto');
const https = require('node:https');
const MAX = 8 * 1024 * 1024;
module.exports = (cloud, get = https.get) => {
  async function bytes(fileID, offset, length, total) {
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const file = (result.fileList || []).find(item => item.fileID === fileID && item.status === 0 && /^https:\/\//.test(item.tempFileURL));
    if (!file) throw new Error('File cannot be read');
    return new Promise((resolve, reject) => {
      const last = offset + length - 1;
      const request = get(file.tempFileURL, { headers: { Range: 'bytes=' + offset + '-' + last } }, response => {
        const chunks = []; let received = 0;
        const partial = total !== undefined;
        if (partial ? response.statusCode !== 206 || response.headers['content-range'] !== 'bytes ' + offset + '-' + last + '/' + total : ![200, 206].includes(response.statusCode)) {
          response.resume(); reject(new Error('Invalid file range')); return;
        }
        if (Number(response.headers['content-length']) > length) { response.destroy(); reject(new Error('File exceeds size limit')); return; }
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Incomplete file transfer')));
        response.on('data', chunk => {
          received += chunk.length;
          if (received > length) { response.destroy(); reject(new Error('File exceeds size limit')); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (partial && received !== length || !partial && response.statusCode === 206 && Number(String(response.headers['content-range']).split('/').pop()) !== received) {
            reject(new Error('Incomplete file transfer')); return;
          }
          resolve(Buffer.concat(chunks));
        });
      });
      request.on('error', reject);
      request.setTimeout(20000, () => request.destroy(new Error('File transfer timeout')));
    });
  }
  return {
    read: fileID => bytes(fileID, 0, MAX),
    async freeze(buffer, ext, name) {
      const key = randomUUID() + (name ? '/' + name : '.' + ext);
      const result = await cloud.uploadFile({ cloudPath: 'finance-files/' + key, fileContent: buffer });
      return result.fileID;
    },
    async remove(fileID) {
      try { await cloud.deleteFile({ fileList: [fileID] }); }
      catch (error) { console.warn('Finance storage cleanup failed', error.errCode || error.code || error.name); }
    },
    slice: (fileID, offset, length, total) => bytes(fileID, offset, length, total)
  };
};
