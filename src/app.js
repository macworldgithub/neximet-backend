const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { runtimeConfig, corsOptions } = require('./config/runtime');
const { protect } = require('./middleware/auth');
const { createScopeHandler } = require('./services/scopeDocuments');

function createApp({ config = runtimeConfig(), connect = connectDB, database = mongoose } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.draining = false;
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  // Preflight and liveness do not depend on MongoDB being available.
  app.use(cors(corsOptions(config)));
  app.get('/health/live', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'alive' }));
  app.get('/', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'running', service: 'Neximet Portal Backend API' }));
  app.get('/api/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (app.locals.draining) throw new Error('Draining');
      await connect();
      await database.connection.db.admin().command({ ping: 1 });
      res.json({ status: 'healthy', service: 'Neximet Portal Backend', timestamp: new Date() });
    } catch { res.status(503).json({ status: 'unavailable', service: 'Neximet Portal Backend' }); }
  });
  app.use(async (req, res, next) => {
    if (app.locals.draining) return res.status(503).json({ success: false, message: 'Server is restarting. Please retry shortly.' });
    try { await connect(); next(); }
    catch { res.status(503).json({ success: false, message: 'Database is temporarily unavailable.' }); }
  });
  app.use('/api/attendance/check-in', express.json({ limit: '1mb' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(morgan(config.production ? 'combined' : 'dev', { skip: req => req.path === '/api/health' }));

  // Scope files contain private project information. Never publish uploads as
  // static files, and never accept bearer tokens in download query strings.
  app.get('/uploads/scopes/:filename', protect, createScopeHandler());
  app.use('/uploads', (req, res) => res.status(404).json({ success: false, message: 'File not found.' }));

  // Routes
  app.use('/api/portal', require('./routes/portalRoutes'));
  app.use('/api/auth', require('./routes/authRoutes'));
  app.use('/api/projects', require('./routes/projectRoutes'));
  app.use('/api/tasks', require('./routes/taskRoutes'));
  app.use('/api/attendance', require('./routes/attendanceRoutes'));
  app.use('/api/deductions', require('./routes/deductionRoutes'));
  app.use('/api/leaves', require('./routes/leaveRoutes'));
  app.use('/api/dashboard', require('./routes/dashboardRoutes'));
  app.use('/api/chat', require('./routes/chatRoutes'));
  app.use('/api/meetings', require('./routes/meetingRoutes'));
  app.use('/api/announcements', require('./routes/announcementRoutes'));
  app.use('/api/notifications', require('./routes/notificationRoutes'));
  app.use('/api/mail', require('./routes/mailRoutes'));
  app.use('/api/ai', require('./routes/aiRoutes'));

  app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error.status || 500;
    if (status >= 500) console.error('Server error:', error.message);
    res.status(status).json({ success: false, message: error.code === 'LIMIT_FILE_SIZE' ? 'The uploaded file exceeds the allowed size.' : config.production && status >= 500 ? 'Internal server error.' : error.message || 'Internal server error.' });
  });
  return app;
}
module.exports = { createApp };
