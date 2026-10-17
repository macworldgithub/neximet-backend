// Optional real-Nginx integration: NGINX_BINARY and OPENSSL_BINARY may name local
// executables. Only loopback test servers and temporary self-signed certificates
// are used. Never reads deployment secrets or changes the host Nginx service.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const executable = process.env.NGINX_BINARY;

async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function get(port, hostname, pathname = '/', tls = true, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = (tls ? https : http).get({ hostname: '127.0.0.1', port, servername: hostname, path: pathname, rejectUnauthorized: false, headers: { Host: hostname, ...headers }, timeout: 4000 }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Proxy test timed out.')));
  });
}

test('real Nginx serves aliases, overwrites proxy headers, upgrades WebSockets and streams without buffering', { skip: !executable, timeout: 45000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neximet-proxy-test-'));
  const normalized = root.replaceAll('\\', '/');
  let child, releaseStream;
  const servers = [], sockets = new Set();
  t.after(async () => {
    releaseStream?.(); for (const socket of sockets) socket.destroy();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('neximet-proxy-test-')) await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'snippets')); await fs.mkdir(path.join(root, 'logs')); await fs.mkdir(path.join(root, 'certs')); await fs.mkdir(path.join(root, 'temp'));
  await run(process.env.OPENSSL_BINARY || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(root, 'certs/privkey.pem'), '-out', path.join(root, 'certs/fullchain.pem')], { windowsHide: true });
  const [backendPort, frontendPort, httpPort, httpsPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const backend = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write('data: first\n\n');
      releaseStream = () => res.end('data: last\n\n'); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers));
  });
  backend.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const frontend = http.createServer((req, res) => res.end('Neximet frontend'));
  for (const [server, port] of [[backend, backendPort], [frontend, frontendPort]]) { servers.push(server); server.listen(port, '127.0.0.1'); await once(server, 'listening'); }
  for (const name of ['neximet-proxy.conf', 'neximet-tls.conf']) {
    const source = (await fs.readFile(path.resolve(__dirname, '../deploy/nginx', name), 'utf8')).replaceAll('/etc/letsencrypt/live/neximet-platform', normalized + '/certs');
    await fs.writeFile(path.join(root, 'snippets', name), source);
  }
  const site = (await fs.readFile(path.resolve(__dirname, '../deploy/nginx/neximet.conf'), 'utf8'))
    .replaceAll('/etc/nginx/snippets', normalized + '/snippets').replaceAll('/var/log/nginx', normalized + '/logs')
    .replaceAll('127.0.0.1:4052', '127.0.0.1:' + backendPort).replaceAll('127.0.0.1:4051', '127.0.0.1:' + frontendPort)
    .replaceAll('listen [::]:80;', '').replaceAll('listen [::]:443 ssl;', '')
    .replaceAll('listen 80;', `listen 127.0.0.1:${httpPort};`).replaceAll('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`);
  const config = `daemon off;\nmaster_process off;\nerror_log ${normalized}/logs/error.log;\npid ${normalized}/nginx.pid;\nevents { worker_connections 128; }\nhttp {\n${site}\n}\n`;
  await fs.writeFile(path.join(root, 'test.conf'), config);
  const args = ['-p', normalized + '/', '-c', normalized + '/test.conf'];
  await run(executable, ['-t', ...args], { windowsHide: true });
  child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  for (let attempt = 0; attempt < 40; attempt++) { try { await get(httpsPort, 'portal.neximet.com'); break; } catch (error) { if (attempt === 39 || child.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
  for (const hostname of ['backend.neximet.com', 'www.backend.neximet.com']) {
    const response = await get(httpsPort, hostname, '/api/health', true, { 'X-Forwarded-For': '192.0.2.123' });
    assert.equal(response.status, 200); const headers = JSON.parse(response.body);
    assert.equal(headers.host, hostname); assert.equal(headers['x-forwarded-proto'], 'https'); assert.equal(headers['x-forwarded-for'], '127.0.0.1');
  }
  assert.equal((await get(httpsPort, 'portal.neximet.com')).body, 'Neximet frontend');
  const redirect = await get(httpsPort, 'www.portal.neximet.com', '/login?a=1');
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, 'https://portal.neximet.com/login?a=1');
  assert.equal((await get(httpPort, 'backend.neximet.com', '/api/health', false)).status, 308);
  await new Promise((resolve, reject) => {
    const request = https.get({ hostname: '127.0.0.1', port: httpsPort, servername: 'backend.neximet.com', path: '/stream', rejectUnauthorized: false, headers: { Host: 'backend.neximet.com' } }, response => {
      const timeout = setTimeout(() => { releaseStream?.(); reject(new Error('Nginx buffered the first SSE event.')); }, 2000);
      response.once('data', chunk => { clearTimeout(timeout); assert.match(chunk.toString(), /first/); releaseStream(); });
      response.once('end', resolve); response.on('error', reject);
    }); request.on('error', reject);
  });
  await new Promise((resolve, reject) => {
    const request = https.get({ hostname: '127.0.0.1', port: httpsPort, servername: 'backend.neximet.com', path: '/api/socket.io/?EIO=4&transport=websocket', rejectUnauthorized: false, headers: { Host: 'backend.neximet.com', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
    request.on('upgrade', (response, socket) => { assert.equal(response.statusCode, 101); socket.destroy(); resolve(); });
    request.on('response', response => { response.resume(); reject(new Error('WebSocket upgrade returned HTTP ' + response.statusCode)); }); request.on('error', reject);
  });
});
