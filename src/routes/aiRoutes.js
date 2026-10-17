const express = require('express');
const { protect } = require('../middleware/auth');
const { createAIHandlers } = require('../controllers/aiController');
function createAIRouter(options) {
  const router = express.Router();
  const ai = createAIHandlers(options);
  router.use(protect);
  router.get('/connections', ai.settings);
  router.put('/connections/:provider', ai.connect);
  router.delete('/connections/:provider', ai.disconnect);
  router.get('/conversations', ai.list);
  router.post('/conversations', ai.create);
  router.get('/conversations/:id', ai.read);
  router.patch('/conversations/:id', ai.rename);
  router.delete('/conversations/:id', ai.remove);
  router.post('/conversations/:id/messages', ai.send);
  return router;
}
module.exports = createAIRouter();
module.exports.createAIRouter = createAIRouter;
