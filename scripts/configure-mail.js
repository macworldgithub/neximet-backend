// Generate a stable local secret without printing it or touching existing credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = path.resolve(__dirname, '../.env');
const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const match = previous.match(/^MAIL_ENCRYPTION_KEY=(.*)$/m);
if (match && /^[a-f\d]{64}$/i.test(match[1].trim())) {
  console.log('MAIL_ENCRYPTION_KEY is already configured. Existing key preserved.');
} else if (match && match[1].trim()) {
  throw new Error('MAIL_ENCRYPTION_KEY is set but invalid. Correct it manually; this script will not replace an existing secret.');
} else {
  const entry = `MAIL_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`;
  fs.writeFileSync(file, match ? previous.replace(/^MAIL_ENCRYPTION_KEY=.*$/m, entry) : `${previous}${previous.endsWith('\n') ? '' : '\n'}\n# Hostinger mailbox password encryption\n${entry}\n`, { mode: 0o600 });
  console.log('Configured MAIL_ENCRYPTION_KEY in backend/.env. Keep it private and use the same key in your deployment.');
}
