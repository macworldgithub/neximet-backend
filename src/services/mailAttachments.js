const sharp = require('sharp');

const MAX_PREVIEWS = 20;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 1024 * 1024;

// Check file bytes rather than trusting sender-controlled filenames or MIME types.
// In particular, SVG/HTML attachments must never become browser image sources.
function isRasterImage(content) {
  if (!Buffer.isBuffer(content) || content.length < 12) return false;
  return content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || content.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    || /^GIF8[79]a$/.test(content.toString('ascii', 0, 6))
    || (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP')
    || (content.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(content.toString('ascii', 8, 12)))
    || ['49492a00', '4d4d002a'].includes(content.subarray(0, 4).toString('hex'));
}

async function attachmentPreviews(attachments = []) {
  let remainingBytes = MAX_TOTAL_PREVIEW_BYTES, attempts = 0;
  const result = [];
  for (const attachment of attachments) {
    const raster = isRasterImage(attachment.content);
    const item = {
      filename: attachment.filename || 'Attachment',
      size: attachment.size,
      contentType: attachment.contentType || 'application/octet-stream',
      inline: attachment.contentDisposition === 'inline' || !!attachment.related,
      isImage: raster || /^image\//i.test(attachment.contentType || ''),
    };
    if (raster && attempts++ < MAX_PREVIEWS && remainingBytes > 0) {
      try {
        // Decode only the first frame, orient photos, and strip metadata. Keep both
        // decoded pixels and response bytes bounded for serverless/API limits.
        let { data, info } = await sharp(attachment.content, { limitInputPixels: 25000000, animated: false })
          .rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75 }).timeout({ seconds: 3 }).toBuffer({ resolveWithObject: true });
        if (data.length > Math.min(MAX_PREVIEW_BYTES, remainingBytes)) {
          ({ data, info } = await sharp(data)
            .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 60 }).timeout({ seconds: 3 }).toBuffer({ resolveWithObject: true }));
        }
        if (data.length <= Math.min(MAX_PREVIEW_BYTES, remainingBytes)) {
          item.preview = { dataUrl: `data:image/webp;base64,${data.toString('base64')}`, width: info.width, height: info.height };
          remainingBytes -= data.length;
        }
      } catch { /* A broken/unsupported image must not prevent opening its email. */ }
    }
    result.push(item);
  }
  return result;
}

module.exports = { attachmentPreviews };
