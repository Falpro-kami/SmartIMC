const LIMIT = 2 * 1024 * 1024;
const EXTENSIONS = ['jpg', 'jpeg', 'png'];
// Read image dimensions before accepting an image; SVG and arbitrary file payloads are not covers.
function dimensions(bytes, ext) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (ext === 'png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (!['jpg', 'jpeg'].includes(ext) || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218 || offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) return null;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}
function valid(bytes, ext) {
  const size = dimensions(bytes, ext);
  return !!size && bytes.length <= LIMIT && size.every(value => value > 0 && value <= 8192) && size[0] * size[1] <= 20000000;
}
module.exports = { LIMIT, EXTENSIONS, valid };
