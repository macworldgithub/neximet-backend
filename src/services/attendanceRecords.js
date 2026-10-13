const Attendance = require('../models/Attendance');
const DeductionRule = require('../models/DeductionRule');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const LeaveRequest = require('../models/LeaveRequest');
const { companyDate, validDate, normalizeRule, scheduledEnd, atCompanyTime, addDays } = require('./attendancePolicy');

async function activeRule() { return normalizeRule(await DeductionRule.findOne({ isActive: true }).sort({ updatedAt: -1 })); }

// Finalize overdue shifts on attendance requests, using scheduled end rather
// than request time. This works across serverless cold starts without a timer.
async function closeEndedShifts(rule, userFilter = {}, now = new Date()) {
  const open = await Attendance.find({ ...userFilter, checkIn: { $ne: null }, checkOut: null, 'override.type': { $ne: 'absent' } }).select('_id date checkIn scheduledCheckOut');
  const operations = [];
  for (const record of open) {
    // Older APIs accepted arbitrary date strings. One malformed legacy row must
    // not break attendance for every employee or silently rewrite its evidence.
    if (!validDate(record.date) || !Number.isFinite(new Date(record.checkIn).getTime())) continue;
    const scheduled = record.scheduledCheckOut || scheduledEnd(record.date, rule);
    const end = new Date(Math.max(new Date(scheduled).getTime(), new Date(record.checkIn).getTime()));
    if (!Number.isFinite(end.getTime())) continue;
    if (end <= now) operations.push({ updateOne: {
      filter: { _id: record._id, checkOut: null, 'override.type': { $ne: 'absent' } },
      update: { $set: { checkOut: end, checkOutSource: 'shift_end', totalWorkHours: Number(((end - new Date(record.checkIn)) / 3600000).toFixed(2)) }, $inc: { __v: 1 } },
    } });
  }
  if (operations.length) await Attendance.bulkWrite(operations);
}

async function dayExemptions(date, userIds) {
  const start = atCompanyTime(date, '00:00'), end = atCompanyTime(addDays(date, 1), '00:00');
  const [holidays, leaves] = await Promise.all([
    Holiday.find({ date: { $gte: start, $lt: end }, isMandatory: true }).select('title'),
    LeaveRequest.find({ user: { $in: userIds }, status: 'approved', totalDays: { $gte: 1 }, startDate: { $lt: end }, endDate: { $gte: start } }).select('user startDate endDate totalDays leaveType'),
  ]);
  return { holiday: holidays[0]?.title || null, leaveUsers: new Set(leaves.map(leave => String(leave.user))) };
}

async function dailyRoster(date = companyDate(), department) {
  const users = await User.find({ isActive: true, ...(department ? { department } : {}) }).select('name email role department designation dailyWage phone').lean();
  const ids = users.map(user => user._id);
  const [records, exemptions, photos] = await Promise.all([
    Attendance.find({ date, user: { $in: ids } }).select('-photo -auditTrail -override.snapshot').lean(), dayExemptions(date, ids),
    Attendance.find({ date, user: { $in: ids }, photo: { $exists: true, $nin: ['', null] } }).select('_id user').lean(),
  ]);
  const withPhotos = new Set(photos.map(record => String(record.user)));
  const byUser = new Map(records.map(record => [String(record.user), record]));
  return users.map(user => {
    const record = byUser.get(String(user._id));
    const status = record?.status || (exemptions.leaveUsers.has(String(user._id)) ? 'on_leave' : exemptions.holiday ? 'on_holiday' : 'not_checked_in');
    return { user, date, recordId: record?._id || null, checkedIn: !!record?.checkIn && record?.status !== 'absent' && record?.override?.type !== 'absent', checkIn: record?.checkIn || null,
      checkOut: record?.checkOut || null, status, isLate: record?.isLate || false, minutesLate: record?.minutesLate || 0,
      deductionAmount: record?.deductionAmount || 0, totalWorkHours: record?.totalWorkHours || 0,
      hasPhoto: withPhotos.has(String(user._id)), deviceLocked: !!record?.deviceLockKey, deviceInfo: record?.deviceInfo || null, location: record?.location || null,
      notes: record?.notes || '', isSimulated: record?.isSimulated || false, override: record?.override || null };
  });
}
module.exports = { activeRule, closeEndedShifts, dayExemptions, dailyRoster };
