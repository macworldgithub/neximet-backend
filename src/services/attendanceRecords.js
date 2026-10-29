const Attendance = require('../models/Attendance');
const DeductionRule = require('../models/DeductionRule');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const LeaveRequest = require('../models/LeaveRequest');
const { companyDate, companyRule, recordedShift, atCompanyTime, addDays, isWorkingDay } = require('./attendancePolicy');
const { leaveCoverage } = require('./leavePolicy');

async function activeRule(transaction) { return companyRule(await DeductionRule.findOne({ isActive: true }).sort({ updatedAt: -1 }).session(transaction || null)); }
const operationalOpen = { checkIn: { $ne: null }, checkOut: null, 'override.type': { $ne: 'absent' }, 'quarantine.at': { $exists: false } };
const versionGuard = record => ({ __v: record.__v === undefined ? { $exists: false } : record.__v });

// Finalize overdue shifts on attendance requests, using scheduled end rather
// than request time. This works across serverless cold starts without a timer.
async function closeEndedShifts(rule, userFilter = {}, now = new Date()) {
  const open = await Attendance.find({ ...userFilter, ...operationalOpen }).select('_id date checkIn scheduledCheckOut expectedCheckIn policySnapshot __v').lean();
  const operations = [];
  for (const record of open) {
    // Older APIs accepted arbitrary date strings. One malformed legacy row must
    // not break attendance for every employee or silently rewrite its evidence.
    let closure;
    try { closure = recordedShift(record, rule); }
    catch (error) {
      if (error.status !== 400) throw error;
      await Attendance.collection.updateOne({ _id: record._id, ...versionGuard(record), ...operationalOpen }, { $set: { quarantine: { at: now, reason: error.message } }, $inc: { __v: 1 } });
      continue;
    }
    const { end, totalWorkHours } = closure;
    if (end <= now) operations.push({ updateOne: {
      filter: { _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v, ...operationalOpen },
      update: { $set: { checkOut: end, checkOutSource: 'shift_end', totalWorkHours }, $inc: { __v: 1 } },
    } });
  }
  if (operations.length) await Attendance.bulkWrite(operations);
}

async function dayExemptions(date, userIds, rule, transaction) {
  rule = rule || await activeRule(transaction);
  const start = atCompanyTime(date, '00:00'), end = atCompanyTime(addDays(date, 1), '00:00');
  const holidays = await Holiday.find({ date: { $gte: start, $lt: end }, isMandatory: true }).select('title').session(transaction || null);
  const leaves = await LeaveRequest.find({ user: { $in: userIds }, status: 'approved', startDate: { $lt: end }, endDate: { $gte: start } }).select('user startDate endDate totalDays session workingDates leaveType').session(transaction || null);
  const coverage = leaveCoverage(leaves, date, rule), leaveUsers = new Set(), halfDayUsers = new Map();
  for (const [key, sessions] of coverage) { if (sessions.size === 2) leaveUsers.add(key); else halfDayUsers.set(key, [...sessions][0]); }
  return { holiday: holidays[0]?.title || null, leaveUsers, halfDayUsers };
}

async function dailyRoster(date = companyDate(), department) {
  const rule = await activeRule();
  const candidates = await User.find({ role: { $ne: 'Client' }, $or: [{ isActive: true }, { deactivatedAt: { $gte: atCompanyTime(date, '00:00') } }], ...(department ? { department } : {}) }).select('name email role department designation baseSalary dailyWage phone joinDate createdAt isActive deactivatedAt attendanceTrackingFrom employmentGaps').lean();
  const users = candidates.filter(user => date >= companyDate(user.joinDate || user.createdAt) && (!user.attendanceTrackingFrom || date >= companyDate(user.attendanceTrackingFrom)) && !user.employmentGaps?.some(gap => date > companyDate(gap.start) && date < companyDate(gap.end)));
  const ids = users.map(user => user._id);
  const [records, exemptions, photos] = await Promise.all([
    Attendance.find({ date, user: { $in: ids } }).select('-photo -auditTrail -override.snapshot').lean(), dayExemptions(date, ids, rule),
    Attendance.find({ date, user: { $in: ids }, photo: { $exists: true, $nin: ['', null] } }).select('_id user').lean(),
  ]);
  const withPhotos = new Set(photos.map(record => String(record.user)));
  const byUser = new Map(records.map(record => [String(record.user), record]));
  return users.map(user => {
    const record = byUser.get(String(user._id));
    const status = record?.status || (exemptions.leaveUsers.has(String(user._id)) ? 'on_leave' : exemptions.holiday ? 'on_holiday' : !isWorkingDay(date, rule) ? 'day_off' : 'not_checked_in');
    const { joinDate, createdAt, isActive, deactivatedAt, attendanceTrackingFrom, employmentGaps, ...publicUser } = user;
    return { user: publicUser, date, recordId: record?._id || null, recordVersion: record?.__v ?? null, checkedIn: !!record?.checkIn && !record?.quarantine?.at && record?.status !== 'absent' && record?.override?.type !== 'absent', checkIn: record?.checkIn || null,
      checkOut: record?.checkOut || null, status, isLate: record?.isLate || false, minutesLate: record?.minutesLate || 0,
      deductionAmount: record?.deductionAmount || 0, totalWorkHours: record?.totalWorkHours || 0,
      hasPhoto: withPhotos.has(String(user._id)), deviceLocked: !!record?.deviceLockKey, deviceInfo: record?.deviceInfo || null, location: record?.location || null,
      notes: record?.notes || '', isSimulated: record?.isSimulated || false, financialReviewRequired: record?.financialReviewRequired || false, override: record?.override || null, quarantine: record?.quarantine?.at ? record.quarantine : null };
  });
}
module.exports = { activeRule, closeEndedShifts, dayExemptions, dailyRoster, operationalOpen, versionGuard };
