function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || !secret.trim()) {
    const error = new Error('Authentication is not configured. Set JWT_SECRET before serving private attendance or account data.');
    error.status = 503;
    throw error;
  }
  return secret;
}
module.exports = { jwtSecret };
