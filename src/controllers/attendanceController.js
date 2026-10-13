const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { TIME_ZONE, fail, companyDate, validDate, validMonth, shiftDate, scheduledEnd, dailyWage, calculateAttendance, distanceMeters, validateSelfie } = require('../services/attendancePolicy');
const { activeRule, closeEndedShifts, dayExemptions, dailyRoster } = require('../services/attendanceRecords');

const executive = user => ['CEO', 'Super Admin'].includes(user.role);
const wrap = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: error.keyPattern?.deviceLockKey ? 'This browser device has already been used by another employee for this attendance day.' : 'Attendance was already recorded or changed. Refresh and try again.' });
    res.status(error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500)).json({ success: false, message: error.message });
  }
};
const id = value => { if (!mongoose.isValidObjectId(value)) fail('Invalid employee or attendance ID.'); return value; };
const text = (value, max = 1000) => { if (value === undefined || value === null) return ''; if (typeof value !== 'string' || value.length > max) fail('Text exceeds the allowed length.'); return value.trim(); };

exports.checkIn = wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user?.isActive) fail('Employee is inactive or unavailable.', 403);
  const body = req.body, now = new Date(), rule = await activeRule();
  const simulated = body.customTime !== undefined || body.bypassGeofence !== undefined || body.simulated === true;
  if (simulated && user.role !== 'CEO') fail('Attendance simulation is available only to the CEO.', 403);
  let checkIn = now;
  if (body.customTime !== undefined) {
    if (typeof body.customTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(body.customTime)) fail('Simulation timestamp must include a timezone.');
    checkIn = new Date(body.customTime);
    if (!Number.isFinite(checkIn.getTime()) || shiftDate(checkIn, rule) !== shiftDate(now, rule)) fail('Simulation is restricted to the current attendance day.');
  }
  if (body.bypassGeofence !== undefined && typeof body.bypassGeofence !== 'boolean') fail('Invalid geofence simulation flag.');
  const date = shiftDate(checkIn, rule);
  await closeEndedShifts(rule, { user: user._id }, now);
  const existing = await Attendance.findOne({ user: user._id, date });
  if (existing?.override?.type === 'absent' || (existing?.status === 'absent' && !existing?.checkIn)) fail('An administrator marked this day absent. Contact an administrator to restore it.', 409);
  if (existing?.checkIn) fail('Already checked in for this attendance day.', 409);
  const open = await Attendance.findOne({ user: user._id, checkIn: { $ne: null }, checkOut: null, date: { $ne: date }, 'override.type': { $ne: 'absent' } });
  if (open) fail('Close the previous open shift before checking in again.', 409);
  const deviceId = text(body.deviceId, 160);
  if (rule.antiProxySettings.enforceSingleDevicePerDay) {
    if (!deviceId) fail('Device identification is required. Reload the application and try again.');
    const conflict = await Attendance.exists({ date, 'deviceInfo.deviceId': deviceId, user: { $ne: user._id } });
    if (conflict) fail('This browser device has already been used by another employee for this attendance day.', 403);
  }
  const photo = body.photo ? validateSelfie(body.photo) : '';
  if (rule.antiProxySettings.requireSelfieVerification && !photo) fail('Capture a selfie before checking in.');
  const office = rule.officeLocation;
  const hasCoordinates = body.latitude !== undefined && body.longitude !== undefined;
  const location = { latitude: null, longitude: null, distanceMeters: null, isVerified: false, officeAddress: office.officeAddress };
  if (hasCoordinates) {
    if (typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90 || typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180) fail('GPS coordinates are invalid.');
    location.latitude = body.latitude; location.longitude = body.longitude;
    location.distanceMeters = distanceMeters(body.latitude, body.longitude, office.latitude, office.longitude);
  }
  if (office.enforceLocation && !body.bypassGeofence) {
    if (!hasCoordinates) fail('Allow location access to check in from the office.');
    if (location.distanceMeters > office.radiusMeters) fail('Check-in rejected: you are ' + location.distanceMeters + 'm from the office; the allowed radius is ' + office.radiusMeters + 'm.', 403);
    location.isVerified = !simulated;
  }
  const priorLateCount = await Attendance.countDocuments({ user: user._id, date: { $gte: date.slice(0, 7) + '-01', $lt: date }, isLate: true });
  let calculation = calculateAttendance(checkIn, user, rule, priorLateCount);
  const exemptions = await dayExemptions(date, [user._id]);
  if (exemptions.leaveUsers.has(String(user._id)) || exemptions.holiday) calculation = { status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, deductionReason: exemptions.holiday ? 'Attendance recorded on a company holiday; no late penalty.' : 'Attendance recorded during approved full-day leave; no late penalty.' };
  if (existing?.override?.type === 'present') calculation = { ...calculation, status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, deductionReason: existing.deductionReason };
  await Attendance.init();
  const fields = {
    checkIn, scheduledCheckOut: scheduledEnd(date, rule), ...calculation, location, photo,
    deviceInfo: { deviceId, deviceType: text(body.deviceType, 100), browser: text(body.browser, 100), userAgent: text(req.headers['user-agent'], 500) },
    notes: text(body.notes), ipAddress: req.ip || '', isSimulated: simulated,
    ...(rule.antiProxySettings.enforceSingleDevicePerDay ? { deviceLockKey: date + ':' + deviceId } : {}),
  };
  const record = existing
    ? await Attendance.findOneAndUpdate({ _id: existing._id, __v: existing.__v === undefined ? { $exists: false } : existing.__v, checkIn: null, 'override.type': { $ne: 'absent' } }, { $set: fields, $inc: { __v: 1 } }, { new: true, runValidators: true })
    : await Attendance.create({ user: user._id, date, ...fields });
  if (!record) fail('Attendance changed while checking in. Refresh and try again.', 409);
  await closeEndedShifts(rule, { user: user._id }, now);
  const saved = await Attendance.findById(record._id).select('-auditTrail -override.snapshot');
  res.status(201).json({ success: true, message: (simulated ? 'CEO simulation recorded. ' : 'Check-in recorded. ') + (calculation.isLate ? calculation.minutesLate + ' minutes late.' : 'On time.'), attendance: saved, distanceFromOffice: location.distanceMeters });
});

