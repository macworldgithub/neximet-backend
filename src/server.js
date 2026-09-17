require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const connectDB = require('./config/db');

// Connect Database
connectDB();

const app = express();

// Ensure database is connected for each request (serverless compatible)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('Database connection error in request:', err.message);
    return res.status(500).json({ success: false, message: 'Database connection failed' });
  }
});

// Middleware
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Persistent serverless scope document handler (serves from MongoDB or disk fallback)
app.get('/uploads/scopes/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const Project = require('./models/Project');

    // 1. Try to find in MongoDB Project model (checks both multiple scopeDocuments and legacy scopeDocument)
    const project = await Project.findOne({
      $or: [
        { 'scopeDocuments.fileName': filename },
        { 'scopeDocument.fileName': filename },
      ],
    });

    if (project) {
      const doc =
        project.scopeDocuments?.find((d) => d.fileName === filename) ||
        (project.scopeDocument?.fileName === filename ? project.scopeDocument : null);

      if (doc && doc.fileData) {
        const buffer = Buffer.from(doc.fileData, 'base64');
        res.setHeader('Content-Type', doc.fileType || 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${encodeURIComponent(doc.originalName || filename)}"`
        );
        return res.send(buffer);
      }
    }

    // 2. Try disk locations (local dev or seeded sample files)
    const diskPath = path.join(__dirname, '../uploads/scopes', filename);
    if (fs.existsSync(diskPath)) {
      return res.sendFile(diskPath);
    }

    const tmpPath = path.join('/tmp', filename);
    if (fs.existsSync(tmpPath)) {
      return res.sendFile(tmpPath);
    }

    // 3. Fallback message for files uploaded before persistent database storage was enabled
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Document Not Found</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0B0F19; color: #F3F4F6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem;">
          <div style="background: #111827; border: 1px solid #1F293D; padding: 2.5rem; border-radius: 1.5rem; max-width: 520px; text-align: center; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
            <div style="width: 56px; height: 56px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #EF4444; border-radius: 1rem; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem auto; font-size: 24px; font-weight: bold;">
              ✕
            </div>
            <h2 style="color: #FFFFFF; font-size: 1.25rem; font-weight: 700; margin: 0 0 0.75rem 0;">Document Not Found on Server</h2>
            <p style="color: #9CA3AF; font-size: 0.875rem; line-height: 1.6; margin: 0 0 1.25rem 0;">
              The document <code style="background: #1F293D; padding: 0.2rem 0.4rem; border-radius: 0.375rem; color: #5CC5FA; font-size: 0.8rem; word-break: break-all;">${filename}</code> was stored in a temporary container before persistent database storage was enabled.
            </p>
            <div style="background: #0B0F19; border: 1px solid #1F293D; padding: 1rem; border-radius: 0.75rem; margin-bottom: 1.5rem;">
              <p style="color: #E5E7EB; font-size: 0.8rem; margin: 0;">
                Please re-upload this document in the <strong>Project Scope</strong> tab to permanently store it in the database.
              </p>
            </div>
            <a href="javascript:window.close()" style="display: inline-block; background: linear-gradient(135deg, #5470F4, #5CC5FA); color: #FFFFFF; text-decoration: none; font-size: 0.875rem; font-weight: 600; padding: 0.625rem 1.5rem; border-radius: 0.75rem;">
              Close Window
            </a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Error serving scope document:', err);
    res.status(500).send('Error serving document');
  }
});

// Static uploads serving for project scopes
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Root route
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    service: 'Neximet Portal Backend API',
    version: '2.0.0',
  });
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/projects', require('./routes/projectRoutes'));
app.use('/api/tasks', require('./routes/taskRoutes'));
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/deductions', require('./routes/deductionRoutes'));
app.use('/api/leaves', require('./routes/leaveRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date(), service: 'Neximet Portal Backend' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

// Only listen on port when executed directly as main process (not as a serverless import)
if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Neximet Portal Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
