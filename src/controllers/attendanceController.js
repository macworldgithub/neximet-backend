const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const LeaveRequest = require('../models/LeaveRequest');
const { TIME_ZONE, fail, companyDate, validDate, validMonth, shiftDate, recordedScheduleEnd, recordedShift, atCompanyTime, addDays, isWorkingDay, dailyWage, distanceMeters, validateSelfie, workHours, normalizeRule } = require('../services/attendancePolicy');
const { activeRule, closeEndedShifts, dayExemptions, dailyRoster, operationalOpen, versionGuard } = require('../services/attendanceRecords');
const { attendanceCalculation, attendanceSchedule } = require('../services/leavePolicy');
const { materializeHistory } = require('../services/attendanceHistory');
const { reconcileLeave, reconcileMonthlyLate } = require('../services/attendanceAdjustments');

const executive = user => ['CEO', 'Super Admin'].includes(user.role);
const wrap = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) {
    if (error.code === 20) return res.status(503).json({ success: false, message: 'Attendance updates require MongoDB Atlas or a replica set with transaction support.' });
    if (error.code === 11000) return res.status(409).json({ success: false, message: error.keyPattern?.deviceLockKey ? 'This browser device has already been used by another employee for this attendance day.' : 'Attendance was already recorded or changed. Refresh and try again.' });
    res.status(error.status || (error.name === 'ValidationError' || error.name === 'CastError' ? 400 : 500)).json({ success: false, message: error.message });
  }
};
const id = value => { if (!mongoose.isValidObjectId(value)) fail('Invalid employee or attendance ID.'); return value; };
const text = (value, max = 1000) => { if (value === undefined || value === null) return ''; if (typeof value !== 'string' || value.length > max) fail('Text exceeds the allowed length.'); return value.trim(); };
const employedOn = (user, date) => date >= companyDate(user.joinDate || user.createdAt) && (!user.attendanceTrackingFrom || date >= companyDate(user.attendanceTrackingFrom)) && !user.employmentGaps?.some(gap => date > companyDate(gap.start) && date < companyDate(gap.end));
const attendanceView = (record, rule) => {
  if (!record) return null;
  const value = record.toObject ? record.toObject() : record;
  try { return !value.scheduledCheckOut && value.checkIn && validDate(value.date) && !value.quarantine?.at && Number.isFinite(new Date(value.checkIn).getTime()) ? { ...value, scheduledCheckOut: recordedScheduleEnd(value, rule) } : value; }
  catch (error) { if (error.status !== 400) throw error; return value; }
};
const repairSuggestion = (record, rule) => {
  if (!record.quarantine?.at || !record.checkIn || !Number.isFinite(new Date(record.checkIn).getTime())) return {};
  try { return { suggestedRepairDate: shiftDate(record.checkIn, normalizeRule(record.policySnapshot || rule)) }; }
  catch (error) { if (error.status !== 400) throw error; return {}; }
};

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
  if (existing?.quarantine?.at) fail('Attendance requires administrator repair before clock actions can continue.', 409);
  if (existing?.override?.type === 'absent' || (existing?.status === 'absent' && !existing?.checkIn && existing.recordSource !== 'automatic')) fail('An administrator marked this day absent. Contact an administrator to restore it.', 409);
  if (existing?.checkIn) fail('Already checked in for this attendance day.', 409);
  const open = await Attendance.findOne({ user: user._id, ...operationalOpen, date: { $ne: date } });
  if (open) fail('Close the previous open shift before checking in again.', 409);
  const deviceId = text(body.deviceId, 160);
  if (rule.antiProxySettings.enforceSingleDevicePerDay) {
    if (!deviceId) fail('Device identification is required. Reload the application and try again.');
    const conflict = await Attendance.exists({ date, 'deviceInfo.deviceId': deviceId, user: { $ne: user._id } });
    if (conflict) fail('This browser device has already been used by another employee for this attendance day.', 403);
  }
  const photo = body.photo ? await validateSelfie(body.photo) : '';
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
  await Attendance.init();
  let calculation;
  const record = await mongoose.connection.transaction(async transaction => {
    const employee = await User.findOneAndUpdate({ _id: user._id, isActive: true }, { $inc: { attendanceVersion: 1 } }, { new: true, session: transaction }).select('+employmentGaps +attendanceTrackingFrom');
    if (!employee) fail('Employee is inactive.', 403);
    if (!employedOn(employee, date)) fail('This working date is outside the employee\'s employment period.', 409);
    if (simulated && employee.role !== 'CEO') fail('Simulation requires CEO access.', 403);
    const current = await Attendance.findOne({ user: user._id, date }).session(transaction);
    if (current?.quarantine?.at) fail('Attendance requires administrator repair before clock actions can continue.', 409);
    if (current?.checkIn || current?.override?.type === 'absent' || (current?.status === 'absent' && current.recordSource !== 'automatic')) fail('Attendance was already recorded or overridden. Refresh before checking in.', 409);
    if (await Attendance.exists({ user: user._id, ...operationalOpen, date: { $ne: date } }).session(transaction)) fail('Close the previous open shift before checking in again.', 409);
    const priorLateCount = await Attendance.countDocuments({ user: user._id, date: { $gte: date.slice(0, 7) + '-01', $lt: date }, isLate: true, isSimulated: { $ne: true }, 'quarantine.at': { $exists: false } }).session(transaction);
    const exemptions = await dayExemptions(date, [user._id], rule, transaction);
    calculation = attendanceCalculation(checkIn, date, employee, rule, exemptions, priorLateCount);
    if (current?.override?.type === 'present') calculation = { ...calculation, status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, deductionReason: current.deductionReason };
    const fields = {
    checkIn, ...calculation, location, photo, policySnapshot: rule, wageSnapshot: dailyWage(employee), recordSource: 'employee', financialReviewRequired: false,
    deviceInfo: { deviceId, deviceType: text(body.deviceType, 100), browser: text(body.browser, 100), userAgent: text(req.headers['user-agent'], 500) },
    notes: text(body.notes), ipAddress: req.ip || '', isSimulated: simulated,
    ...(rule.antiProxySettings.enforceSingleDevicePerDay ? { deviceLockKey: date + ':' + deviceId } : {}),
    };
    if (current) return Attendance.findOneAndUpdate({ _id: current._id, __v: current.__v === undefined ? { $exists: false } : current.__v, checkIn: null, 'override.type': { $ne: 'absent' }, 'quarantine.at': { $exists: false } }, { $set: fields, $inc: { __v: 1 } }, { new: true, runValidators: true, session: transaction });
    const [created] = await Attendance.create([{ user: user._id, date, ...fields }], { session: transaction });
    return created;
  });
  if (!record) fail('Attendance changed while checking in. Refresh and try again.', 409);
  await closeEndedShifts(rule, { user: user._id }, now);
  const saved = await Attendance.findById(record._id).select('-auditTrail -override.snapshot');
  res.status(201).json({ success: true, message: (simulated ? 'CEO simulation recorded. ' : 'Check-in recorded. ') + (calculation.isLate ? calculation.minutesLate + ' minutes late.' : 'On time.'), attendance: saved, distanceFromOffice: location.distanceMeters });
});

