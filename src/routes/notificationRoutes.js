const router = require('express').Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
router.use(require('../middleware/auth').protect);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/', async (req, res, next) => {
  try {
    const filter = { user: req.user.id, withdrawn: false };
    if (req.query.before && !mongoose.isValidObjectId(req.query.before)) return res.status(400).json({ success: false, message: 'Invalid notification cursor.' });
    const [rows, unreadCount] = await Promise.all([
      Notification.find({ ...filter, ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) }).sort({ _id: -1 }).limit(31).select('-user -key -pushPrepared -__v').lean(),
      Notification.countDocuments({ ...filter, readAt: null }),
    ]);
    const notifications = rows.slice(0, 30);
    res.json({ success: true, notifications, unreadCount, nextCursor: rows.length > 30 ? String(notifications.at(-1)._id) : null });
  } catch (error) { next(error); }
});
router.post('/read-all', async (req, res, next) => {
  try {
    // Bound to the newest item actually shown, so a new arrival remains unread.
    if (!mongoose.isValidObjectId(req.body.through)) return res.status(400).json({ success: false, message: 'Invalid notification cursor.' });
    await Notification.updateMany({ user: req.user.id, withdrawn: false, readAt: null, _id: { $lte: req.body.through } }, { $set: { readAt: new Date() } });
    res.json({ success: true });
  } catch (error) { next(error); }
});
router.post('/:id/read', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid notification.' });
    const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id, withdrawn: false }, { $set: { readAt: new Date() } });
    if (!notification) return res.status(404).json({ success: false, message: 'Notification not found.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});
module.exports = router;
