const router = require('express').Router();
const mongoose = require('mongoose');
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const User = require('../models/User');
const notifications = require('../services/notifications');
const executive = user => ['CEO', 'Super Admin'].includes(user.role);
const allowed = req => executive(req.user) ? {} : { recipients: req.user.id };
router.use(require('../middleware/auth').protect);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/', async (req, res, next) => {
  try {
    if (req.query.before && !mongoose.isValidObjectId(req.query.before)) return res.status(400).json({ success: false, message: 'Invalid announcement cursor.' });
    const rows = await Announcement.find({ ...allowed(req), archivedAt: null, ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) })
      .sort({ _id: -1 }).limit(21).select('-recipients -notificationsPrepared').populate('author', 'name role').lean();
    res.json({ success: true, announcements: rows.slice(0, 20), nextCursor: rows.length > 20 ? String(rows[19]._id) : null });
  } catch (error) { next(error); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid announcement.' });
    const announcement = await Announcement.findOne({ _id: req.params.id, ...allowed(req), archivedAt: null }).select('-recipients -notificationsPrepared').populate('author', 'name role');
    if (!announcement) return res.status(404).json({ success: false, message: 'Announcement not found.' });
    res.json({ success: true, announcement });
  } catch (error) { next(error); }
});
router.post('/', async (req, res, next) => {
  try {
    if (!executive(req.user)) return res.status(403).json({ success: false, message: 'Only CEOs and Super Admins can publish announcements.' });
    const { title, body, audience = 'everyone', priority = 'normal', department, userIds } = req.body;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 160 || typeof body !== 'string' || !body.trim() || body.trim().length > 10000 || !['everyone', 'department', 'users'].includes(audience) || !['normal', 'important'].includes(priority)) return res.status(400).json({ success: false, message: 'Provide a title (up to 160 characters), announcement (up to 10,000 characters), and valid audience/priority.' });
    const filter = { isActive: true, role: { $ne: 'Client' } };
    if (audience === 'department') {
      if (!User.schema.path('department').enumValues.includes(department)) return res.status(400).json({ success: false, message: 'Select a valid department.' });
      filter.department = department;
    }
    if (audience === 'users') {
      if (!Array.isArray(userIds) || !userIds.length || userIds.length > 500 || userIds.some(id => typeof id !== 'string' || !mongoose.isValidObjectId(id))) return res.status(400).json({ success: false, message: 'Select between 1 and 500 active users.' });
      filter._id = { $in: [...new Set(userIds)] };
    }
    const recipients = await User.find(filter).distinct('_id');
    if (!recipients.length || audience === 'users' && recipients.length !== new Set(userIds).size) return res.status(400).json({ success: false, message: 'The audience contains no users or includes an inactive user. Refresh and try again.' });
    const announcement = await Announcement.create({ title: title.trim(), body: body.trim(), audience, priority, department: audience === 'department' ? department : undefined, recipients, author: req.user.id });
    // The stored audience is the publication-time snapshot. Other users cannot
    // retrieve a targeted announcement by guessing its ID.
    try { await notifications.announcementPublished(announcement); }
    catch (error) { console.error('Announcement fanout queued for retry:', error.message); }
    res.status(201).json({ success: true, announcement: { _id: announcement._id }, recipientCount: recipients.length });
  } catch (error) { next(error); }
});
router.post('/:id/archive', async (req, res, next) => {
  try {
    if (!executive(req.user)) return res.status(403).json({ success: false, message: 'Only CEOs and Super Admins can archive announcements.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid announcement.' });
    const announcement = await Announcement.findByIdAndUpdate(req.params.id, { $set: { archivedAt: new Date() } });
    if (!announcement) return res.status(404).json({ success: false, message: 'Announcement not found.' });
    await Notification.updateMany({ announcement: announcement._id }, { $set: { withdrawn: true } });
    res.json({ success: true });
  } catch (error) { next(error); }
});
module.exports = router;