exports.checkOut = wrap(async (req, res) => {
  const now = new Date(), rule = await activeRule();
  // Quarantine malformed rows, but leave overdue valid rows for this explicit checkout.
  const invalid = await Attendance.find({ user: req.user.id, ...operationalOpen }).select('date checkIn scheduledCheckOut expectedCheckIn policySnapshot __v').lean();
  for (const row of invalid) {
    try { recordedShift(row, rule); }
    catch (error) {
      if (error.status !== 400) throw error;
      await Attendance.collection.updateOne({ _id: row._id, ...versionGuard(row), ...operationalOpen }, { $set: { quarantine: { at: now, reason: error.message } }, $inc: { __v: 1 } });
    }
  }
  let record = await Attendance.findOne({ user: req.user.id, ...operationalOpen }).sort({ checkIn: -1 });
  if (!record) fail('No open check-in found. This shift may already be closed.', 409);
  if (new Date(record.checkIn) > now) fail('Cannot check out before the recorded check-in time.');
  const scheduled = recordedScheduleEnd(record, rule);
  const end = new Date(Math.min(now.getTime(), Math.max(new Date(scheduled).getTime(), new Date(record.checkIn).getTime())));
  record = await Attendance.findOneAndUpdate({ _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v, ...operationalOpen }, { $set: { checkOut: end, checkOutSource: end < now ? 'shift_end' : 'employee', totalWorkHours: workHours(record, end, rule) }, $inc: { __v: 1 } }, { new: true, runValidators: true }).select('-auditTrail -override.snapshot');
  if (!record) fail('Attendance changed while checking out. Refresh the page.', 409);
  res.json({ success: true, message: 'Shift closed. Total hours: ' + record.totalWorkHours + 'h.', attendance: record });
});

