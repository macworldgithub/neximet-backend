require('dotenv').config();
const { validateProduction } = require('../src/config/runtime');
try {
  validateProduction({ ...process.env, NODE_ENV: 'production' });
  require('../src/routes/mailRoutes');
  require('../src/routes/aiRoutes');
  console.log('Production environment and mail/AI runtime checks passed. Secrets were not printed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
