// Vercel WebSocket beta accepts a Node HTTP server with upgrade handlers.
const app = require('../src/server');
const { createRealtimeServer } = require('../src/services/realtime');
module.exports = createRealtimeServer(app).server;
