// Generates persistent VAPID keys locally; never prints the private key.
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const dotenv = require('dotenv');
const file = path.join(__dirname, '..', '.env');
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const existing = dotenv.parse(source);
if (existing.WEB_PUSH_VAPID_PUBLIC_KEY && existing.WEB_PUSH_VAPID_PRIVATE_KEY) {
  if (!existing.WEB_PUSH_SUBJECT) fs.appendFileSync(file, '\nWEB_PUSH_SUBJECT=https://neximet.com\n');
  console.log('Existing Web Push keys preserved.');
} else {
  const keys = webpush.generateVAPIDKeys();
  const clean = source.replace(/^WEB_PUSH_(VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|SUBJECT)=.*\r?\n?/gm, '').trimEnd();
  fs.writeFileSync(file, `${clean}\nWEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}\nWEB_PUSH_SUBJECT=https://neximet.com\n`);
  console.log('Web Push keys saved in backend/.env. Restart the existing backend process with its updated environment. Keep the private key secret.');
}