exports.getTodayStatus = wrap(async (req, res) => {
  const now = new Date(), rule = await activeRule(), date = shiftDate(now, rule);
  await closeEndedShifts(rule, { user: req.user.id }, now);
  await materializeHistory(rule, { user: req.user.id, date: { $gte: date, $lte: date } }, now);
  const [record, user, exemptions] = await Promise.all([
    Attendance.findOne({ user: req.user.id, date }).select('-auditTrail -override.snapshot'), User.findById(req.user.id), dayExemptions(date, [req.user.id], rule),
  ]);
  const openAttendance = await Attendance.findOne({ user: req.user.id, ...operationalOpen }).sort({ checkIn: -1 }).select('-auditTrail -override.snapshot');
  const repairRequired = await Attendance.find({ user: req.user.id, 'quarantine.at': { $exists: true } }).select('_id date quarantine').lean();
  const attendance = attendanceView(record, rule) || (exemptions.leaveUsers.has(String(req.user.id)) ? { date, status: 'on_leave' } : exemptions.holiday ? { date, status: 'on_holiday' } : !isWorkingDay(date, rule) ? { date, status: 'day_off' } : null);
  const halfDaySession = exemptions.halfDayUsers.get(String(req.user.id));
  res.json({ success: true, date, timeZone: TIME_ZONE, attendance, openAttendance: attendanceView(openAttendance, rule), repairRequired, officeLocation: rule.officeLocation, antiProxySettings: rule.antiProxySettings,
    personalSchedule: { ...attendanceSchedule(date, rule, halfDaySession), halfDaySession: halfDaySession || null },
    shiftStartTime: rule.shiftStartTime, shiftEndTime: rule.shiftEndTime, gracePeriodMinutes: rule.gracePeriodMinutes,
    halfDayThresholdMinutes: rule.halfDayThresholdMinutes, fullDayAbsentThresholdMinutes: rule.fullDayAbsentThresholdMinutes,
    leaveBalances: user?.leaveBalances || { casual: 0, sick: 0, annual: 0 }, dailyWage: dailyWage(user || {}) });
});

