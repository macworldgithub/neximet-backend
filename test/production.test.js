// No .env, production database, real mailbox or AI provider is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { runtimeConfig, validateProduction, originAllowed } = require('../src/config/runtime');
const { createApp } = require('../src/app');
const { createScopeHandler, canReadProject } = require('../src/services/scopeDocuments');
const { verifyDatabase, startServer } = require('../src/lifecycle');
const { prepare } = require('../scripts/setup-production-env');
const dotenv = require('dotenv');

const environment = () => ({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:27017/isolated?replicaSet=test', JWT_SECRET: 'a'.repeat(64), MAIL_ENCRYPTION_KEY: 'b'.repeat(64) });
async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('production fails closed on missing/weak secrets, invalid origin lists and invalid ports', () => {
  const config = validateProduction(environment()); assert.equal(config.port, 4052); assert.equal(config.host, '127.0.0.1'); assert.equal(config.trustProxy, 'loopback');
  for (const changes of [{ MONGODB_URI: '' }, { JWT_SECRET: 'short' }, { JWT_SECRET: 'neximet_super_secret_jwt_key_2026_enterprise_portal' }, { MAIL_ENCRYPTION_KEY: 'invalid' }, { AI_ENCRYPTION_KEY: 'invalid' }, { CEO_MASTER_KEY: 'NEXIMET-CEO-2026-RECOVERY' }, { PORT: 0 }, { PORT: 65536 }, { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'http://portal.neximet.com' }, { CORS_ORIGINS: 'https://portal.neximet.com/path' }, { TRUST_PROXY: 'true' }, { WEB_PUSH_VAPID_PUBLIC_KEY: 'partial' }]) assert.throws(() => validateProduction({ ...environment(), ...changes }));
});

test('browser origins match exactly; non-browser authenticated clients remain possible', () => {
  const config = runtimeConfig(environment());
  for (const origin of [undefined, 'https://portal.neximet.com', 'https://www.portal.neximet.com']) assert.equal(originAllowed(origin, config), true);
  for (const origin of ['null', 'https://evil.test', 'https://portal.neximet.com.evil.test', 'https://portal.neximet.com:9999']) assert.equal(originAllowed(origin, config), false);
});

test('health distinguishes liveness, database readiness and draining; CORS preflight survives a database outage', async t => {
  let calls = 0, unavailable = false;
  const config = runtimeConfig(environment());
  const app = createApp({ config, connect: async () => { calls++; if (unavailable) throw new Error('private connection details'); }, database: { connection: { db: { admin: () => ({ command: async () => ({ ok: 1 }) }) } } } });
  const base = await listen(t, app);
  unavailable = true;
  assert.equal((await fetch(base + '/health/live')).status, 200); assert.equal(calls, 0);
  const preflight = await fetch(base + '/api/auth/login', { method: 'OPTIONS', headers: { Origin: 'https://portal.neximet.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(preflight.status, 204); assert.equal(calls, 0);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://portal.neximet.com');
  const bad = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.test' } });
  assert.equal(bad.status, 403); assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const down = await fetch(base + '/api/health'); assert.equal(down.status, 503); assert.equal((await down.text()).includes('private connection details'), false);
  unavailable = false;
  const ready = await fetch(base + '/api/health'); assert.equal(ready.status, 200); assert.equal(ready.headers.get('cache-control'), 'no-store'); assert.equal(ready.headers.get('x-powered-by'), null);
  assert.equal((await fetch(base + '/uploads/scopes/private.pdf')).status, 401);
  assert.equal((await fetch(base + '/uploads/arbitrary.txt')).status, 404);
  app.locals.draining = true;
  assert.equal((await fetch(base + '/api/health')).status, 503); assert.equal((await fetch(base + '/health/live')).status, 200);
  assert.equal((await fetch(base + '/api/auth/me')).status, 503);
});

test('production startup requires a transaction-capable database and initializes unique indexes', async () => {
  let indexes = 0;
  const connection = hello => ({ db: { admin: () => ({ command: async () => hello }) }, models: { User: { init: async () => indexes++ } } });
  await assert.rejects(() => verifyDatabase(connection({}), { production: true }), /replica set/);
  await verifyDatabase(connection({ setName: 'production' }), { production: true }); assert.equal(indexes, 1);
  await verifyDatabase(connection({ msg: 'isdbgrid' }), { production: true }); assert.equal(indexes, 2);
});

test('secret setup preserves existing credentials and the AI mail-key fallback across migrations', () => {
  const first = prepare('JWT_SECRET=existing-secret\nMAIL_ENCRYPTION_KEY=' + 'c'.repeat(64) + '\nAI_ENCRYPTION_KEY=\n');
  const values = dotenv.parse(first.output);
  assert.equal(values.JWT_SECRET, 'existing-secret'); assert.equal(values.MAIL_ENCRYPTION_KEY, 'c'.repeat(64)); assert.equal(values.AI_ENCRYPTION_KEY, values.MAIL_ENCRYPTION_KEY);
  const second = prepare(first.output); assert.deepEqual(second.changed, []); assert.equal(second.output, first.output);
  assert.throws(() => prepare('WEB_PUSH_VAPID_PUBLIC_KEY=partial\n'), /Partial VAPID/);
  const fresh = dotenv.parse(prepare('').output); assert.equal(fresh.JWT_SECRET.length, 64); assert.equal(fresh.MAIL_ENCRYPTION_KEY.length, 64);
});

test('a PM2 shutdown drains the HTTP server and disconnects the database exactly once', async () => {
  const app = express(); app.get('/', (req, res) => res.end('ready'));
  let disconnected = 0;
  const database = { connection: { db: { admin: () => ({ command: async () => ({ setName: 'test' }) }) }, models: {} }, disconnect: async () => disconnected++ };
  const running = await startServer(app, { config: { port: 0, host: '127.0.0.1', production: true }, connect: async () => {}, mongoose: database, createRealtimeServer: app => {
    const server = require('node:http').createServer(app);
    return { server, io: { close: done => server.close(done) } };
  } });
  const response = await fetch('http://127.0.0.1:' + running.server.address().port); assert.equal(await response.text(), 'ready');
  const first = running.shutdown('test'); assert.equal(app.locals.draining, true); assert.equal(running.shutdown('duplicate'), first);
  await first; assert.equal(disconnected, 1); assert.equal(running.server.listening, false);
});

test('scope downloads enforce project membership and return private binary content', async t => {
  const owner = { _id: 'owner', role: 'Team Member', department: 'Software Development' };
  const project = { department: 'Graphics Designing', assignedMembers: [{ user: 'owner' }], scopeDocuments: [{ fileName: 'scope.pdf', originalName: 'Scope.pdf', fileData: Buffer.from('%PDF-private').toString('base64') }] };
  assert.equal(canReadProject(owner, project), true); assert.equal(canReadProject({ ...owner, _id: 'stranger' }, project), false);
  let current = owner;
  const app = express(); app.use((req, res, next) => { req.user = current; next(); });
  app.get('/uploads/scopes/:filename', createScopeHandler({ Project: { findOne: async () => project }, uploadRoot: require('node:path').resolve(__dirname, 'fixtures/nonexistent-scope-dir') }));
  const base = await listen(t, app);
  const file = await fetch(base + '/uploads/scopes/scope.pdf'); assert.equal(file.status, 200); assert.equal(await file.text(), '%PDF-private');
  assert.equal(file.headers.get('cache-control'), 'private, no-store'); assert.equal(file.headers.get('content-type'), 'application/pdf');
  current = { ...owner, _id: 'stranger' }; assert.equal((await fetch(base + '/uploads/scopes/scope.pdf')).status, 404);
  current = { ...owner, role: 'CEO' }; assert.equal((await fetch(base + '/uploads/scopes/scope.pdf')).status, 200);
  project.scopeDocuments[0].fileData = '';
  const missing = await fetch(base + '/uploads/scopes/scope.pdf'); assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal((await fetch(base + '/uploads/scopes/a..pdf')).status, 400);
});

test('PM2 config pins single loopback processes on the requested ports with ESM support', () => {
  const backend = require('../ecosystem.config').apps[0];
  assert.equal(backend.env.PORT, '4052'); assert.equal(backend.env.HOST, '127.0.0.1'); assert.equal(backend.instances, 1);
  assert.ok(backend.node_args.includes('--experimental-require-module')); assert.equal(backend.wait_ready, true);
});
