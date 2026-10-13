// Uses a disposable localhost database. Never loads the application .env or server.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const Attendance = require('../src/models/Attendance');
const DeductionRule = require('../src/models/DeductionRule');
const Holiday = require('../src/models/Holiday');
const LeaveRequest = require('../src/models/LeaveRequest');
const p = require('../src/services/attendancePolicy');
process.env.JWT_SECRET = 'isolated-attendance-test-secret';
let mongo, directory, server, base, people, photo;
const token = new Map();
async function request(user, endpoint, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(base + endpoint, { method, headers: { ...(user ? { Authorization: 'Bearer ' + token.get(String(user._id)) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const payload = (device = 'device-one') => ({ deviceId: device, latitude: 24.8607, longitude: 67.0011, photo });
async function record(user, changes = {}) {
  const now = new Date();
  return Attendance.create({ user: user._id, date: p.companyDate(), checkIn: new Date(now - 1800000), scheduledCheckOut: new Date(now.getTime() + 3600000), status: 'late', isLate: true, minutesLate: 30, deductionAmount: 50, deductionPercentage: 5, photo, ...changes });
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-attendance-test-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const binary = process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod');
  mongo = spawn(binary, ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let startupError; mongo.on('error', error => { startupError = error; });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/attendance_tests`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 39) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  await Promise.all([User.init(), Attendance.init(), DeductionRule.init(), Holiday.init(), LeaveRequest.init()]);
  people = await User.create([
    { name: 'Member', role: 'Team Member', department: 'Software Development' },
    { name: 'Other', role: 'Team Member', department: 'Graphics Designing' },
    { name: 'CEO', role: 'CEO', department: 'Executive' },
    { name: 'Admin', role: 'Super Admin', department: 'Executive' },
    { name: 'Manager', role: 'Project Manager', department: 'Software Development' },
  ].map((person, i) => ({ ...person, email: `attendance${i}@example.test`, password: 'isolated-password', dailyWage: 1000 })));
  for (const user of people) token.set(String(user._id), jwt.sign({ id: user._id }, process.env.JWT_SECRET));
  photo = 'data:image/png;base64,' + (await readFile(path.join(__dirname, 'fixtures', 'attendance-image.png'))).toString('base64');
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.use('/attendance', require('../src/routes/attendanceRoutes'));
  app.use('/deductions', require('../src/routes/deductionRoutes'));
  app.use('/dashboard', require('../src/routes/dashboardRoutes'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async () => {
  await Promise.all([Attendance.deleteMany({}), DeductionRule.deleteMany({}), Holiday.deleteMany({}), LeaveRequest.deleteMany({})]);
  await DeductionRule.create({ ...p.DEFAULT_RULE, policyKey: 'attendance', shiftStartTime: '00:00', shiftEndTime: '23:59' });
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const exited = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await exited; }
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('neximet-attendance-test-')) await rm(directory, { recursive: true, force: true });
});

test('unauthenticated and employee simulation/administrative requests are denied', async () => {
  const [member, other] = people;
  assert.equal((await request(null, '/attendance/today')).status, 401);
  for (const extra of [{ customTime: new Date().toISOString() }, { bypassGeofence: true }, { simulated: true }]) assert.equal((await request(member, '/attendance/check-in', { ...payload(), ...extra })).status, 403);
  assert.equal((await request(member, '/attendance/mark-absent', { userId: other.id })).status, 403);
});
test('check-in rejects missing device, fake photos and invalid/outside coordinates', async () => {
  for (const extra of [{ deviceId: '' }, { photo: 'truthy-fake-photo' }, { latitude: 91 }, { latitude: null }, { longitude: '67' }]) assert.equal((await request(people[0], '/attendance/check-in', { ...payload(), ...extra })).status, 400);
  assert.equal((await request(people[0], '/attendance/check-in', { ...payload(), latitude: 0, longitude: 0 })).status, 403);
  assert.equal(await Attendance.countDocuments(), 0);
});
test('real check-in uses server timestamp and respects duplicate user/day under concurrency', async () => {
  const start = Date.now();
  const results = await Promise.all([request(people[0], '/attendance/check-in', payload()), request(people[0], '/attendance/check-in', payload())]);
  assert.equal(results.filter(res => res.status === 201).length, 1);
  assert.equal(results.filter(res => res.status === 409).length, 1);
  const doc = await Attendance.findOne({ user: people[0]._id });
  assert.ok(doc.checkIn.getTime() >= start && doc.checkIn.getTime() <= Date.now());
  assert.equal(doc.location.isVerified, true);
  assert.equal(await Attendance.countDocuments(), 1);
});
test('concurrent users cannot register the same locked browser on the same day', async () => {
  const results = await Promise.all(people.slice(0, 2).map(user => request(user, '/attendance/check-in', payload('shared-browser'))));
  assert.equal(results.filter(res => res.status === 201).length, 1);
  assert.ok(results.some(res => [403, 409].includes(res.status)));
  assert.equal(await Attendance.countDocuments(), 1);
});
test('disabling device/location/selfie enforcement does not falsely stamp GPS as verified', async () => {
  await DeductionRule.updateOne({}, { $set: { 'officeLocation.enforceLocation': false, 'antiProxySettings.enforceSingleDevicePerDay': false, 'antiProxySettings.requireSelfieVerification': false } });
  const res = await request(people[0], '/attendance/check-in', {});
  assert.equal(res.status, 201); assert.equal(res.body.attendance.location.isVerified, false);
});
test('CEO simulation is date-bounded, explicitly marked, and never GPS verified', async () => {
  assert.equal((await request(people[2], '/attendance/check-in', { ...payload(), customTime: 'invalid' })).status, 400);
  assert.equal((await request(people[2], '/attendance/check-in', { ...payload(), customTime: '2020-01-01T09:00:00+05:00' })).status, 400);
  const res = await request(people[2], '/attendance/check-in', { ...payload(), customTime: p.atCompanyTime(p.companyDate(), '09:35').toISOString() });
  assert.equal(res.status, 201); assert.equal(res.body.attendance.isSimulated, true); assert.equal(res.body.attendance.location.isVerified, false);
});
test('overnight simulations and default admin overrides use the current working day', async () => {
  const night = p.normalizeRule({ shiftStartTime: '22:00', shiftEndTime: '06:00' });
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '22:00', shiftEndTime: '06:00' } });
  const day = p.shiftDate(new Date(), night);
  await record(people[0], { date: day, checkOut: new Date() });
  const absent = await request(people[3], '/attendance/mark-absent', { userId: people[0].id });
  assert.equal(absent.status, 200); assert.equal(absent.body.attendance.date, day);
  const simulated = await request(people[2], '/attendance/check-in', { ...payload('night-simulator'), customTime: p.atCompanyTime(day, '22:10').toISOString() });
  assert.equal(simulated.status, 201); assert.equal(simulated.body.attendance.date, day);
  assert.equal((await request(people[2], '/attendance/today')).body.date, day);
});
test('checkout is atomic and cannot be overwritten by repeated clicks', async () => {
  await record(people[0]);
  const results = await Promise.all([request(people[0], '/attendance/check-out', {}), request(people[0], '/attendance/check-out', {})]);
  assert.equal(results.filter(res => res.status === 200).length, 1); assert.equal(results.filter(res => res.status === 409).length, 1);
  const first = await Attendance.findOne({ user: people[0]._id });
  assert.ok(first.totalWorkHours >= 0.5); assert.equal(first.checkOutSource, 'employee');
  assert.equal((await request(people[0], '/attendance/check-out', {})).status, 409);
  const second = await Attendance.findById(first._id); assert.equal(second.checkOut.getTime(), first.checkOut.getTime());
});
test('future simulated check-in cannot yield negative worked hours', async () => {
  await record(people[0], { checkIn: new Date(Date.now() + 3600000) });
  assert.equal((await request(people[0], '/attendance/check-out', {})).status, 400);
  assert.equal((await Attendance.findOne()).checkOut, undefined);
});
test('overdue shifts close at their recorded scheduled end, including prior-day shifts', async () => {
  const day = p.addDays(p.companyDate(), -1);
  const doc = await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:00'), scheduledCheckOut: p.atCompanyTime(day, '18:00') });
  await request(people[0], '/attendance/today');
  const closed = await Attendance.findById(doc._id);
  assert.equal(closed.totalWorkHours, 9); assert.equal(closed.checkOutSource, 'shift_end'); assert.equal(closed.checkOut.getTime(), p.atCompanyTime(day, '18:00').getTime());
});
test('malformed legacy dates cannot break roster reads or be silently rewritten', async () => {
  const inserted = await Attendance.collection.insertOne({ user: people[1]._id, date: 'legacy-invalid-date', checkIn: new Date(Date.now() - 60000), checkOut: null, status: 'present' });
  const roster = await request(people[3], '/attendance/roster'); assert.equal(roster.status, 200);
  const legacy = await Attendance.collection.findOne({ _id: inserted.insertedId }); assert.equal(legacy.checkOut, null); assert.equal(legacy.date, 'legacy-invalid-date');
});
test('absence overrides retain evidence, block employee changes, and restore original deductions', async () => {
  const doc = await record(people[0], { checkOut: new Date(), totalWorkHours: 0.5, notes: 'original', deductionReason: 'original late charge' });
  const absent = await request(people[3], '/attendance/mark-absent', { userId: people[0].id });
  assert.equal(absent.status, 200); assert.equal(absent.body.attendance.status, 'absent');
  let changed = await Attendance.findById(doc._id);
  assert.equal(changed.checkIn.getTime(), doc.checkIn.getTime()); assert.equal(changed.photo, photo); assert.equal(changed.totalWorkHours, 0.5);
  assert.equal((await request(people[0], '/attendance/check-in', payload())).status, 409);
  assert.equal((await request(people[0], '/attendance/check-out', {})).status, 409);
  const restored = await request(people[3], '/attendance/mark-present', { userId: people[0].id });
  assert.equal(restored.status, 200); assert.equal(restored.body.attendance.status, 'late');
  changed = await Attendance.findById(doc._id); assert.equal(changed.deductionAmount, 50); assert.equal(changed.notes, 'original'); assert.equal(changed.auditTrail.length, 2);
});
test('concurrent check-in and administrator override cannot discard check-in evidence', async () => {
  const results = await Promise.all([request(people[0], '/attendance/check-in', payload()), request(people[3], '/attendance/mark-absent', { userId: people[0].id })]);
  const saved = await Attendance.findOne({ user: people[0]._id });
  assert.equal(await Attendance.countDocuments({ user: people[0]._id }), 1);
  if (results[0].status === 201) {
    assert.ok(saved.checkIn); assert.equal(saved.photo, photo);
    if (saved.override?.type === 'absent') assert.ok(saved.override.snapshot.status);
  } else assert.equal(results[0].status, 409);
});
test('repeated absence overrides preserve original state and manual presence is restored', async () => {
  await request(people[3], '/attendance/mark-present', { userId: people[0].id });
  await request(people[3], '/attendance/mark-absent', { userId: people[0].id });
  await request(people[3], '/attendance/mark-absent', { userId: people[0].id });
  await request(people[3], '/attendance/mark-present', { userId: people[0].id });
  const saved = await Attendance.findOne({ user: people[0]._id });
  assert.equal(saved.override.type, 'present'); assert.equal(saved.checkIn, undefined); assert.equal(saved.auditTrail.length, 4);
});
test('CEO simulated penalties do not affect real monthly payroll or employee dashboard counts', async () => {
  await record(people[2], { isSimulated: true, deductionAmount: 500 });
  const ledger = await request(people[3], '/deductions/monthly-report'); assert.equal(ledger.body.grandTotalDeductions, 0);
  const dashboard = await request(people[3], '/dashboard/stats'); assert.equal(dashboard.body.attendance.totalEmployees, 4); assert.equal(dashboard.body.attendance.checkedInToday, 0); assert.equal(dashboard.body.attendance.monthlyDeductions, 0);
});
test('full-day late absence retains check-in evidence without counting as present attendance', async () => {
  await record(people[0], { status: 'absent', deductionAmount: 1000, deductionPercentage: 100, minutesLate: 180 });
  const roster = await request(people[3], '/attendance/roster');
  const row = roster.body.roster.find(r => r.user._id === people[0].id);
  assert.equal(row.checkedIn, false); assert.ok(row.checkIn);
  const dashboard = await request(people[3], '/dashboard/stats'); assert.equal(dashboard.body.attendance.checkedInToday, 0); assert.equal(dashboard.body.attendance.absentCount, 1);
  await request(people[3], '/attendance/mark-present', { userId: people[0].id });
  const waived = await Attendance.findOne({ user: people[0]._id });
  assert.equal(waived.deductionAmount, 0); assert.equal(waived.auditTrail[0].previousState.deductionAmount, 1000); assert.equal(waived.auditTrail[0].previousState.minutesLate, 180);
});
test('manual presence has no fabricated timestamp; absent dates cannot be overwritten or be invalid', async () => {
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: '2026-02-30' })).status, 400);
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: p.addDays(p.companyDate(), 1) })).status, 400);
  await request(people[2], '/attendance/mark-absent', { userId: people[0].id });
  assert.equal((await request(people[0], '/attendance/check-in', payload())).status, 409);
  await request(people[2], '/attendance/mark-present', { userId: people[0].id });
  const doc = await Attendance.findOne({ user: people[0]._id }); assert.equal(doc.checkIn, undefined); assert.equal(doc.deductionAmount, 0);
});
test('department history filters before pagination, summary covers every matching record, self stays private', async () => {
  const today = p.companyDate();
  await Attendance.insertMany(Array.from({ length: 110 }, (_, i) => ({ user: people[1]._id, date: p.addDays(today, -i), status: 'present' })));
  await record(people[0], { date: p.addDays(today, -200), checkOut: new Date(), deductionAmount: 75 });
  const filtered = await request(people[3], '/attendance/history?department=Software%20Development');
  assert.equal(filtered.status, 200); assert.equal(filtered.body.count, 1); assert.equal(filtered.body.records.length, 1); assert.equal(filtered.body.totalDeductions, 75);
  const all = await request(people[3], '/attendance/history?limit=10'); assert.equal(all.body.count, 111); assert.equal(all.body.pages, 12);
  const self = await request(people[0], '/attendance/history?userId=' + people[1].id); assert.equal(self.body.count, 1); assert.equal(self.body.records[0].photo, undefined); assert.equal(self.body.records[0].hasPhoto, true);
  for (const query of ['?month=2026-13','?page=0','?limit=1000','?status=wrong']) assert.equal((await request(people[3], '/attendance/history' + query)).status, 400);
});
test('selfies are fetched only by their owner or executives and are never cached publicly', async () => {
  const doc = await record(people[0]);
  assert.equal((await request(people[1], '/attendance/records/' + doc.id + '/photo')).status, 404);
  const own = await request(people[0], '/attendance/records/' + doc.id + '/photo'); assert.equal(own.body.attendance.photo, photo); assert.equal(own.headers.get('cache-control'), 'private, no-store');
  assert.equal((await request(people[3], '/attendance/records/' + doc.id + '/photo')).status, 200);
  const roster = await request(people[3], '/attendance/roster'); const item = roster.body.roster.find(r => r.user._id === people[0].id); assert.equal(item.hasPhoto, true); assert.equal(item.photo, undefined);
});
test('approved full-day leave and holidays are not counted as unexplained absence', async () => {
  const day = p.companyDate();
  await LeaveRequest.create({ user: people[0]._id, leaveType: 'casual', startDate: day, endDate: day, totalDays: 1, reason: 'test', status: 'approved' });
  assert.equal((await request(people[0], '/attendance/today')).body.attendance.status, 'on_leave');
  await Holiday.create({ title: 'Test holiday', date: day, isMandatory: true });
  const roster = await request(people[3], '/attendance/roster');
  assert.equal(roster.body.roster.find(r => r.user._id === people[1].id).status, 'on_holiday');
  const dashboard = await request(people[3], '/dashboard/stats'); assert.equal(dashboard.status, 200); assert.equal(dashboard.body.attendance.absentCount, 0); assert.equal(dashboard.body.attendance.totalEmployees, 4);
  const workedOnHoliday = await request(people[1], '/attendance/check-in', payload('holiday-device'));
  assert.equal(workedOnHoliday.status, 201); assert.equal(workedOnHoliday.body.attendance.deductionAmount, 0); assert.equal(workedOnHoliday.body.attendance.isLate, false);
});
test('monthly ledger includes admin access, scopes managers, and does not call absence a late incident', async () => {
  await record(people[0], { status: 'absent', isLate: false, minutesLate: 0, deductionAmount: 1000 });
  await record(people[1], { deductionAmount: 75 });
  const admin = await request(people[3], '/deductions/monthly-report'); assert.equal(admin.status, 200); assert.equal(admin.body.grandTotalDeductions, 1075);
  const manager = await request(people[4], '/deductions/monthly-report'); assert.equal(manager.body.report.length, 1); assert.equal(manager.body.report[0].totalLateIncidents, 0); assert.equal(manager.body.report[0].totalAbsentIncidents, 1);
  assert.equal((await request(people[3], '/deductions/monthly-report?month=wrong')).status, 400);
});
test('saved policy and simulator share validated full-day/repeat calculations and preserve nested settings', async () => {
  const invalid = await request(people[2], '/deductions/rules', { gracePeriodMinutes: 70, halfDayThresholdMinutes: 60 }, 'PUT'); assert.equal(invalid.status, 400);
  assert.equal((await request(people[0], '/deductions/rules', { gracePeriodMinutes: 10 }, 'PUT')).status, 403);
  const saved = await request(people[2], '/deductions/rules', { officeLocation: { radiusMeters: 400 } }, 'PUT'); assert.equal(saved.status, 200); assert.equal(saved.body.rule.officeLocation.latitude, 24.8607);
  const simulated = await request(people[0], '/deductions/simulate', { minutesLate: 180, dailyWage: 1000, priorLateCount: 2 }); assert.equal(simulated.body.simulation.deduction, 1000); assert.equal(simulated.body.simulation.status, 'absent');
  assert.equal((await request(people[0], '/deductions/simulate', { minutesLate: -1, dailyWage: 1000 })).status, 400);
  await DeductionRule.deleteMany({});
  await Promise.all([request(people[0], '/deductions/rules'), request(people[1], '/deductions/rules')]); assert.equal(await DeductionRule.countDocuments(), 0);
});
test('stale policy edits cannot silently overwrite another saved configuration', async () => {
  const first = await request(people[2], '/deductions/rules');
  assert.equal((await request(people[2], '/deductions/rules', { ...first.body.rule, gracePeriodMinutes: 10 }, 'PUT')).status, 200);
  const stale = await request(people[2], '/deductions/rules', { ...first.body.rule, gracePeriodMinutes: 12 }, 'PUT');
  assert.equal(stale.status, 409); assert.equal((await DeductionRule.findOne()).gracePeriodMinutes, 10);
});
