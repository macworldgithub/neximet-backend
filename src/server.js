require('dotenv').config();
const { createApp } = require('./app');
const { validateProduction } = require('./config/runtime');
const config = validateProduction();
const app = createApp({ config });

if (require.main === module && !process.env.VERCEL) {
  const mongoose = require('mongoose');
  const connect = require('./config/db');
  const { createRealtimeServer } = require('./services/realtime');
  require('./lifecycle').startServer(app, { config, connect, mongoose, createRealtimeServer }).catch(error => {
    console.error('Backend startup failed:', error.message);
    process.exit(1);
  });
}
module.exports = app;
