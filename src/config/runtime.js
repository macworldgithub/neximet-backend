const PRODUCTION_ORIGINS = ['https://portal.neximet.com', 'https://www.portal.neximet.com'];

function runtimeConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const origins = (env.CORS_ORIGINS || (production ? PRODUCTION_ORIGINS.join(',') : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:4051,http://127.0.0.1:4051'))
    .split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('CORS_ORIGINS must contain complete origins separated by commas.'); }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) throw new Error('CORS_ORIGINS must contain exact HTTPS origins in production, without paths or wildcards.');
  }
  const port = Number(env.PORT ?? (production ? 4052 : 4000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const trustProxy = env.TRUST_PROXY === 'false' ? false : 'loopback';
  if (env.TRUST_PROXY && !['false', 'loopback'].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be loopback or false.');
  return { production, origins, port, host: env.HOST || '127.0.0.1', trustProxy };
}

function validateProduction(env = process.env) {
  const config = runtimeConfig(env);
  if (!config.production) return config;
  const errors = [];
  if (!/^mongodb(?:\+srv)?:\/\//.test(env.MONGODB_URI || '') || /[<>]/.test(env.MONGODB_URI)) errors.push('MONGODB_URI must identify your production MongoDB replica set or Atlas database');
  if ((env.JWT_SECRET || '').length < 32 || /^(neximet_super_secret|replace|change|your[-_])/i.test(env.JWT_SECRET || '')) errors.push('JWT_SECRET must be a private random secret of at least 32 characters');
  if (!/^[a-f\d]{64}$/i.test(env.MAIL_ENCRYPTION_KEY || '')) errors.push('MAIL_ENCRYPTION_KEY must be the persistent 64-character hexadecimal encryption key');
  if (env.AI_ENCRYPTION_KEY && !/^[a-f\d]{64}$/i.test(env.AI_ENCRYPTION_KEY)) errors.push('AI_ENCRYPTION_KEY must be a persistent 64-character hexadecimal key');
  if (env.CEO_MASTER_KEY && (env.CEO_MASTER_KEY.length < 32 || env.CEO_MASTER_KEY === 'NEXIMET-CEO-2026-RECOVERY')) errors.push('CEO_MASTER_KEY must be blank (disabled) or a private random secret of at least 32 characters');
  const push = [env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY, env.WEB_PUSH_SUBJECT];
  if (push.some(Boolean) && !push.every(Boolean)) errors.push('Web Push requires both VAPID keys and WEB_PUSH_SUBJECT');
  if (push.every(Boolean)) {
    try { require('web-push').setVapidDetails(...[push[2], push[0], push[1]]); }
    catch { errors.push('Web Push VAPID keys or subject are invalid'); }
  }
  if (errors.length) throw new Error('Production configuration is incomplete:\n- ' + errors.join('\n- '));
  return config;
}

function originAllowed(origin, config = runtimeConfig()) { return !origin || config.origins.includes(origin); }
function corsOptions(config = runtimeConfig()) {
  return {
    origin(origin, callback) {
      if (originAllowed(origin, config)) return callback(null, true);
      const error = new Error('Origin is not allowed.'); error.status = 403; callback(error);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'], maxAge: 600,
  };
}
module.exports = { runtimeConfig, validateProduction, originAllowed, corsOptions };
