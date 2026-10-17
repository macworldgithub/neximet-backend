const Holiday = require('../models/Holiday');
const { fail, validDate, companyDate, addDays, atCompanyTime, scheduledEnd, isWorkingDay, dailyWage, calculateDeduction } = require('./attendancePolicy');

async function leaveDuration(input, rule, transaction) {
  const { startDate, endDate } = input;
  const session = input.session || (input.totalDays === 0.5 ? 'morning' : 'full');
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) fail('Choose valid start/end dates in chronological order.');
  const span = (new Date(endDate) - new Date(startDate)) / 86400000;
  if (span > 365) fail('A leave request may cover at most one year.');
  if (!['full', 'morning', 'afternoon'].includes(session) || (session !== 'full' && startDate !== endDate)) fail('Morning/afternoon leave must cover one date only.');
  const holidays = await Holiday.find({ isMandatory: true, date: { $gte: atCompanyTime(startDate, '00:00'), $lt: atCompanyTime(addDays(endDate, 1), '00:00') } }).session(transaction || null).lean();
  const excluded = new Set(holidays.map(holiday => companyDate(holiday.date)));
  const workingDates = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) if (isWorkingDay(date, rule) && !excluded.has(date)) workingDates.push(date);
  if (!workingDates.length) fail('This range contains no scheduled working days.');
  const totalDays = session === 'full' ? workingDates.length : 0.5;
  if (input.totalDays !== undefined && input.totalDays !== totalDays) fail(`The selected dates/session require ${totalDays} leave days. Reload the calculated duration.`);
  return { startDate: atCompanyTime(startDate, '00:00'), endDate: atCompanyTime(endDate, '00:00'), workingDates, session, totalDays };
}

function leaveCoverage(leaves, date, rule) {
  const coverage = new Map();
  if (!isWorkingDay(date, rule)) return coverage;
  for (const leave of leaves) {
    if (leave.workingDates?.length ? !leave.workingDates.includes(date) : companyDate(leave.startDate) > date || companyDate(leave.endDate) < date) continue;
    const key = String(leave.user), values = coverage.get(key) || new Set();
    // Legacy approved 0.5-day requests had no session; treat them as first-half leave.
    const session = leave.totalDays === 0.5 && (!leave.session || leave.session === 'full') ? 'morning' : leave.session || 'full';
    if (session === 'full') { values.add('morning'); values.add('afternoon'); } else values.add(session);
    coverage.set(key, values);
  }
  return coverage;
}

function attendanceSchedule(date, rule, halfSession) {
  const start = atCompanyTime(date, rule.shiftStartTime), end = scheduledEnd(date, rule);
  const middle = new Date((start.getTime() + end.getTime()) / 2);
  return { expectedCheckIn: halfSession === 'morning' ? middle : start, scheduledCheckOut: halfSession === 'afternoon' ? middle : end };
}

function attendanceCalculation(checkIn, date, user, rule, exemptions, priorLateCount = 0) {
  const key = String(user._id || user.id), halfSession = exemptions.halfDayUsers?.get(key);
  const schedule = attendanceSchedule(date, rule, halfSession);
  if (exemptions.holiday || exemptions.leaveUsers.has(key) || !isWorkingDay(date, rule)) {
    return { ...schedule, status: 'present', isLate: false, minutesLate: 0, deductionAmount: 0, deductionPercentage: 0,
      deductionReason: exemptions.holiday ? 'Company holiday; no late penalty.' : exemptions.leaveUsers.has(key) ? 'Approved full-day leave; no late penalty.' : 'Scheduled day off; no late penalty.' };
  }
  const calculation = calculateDeduction((new Date(checkIn) - schedule.expectedCheckIn) / 60000, dailyWage(user), rule, priorLateCount, { afterCutoff: new Date(checkIn) > atCompanyTime(date, '14:00') });
  if (halfSession) {
    calculation.deductionPercentage = Math.min(50, calculation.deductionPercentage);
    calculation.deductionAmount = Math.min(Math.round(dailyWage(user) * 50) / 100, calculation.deductionAmount);
    calculation.deductionReason += ` Approved ${halfSession} leave; arrival is assessed against the remaining half shift and its deduction is capped at half a daily wage.`;
  }
  return { ...schedule, ...calculation };
}
module.exports = { leaveDuration, leaveCoverage, attendanceSchedule, attendanceCalculation };