exports.getHistory = wrap(async (req, res) => {
  const { userId, month, department, status, startDate, endDate } = req.query, filter = {};
  if (!executive(req.user)) filter.user = req.user.id;
  else if (userId && userId !== 'all') filter.user = id(userId);
  if (month) { if (!validMonth(month)) fail('Month must be a valid YYYY-MM.'); filter.date = { $regex: '^' + month }; }
  if (startDate !== undefined || endDate !== undefined) {
    if ((startDate !== undefined && !validDate(startDate)) || (endDate !== undefined && !validDate(endDate))) fail('Start and end dates must be valid YYYY-MM-DD dates.');
    if (startDate && endDate && startDate > endDate) fail('Start date must not be after end date.');
    filter.date = { ...filter.date, ...(startDate ? { $gte: startDate } : {}), ...(endDate ? { $lte: endDate } : {}) };
  }
  if (status && status !== 'All') { if (!['present','late','half_day','absent','on_leave','on_holiday','day_off'].includes(status)) fail('Invalid attendance status.'); filter.status = status; }
  const search = text(req.query.search, 100);
  if ((department && department !== 'All') || search) {
    // Treat names as literal text, and intersect with the authorized user scope.
    const matching = await User.find({
      ...(department && department !== 'All' ? { department } : {}),
      ...(search ? { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}),
      ...(filter.user ? { _id: filter.user } : {}),
    }).select('_id');
    filter.user = { $in: matching.map(user => user._id) };
  }
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid pagination (limit 1–100).');
  const historyRule = await activeRule();
  await closeEndedShifts(historyRule, filter.user ? { user: filter.user } : {});
  await materializeHistory(historyRule, filter);
  const aggregateFilter = { ...filter };
  if (filter.user) aggregateFilter.user = filter.user.$in ? { $in: filter.user.$in.map(value => new mongoose.Types.ObjectId(String(value))) } : new mongoose.Types.ObjectId(String(filter.user));
  // Keep original rows available for review while excluding untrusted evidence
  // from financial/incident totals, consistently with the payroll ledger.
  const countable = { $and: [{ $ne: ['$isSimulated', true] }, { $eq: [{ $ifNull: ['$quarantine.at', null] }, null] }] };
  const [records, summary] = await Promise.all([
    Attendance.find(filter).select('-photo -auditTrail -override.snapshot').populate('user', 'name email department designation dailyWage').sort({ date: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Attendance.aggregate([{ $match: aggregateFilter }, { $group: {
      _id: null, count: { $sum: 1 },
      lateCount: { $sum: { $cond: [{ $and: ['$isLate', countable] }, 1, 0] } },
      totalDeductions: { $sum: { $cond: [countable, '$deductionAmount', 0] } },
    } }]),
  ]);
  const photoIds = new Set((await Attendance.find({ _id: { $in: records.map(record => record._id) }, photo: { $exists: true, $nin: ['', null] } }).select('_id')).map(record => String(record._id)));
  const totals = summary[0] || { count: 0, lateCount: 0, totalDeductions: 0 };
  res.json({ success: true, count: totals.count, lateCount: totals.lateCount, totalDeductions: totals.totalDeductions, page, limit,
    pages: Math.ceil(totals.count / limit), records: records.map(record => ({ ...record, hasPhoto: photoIds.has(String(record._id)), ...repairSuggestion(record, historyRule) })) });
});

exports.getDailyRoster = wrap(async (req, res) => {
  const rule = await activeRule();
  const date = req.query.date || shiftDate(new Date(), rule);
  if (!validDate(date)) fail('Date must be a valid YYYY-MM-DD.');
  await closeEndedShifts(rule);
  await materializeHistory(rule, { date: { $gte: date, $lte: date } });
  res.json({ success: true, date, timeZone: TIME_ZONE, roster: await dailyRoster(date) });
});

exports.getPhoto = wrap(async (req, res) => {
  const record = await Attendance.findById(id(req.params.id)).select('user photo date checkIn deviceInfo location isSimulated');
  if (!record || (!executive(req.user) && String(record.user) !== String(req.user.id))) fail('Attendance photo unavailable.', 404);
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, attendance: record });
});

