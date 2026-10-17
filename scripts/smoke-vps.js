// Read-only deployment checks. No credentials, database writes or paid AI calls.
const publicMode = process.argv.includes('--public');
const backend = publicMode ? 'https://backend.neximet.com' : 'http://127.0.0.1:4052';
const frontend = publicMode ? 'https://portal.neximet.com' : 'http://127.0.0.1:4051';
async function check(url, expected, options) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual', ...options });
  if (response.status !== expected) throw new Error(`${url}: expected HTTP ${expected}, got ${response.status}`);
  await response.arrayBuffer();
  console.log(`PASS HTTP ${expected}: ${url}`);
  return response;
}
(async () => {
  await check(backend + '/health/live', 200);
  await check(backend + '/api/health', 200);
  await check(frontend + '/login', 200);
  const allowed = await check(backend + '/api/health', 200, { headers: { Origin: 'https://portal.neximet.com' } });
  if (allowed.headers.get('access-control-allow-origin') !== 'https://portal.neximet.com') throw new Error('Portal CORS response is missing.');
  await check(backend + '/api/health', 403, { headers: { Origin: 'https://untrusted.invalid' } });
  await check(backend + '/uploads/scopes/protected.pdf', 401);
  if (publicMode) {
    await check('https://www.backend.neximet.com/api/health', 200);
    const redirect = await check('https://www.portal.neximet.com/login', 308);
    if (redirect.headers.get('location') !== 'https://portal.neximet.com/login') throw new Error('The www portal redirect is incorrect.');
  }
  console.log('Deployment smoke checks passed.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
