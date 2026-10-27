const { randomUUID } = require('node:crypto');
const MAX = 5 * 1024 * 1024;
module.exports = cloud => ({
  async read(fileID) {
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const file = (result.fileList || []).find(f => f.fileID === fileID && f.status === 0 && /^https:\/\//.test(f.tempFileURL));
    if (!file) throw new Error('Upload cannot be read');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(file.tempFileURL, { signal: controller.signal, redirect: 'error', headers: { Range: 'bytes=0-' + MAX } });
      if (![200, 206].includes(response.status) || Number(response.headers.get('content-length')) > MAX) throw new Error('Upload exceeds file limit');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX) { controller.abort(); throw new Error('Upload exceeds file limit'); }
        chunks.push(Buffer.from(chunk));
      }
      // A partial response must represent the entire object, never a truncated large file.
      const range = response.headers.get('content-range');
      if (response.status === 206 && (!range || Number(range.split('/').pop()) !== size)) throw new Error('Incomplete upload');
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  },
  async freeze(bytes, ext) {
    // Private server-owned copy: the uploader must not be able to overwrite/delete submitted versions.
    const result = await cloud.uploadFile({ cloudPath: 'weekly-files/' + randomUUID() + '.' + ext, fileContent: bytes });
    return result.fileID;
  },
  async slice(fileID, offset, length, total) {
    const result = await cloud.getTempFileURL({ fileList: [fileID] });
    const file = (result.fileList || []).find(f => f.fileID === fileID && f.status === 0 && /^https:\/\//.test(f.tempFileURL));
    if (!file) throw new Error('File cannot be read');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(file.tempFileURL, { signal: controller.signal, redirect: 'error', headers: { Range: 'bytes=' + offset + '-' + (offset + length - 1) } });
      if (response.status !== 206 || response.headers.get('content-range') !== 'bytes ' + offset + '-' + (offset + length - 1) + '/' + total) throw new Error('Invalid file range');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > length) { controller.abort(); throw new Error('File range exceeds limit'); }
        chunks.push(Buffer.from(chunk));
      }
      if (size !== length) throw new Error('Incomplete file range');
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  }
});
