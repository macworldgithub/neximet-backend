const crypto = require('node:crypto');

function encryptionKey() {
  const value = process.env.MAIL_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw Object.assign(new Error('Mail is not configured on the server. Set MAIL_ENCRYPTION_KEY to a 64-character hex secret.'), { status: 503 });
  }
  return Buffer.from(value, 'hex');
}

function encryptPassword(password, userId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(String(userId)));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptPassword(value, userId) {
  const key = encryptionKey();
  try {
    const [version, iv, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted value');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(String(userId)));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw Object.assign(new Error('Unable to unlock this mailbox. Reconnect it in Mail settings.'), { status: 503 });
  }
}

module.exports = { encryptionKey, encryptPassword, decryptPassword };