exports.checkOut = wrap(async (req, res) => {
  const now = new Date(), rule = await activeRule();
  let record = await Attendance.findOne({ user: req.user.id, checkIn: { $ne: null }, checkOut: null, 'override.type': { $ne: 'absent' } }).sort({ checkIn: -1 });
  if (!record) fail('No open check-in found. This shift may already be closed.', 409);
  if (new Date(record.checkIn) > now) fail('Cannot check out before the recorded check-in time.');
  const scheduled = record.scheduledCheckOut || scheduledEnd(record.date, rule);
  const end = new Date(Math.min(now.getTime(), Math.max(new Date(scheduled).getTime(), new Date(record.checkIn).getTime())));
  record = await Attendance.findOneAndUpdate({ _id: record._id, checkOut: null, 'override.type': { $ne: 'absent' } }, { $set: { checkOut: end, checkOutSource: end < now ? 'shift_end' : 'employee', totalWorkHours: Number(((end - new Date(record.checkIn)) / 3600000).toFixed(2)) }, $inc: { __v: 1 } }, { new: true, runValidators: true }).select('-auditTrail -override.snapshot');
  if (!record) fail('Attendance changed while checking out. Refresh the page.', 409);
  res.json({ success: true, message: 'Shift closed. Total hours: ' + record.totalWorkHours + 'h.', attendance: record });
});

exports.getTodayStatus = wrap(async (req, res) => {
  const now = new Date(), rule = await activeRule(), date = shiftDate(now, rule);
  await closeEndedShifts(rule, { user: req.user.id }, now);
  const [record, user, exemptions] = await Promise.all([
    Attendance.findOne({ user: req.user.id, date }).select('-auditTrail -override.snapshot'), User.findById(req.user.id), dayExemptions(date, [req.user.id]),
  ]);
  const attendance = record || (exemptions.leaveUsers.has(String(req.user.id)) ? { date, status: 'on_leave' } : exemptions.holiday ? { date, status: 'on_holiday' } : null);
  res.json({ success: true, date, timeZone: TIME_ZONE, attendance, officeLocation: rule.officeLocation, antiProxySettings: rule.antiProxySettings,
    shiftStartTime: rule.shiftStartTime, shiftEndTime: rule.shiftEndTime, gracePeriodMinutes: rule.gracePeriodMinutes,
    halfDayThresholdMinutes: rule.halfDayThresholdMinutes, fullDayAbsentThresholdMinutes: rule.fullDayAbsentThresholdMinutes,
    leaveBalances: user?.leaveBalances || { casual: 0, sick: 0, annual: 0 }, dailyWage: dailyWage(user || {}) });
});

