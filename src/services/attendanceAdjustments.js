const Attendance = require('../models/Attendance');
const { companyDate, normalizeRule, dailyWage, workHours, validDate } = require('./attendancePolicy');
const { dayExemptions } = require('./attendanceRecords');
const { attendanceCalculation } = require('./leavePolicy');

async function reconcileLeave(leave, actor, rule, transaction, recordId) {
  const records = await Attendance.find({ user: leave.user, ...(recordId ? { _id: recordId } : {}), date: { $gte: companyDate(leave.startDate), $lte: companyDate(leave.endDate) }, 'quarantine.at': { $exists: false } }).session(transaction);
  const user = await require('../models/User').findById(leave.user).session(transaction);
  const reducedMonths = new Set();
  for (const record of records) {
    const snapshotRule = normalizeRule(record.policySnapshot || rule);
    const exemptions = await dayExemptions(record.date, [leave.user], snapshotRule, transaction);
    if (!exemptions.leaveUsers.has(String(leave.user)) && !exemptions.halfDayUsers.has(String(leave.user))) continue;
    const previousState = Object.fromEntries(['status', 'isLate', 'minutesLate', 'deductionAmount', 'deductionPercentage', 'deductionReason', 'scheduledCheckOut', 'expectedCheckIn', 'override', 'totalWorkHours', 'policySnapshot', 'wageSnapshot'].map(key => [key, record[key]]));
    const wage = record.wageSnapshot ?? (record.deductionPercentage > 0 ? record.deductionAmount * 100 / record.deductionPercentage : dailyWage(user || {}));
    let fields;
    if (record.checkIn) {
      const prior = await Attendance.countDocuments({ user: leave.user, date: { $gte: record.date.slice(0, 7) + '-01', $lt: record.date }, isLate: true, isSimulated: { $ne: true }, 'quarantine.at': { $exists: false } }).session(transaction);
      fields = attendanceCalculation(record.checkIn, record.date, { _id: leave.user, dailyWage: wage }, snapshotRule, exemptions, prior);
      // Existing deductions can be waived/reduced by approval, never increased.
      fields.deductionAmount = Math.min(record.deductionAmount, fields.deductionAmount);
      fields.deductionPercentage = wage > 0 ? Math.round(fields.deductionAmount / wage * 10000) / 100 : 0;
      // Full-day leave doesn't change a recorded shift's schedule.
      if (exemptions.leaveUsers.has(String(leave.user))) { delete fields.scheduledCheckOut; delete fields.expectedCheckIn; }
    } else {
      fields = { status: exemptions.leaveUsers.has(String(leave.user)) ? 'on_leave' : 'absent', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0,
        financialReviewRequired: !exemptions.leaveUsers.has(String(leave.user)), deductionReason: exemptions.leaveUsers.has(String(leave.user)) ? 'Approved full-day leave; no absence charge.' : 'Approved half-day leave; remaining unrecorded attendance requires administrator review.' };
    }
    Object.assign(fields, { policySnapshot: snapshotRule, wageSnapshot: wage });
    if (record.checkOut && fields.scheduledCheckOut) {
      // Retain the actual employee checkout evidence; cap credited hours to the working half.
      fields.totalWorkHours = workHours({ ...record.toObject(), ...fields }, new Date(Math.min(new Date(record.checkOut).getTime(), fields.scheduledCheckOut.getTime())));
    }
    // A later executive leave approval is an audited authorization to excuse
    // an earlier absence. Keep administrator presence waivers in force.
    if (record.override?.type === 'absent') {
      if (!record.checkIn && exemptions.halfDayUsers.has(String(leave.user))) {
        // Half-day leave excuses only half of an already-confirmed no-show.
        Object.assign(fields, { deductionAmount: Math.min(record.deductionAmount, Math.round(wage / 2)), financialReviewRequired: false, deductionReason: 'Approved half-day leave; confirmed remaining-half absence retained.' });
        fields.deductionPercentage = wage > 0 ? Math.round(fields.deductionAmount / wage * 10000) / 100 : 0;
      } else fields.override = null;
    }
    if (record.override?.type === 'present') Object.assign(fields, { status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0, financialReviewRequired: false, deductionReason: record.deductionReason || 'Administrator verified presence without deduction.' });
    if (record.checkIn || fields.status === 'on_leave') fields.financialReviewRequired = false;
    if (record.isLate && !fields.isLate) reducedMonths.add(record.date.slice(0, 7));
    await Attendance.updateOne({ _id: record._id, __v: record.__v }, { $set: fields, $inc: { __v: 1 }, $push: { auditTrail: { action: 'leave_adjustment', by: actor, at: new Date(), reason: `Approved leave ${leave._id} (${leave.session || 'full'}).`, previousStatus: record.status, previousState } } }, { session: transaction, runValidators: true });
  }
  await reconcileMonthlyLate(leave.user, reducedMonths, actor, rule, transaction, `Approved leave ${leave._id} removed an earlier monthly late incident.`);
}

async function reconcileMonthlyLate(userId, months, actor, rule, transaction, reason) {
  if (!months.size) return;
  const user = await require('../models/User').findById(userId).session(transaction);
  for (const month of months) {
    const records = await Attendance.find({ user: userId, date: { $regex: '^' + month }, isSimulated: { $ne: true }, 'quarantine.at': { $exists: false } }).sort({ date: 1 }).select('-photo -auditTrail -override.snapshot').session(transaction);
    let prior = 0;
    for (const record of records) {
      const previousLateCount = prior;
      if (record.isLate) prior++;
      if (!record.isLate || record.override?.type || !validDate(record.date) || !record.checkIn || !Number.isFinite(new Date(record.checkIn).getTime()) || record.deductionAmount <= 0) continue;
      const snapshotRule = normalizeRule(record.policySnapshot || rule);
      const wage = record.wageSnapshot ?? (record.deductionPercentage > 0 ? record.deductionAmount * 100 / record.deductionPercentage : dailyWage(user || {}));
      const exemptions = await dayExemptions(record.date, [userId], snapshotRule, transaction);
      const calculation = attendanceCalculation(record.checkIn, record.date, { _id: userId, dailyWage: wage }, snapshotRule, exemptions, previousLateCount);
      if (calculation.deductionAmount >= record.deductionAmount) continue;
      const previousState = { deductionAmount: record.deductionAmount, deductionPercentage: record.deductionPercentage, deductionReason: record.deductionReason };
      const amount = calculation.deductionAmount;
      await Attendance.updateOne({ _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v }, { $set: { deductionAmount: amount, deductionPercentage: wage > 0 ? Math.round(amount / wage * 10000) / 100 : 0, deductionReason: calculation.deductionReason }, $inc: { __v: 1 }, $push: { auditTrail: { action: 'repeat_adjustment', by: actor, at: new Date(), reason, previousStatus: record.status, previousState } } }, { session: transaction, runValidators: true });
    }
  }
}
module.exports = { reconcileLeave, reconcileMonthlyLate };
