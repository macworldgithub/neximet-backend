const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const LeaveRequest = require('../models/LeaveRequest');
const mongoose = require('mongoose');
const { companyDate, addDays, atCompanyTime, scheduledEnd, isWorkingDay, validDate, shiftDate, normalizeRule, dailyWage } = require('./attendancePolicy');
const { leaveCoverage, attendanceSchedule } = require('./leavePolicy');

// Materialize missing calendar outcomes, never fabricated check-in/out evidence or
// retrospective monetary charges. Unique user/day upserts make concurrent reads safe.
async function materializeHistory(rule, filter = {}, now = new Date()) {
  const today = companyDate(now);
  const people = await User.find({ role: { $ne: 'Client' }, ...(filter.user ? { _id: filter.user } : {}), $or: [{ isActive: true }, { deactivatedAt: { $type: 'date' } }] }).select('_id role joinDate createdAt dailyWage baseSalary isActive deactivatedAt attendanceCalendarThrough attendanceCalendarRevision attendanceTrackingFrom employmentGaps').lean();
  let requestedStart = filter.date?.$gte, requestedEnd = filter.date?.$lte || today;
  if (filter.date?.$regex) { const month = filter.date.$regex.slice(1); requestedStart = [requestedStart, month + '-01'].filter(Boolean).sort().at(-1); const next = new Date(month + '-01T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1); requestedEnd = [requestedEnd, addDays(next.toISOString().slice(0, 10), -1)].sort()[0]; }
  requestedEnd = [requestedEnd, today].sort()[0];
  if (!people.length) return;
  const rawStarts = people.map(person => { const join = companyDate(person.joinDate || person.createdAt || now), tracking = person.attendanceTrackingFrom ? companyDate(person.attendanceTrackingFrom) : join; return [join, tracking, requestedStart || join].sort().at(-1); });
  const starts = people.map((person, index) => validDate(person.attendanceCalendarThrough) ? [rawStarts[index], addDays(person.attendanceCalendarThrough, 1)].sort().at(-1) : rawStarts[index]);
  const start = starts.slice().sort()[0];
  if (!validDate(start) || start > requestedEnd) return;
  const ids = people.map(person => person._id);
  const existing = await Attendance.find({ user: { $in: ids }, date: { $gte: start, $lte: requestedEnd } }).select('user date status recordSource checkIn deductionAmount override.type').lean();
  const known = new Set(existing.map(record => `${record.user}:${record.date}`));
  // A shift on the final requested date can have arrival evidence the next morning.
  const legacy = await Attendance.find({ user: { $in: ids }, 'quarantine.at': { $exists: true }, checkIn: { $gte: atCompanyTime(start, '00:00'), $lt: atCompanyTime(addDays(requestedEnd, 2), '00:00') } }).select('user checkIn policySnapshot').lean();
  for (const record of legacy) {
    try { known.add(`${record.user}:${shiftDate(record.checkIn, normalizeRule(record.policySnapshot || rule))}`); }
    catch (error) {
      if (error.status !== 400) throw error;
      // A corrupt saved policy cannot establish whether arrival belongs to
      // this date or the preceding overnight shift. Avoid inferring a no-show
      // for either possible date until the original evidence is reviewed.
      const day = companyDate(record.checkIn);
      known.add(`${record.user}:${day}`); known.add(`${record.user}:${addDays(day, -1)}`);
    }
  }
  const holidays = await Holiday.find({ isMandatory: true, date: { $gte: atCompanyTime(start, '00:00'), $lt: atCompanyTime(addDays(requestedEnd, 1), '00:00') } }).lean();
  const holidayByDate = new Map(holidays.map(holiday => [companyDate(holiday.date), holiday.title]));
  const leaves = await LeaveRequest.find({ user: { $in: ids }, status: 'approved', startDate: { $lt: atCompanyTime(addDays(requestedEnd, 1), '00:00') }, endDate: { $gte: atCompanyTime(start, '00:00') } }).lean();
  const coverageByDate = new Map();
  const closedByDate = new Map();
  const operations = [];
  for (let index = 0; index < people.length; index++) {
    const person = people[index], last = person.deactivatedAt ? [requestedEnd, companyDate(person.deactivatedAt)].sort()[0] : requestedEnd;
    for (let date = starts[index]; date <= last; date = addDays(date, 1)) {
      if (person.employmentGaps?.some(gap => date > companyDate(gap.start) && date < companyDate(gap.end))) continue;
      if (known.has(`${person._id}:${date}`)) continue;
      if (!coverageByDate.has(date)) coverageByDate.set(date, leaveCoverage(leaves, date, rule));
      const sessions = coverageByDate.get(date).get(String(person._id));
      const holiday = holidayByDate.get(date), working = isWorkingDay(date, rule);
      if (!closedByDate.has(date)) closedByDate.set(date, scheduledEnd(date, rule) <= now);
      const closed = sessions?.size === 1 ? attendanceSchedule(date, rule, [...sessions][0]).scheduledCheckOut <= now : closedByDate.get(date);
      const status = holiday ? 'on_holiday' : !working ? 'day_off' : sessions?.size === 2 ? 'on_leave' : closed ? 'absent' : null;
      if (!status) continue;
      if (status === 'absent' && person.role === 'CEO') continue;
      const reason = holiday ? `Company holiday: ${holiday}.` : !working ? 'Scheduled day off.' : status === 'on_leave' ? 'Approved full-day leave.' : sessions?.size ? 'No check-in during the remaining half shift. Administrator deduction review required.' : 'No check-in recorded by shift end. Administrator deduction review required.';
      operations.push({ updateOne: { filter: { user: person._id, date }, update: { $setOnInsert: { user: person._id, date, status, recordSource: 'automatic', deductionAmount: 0, deductionPercentage: 0, isLate: false, minutesLate: 0, financialReviewRequired: status === 'absent', deductionReason: reason, policySnapshot: rule, wageSnapshot: dailyWage(person) } }, upsert: true } });
    }
  }
  await Attendance.init();
  for (let offset = 0; offset < operations.length; offset += 500) {
    try { await Attendance.bulkWrite(operations.slice(offset, offset + 500), { ordered: false }); }
    catch (error) { if (!error.writeErrors?.length || error.writeErrors.some(item => item.code !== 11000)) throw error; }
  }
  const pendingExisting = leaves.length ? existing.filter(record => record.status === 'absent' && record.recordSource === 'automatic' && !record.checkIn && !record.override?.type && !record.deductionAmount) : [];
  if (operations.length || pendingExisting.length) {
    // Generation reads coverage before inserting rows. Serialize a final fresh
    // coverage check with approvals so a newly approved day cannot remain absent.
    const generatedUsers = [...new Set([...operations.map(operation => String(operation.updateOne.filter.user)), ...pendingExisting.map(record => String(record.user))])];
    await mongoose.connection.transaction(async transaction => {
      await User.updateMany({ _id: { $in: generatedUsers } }, { $inc: { attendanceVersion: 1 } }, { session: transaction });
      const approved = await LeaveRequest.find({ user: { $in: generatedUsers }, status: 'approved', startDate: { $lt: atCompanyTime(addDays(requestedEnd, 1), '00:00') }, endDate: { $gte: atCompanyTime(start, '00:00') } }).session(transaction).lean();
      if (!approved.length) return;
      const eligible = { user: { $in: generatedUsers }, date: { $gte: start, $lte: requestedEnd }, recordSource: 'automatic', status: 'absent', checkIn: null, 'override.type': { $exists: false }, deductionAmount: 0 };
      const missing = await Attendance.find(eligible).session(transaction).lean();
      const corrections = [];
      for (const record of missing) {
        const coverage = leaveCoverage(approved, record.date, normalizeRule(record.policySnapshot || rule));
        if (coverage.get(String(record.user))?.size !== 2) continue;
        corrections.push({ updateOne: { filter: { ...eligible, _id: record._id, __v: record.__v === undefined ? { $exists: false } : record.__v }, update: { $set: { status: 'on_leave', financialReviewRequired: false, deductionReason: 'Approved full-day leave; no absence charge.' }, $inc: { __v: 1 } } } });
      }
      for (let offset = 0; offset < corrections.length; offset += 500) await Attendance.bulkWrite(corrections.slice(offset, offset + 500), { session: transaction });
    });
  }
  // A contiguous completed prefix prevents scanning years of history every minute.
  let completed = requestedEnd;
  while (scheduledEnd(completed, rule) > now) completed = addDays(completed, -1);
  for (let index = 0; index < people.length; index++) {
    const person = people[index], join = companyDate(person.attendanceTrackingFrom || person.joinDate || person.createdAt || now);
    const through = person.attendanceCalendarThrough;
    const contiguous = rawStarts[index] <= (validDate(through) ? addDays(through, 1) : join);
    const last = person.deactivatedAt ? [completed, companyDate(person.deactivatedAt)].sort()[0] : completed;
    // A repair can move a row after the generation read. Its revision prevents
    // this stale scan from restoring a checkpoint over the newly vacated date.
    if (contiguous && last >= starts[index]) await User.updateOne({ _id: person._id, attendanceCalendarRevision: person.attendanceCalendarRevision === undefined ? { $exists: false } : person.attendanceCalendarRevision }, { $max: { attendanceCalendarThrough: last } });
  }
}
module.exports = { materializeHistory };
