// No application .env, database, or provider connections are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const config = require('../vercel.json');

test('the mail route cold-starts with Vercel ESM interoperability enabled', () => {
  // Reproduce Vercel's disabled default, then apply the configured opt-in.
  const options = (config.env?.NODE_OPTIONS || '').split(/\s+/).filter(Boolean);
  const startup = spawnSync(process.execPath, ['--no-experimental-require-module', ...options, '-e', `
    const assert = require('node:assert/strict');
    const router = require('./src/routes/mailRoutes');
    const { formatMailBody } = require('./src/services/mailHtml');
    assert.equal(typeof router, 'function');
    const result = formatMailBody({ html: '<p>Hello <b>world</b></p><script>bad()</script>' });
    assert.ok(result.html.includes('<b>world</b>'));
    assert.ok(!result.html.includes('<script>'));
    console.log('Mail cold start passed');
  `], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_OPTIONS: config.env.NODE_OPTIONS },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(startup.error, undefined);
  assert.equal(startup.status, 0, startup.stderr || startup.stdout);
  assert.match(startup.stdout, /Mail cold start passed/);
});
