const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { protect } = require('../middleware/auth');
const chat = require('../controllers/chatController');
const push = require('../controllers/chatPushController');
const chatAttachments = require('../services/chatAttachments');
const { FILE_LIMIT, MAX_FILES } = require('../services/chatMedia');
const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.m4v', '.mov', '.webm', '.pdf', '.txt', '.csv', '.docx', '.xlsx', '.pptx', '.zip']);
const upload = multer({
  storage: chatAttachments.storage,
  // Busboy marks a stream truncated as soon as it reaches fileSize, including
  // equality. The streaming storage enforces the inclusive 100 MB limit.
  limits: { fileSize: FILE_LIMIT + 1, files: MAX_FILES, fields: 2, fieldSize: 16000, parts: MAX_FILES + 3 },
  fileFilter: (req, file, callback) => callback(allowed.has(path.extname(file.originalname).toLowerCase()) ? null : Object.assign(new Error('Use an image, MP4/MOV/WebM video, PDF, text, Office document, or ZIP file'), { status: 400 }), true),
}).array('attachment', MAX_FILES);
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
router.post('/conversations/:id/members', chat.addMembers);
router.get('/conversations/:id/messages', chat.getMessages);
router.post('/conversations/:id/messages', chat.authorizeUpload, (req, res, next) => upload(req, res, (error) => {
  if (error) return res.status(400).json({ success: false, message: error.code === 'LIMIT_FILE_SIZE' ? 'Attachments must total 100 MB or smaller per message' : ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT'].includes(error.code) ? `Attach up to ${MAX_FILES} files per message` : error.message });
  next();
}), chat.sendMessage);
router.post('/conversations/:id/read', chat.markRead);
router.post('/conversations/:id/delivered', chat.markDelivered);
router.post('/conversations/:id/typing', chat.setTyping);
router.get('/conversations/:id/messages/:messageId/attachment', chat.downloadAttachment);
module.exports = router;
