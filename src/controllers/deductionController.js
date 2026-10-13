const DeductionRule = require('../models/DeductionRule');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { TIME_ZONE, fail, shiftDate, validMonth, normalizeRule, validateRule, calculateDeduction } = require('../services/attendancePolicy');
const { activeRule, closeEndedShifts } = require('../services/attendanceRecords');
const wrap = handler => async (req, res) => {
  try { await handler(req, res); } catch (error) { res.status(error.status || (error.code === 11000 || error.name === 'VersionError' ? 409 : error.name === 'ValidationError' ? 400 : 500)).json({ success: false, message: error.name === 'VersionError' ? 'Policy changed in another session. Reload before saving.' : error.message }); }
};
const fields = ['title','shiftStartTime','shiftEndTime','gracePeriodMinutes','lateThresholdMinutes','deductionType','percentageDeductionRate','fixedDeductionAmount','halfDayThresholdMinutes','fullDayAbsentThresholdMinutes','consecutiveLateThreshold','consecutivePenaltyMultiplier','currencySymbol','officeLocation','antiProxySettings'];

exports.getActiveRule = wrap(async (req, res) => {
  // A read must not create duplicate default policies during concurrent cold starts.
  res.json({ success: true, rule: await activeRule(), timeZone: TIME_ZONE });
});

exports.updateRule = wrap(async (req, res) => {
  if (req.user.role !== 'CEO') fail('Only the CEO can change attendance policy.', 403);
  const current = await DeductionRule.findOne({ isActive: true }).sort({ updatedAt: -1 });
  if (current && req.body.__v !== undefined && req.body.__v !== current.__v) fail('Policy changed in another session. Reload before saving.', 409);
  const changes = Object.fromEntries(fields.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
  const previous = normalizeRule(current);
  const rule = validateRule(normalizeRule({ ...previous, ...changes,
    officeLocation: { ...previous.officeLocation, ...changes.officeLocation }, antiProxySettings: { ...previous.antiProxySettings, ...changes.antiProxySettings } }));
  await DeductionRule.init();
  const document = current || await DeductionRule.findOneAndUpdate({ policyKey: 'attendance' }, { $setOnInsert: { policyKey: 'attendance', isActive: true } }, { upsert: true, new: true, runValidators: true });
  for (const key of fields) document[key] = rule[key];
  document.policyKey = 'attendance'; document.updatedBy = req.user.id; document.isActive = true;
  await document.save();
  res.json({ success: true, message: 'Policy saved. Changes apply to future check-ins; recorded deductions retain their original values.', rule: normalizeRule(document), timeZone: TIME_ZONE });
});

exports.simulateCalculation = wrap(async (req, res) => {
  const minutes = req.body.minutesLate, wage = req.body.dailyWage, prior = req.body.priorLateCount ?? 0;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440 || typeof wage !== 'number' || !Number.isFinite(wage) || wage < 0 || !Number.isInteger(prior) || prior < 0) fail('Provide valid minutes late (0–1440), non-negative wage and previous late count.');
  const rule = validateRule(normalizeRule(req.body.ruleOverrides || await activeRule()));
  const result = calculateDeduction(minutes, wage, rule, prior);
  res.json({ success: true, simulation: { ...result, minutesLate: result.minutesLate, dailyWage: wage, deduction: result.deductionAmount, explanation: result.deductionReason } });
});

exports.getMonthlyReport = wrap(async (req, res) => {
  const rule = await activeRule();
  const month = req.query.month || shiftDate(new Date(), rule).slice(0, 7);
  if (!validMonth(month)) fail('Month must be a valid YYYY-MM.');
  const allowed = ['CEO','Super Admin','Project Manager'].includes(req.user.role);
  if (!allowed) fail('Access denied.', 403);
  const filter = { date: { $regex: '^' + month }, deductionAmount: { $gt: 0 }, isSimulated: { $ne: true } };
  if (req.user.role === 'Project Manager') {
    const employees = await User.find({ department: req.user.department }).select('_id');
    filter.user = { $in: employees.map(user => user._id) };
  }
  await closeEndedShifts(rule, filter.user ? { user: filter.user } : {});
  const records = await Attendance.find(filter).select('date user checkIn status isLate minutesLate deductionAmount deductionReason')
    .populate('user', 'name email department designation baseSalary dailyWage').sort({ date: 1, _id: 1 });
  const grouped = new Map();
  for (const record of records) {
    if (!record.user) continue;
    const key = String(record.user._id);
    if (!grouped.has(key)) grouped.set(key, { user: record.user, totalLateIncidents: 0, totalAbsentIncidents: 0, totalMinutesLate: 0, totalDeductions: 0, incidents: [] });
    const item = grouped.get(key);
    item.totalLateIncidents += record.isLate ? 1 : 0;
    item.totalAbsentIncidents += record.status === 'absent' ? 1 : 0;
    item.totalMinutesLate += record.minutesLate || 0; item.totalDeductions += record.deductionAmount || 0;
    item.incidents.push({ date: record.date, checkIn: record.checkIn, status: record.status, minutesLate: record.minutesLate, deductionAmount: record.deductionAmount, reason: record.deductionReason });
  }
  const report = [...grouped.values()];
  res.json({ success: true, month, timeZone: TIME_ZONE, grandTotalDeductions: report.reduce((sum, item) => sum + item.totalDeductions, 0), employeesPenalizedCount: report.length, report });
});