exports.repairRecord = wrap(async (req, res) => {
  if (!executive(req.user)) fail('Administrator access required.', 403);
  if (req.body.expectedRecordId !== undefined && req.body.expectedRecordId !== null) id(req.body.expectedRecordId);
  if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== null && (!Number.isInteger(req.body.expectedVersion) || req.body.expectedVersion < 0)) fail('Invalid attendance record version.');
  await Attendance.init();
  const record = await Attendance.findById(id(req.params.id)).lean();
  if (!record?.quarantine?.at) fail('This record does not require legacy repair.', 409);
  if ((req.body.expectedRecordId !== undefined && String(record._id) !== req.body.expectedRecordId) || (req.body.expectedVersion !== undefined && (record.__v ?? null) !== req.body.expectedVersion)) fail('Attendance changed since you opened this action. Refresh and review it again.', 409);
  const date = req.body.date;
  if (!validDate(date) || date > companyDate() || !record.checkIn || !Number.isFinite(new Date(record.checkIn).getTime())) fail('Choose a valid past/current working date for a record with intact check-in evidence.');
  const rule = normalizeRule(record.policySnapshot || await activeRule());
  const bounds = attendanceSchedule(date, rule);
  const withinShift = value => value && Number.isFinite(new Date(value).getTime()) && new Date(value) >= bounds.expectedCheckIn && new Date(value) <= bounds.scheduledCheckOut;
  // Keep valid half-shift bounds, but move a schedule left on the wrong date.
  // Arrival and employee departure timestamps remain original evidence.
  const schedule = withinShift(record.scheduledCheckOut) ? record.scheduledCheckOut : bounds.scheduledCheckOut;
  const expected = record.expectedCheckIn && Number.isFinite(new Date(record.expectedCheckIn).getTime()) && !withinShift(record.expectedCheckIn) ? bounds.expectedCheckIn : record.expectedCheckIn;
  // Date repair cannot restore a corrupt expected arrival or saved policy.
  // Validate before clearing quarantine so success never immediately re-quarantines.
  recordedShift({ ...record, date, scheduledCheckOut: schedule, expectedCheckIn: expected }, rule);
  if (record.checkOut && !Number.isFinite(new Date(record.checkOut).getTime())) fail('Invalid legacy checkout evidence requires administrator review.');
  const hours = record.checkOut ? workHours({ ...record, date, expectedCheckIn: expected }, new Date(Math.min(new Date(record.checkOut).getTime(), new Date(schedule).getTime())), rule) : undefined;
  const deviceLockKey = record.deviceInfo?.deviceId && (record.deviceLockKey || rule.antiProxySettings?.enforceSingleDevicePerDay) ? `${date}:${record.deviceInfo.deviceId}` : null;
  const repaired = await mongoose.connection.transaction(async transaction => {
    await User.updateOne({ _id: record.user }, { $inc: { attendanceVersion: 1, attendanceCalendarRevision: 1 }, $unset: { attendanceCalendarThrough: '' } }, { session: transaction });
    const placeholder = await Attendance.findOne({ user: record.user, date, _id: { $ne: record._id } }).session(transaction);
    if (placeholder && (placeholder.recordSource !== 'automatic' || placeholder.checkIn || placeholder.override?.type || placeholder.deductionAmount > 0)) fail('Another recorded attendance already uses this date. Both records have been retained; choose the correct working date.', 409);
    if (placeholder) await Attendance.deleteOne({ _id: placeholder._id }, { session: transaction });
    const updated = await Attendance.findOneAndUpdate({ _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v, 'quarantine.at': { $exists: true } }, {
      $set: { date, scheduledCheckOut: schedule, ...(expected != null ? { expectedCheckIn: expected } : {}), ...(hours !== undefined ? { totalWorkHours: hours } : {}), ...(deviceLockKey ? { deviceLockKey } : {}) }, $unset: { quarantine: '' }, $inc: { __v: 1 }, $push: { auditTrail: { action: 'repair', by: req.user.id, at: new Date(), reason: text(req.body.notes) || 'Administrator repaired the legacy working date and derived schedule; original timestamps and financial evidence retained.', previousStatus: record.status, previousState: { date: record.date, scheduledCheckOut: record.scheduledCheckOut, expectedCheckIn: record.expectedCheckIn, totalWorkHours: record.totalWorkHours, deviceLockKey: record.deviceLockKey, quarantine: record.quarantine, replacedCalendarOutcome: placeholder?.toObject() } } },
    }, { new: true, runValidators: true, session: transaction }).select('-photo -auditTrail -override.snapshot');
    if (!updated) fail('Attendance changed while repairing. Refresh before retrying.', 409);
    const covering = await LeaveRequest.find({ user: record.user, status: 'approved', startDate: { $lt: atCompanyTime(addDays(date, 1), '00:00') }, endDate: { $gte: atCompanyTime(date, '00:00') } }).session(transaction);
    for (const leave of covering) await reconcileLeave(leave, req.user.id, rule, transaction, record._id);
    return updated;
  });
  if (!repaired) fail('Attendance changed while repairing. Refresh before retrying.', 409);
  await closeEndedShifts(rule, { user: record.user });
  res.json({ success: true, message: 'Legacy record repaired with an audit trail.', attendance: await Attendance.findById(repaired._id).select('-photo -auditTrail -override.snapshot') });
});

