const crypto = require('node:crypto');

function encryptionKey() {
  const value = process.env.AI_ENCRYPTION_KEY || process.env.MAIL_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) throw Object.assign(new Error('AI connections need a server encryption key. Ask your administrator to configure it.'), { status: 503 });
  return Buffer.from(value, 'hex');
}
function encryptKey(secret, user, provider) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`ai:${user}:${provider}`));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
function decryptKey(value, user, provider) {
  const key = encryptionKey();
  try {
    const [version, iv, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    cipher.setAAD(Buffer.from(`ai:${user}:${provider}`));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]).toString('utf8');
  } catch {
    throw Object.assign(new Error('Reconnect this provider in AI connections.'), { status: 503 });
  }
}
module.exports = { encryptionKey, encryptKey, decryptKey };
