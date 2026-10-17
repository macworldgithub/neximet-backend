const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const webpush = require('web-push');

function prepare(source) {
  const values = dotenv.parse(source);
  const changes = {};
  const random = () => crypto.randomBytes(32).toString('hex');
  if (!values.JWT_SECRET) changes.JWT_SECRET = random();
  if (!values.MAIL_ENCRYPTION_KEY) changes.MAIL_ENCRYPTION_KEY = random();
  // Existing AI connections may already use the mail key as their fallback.
  if (!values.AI_ENCRYPTION_KEY) changes.AI_ENCRYPTION_KEY = values.MAIL_ENCRYPTION_KEY || changes.MAIL_ENCRYPTION_KEY;
  if (!!values.WEB_PUSH_VAPID_PUBLIC_KEY !== !!values.WEB_PUSH_VAPID_PRIVATE_KEY) throw new Error('Partial VAPID configuration found. Restore the original matching pair; existing keys were preserved.');
  if (!values.WEB_PUSH_VAPID_PUBLIC_KEY) {
    const pair = webpush.generateVAPIDKeys();
    changes.WEB_PUSH_VAPID_PUBLIC_KEY = pair.publicKey;
    changes.WEB_PUSH_VAPID_PRIVATE_KEY = pair.privateKey;
  }
  if (!values.WEB_PUSH_SUBJECT) changes.WEB_PUSH_SUBJECT = 'https://portal.neximet.com';
  let output = source;
  for (const [key, value] of Object.entries(changes)) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    output = line.test(output) ? output.replace(line, `${key}=${value}`) : `${output.trimEnd()}\n${key}=${value}\n`;
  }
  return { output, changed: Object.keys(changes) };
}
if (require.main === module) {
  const file = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(file)) throw new Error('Create backend/.env from .env.production.example, or securely copy your existing production .env first.');
  const { output, changed } = prepare(fs.readFileSync(file, 'utf8'));
  if (changed.length) fs.writeFileSync(file, output, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  console.log(changed.length ? `Configured missing values: ${changed.join(', ')}. Existing secrets preserved; no secret values printed.` : 'Existing production secrets preserved.');
}
module.exports = { prepare };
