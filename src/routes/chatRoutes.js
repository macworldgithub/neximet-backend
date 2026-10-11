const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { protect } = require('../middleware/auth');
const chat = require('../controllers/chatController');
const push = require('../controllers/chatPushController');
const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.csv', '.docx', '.xlsx', '.pptx', '.zip']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 2, fieldSize: 16000 },
  fileFilter: (req, file, callback) => callback(allowed.has(path.extname(file.originalname).toLowerCase()) ? null : Object.assign(new Error('Use an image, PDF, text, Office document, or ZIP file'), { status: 400 }), true),
}).single('attachment');
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.post('/push/delivered', push.delivered);
router.use(protect);
router.get('/push/config', push.config);
router.post('/push/subscriptions', push.subscribe);
router.delete('/push/subscriptions', push.unsubscribe);
router.post('/push/flush', push.flush);
router.get('/deliveries', chat.getDeliveries);
router.get('/people', chat.getPeople);
router.get('/conversations', chat.listConversations);
router.post('/conversations', chat.createConversation);
router.get('/conversations/:id', chat.getConversation);
router.get('/conversations/:id/messages', chat.getMessages);
router.post('/conversations/:id/messages', (req, res, next) => upload(req, res, (error) => {
  if (error) return res.status(400).json({ success: false, message: error.code === 'LIMIT_FILE_SIZE' ? 'Files must be 3 MB or smaller' : error.message });
  next();
}), chat.sendMessage);
router.post('/conversations/:id/read', chat.markRead);
router.post('/conversations/:id/delivered', chat.markDelivered);
router.post('/conversations/:id/typing', chat.setTyping);
router.get('/conversations/:id/messages/:messageId/attachment', chat.downloadAttachment);
module.exports = router;
