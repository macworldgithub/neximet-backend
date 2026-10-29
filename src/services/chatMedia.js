const path = require('node:path');
const FILE_LIMIT = 100 * 1024 * 1024;
const VIDEO_LIMIT = FILE_LIMIT;
const MAX_FILES = 20;
const images = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const videos = new Set(['.mp4', '.m4v', '.mov', '.webm']);
function mediaType(data) {
  if (!Buffer.isBuffer(data)) return null;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') {
    const brand = data.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) return 'video/mp4';
  }
  if (data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && data.subarray(0, 4096).includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}
function attachment(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const video = videos.has(extension), image = images.has(extension);
  if (file.size > FILE_LIMIT) throw Object.assign(Error('Attachments must total 100 MB or smaller per message'), { status: 400 });
  const detected = mediaType(file.buffer);
  if ((image && !detected?.startsWith('image/')) || (video && !detected?.startsWith('video/'))) throw Object.assign(Error('This media file could not be recognized. Use a valid PNG, JPEG, GIF, WebP, MP4, MOV, or WebM file.'), { status: 400 });
  return { name: file.originalname.replace(/[\r\n\x00]/g, '').slice(0, 200), size: file.size, mimeType: detected || file.mimetype, data: file.buffer };
}
module.exports = { attachment, mediaType, videos, VIDEO_LIMIT, FILE_LIMIT, MAX_FILES };