async function overrideAttendance(req, res, absent) {
  if (!executive(req.user)) fail('Administrator access required.', 403);
  let rule = await activeRule();
  const userId = id(req.body.userId), date = req.body.date || shiftDate(new Date(), rule);
  if (!validDate(date) || date > companyDate()) fail('Attendance override requires a valid date that is not in the future.');
  if (req.body.verifyPresence !== undefined && (absent || typeof req.body.verifyPresence !== 'boolean')) fail('Invalid presence verification option.');
  if (req.body.expectedRecordId !== undefined && req.body.expectedRecordId !== null) id(req.body.expectedRecordId);
  if (req.body.expectedVersion !== undefined && req.body.expectedVersion !== null && (!Number.isInteger(req.body.expectedVersion) || req.body.expectedVersion < 0)) fail('Invalid attendance record version.');
  await Attendance.init();
  let employeeName;
  const updated = await mongoose.connection.transaction(async transaction => {
    const targetUser = await User.findOneAndUpdate({ _id: userId }, { $inc: { attendanceVersion: 1 } }, { new: true, session: transaction }).select('+employmentGaps +attendanceTrackingFrom');
    if (!targetUser) fail('Employee not found.', 404);
    employeeName = targetUser.name;
    const record = await Attendance.findOne({ user: userId, date }).session(transaction);
    if (record?.quarantine?.at) fail('Repair the attendance evidence before applying an attendance override.', 409);
    if ((req.body.expectedRecordId !== undefined && (record ? String(record._id) : null) !== req.body.expectedRecordId) || (req.body.expectedVersion !== undefined && (record?.__v ?? null) !== req.body.expectedVersion)) fail('Attendance changed since you opened this action. Refresh and review it again.', 409);
    if (!record && !employedOn(targetUser, date)) fail('Cannot create attendance outside the employee\'s employment period.', 404);
    if (!targetUser.isActive && (!record || (targetUser.deactivatedAt && date > companyDate(targetUser.deactivatedAt)))) fail('Only recorded attendance before the employee left can be corrected.', 404);
    rule = normalizeRule(record?.policySnapshot || await activeRule(transaction));
    const wage = record?.wageSnapshot ?? dailyWage(targetUser);
    const previousStatus = record?.status || 'not_checked_in';
    const previousState = record ? Object.fromEntries(['status','isLate','minutesLate','deductionAmount','deductionPercentage','deductionReason','notes','financialReviewRequired'].map(key => [key, record[key]])) : null;
    const reason = text(req.body.notes) || (absent ? 'Administrator marked absent.' : 'Administrator restored attendance.');
    let fields;
    if (absent) {
      const coverage = await dayExemptions(date, [userId], rule, transaction);
      const percentage = coverage.holiday || coverage.leaveUsers.has(String(userId)) || !isWorkingDay(date, rule) ? 0 : coverage.halfDayUsers.has(String(userId)) ? 50 : 100;
      const snapshot = record?.override?.type === 'absent' ? record.override.snapshot : Object.fromEntries(['status','isLate','minutesLate','deductionAmount','deductionPercentage','deductionReason','notes','override','financialReviewRequired'].map(key => [key, record ? record[key] : undefined]));
      fields = { status: 'absent', isLate: false, minutesLate: 0, deductionAmount: Math.round(wage * percentage / 100), deductionPercentage: percentage, deductionReason: `${reason}${percentage < 100 ? ' Approved leave/day-off coverage limits this absence charge to ' + percentage + '% of daily wage.' : ''}`, notes: reason, financialReviewRequired: false,
        override: { type: 'absent', snapshot, by: req.user.id, at: new Date() } };
    } else {
      const snapshot = !req.body.verifyPresence && record?.override?.type === 'absent' ? record.override.snapshot : null;
      fields = snapshot?.status ? { ...snapshot, override: snapshot.override || null } : { status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, deductionReason: reason, notes: reason, financialReviewRequired: false, override: { type: 'present', by: req.user.id, at: new Date() } };
      if (fields.financialReviewRequired === undefined) fields.financialReviewRequired = false;
    }
    Object.assign(fields, { policySnapshot: rule, wageSnapshot: wage });
    const event = { action: absent ? 'mark_absent' : !req.body.verifyPresence && record?.override?.snapshot?.status ? 'restore' : 'mark_present', by: req.user.id, at: new Date(), reason, previousStatus, previousState };
    const saved = record
      ? await Attendance.findOneAndUpdate({ _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v }, { $set: fields, $inc: { __v: 1 }, $push: { auditTrail: event } }, { new: true, runValidators: true, session: transaction }).select('-auditTrail -override.snapshot')
      : (await Attendance.create([{ user: userId, date, ...fields, recordSource: 'administrator', auditTrail: [event] }], { session: transaction }))[0];
    if (!saved) fail('Attendance changed concurrently. Refresh and try again.', 409);
    if (record?.isLate && !fields.isLate) await reconcileMonthlyLate(userId, new Set([date.slice(0, 7)]), req.user.id, rule, transaction, `Administrator correction on ${date} removed an earlier monthly late incident.`);
    return saved;
  });
  await closeEndedShifts(rule, { user: userId });
  const saved = await Attendance.findById(updated._id).select('-auditTrail -override.snapshot');
  res.json({ success: true, message: employeeName + ': ' + (absent ? 'marked absent' : req.body.verifyPresence ? 'presence verified without deduction' : 'attendance restored') + ' for ' + date + '. Original check-in evidence retained.', attendance: saved });
}
exports.markAbsent = wrap((req, res) => overrideAttendance(req, res, true));
exports.markPresent = wrap((req, res) => overrideAttendance(req, res, false));
