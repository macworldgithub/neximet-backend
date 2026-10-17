const express = require('express');
const { protect } = require('../middleware/auth');
const { createMailHandlers } = require('../controllers/mailController');

const router = express.Router();
const mail = createMailHandlers();
router.use(protect);
router.get('/settings', mail.settings);
router.put('/settings', mail.save);
router.delete('/settings', mail.disconnect);
router.get('/status', mail.status);
router.get('/messages', mail.list);
router.get('/messages/:uid', mail.read);
router.post('/send', mail.send);
module.exports = router;