exports.getHistory = wrap(async (req, res) => {
  const { userId, month, department, status } = req.query, filter = {};
  if (!executive(req.user)) filter.user = req.user.id;
  else if (userId && userId !== 'all') filter.user = id(userId);
  if (month) { if (!validMonth(month)) fail('Month must be a valid YYYY-MM.'); filter.date = { $regex: '^' + month }; }
  if (status && status !== 'All') { if (!['present','late','half_day','absent','on_leave'].includes(status)) fail('Invalid attendance status.'); filter.status = status; }
  if (department && department !== 'All') {
    const matching = await User.find({ department, ...(filter.user ? { _id: filter.user } : {}) }).select('_id');
    filter.user = { $in: matching.map(user => user._id) };
  }
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid pagination (limit 1–100).');
  await closeEndedShifts(await activeRule(), filter.user ? { user: filter.user } : {});
  const aggregateFilter = { ...filter };
  if (filter.user) aggregateFilter.user = filter.user.$in ? { $in: filter.user.$in.map(value => new mongoose.Types.ObjectId(String(value))) } : new mongoose.Types.ObjectId(String(filter.user));
  const [records, summary] = await Promise.all([
    Attendance.find(filter).select('-photo -auditTrail -override.snapshot').populate('user', 'name email department designation dailyWage').sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Attendance.aggregate([{ $match: aggregateFilter }, { $group: { _id: null, count: { $sum: 1 }, lateCount: { $sum: { $cond: ['$isLate', 1, 0] } }, totalDeductions: { $sum: '$deductionAmount' } } }]),
  ]);
  const photoIds = new Set((await Attendance.find({ _id: { $in: records.map(record => record._id) }, photo: { $exists: true, $nin: ['', null] } }).select('_id')).map(record => String(record._id)));
  const totals = summary[0] || { count: 0, lateCount: 0, totalDeductions: 0 };
  res.json({ success: true, count: totals.count, lateCount: totals.lateCount, totalDeductions: totals.totalDeductions, page, limit,
    pages: Math.ceil(totals.count / limit), records: records.map(record => ({ ...record, hasPhoto: photoIds.has(String(record._id)) })) });
});

exports.getDailyRoster = wrap(async (req, res) => {
  const rule = await activeRule();
  const date = req.query.date || shiftDate(new Date(), rule);
  if (!validDate(date)) fail('Date must be a valid YYYY-MM-DD.');
  await closeEndedShifts(rule);
  res.json({ success: true, date, timeZone: TIME_ZONE, roster: await dailyRoster(date) });
});

exports.getPhoto = wrap(async (req, res) => {
  const record = await Attendance.findById(id(req.params.id)).select('user photo date checkIn deviceInfo location isSimulated');
  if (!record || (!executive(req.user) && String(record.user) !== String(req.user.id))) fail('Attendance photo unavailable.', 404);
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, attendance: record });
});

async function overrideAttendance(req, res, absent) {
  if (!executive(req.user)) fail('Administrator access required.', 403);
  const rule = await activeRule();
  const userId = id(req.body.userId), date = req.body.date || shiftDate(new Date(), rule);
  if (!validDate(date) || date > companyDate()) fail('Attendance override requires a valid date that is not in the future.');
  const targetUser = await User.findById(userId);
  if (!targetUser?.isActive) fail('Employee not found or inactive.', 404);
  await Attendance.init();
  const record = await Attendance.findOne({ user: userId, date });
  const previousStatus = record?.status || 'not_checked_in';
  const previousState = record ? Object.fromEntries(['status','isLate','minutesLate','deductionAmount','deductionPercentage','deductionReason','notes'].map(key => [key, record[key]])) : null;
  const reason = text(req.body.notes) || (absent ? 'Administrator marked absent.' : 'Administrator restored attendance.');
  let fields;
  if (absent) {
    const snapshot = record?.override?.type === 'absent' ? record.override.snapshot : Object.fromEntries(['status','isLate','minutesLate','deductionAmount','deductionPercentage','deductionReason','notes','override'].map(key => [key, record ? record[key] : undefined]));
    fields = { status: 'absent', isLate: false, minutesLate: 0, deductionAmount: dailyWage(targetUser), deductionPercentage: 100, deductionReason: reason, notes: reason,
      override: { type: 'absent', snapshot, by: req.user.id, at: new Date() } };
  } else {
    const snapshot = record?.override?.type === 'absent' ? record.override.snapshot : null;
    fields = snapshot?.status ? { ...snapshot, override: snapshot.override || null } : { status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, deductionReason: reason, notes: reason, override: { type: 'present', by: req.user.id, at: new Date() } };
  }
  const event = { action: absent ? 'mark_absent' : record?.override?.snapshot?.status ? 'restore' : 'mark_present', by: req.user.id, at: new Date(), reason, previousStatus, previousState };
  const updated = record
    ? await Attendance.findOneAndUpdate({ _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v }, { $set: fields, $inc: { __v: 1 }, $push: { auditTrail: event } }, { new: true, runValidators: true }).select('-auditTrail -override.snapshot')
    : await Attendance.create({ user: userId, date, ...fields, auditTrail: [event] });
  if (!updated) fail('Attendance changed concurrently. Refresh and try again.', 409);
  await closeEndedShifts(rule, { user: userId });
  const saved = await Attendance.findById(updated._id).select('-auditTrail -override.snapshot');
  res.json({ success: true, message: targetUser.name + ': ' + (absent ? 'marked absent' : 'attendance restored') + ' for ' + date + '. Original check-in evidence retained.', attendance: saved });
}
exports.markAbsent = wrap((req, res) => overrideAttendance(req, res, true));
exports.markPresent = wrap((req, res) => overrideAttendance(req, res, false));
