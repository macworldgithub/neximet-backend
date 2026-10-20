async function verifyDatabase(connection, { production = false } = {}) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (production && !hello.setName && hello.msg !== 'isdbgrid') throw new Error('Production requires MongoDB Atlas or a replica set: attendance and leave updates use transactions.');
  await Promise.all(Object.values(connection.models).map(model => model.init()));
}

async function startServer(app, { config, connect, mongoose, createRealtimeServer, shutdownMs = 15000 } = {}) {
  await connect();
  await verifyDatabase(mongoose.connection, config);
  const { server, io, closeCalls } = createRealtimeServer(app, { config });
  // Nginx has a 60-second upstream idle timeout.
  server.keepAliveTimeout = 70000;
  server.headersTimeout = 75000;
  server.requestTimeout = 120000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  console.log(`Neximet backend listening on ${config.host}:${config.port}`);
  if (process.send) process.send('ready');
  let stopping;
  const shutdown = (signal = 'shutdown') => {
    if (stopping) return stopping;
    app.locals.draining = true;
    console.log(`Received ${signal}; draining connections.`);
    const deadline = setTimeout(() => { server.closeAllConnections?.(); process.exit(1); }, shutdownMs);
    deadline.unref();
    stopping = Promise.resolve().then(() => closeCalls?.()).then(() => new Promise(resolve => io.close(resolve))).then(() => mongoose.disconnect()).finally(() => {
      clearTimeout(deadline);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
    });
    return stopping;
  };
  const onSignal = signal => { void shutdown(signal).then(() => process.exit(0), error => { console.error('Shutdown failed:', error.message); process.exit(1); }); };
  const onInterrupt = () => onSignal('SIGINT'), onTerminate = () => onSignal('SIGTERM');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  return { server, io, shutdown };
}
module.exports = { startServer, verifyDatabase };
