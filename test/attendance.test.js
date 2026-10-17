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
let mongo, directory, server, base, people, photo, bootstrap;
const testTempRoot = path.resolve(process.env.ATTENDANCE_TEST_TMPDIR || os.tmpdir());
// Freeze calendar constructors for attendance, while retaining the real clock
// for MongoDB heartbeat/session expiry and JWT expiry across date jumps.
const actualNow = Date.now;
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
  directory = await mkdtemp(path.join(testTempRoot, 'neximet-attendance-test-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const binary = process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod');
  mongo = spawn(binary, ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--replSet', 'attendance-test', '--wiredTigerCacheSizeGB', '0.25', '--wiredTigerEngineConfigString', 'session_max=1000', '--setParameter', 'diagnosticDataCollectionEnabled=false', '--maxConns', '50', '--logpath', path.join(directory, 'mongo.log')], { stdio: 'ignore', windowsHide: true });
  let startupError; mongo.on('error', error => { startupError = error; });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    try { bootstrap = await mongoose.mongo.MongoClient.connect(`mongodb://127.0.0.1:${port}/attendance_tests?directConnection=true`, { serverSelectionTimeoutMS: 300 }); break; }
    catch (error) { if (attempt === 39 || mongo.exitCode !== null) { const log = await readFile(path.join(directory, 'mongo.log'), 'utf8').catch(() => 'No MongoDB log was created.'); throw new Error(`Disposable MongoDB did not start (exit ${mongo.exitCode}): ${log.slice(-6000)}`, { cause: error }); } await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  await bootstrap.db().admin().command({ replSetInitiate: { _id: 'attendance-test', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await bootstrap.db().admin().command({ hello: 1 })).isWritablePrimary) break;
    if (attempt === 99) throw new Error('Disposable replica set did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await bootstrap.close(); bootstrap = null;
  await mongoose.connect(`mongodb://127.0.0.1:${port}/attendance_tests?replicaSet=attendance-test`, { serverSelectionTimeoutMS: 3000 });
  await Promise.all([User.init(), Attendance.init(), DeductionRule.init(), Holiday.init(), LeaveRequest.init()]);
  people = await User.create([
    { name: 'Member', role: 'Team Member', department: 'Software Development' },
    { name: 'Other', role: 'Team Member', department: 'Graphics Designing' },
    { name: 'CEO', role: 'CEO', department: 'Executive' },
    { name: 'Admin', role: 'Super Admin', department: 'Executive' },
    { name: 'Manager', role: 'Project Manager', department: 'Software Development' },
  ].map((person, i) => ({ ...person, email: `attendance${i}@example.test`, password: 'isolated-password', baseSalary: 22000, dailyWage: 1000 })));
  for (const user of people) token.set(String(user._id), jwt.sign({ id: user._id }, process.env.JWT_SECRET));
  photo = 'data:image/png;base64,' + (await readFile(path.join(__dirname, 'fixtures', 'attendance-image.png'))).toString('base64');
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.use('/attendance', require('../src/routes/attendanceRoutes'));
  app.use('/deductions', require('../src/routes/deductionRoutes'));
  app.use('/dashboard', require('../src/routes/dashboardRoutes'));
  app.use('/leaves', require('../src/routes/leaveRoutes'));
  app.use('/auth', require('../src/routes/authRoutes'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  await Promise.all([Attendance.deleteMany({}), DeductionRule.deleteMany({}), Holiday.deleteMany({}), LeaveRequest.deleteMany({})]);
  await DeductionRule.create({ ...p.DEFAULT_RULE, policyKey: 'attendance', shiftStartTime: '00:00', shiftEndTime: '23:59' });
  await User.updateMany({}, { $set: { joinDate: new Date(), isActive: true, baseSalary: 22000, dailyWage: 1000, 'leaveBalances.casual': 10 }, $unset: { deactivatedAt: '', attendanceCalendarThrough: '', attendanceCalendarRevision: '', attendanceTrackingFrom: '', employmentGaps: '' } });
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (bootstrap) await bootstrap.close();
  if (mongo && mongo.exitCode === null) { const exited = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await exited; }
  if (directory && path.dirname(path.resolve(directory)) === testTempRoot && path.basename(directory).startsWith('neximet-attendance-test-')) await rm(directory, { recursive: true, force: true });
});

test('real arrivals charge every second monthly late and separately charge arrivals strictly after 2 PM', async t => {
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-09-01', '00:00'), baseSalary: 150000, dailyWage: 5 } });
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '09:00', shiftEndTime: '18:00' } });
  const cases = [
    ['2026-10-05', '13:59', 'late', true, 0],
    ['2026-10-06', '14:00', 'late', true, 6818.18],
    ['2026-10-07', '14:01', 'absent', false, 6818.18],
    ['2026-10-08', '09:16', 'late', true, 0],
    ['2026-10-09', '10:00', 'late', true, 6818.18],
    ['2026-11-02', '10:00', 'late', true, 0],
  ];
  for (const [day, time, status, isLate, amount] of cases) {
    t.mock.timers.setTime(p.atCompanyTime(day, time).getTime());
    const response = await request(people[0], '/attendance/check-in', payload());
    assert.equal(response.status, 201, response.body.message);
    assert.equal(response.body.attendance.status, status, day);
    assert.equal(response.body.attendance.isLate, isLate, day);
    assert.equal(response.body.attendance.deductionAmount, undefined);
    const saved = await Attendance.findOne({ user: people[0]._id, date: day });
    assert.equal(saved.deductionAmount, amount, day); assert.equal(saved.wageSnapshot, 6818.18);
    assert.equal(saved.policySnapshot.policyVersion, p.COMPANY_POLICY_VERSION);
  }
  const ledger = await request(people[2], '/deductions/monthly-report?month=2026-10');
  const employee = ledger.body.report.find(row => row.user._id === people[0].id);
  assert.equal(employee.totalLateIncidents, 4); assert.equal(employee.totalDeductions, 20454.54);
  // Removing/restoring an earlier late reassigns the pair charge to the correct later date.
  assert.equal((await request(people[3], '/attendance/mark-absent', { userId: people[0].id, date: '2026-10-05' })).status, 200);
  for (const [day, amount] of [['2026-10-06', 0], ['2026-10-08', 6818.18], ['2026-10-09', 0]]) assert.equal((await Attendance.findOne({ user: people[0]._id, date: day })).deductionAmount, amount, day);
  assert.equal((await request(people[3], '/attendance/mark-present', { userId: people[0].id, date: '2026-10-05' })).status, 200);
  for (const [day, amount] of [['2026-10-05', 0], ['2026-10-06', 6818.18], ['2026-10-08', 0], ['2026-10-09', 6818.18]]) assert.equal((await Attendance.findOne({ user: people[0]._id, date: day })).deductionAmount, amount, day);
});

test('salary, daily wages, audit deductions and pay snapshots are CEO-only across authenticated responses and login', async () => {
  await record(people[0], { wageSnapshot: 1000, override: { type: 'absent', snapshot: { deductionAmount: 123 } }, auditTrail: [{ action: 'mark_absent', by: people[2]._id, previousState: { deductionAmount: 123, wageSnapshot: 1000 } }] });
  function noPay(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['baseSalary', 'dailyWage', 'deductionAmount', 'wageSnapshot', 'totalDeductions', 'monthlyDeductions', 'myMonthlyDeductions', 'todayDeductions'].includes(key), key);
      noPay(item);
    }
  }
  for (const person of [people[0], people[3], people[4]]) {
    for (const endpoint of ['/auth/me', '/auth/users', '/attendance/today', '/attendance/history', '/dashboard/stats', ...(person.role === 'Super Admin' ? ['/attendance/roster'] : [])]) {
      const response = await request(person, endpoint); assert.equal(response.status, 200, endpoint); noPay(response.body);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    const login = await request(null, '/auth/login', { email: person.email, password: 'isolated-password' });
    assert.equal(login.status, 200); noPay(login.body);
  }
  await User.updateOne({ _id: people[0]._id }, { $set: { baseSalary: 150000, dailyWage: 99 } });
  const ceo = await request(people[2], '/auth/users');
  const employee = ceo.body.users.find(user => user._id === people[0].id);
  assert.equal(employee.baseSalary, 150000); assert.equal(employee.dailyWage, 6818.18);
  const history = await request(people[2], '/attendance/history');
  assert.equal(history.body.records[0].deductionAmount, 50); assert.equal(history.body.records[0].user.dailyWage, 6818.18);
});

test('Super Admins retain profile management but cannot set pay, promote CEOs or take over CEO accounts', async () => {
  for (const body of [{ baseSalary: 44000 }, { dailyWage: 2000 }, { expectedPay: { baseSalary: 22000 } }, { role: 'CEO' }]) assert.equal((await request(people[3], `/auth/users/${people[0].id}`, body, 'PUT')).status, 403);
  assert.equal((await request(people[3], `/auth/users/${people[2].id}`, { name: 'Takeover' }, 'PUT')).status, 403);
  assert.equal((await request(people[3], '/auth/admin-reset-password', { userId: people[2].id, newPassword: 'blocked-password' })).status, 403);
  const profile = await request(people[3], `/auth/users/${people[0].id}`, { phone: '123' }, 'PUT');
  assert.equal(profile.status, 200); assert.equal(profile.body.user.baseSalary, undefined);
  const creation = { name: 'New Employee', email: 'new-payroll@example.test', password: 'isolated-password', department: 'Software Development' };
  assert.equal((await request(people[3], '/auth/users', { ...creation, baseSalary: 44000 })).status, 403);
  assert.equal((await request(people[3], '/auth/users', { ...creation, role: 'CEO' })).status, 403);
  const created = await request(people[3], '/auth/users', creation); assert.equal(created.status, 201); assert.equal(created.body.user.baseSalary, undefined);
  await User.deleteOne({ _id: created.body.user._id });
  const changed = await request(people[2], `/auth/users/${people[0].id}`, { baseSalary: 44000 }, 'PUT');
  assert.equal(changed.status, 200); assert.equal(changed.body.user.dailyWage, 2000);
  assert.equal((await request(people[2], `/auth/users/${people[0].id}`, { dailyWage: 2100 }, 'PUT')).status, 400);
  const previous = process.env.CEO_MASTER_KEY; delete process.env.CEO_MASTER_KEY;
  try { assert.equal((await request(null, '/auth/ceo-reset-password', { email: people[2].email, masterKey: 'NEXIMET-CEO-2026-RECOVERY', newPassword: 'blocked-password' })).status, 503); }
  finally { if (previous === undefined) delete process.env.CEO_MASTER_KEY; else process.env.CEO_MASTER_KEY = previous; }
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
  const start = new Date().getTime();
  const results = await Promise.all([request(people[0], '/attendance/check-in', payload()), request(people[0], '/attendance/check-in', payload())]);
  assert.equal(results.filter(res => res.status === 201).length, 1);
  assert.equal(results.filter(res => res.status === 409).length, 1);
  const doc = await Attendance.findOne({ user: people[0]._id });
  assert.ok(doc.checkIn.getTime() >= start && doc.checkIn.getTime() <= new Date().getTime());
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
  await User.updateOne({ _id: people[2]._id }, { $set: { joinDate: p.atCompanyTime(day, '00:00') } });
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
  await record(people[0], { checkIn: new Date(new Date().getTime() + 3600000) });
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
  const inserted = await Attendance.collection.insertOne({ user: people[1]._id, date: 'legacy-invalid-date', checkIn: new Date(new Date().getTime() - 60000), checkOut: null, status: 'present' });
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
  const ledger = await request(people[2], '/deductions/monthly-report'); assert.equal(ledger.body.grandTotalDeductions, 0);
  const dashboard = await request(people[3], '/dashboard/stats'); assert.equal(dashboard.body.attendance.totalEmployees, 4); assert.equal(dashboard.body.attendance.checkedInToday, 0); assert.equal(dashboard.body.attendance.monthlyDeductions, undefined);
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
  assert.equal(filtered.status, 200); assert.equal(filtered.body.count, 1); assert.equal(filtered.body.records.length, 1); assert.equal(filtered.body.totalDeductions, undefined);
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

test('CEO history searches all pages and applies inclusive date boundaries with matching totals', async () => {
  await Attendance.insertMany(Array.from({ length: 25 }, (_, i) => ({ user: people[0]._id, date: p.addDays('2026-01-01', i), status: 'late', isLate: true, deductionAmount: 10 })));
  await record(people[0], { date: '2025-12-31', checkOut: new Date(), deductionAmount: 999 });
  await record(people[1], { date: '2026-01-01', checkOut: new Date(), deductionAmount: 555 });
  const query = '/attendance/history?startDate=2026-01-01&endDate=2026-01-25&search=%20mEm%20&limit=20';
  const first = await request(people[2], query);
  assert.equal(first.status, 200); assert.equal(first.body.count, 25); assert.equal(first.body.lateCount, 25); assert.equal(first.body.totalDeductions, 250); assert.equal(first.body.pages, 2);
  assert.equal(first.body.records.length, 20); assert.equal(first.body.records[0].date, '2026-01-25');
  const last = await request(people[2], query + '&page=2');
  assert.equal(last.body.records.length, 5); assert.equal(last.body.records[4].date, '2026-01-01'); assert.equal(last.body.totalDeductions, 250);
  const one = await request(people[2], '/attendance/history?startDate=2026-01-01&endDate=2026-01-01&search=member');
  assert.equal(one.body.count, 1); assert.equal(one.body.records[0].date, '2026-01-01');
  const all = await request(people[2], '/attendance/history'); assert.equal(all.body.count, 27);
});

test('history name search is literal and intersects month, department and authorized employee scope', async () => {
  await record(people[0], { date: '2026-01-31', checkOut: new Date() });
  await record(people[0], { date: '2026-02-01', checkOut: new Date() });
  await record(people[1], { date: '2026-02-01', checkOut: new Date() });
  assert.equal((await request(people[2], '/attendance/history?search=.*')).body.count, 0);
  assert.equal((await request(people[2], '/attendance/history?search=OTHER&department=Software%20Development')).body.count, 0);
  assert.equal((await request(people[2], '/attendance/history?search=member&month=2026-01&startDate=2026-01-31&endDate=2026-02-01')).body.count, 1);
  const own = await request(people[0], '/attendance/history?userId=all&search=member&startDate=2026-01-31&endDate=2026-02-01');
  assert.equal(own.body.count, 2); assert.ok(own.body.records.every(row => row.user._id === people[0].id));
  assert.equal((await request(people[0], '/attendance/history?search=other&userId=' + people[1].id)).body.count, 0);
  assert.equal((await request(people[2], '/attendance/history?search=nobody')).body.count, 0);
});

test('history rejects malformed, reversed and repeated date/search parameters', async () => {
  for (const query of [
    '?startDate=2026-02-30', '?endDate=invalid', '?startDate=',
    '?startDate=2026-02-02&endDate=2026-02-01', '?startDate=2026-01-01&startDate=2026-01-02',
    '?search=a&search=b', '?search=' + 'a'.repeat(101),
  ]) assert.equal((await request(people[2], '/attendance/history' + query)).status, 400);
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
  assert.equal(workedOnHoliday.status, 201); assert.equal(workedOnHoliday.body.attendance.deductionAmount, undefined); assert.equal(workedOnHoliday.body.attendance.isLate, false);
});
test('monthly ledger is CEO-only and does not call absence a late incident', async () => {
  await record(people[0], { status: 'absent', isLate: false, minutesLate: 0, deductionAmount: 1000 });
  await record(people[1], { deductionAmount: 75 });
  const admin = await request(people[2], '/deductions/monthly-report'); assert.equal(admin.status, 200); assert.equal(admin.body.grandTotalDeductions, 1075);
  for (const person of [people[0], people[3], people[4]]) assert.equal((await request(person, '/deductions/monthly-report')).status, 403);
  const absence = admin.body.report.find(row => row.user._id === people[0].id); assert.equal(absence.totalLateIncidents, 0); assert.equal(absence.totalAbsentIncidents, 1);
  assert.equal((await request(people[2], '/deductions/monthly-report?month=wrong')).status, 400);
});

test('dashboards retain personal and executive attendance without returning squad attendance', async () => {
  await record(people[0], { deductionAmount: 75 });
  await record(people[4], { deductionAmount: 100 });
  for (const person of [people[0], people[4], people[2], people[3]]) {
    const response = await request(person, '/dashboard/stats');
    assert.equal(response.status, 200);
    assert.equal(response.body.squadMembers, undefined);
    assert.ok(!Object.keys(response.body.attendance).some(key => key.startsWith('dept')));
    if (person.id === people[0].id || person.id === people[4].id) {
      assert.equal(response.body.attendance.myMonthlyDeductions, undefined);
      assert.ok(response.body.attendance.myTodayStatus.checkIn);
    } else {
      assert.equal(response.body.attendance.checkedInToday, 2);
      assert.equal(response.body.attendance.monthlyDeductions, person.role === 'CEO' ? 175 : undefined);
    }
  }
});
test('saved policy and simulator share validated full-day/repeat calculations and preserve nested settings', async () => {
  const invalid = await request(people[2], '/deductions/rules', { gracePeriodMinutes: 70, halfDayThresholdMinutes: 60 }, 'PUT'); assert.equal(invalid.status, 400);
  assert.equal((await request(people[0], '/deductions/rules', { gracePeriodMinutes: 10 }, 'PUT')).status, 403);
  const saved = await request(people[2], '/deductions/rules', { officeLocation: { radiusMeters: 400 } }, 'PUT'); assert.equal(saved.status, 200); assert.equal(saved.body.rule.officeLocation.latitude, 24.8607);
  const simulated = await request(people[2], '/deductions/simulate', { minutesLate: 841, dailyWage: 1000, priorLateCount: 2 }); assert.equal(simulated.body.simulation.deduction, 1000); assert.equal(simulated.body.simulation.status, 'absent');
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

test('header-shaped corrupt PNGs are rejected even when selfies are mandatory', async () => {
  const bytes = Buffer.alloc(45); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(32, 16); bytes.writeUInt32BE(32, 20); bytes.write('IEND', 37, 'ascii');
  const response = await request(people[0], '/attendance/check-in', { ...payload(), photo: 'data:image/png;base64,' + bytes.toString('base64') });
  assert.equal(response.status, 400); assert.equal(await Attendance.countDocuments(), 0);
});

test('leave duration is calculated from weekdays/holidays and mismatched dates or day counts fail', async () => {
  const duration = await request(people[0], '/leaves/duration?startDate=2026-10-09&endDate=2026-10-12&session=full');
  assert.equal(duration.body.duration.totalDays, 2);
  await Holiday.create({ title: 'Excluded Monday', date: p.atCompanyTime('2026-10-12', '00:00') });
  const withHoliday = await request(people[0], '/leaves/duration?startDate=2026-10-09&endDate=2026-10-12&session=full');
  assert.equal(withHoliday.body.duration.totalDays, 1);
  for (const changes of [{ totalDays: 4 }, { startDate: '2026-10-12', endDate: '2026-10-09' }, { startDate: '2026-10-10', endDate: '2026-10-11' }, { session: 'morning', totalDays: 0.5 }]) {
    const response = await request(people[0], '/leaves/apply', { leaveType: 'casual', startDate: '2026-10-09', endDate: '2026-10-12', reason: 'test', ...changes });
    assert.equal(response.status, 400);
  }
});

async function apply(user, start, end = start, session = 'full') {
  const response = await request(user, '/leaves/apply', { leaveType: 'casual', startDate: start, endDate: end, session, reason: 'Regression test' });
  assert.equal(response.status, 201, response.body.message); return response.body.leaveRequest;
}
const approve = leave => request(people[2], `/leaves/requests/${leave._id}/review`, { status: 'approved' }, 'PUT');

test('approval rechecks current entitlement and does not approve twenty days against a ten-day balance', async () => {
  const first = await apply(people[0], '2026-11-02', '2026-11-13');
  const second = await apply(people[0], '2026-11-16', '2026-11-27');
  assert.equal((await approve(first)).status, 200); assert.equal((await approve(second)).status, 409);
  assert.equal((await User.findById(people[0]._id)).leaveBalances.casual, 0);
  assert.equal((await LeaveRequest.findById(second._id)).status, 'pending');
});

test('simultaneous approvals and duplicate review clicks debit entitlement exactly once', async () => {
  const first = await apply(people[0], '2026-11-02', '2026-11-09');
  const second = await apply(people[0], '2026-11-16', '2026-11-23');
  const results = await Promise.all([approve(first), approve(second)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  assert.equal((await User.findById(people[0]._id)).leaveBalances.casual, 4);
  const oneDay = await apply(people[1], '2026-11-02');
  const duplicates = await Promise.all([approve(oneDay), approve(oneDay)]);
  assert.equal(duplicates.filter(result => result.status === 200).length, 1);
  assert.equal((await User.findById(people[1]._id)).leaveBalances.casual, 9);
});

test('overlapping approvals roll back their balance debit, while opposite half sessions can combine', async () => {
  const morning = await apply(people[0], '2026-11-02', '2026-11-02', 'morning');
  const repeated = await apply(people[0], '2026-11-02', '2026-11-02', 'morning');
  const afternoon = await apply(people[0], '2026-11-02', '2026-11-02', 'afternoon');
  assert.equal((await approve(morning)).status, 200); assert.equal((await approve(repeated)).status, 409); assert.equal((await approve(afternoon)).status, 200);
  assert.equal((await User.findById(people[0]._id)).leaveBalances.casual, 9);
  const coverage = await require('../src/services/attendanceRecords').dayExemptions('2026-11-02', [people[0]._id]);
  assert.ok(coverage.leaveUsers.has(people[0].id));
});

test('full-day approval waives an existing late penalty with a financial audit trail and intact evidence', async () => {
  const day = '2026-10-13';
  const original = await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:35'), scheduledCheckOut: p.atCompanyTime(day, '18:00') });
  assert.equal((await approve(await apply(people[0], day))).status, 200);
  const adjusted = await Attendance.findById(original._id);
  assert.equal(adjusted.deductionAmount, 0); assert.equal(adjusted.isLate, false); assert.equal(adjusted.status, 'present');
  assert.equal(adjusted.checkIn.getTime(), original.checkIn.getTime()); assert.equal(adjusted.photo, original.photo);
  assert.equal(adjusted.scheduledCheckOut.getTime(), original.scheduledCheckOut.getTime());
  assert.equal(adjusted.auditTrail.at(-1).action, 'leave_adjustment'); assert.equal(adjusted.auditTrail.at(-1).previousState.deductionAmount, 50);
});

test('morning/afternoon approvals reconcile recorded absence against the original shift policy', async () => {
  const day = '2026-10-13';
  const original = await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '13:00'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), policySnapshot: p.DEFAULT_RULE, wageSnapshot: 1000, status: 'absent', deductionAmount: 1000, deductionPercentage: 100 });
  assert.equal((await approve(await apply(people[0], day, day, 'morning'))).status, 200);
  const adjusted = await Attendance.findById(original._id);
  assert.equal(adjusted.status, 'present'); assert.equal(adjusted.deductionAmount, 0); assert.equal(adjusted.expectedCheckIn.getTime(), p.atCompanyTime(day, '13:30').getTime());
  const late = await record(people[1], { date: day, checkIn: p.atCompanyTime(day, '16:00'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), policySnapshot: p.DEFAULT_RULE, wageSnapshot: 1000, status: 'absent', deductionAmount: 1000, deductionPercentage: 100 });
  assert.equal((await approve(await apply(people[1], day, day, 'afternoon'))).status, 200);
  assert.equal((await Attendance.findById(late._id)).deductionAmount, 500);
});

test('leave approval and a check-in serialize so a late charge cannot escape the approved exemption', async () => {
  await DeductionRule.updateOne({}, { $set: { workingDays: [0,1,2,3,4,5,6] } });
  const leave = await apply(people[0], p.companyDate());
  const responses = await Promise.all([approve(leave), request(people[0], '/attendance/check-in', payload())]);
  assert.ok(responses.every(response => [200,201].includes(response.status)), JSON.stringify(responses.map(result => result.body)));
  const saved = await Attendance.findOne({ user: people[0]._id }); assert.equal(saved.deductionAmount, 0); assert.equal(saved.isLate, false);
  assert.equal((await User.findById(people[0]._id)).leaveBalances.casual, 9);
});

test('legacy invalid dates are quarantined without blocking check-in and can be repaired with preserved evidence', async () => {
  const day = p.addDays(p.companyDate(), -1), arrival = p.atCompanyTime(day, '09:00');
  const inserted = await Attendance.collection.insertOne({ user: people[0]._id, date: 'legacy-invalid-date', checkIn: arrival, checkOut: null, status: 'present', photo, deductionAmount: 50 });
  const today = await request(people[0], '/attendance/today'); assert.equal(today.body.repairRequired.length, 1);
  assert.equal((await request(people[0], '/attendance/check-in', payload())).status, 201);
  assert.equal((await request(people[0], `/attendance/records/${inserted.insertedId}/repair`, { date: day })).status, 403);
  const repaired = await request(people[2], `/attendance/records/${inserted.insertedId}/repair`, { date: day }); assert.equal(repaired.status, 200, repaired.body.message);
  const stored = await Attendance.findById(inserted.insertedId); assert.equal(stored.date, day); assert.equal(stored.checkIn.getTime(), arrival.getTime()); assert.equal(stored.photo, photo); assert.equal(stored.deductionAmount, 50); assert.equal(stored.quarantine?.at, undefined); assert.equal(stored.auditTrail.at(-1).action, 'repair');
});

test('invalid legacy shift ends are quarantined instead of blocking subsequent attendance', async () => {
  const day = p.addDays(p.companyDate(), -1), arrival = p.atCompanyTime(day, '09:00');
  const inserted = await Attendance.collection.insertOne({ user: people[0]._id, date: day, checkIn: arrival, checkOut: null, scheduledCheckOut: 'invalid-end', status: 'present' });
  const today = await request(people[0], '/attendance/today');
  assert.equal(today.status, 200); assert.equal(today.body.repairRequired.length, 1);
  const raw = await Attendance.collection.findOne({ _id: inserted.insertedId });
  assert.equal(raw.scheduledCheckOut, 'invalid-end'); assert.equal(raw.checkOut, null); assert.ok(raw.quarantine.at);
  assert.equal((await request(people[0], '/attendance/check-in', payload())).status, 201);
  const repaired = await request(people[2], `/attendance/records/${inserted.insertedId}/repair`, { date: day });
  assert.equal(repaired.status, 200, repaired.body.message);
  const stored = await Attendance.findById(inserted.insertedId); assert.equal(stored.checkIn.getTime(), arrival.getTime()); assert.ok(stored.checkOut); assert.equal(stored.quarantine?.at, undefined);
});

test('today exposes an earlier open shift after an overnight-to-daytime policy change', async () => {
  const OriginalDate = Date, day = p.companyDate(), previousDay = p.addDays(day, -1), now = p.atCompanyTime(day, '02:00').getTime();
  const open = await record(people[0], { date: previousDay, checkIn: p.atCompanyTime(previousDay, '22:00'), scheduledCheckOut: p.atCompanyTime(day, '06:00') });
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])); } };
  try { const today = await request(people[0], '/attendance/today'); assert.equal(today.body.attendance, null); assert.equal(today.body.openAttendance._id, open.id); assert.equal(today.body.openAttendance.date, previousDay); assert.equal((await request(people[0], '/attendance/check-out', {})).status, 200); }
  finally { global.Date = OriginalDate; }
});

test('history materializes no-shows, weekends and holidays only within employment dates without inventing payroll charges', async () => {
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-09', '00:00') } });
  await Holiday.create({ title: 'Monday holiday', date: p.atCompanyTime('2026-10-12', '00:00') });
  await require('../src/services/attendanceHistory').materializeHistory(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: '2026-10-08', $lte: '2026-10-12' } }, p.atCompanyTime('2026-10-13', '12:00'));
  const rows = await Attendance.find({ user: people[0]._id }).sort({ date: 1 });
  assert.deepEqual(rows.map(row => row.status), ['absent','day_off','day_off','on_holiday']);
  assert.ok(rows.every(row => !row.checkIn && !row.checkOut && row.deductionAmount === 0));
  assert.equal(rows[0].financialReviewRequired, true);
  await require('../src/services/attendanceHistory').materializeHistory(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: '2026-10-08', $lte: '2026-10-12' } }, p.atCompanyTime('2026-10-13', '12:00'));
  assert.equal(await Attendance.countDocuments({ user: people[0]._id }), 4);
});

test('manual absence review honors approved half-day coverage and clears the review flag', async () => {
  const day = p.companyDate();
  await LeaveRequest.create({ user: people[0]._id, leaveType: 'casual', startDate: day, endDate: day, totalDays: 0.5, session: 'morning', reason: 'test', status: 'approved' });
  await Attendance.create({ user: people[0]._id, date: day, status: 'absent', recordSource: 'automatic', financialReviewRequired: true });
  const result = await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day }); assert.equal(result.status, 200);
  const rule = await DeductionRule.findOne();
  const expected = p.isWorkingDay(day, p.normalizeRule(rule)) ? 500 : 0;
  assert.equal(result.body.attendance.deductionAmount, expected); assert.equal(result.body.attendance.financialReviewRequired, false);
});

test('later executive leave approval excuses an older absence override and keeps its financial evidence in audit', async () => {
  const day = '2026-10-13';
  await record(people[0], { date: day, policySnapshot: p.DEFAULT_RULE, wageSnapshot: 1000 });
  await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day });
  assert.equal((await approve(await apply(people[0], day))).status, 200);
  const stored = await Attendance.findOne({ user: people[0]._id, date: day });
  assert.equal(stored.deductionAmount, 0); assert.equal(stored.override?.type, undefined);
  assert.equal(stored.auditTrail.at(-1).previousState.override.type, 'absent');
});

test('legacy repair archives an automatic placeholder and never replaces real attendance', async () => {
  const day = p.addDays(p.companyDate(), -1), arrival = p.atCompanyTime(day, '09:00');
  const legacy = await Attendance.collection.insertOne({ user: people[0]._id, date: 'bad-date', checkIn: arrival, checkOut: null, status: 'present', quarantine: { at: new Date(), reason: 'test' }, __v: 0 });
  const automatic = await Attendance.create({ user: people[0]._id, date: day, status: 'absent', recordSource: 'automatic', deductionAmount: 0, financialReviewRequired: true });
  const repaired = await request(people[2], `/attendance/records/${legacy.insertedId}/repair`, { date: day }); assert.equal(repaired.status, 200, repaired.body.message);
  const stored = await Attendance.findById(legacy.insertedId);
  assert.equal(String(stored.auditTrail.at(-1).previousState.replacedCalendarOutcome._id), automatic.id); assert.equal(await Attendance.countDocuments({ user: people[0]._id, date: day }), 1);
  const other = await Attendance.collection.insertOne({ user: people[0]._id, date: 'another-bad-date', checkIn: arrival, checkOut: null, status: 'present', quarantine: { at: new Date(), reason: 'test' }, __v: 0 });
  const conflict = await request(people[2], `/attendance/records/${other.insertedId}/repair`, { date: day }); assert.equal(conflict.status, 409); assert.ok(await Attendance.findById(other.insertedId));
});

test('historical absence correction remains available for a former employee with recorded evidence', async () => {
  const day = p.addDays(p.companyDate(), -2);
  await record(people[0], { date: day, checkOut: new Date() });
  await User.updateOne({ _id: people[0]._id }, { $set: { isActive: false, deactivatedAt: p.atCompanyTime(p.addDays(day, 1), '18:00') } });
  assert.equal((await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: day })).status, 200);
  assert.equal((await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: p.companyDate() })).status, 404);
});

test('history checkpoints avoid duplicate work and employment gaps are never classified as no-shows', async () => {
  const user = people[0];
  await User.updateOne({ _id: user._id }, { $set: { joinDate: p.atCompanyTime('2026-10-01', '00:00'), employmentGaps: [{ start: p.atCompanyTime('2026-10-02', '18:00'), end: p.atCompanyTime('2026-10-09', '09:00') }] } });
  const materialize = require('../src/services/attendanceHistory').materializeHistory;
  const filter = { user: user._id, date: { $gte: '2026-10-01', $lte: '2026-10-09' } }, now = p.atCompanyTime('2026-10-10', '12:00');
  await materialize(p.DEFAULT_RULE, filter, now);
  const dates = (await Attendance.find({ user: user._id }).sort({ date: 1 })).map(row => row.date);
  assert.deepEqual(dates, ['2026-10-01','2026-10-02','2026-10-09']);
  assert.equal((await User.findById(user._id).select('+attendanceCalendarThrough')).attendanceCalendarThrough, '2026-10-09');
  await materialize(p.DEFAULT_RULE, filter, now); assert.equal(await Attendance.countDocuments({ user: user._id }), 3);
});

test('administrator overrides serialize with full and half leave approvals, including missing attendance rows', async () => {
  const day = p.companyDate();
  await DeductionRule.updateOne({}, { $set: { workingDays: [0,1,2,3,4,5,6] } });
  for (const [index, session] of ['full', 'morning'].entries()) {
    const person = people[index], leave = await apply(person, day, day, session);
    const results = await Promise.all([approve(leave), request(people[2], '/attendance/mark-absent', { userId: person.id, date: day })]);
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
    const saved = await Attendance.findOne({ user: person._id, date: day });
    assert.equal(saved.deductionAmount, session === 'full' ? 0 : 500);
    assert.equal(saved.financialReviewRequired, false);
  }
});

test('absence review uses saved wage/calendar and refuses new rows before joining or in employment gaps', async () => {
  const day = p.companyDate(), original = await record(people[0], { policySnapshot: { ...p.DEFAULT_RULE, workingDays: [0,1,2,3,4,5,6] }, wageSnapshot: 1000 });
  await User.updateOne({ _id: people[0]._id }, { $set: { baseSalary: 44000, dailyWage: 2000 } });
  await DeductionRule.updateOne({}, { $set: { workingDays: [0] } });
  const result = await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day });
  assert.equal(result.status, 200); assert.equal(result.body.attendance.deductionAmount, 1000);
  assert.equal(result.body.attendance._id, original.id);
  const beforeJoin = await request(people[2], '/attendance/mark-absent', { userId: people[1].id, date: p.addDays(day, -1) });
  assert.equal(beforeJoin.status, 404);
  await User.updateOne({ _id: people[1]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-01', '00:00'), employmentGaps: [{ start: p.atCompanyTime('2026-10-02', '18:00'), end: p.atCompanyTime('2026-10-09', '09:00') }] } });
  assert.equal((await request(people[2], '/attendance/mark-present', { userId: people[1].id, date: '2026-10-06' })).status, 404);
  await User.updateOne({ _id: people[1]._id }, { $set: { joinDate: p.atCompanyTime(p.addDays(day, 1), '00:00') } });
  assert.equal((await request(people[1], '/attendance/check-in', payload('future-join-device'))).status, 409);
});

test('verified presence waives an inferred absence rather than restoring its old absent snapshot', async () => {
  const day = p.companyDate();
  await Attendance.create({ user: people[0]._id, date: day, status: 'absent', recordSource: 'automatic', financialReviewRequired: true });
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day })).status, 200);
  const verified = await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: day, verifyPresence: true });
  assert.equal(verified.status, 200); assert.equal(verified.body.attendance.status, 'present'); assert.equal(verified.body.attendance.deductionAmount, 0); assert.equal(verified.body.attendance.financialReviewRequired, false); assert.equal(verified.body.attendance.checkIn, undefined);
});

test('morning leave credits only the working half after approval, automatic closure and explicit checkout', async () => {
  const day = '2026-10-13';
  const saved = await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:00'), checkOut: p.atCompanyTime(day, '18:00'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), totalWorkHours: 9, policySnapshot: p.DEFAULT_RULE });
  assert.equal((await approve(await apply(people[0], day, day, 'morning'))).status, 200);
  const adjusted = await Attendance.findById(saved._id);
  assert.equal(adjusted.totalWorkHours, 4.5); assert.equal(adjusted.checkIn.getTime(), saved.checkIn.getTime()); assert.equal(adjusted.checkOut.getTime(), saved.checkOut.getTime());
  const open = await record(people[1], { date: day, checkIn: p.atCompanyTime(day, '09:00'), expectedCheckIn: p.atCompanyTime(day, '13:30'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), policySnapshot: p.DEFAULT_RULE });
  await require('../src/services/attendanceRecords').closeEndedShifts(p.DEFAULT_RULE, { user: people[1]._id }, p.atCompanyTime(day, '19:00'));
  assert.equal((await Attendance.findById(open._id)).totalWorkHours, 4.5);
  const checkout = await record(people[4], { date: day, checkIn: p.atCompanyTime(day, '09:00'), expectedCheckIn: p.atCompanyTime(day, '13:30'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), policySnapshot: p.DEFAULT_RULE });
  const OriginalDate = Date, now = p.atCompanyTime(day, '16:00').getTime();
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])); } };
  try { const result = await request(people[4], '/attendance/check-out', {}); assert.equal(result.status, 200); assert.equal(result.body.attendance.totalWorkHours, 2.5); }
  finally { global.Date = OriginalDate; }
  assert.equal((await Attendance.findById(checkout._id)).checkIn.getTime(), checkout.checkIn.getTime());
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '00:00', shiftEndTime: '08:00' } });
  const legacy = await record(people[3], { date: day, checkIn: p.atCompanyTime(day, '00:00'), checkOut: p.atCompanyTime(day, '08:00'), scheduledCheckOut: p.atCompanyTime(day, '08:00'), totalWorkHours: 8 });
  assert.equal((await approve(await apply(people[3], day, day, 'morning'))).status, 200);
  const legacyAdjusted = await Attendance.findById(legacy._id); assert.equal(legacyAdjusted.totalWorkHours, 4); assert.equal(legacyAdjusted.policySnapshot.shiftStartTime, '00:00');
});

test('automatic closure cannot overwrite a half-shift schedule changed after its read', async () => {
  const day = '2026-10-13', saved = await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:00'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), policySnapshot: p.DEFAULT_RULE });
  const original = Attendance.bulkWrite;
  Attendance.bulkWrite = async function (...args) {
    await Attendance.updateOne({ _id: saved._id }, { $set: { scheduledCheckOut: p.atCompanyTime(day, '13:30') }, $inc: { __v: 1 } });
    return original.apply(this, args);
  };
  try { await require('../src/services/attendanceRecords').closeEndedShifts(p.DEFAULT_RULE, { user: people[0]._id }, p.atCompanyTime(day, '19:00')); }
  finally { Attendance.bulkWrite = original; }
  assert.equal((await Attendance.findById(saved._id)).checkOut, undefined);
  await require('../src/services/attendanceRecords').closeEndedShifts(p.DEFAULT_RULE, { user: people[0]._id }, p.atCompanyTime(day, '19:00'));
  const closed = await Attendance.findById(saved._id); assert.equal(closed.checkOut.getTime(), p.atCompanyTime(day, '13:30').getTime()); assert.equal(closed.totalWorkHours, 4.5);
});

test('afternoon leave no-show appears when the remaining morning half ends', async () => {
  const day = '2026-10-13';
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime(day, '00:00') } });
  assert.equal((await approve(await apply(people[0], day, day, 'afternoon'))).status, 200);
  const materialize = require('../src/services/attendanceHistory').materializeHistory;
  await materialize(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: day, $lte: day } }, p.atCompanyTime(day, '13:29'));
  assert.equal(await Attendance.countDocuments({ user: people[0]._id }), 0);
  await materialize(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: day, $lte: day } }, p.atCompanyTime(day, '13:30'));
  const saved = await Attendance.findOne({ user: people[0]._id }); assert.equal(saved.status, 'absent'); assert.equal(saved.deductionAmount, 0); assert.equal(saved.financialReviewRequired, true);
});

test('direct checkout quarantines an invalid legacy schedule without inventing departure evidence', async () => {
  const day = p.companyDate(), inserted = await Attendance.collection.insertOne({ user: people[0]._id, date: day, checkIn: new Date(new Date().getTime() - 60000), checkOut: null, scheduledCheckOut: 'invalid-end', status: 'present' });
  const result = await request(people[0], '/attendance/check-out', {}); assert.equal(result.status, 409);
  const raw = await Attendance.collection.findOne({ _id: inserted.insertedId }); assert.equal(raw.checkOut, null); assert.equal(raw.scheduledCheckOut, 'invalid-end'); assert.ok(raw.quarantine.at);
});

test('today exposes the remaining half-shift before check-in and distinguishes scheduled days off', async () => {
  const day = p.companyDate();
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '09:00', shiftEndTime: '18:00', workingDays: [0,1,2,3,4,5,6] } });
  assert.equal((await approve(await apply(people[0], day, day, 'morning'))).status, 200);
  const result = await request(people[0], '/attendance/today');
  assert.equal(result.status, 200); assert.equal(result.body.personalSchedule.halfDaySession, 'morning'); assert.equal(new Date(result.body.personalSchedule.expectedCheckIn).getTime(), p.atCompanyTime(day, '13:30').getTime());
  await DeductionRule.updateOne({}, { $set: { workingDays: [0, 6] } });
  assert.deepEqual((await request(people[1], '/deductions/rules')).body.rule.workingDays, [1,2,3,4,5]);
  const OriginalDate = Date, saturday = p.atCompanyTime('2026-10-17', '12:00').getTime();
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [saturday])); } };
  try { assert.equal((await request(people[1], '/attendance/today')).body.attendance.status, 'day_off'); } finally { global.Date = OriginalDate; }
});

test('a real arrival upgrades an inferred no-show in place without bypassing an administrator absence', async () => {
  const day = p.companyDate(), missing = await Attendance.create({ user: people[0]._id, date: day, status: 'absent', recordSource: 'automatic', financialReviewRequired: true });
  const result = await request(people[0], '/attendance/check-in', payload());
  assert.equal(result.status, 201); assert.equal(result.body.attendance._id, missing.id); assert.ok(result.body.attendance.checkIn); assert.equal(result.body.attendance.recordSource, 'employee'); assert.equal(result.body.attendance.financialReviewRequired, false);
  assert.equal(await Attendance.countDocuments({ user: people[0]._id, date: day }), 1);
  await Attendance.create({ user: people[1]._id, date: day, status: 'absent', recordSource: 'automatic', override: { type: 'absent', by: people[2]._id, at: new Date() } });
  assert.equal((await request(people[1], '/attendance/check-in', payload('protected-user-device'))).status, 409);
});

test('half-day approval preserves an administrator presence waiver without reopening absence review', async () => {
  const day = p.companyDate();
  await DeductionRule.updateOne({}, { $set: { workingDays: [0,1,2,3,4,5,6] } });
  assert.equal((await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: day, verifyPresence: true })).status, 200);
  assert.equal((await approve(await apply(people[0], day, day, 'morning'))).status, 200);
  const saved = await Attendance.findOne({ user: people[0]._id, date: day });
  assert.equal(saved.status, 'present'); assert.equal(saved.deductionAmount, 0); assert.equal(saved.financialReviewRequired, false); assert.equal(saved.override.type, 'present');
  assert.ok(!saved.deductionReason.includes('requires administrator review'));
});

test('repair restores the canonical browser/day lock and rolls back conflicting device repairs', async () => {
  const day = p.addDays(p.companyDate(), -1), device = 'legacy-repair-device';
  const make = (person, suffix) => Attendance.collection.insertOne({ user: person._id, date: 'invalid-' + suffix, checkIn: p.atCompanyTime(day, '09:00'), checkOut: null, status: 'present', deviceInfo: { deviceId: device }, deviceLockKey: 'invalid-' + suffix + ':' + device, quarantine: { at: new Date(), reason: 'legacy' }, __v: 0 });
  const first = await make(people[0], 'one');
  const repaired = await request(people[2], `/attendance/records/${first.insertedId}/repair`, { date: day });
  assert.equal(repaired.status, 200); assert.equal((await Attendance.findById(first.insertedId)).deviceLockKey, `${day}:${device}`);
  const second = await make(people[1], 'two');
  const conflict = await request(people[2], `/attendance/records/${second.insertedId}/repair`, { date: day });
  assert.equal(conflict.status, 409);
  const retained = await Attendance.collection.findOne({ _id: second.insertedId }); assert.equal(retained.date, 'invalid-two'); assert.ok(retained.quarantine.at);
});

test('stale quarantine writes cannot undo repairs during automatic closure or direct checkout', async () => {
  for (const [index, explicit] of [false, true].entries()) {
    const person = people[index], inserted = await Attendance.collection.insertOne({ user: person._id, date: p.companyDate(), checkIn: new Date(new Date().getTime() - 60000), checkOut: null, scheduledCheckOut: 'invalid-end', status: 'present', __v: 0 });
    const original = Attendance.collection.updateOne;
    let repaired = false;
    Attendance.collection.updateOne = async function (filter, update, ...args) {
      if (String(filter._id) === String(inserted.insertedId) && update.$set?.quarantine && !repaired) {
        repaired = true;
        await original.call(this, { _id: inserted.insertedId }, { $set: { scheduledCheckOut: new Date(new Date().getTime() + 3600000) }, $inc: { __v: 1 } });
      }
      return original.call(this, filter, update, ...args);
    };
    try {
      if (explicit) assert.equal((await request(person, '/attendance/check-out', {})).status, 200);
      else await require('../src/services/attendanceRecords').closeEndedShifts(p.DEFAULT_RULE, { user: person._id });
    } finally { Attendance.collection.updateOne = original; }
    const stored = await Attendance.collection.findOne({ _id: inserted.insertedId }); assert.equal(stored.quarantine?.at, undefined); assert.ok(stored.scheduledCheckOut instanceof Date);
  }
});

test('distant antipodal GPS locations are rejected as outside the office instead of producing NaN', async () => {
  await DeductionRule.updateOne({}, { $set: { 'officeLocation.latitude': 88.40000000000009, 'officeLocation.longitude': -170 } });
  const result = await request(people[0], '/attendance/check-in', { ...payload(), latitude: -88.40000000000009, longitude: 10 });
  assert.equal(result.status, 403); assert.match(result.body.message, /from the office/); assert.equal(await Attendance.countDocuments(), 0);
});

test('stale administrator confirmations cannot overwrite changed or newly-created attendance', async () => {
  const day = p.companyDate(), original = await record(people[0]);
  await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: day, verifyPresence: true });
  const stale = await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day, expectedRecordId: original.id, expectedVersion: original.__v });
  assert.equal(stale.status, 409); assert.equal((await Attendance.findById(original._id)).deductionAmount, 0);
  const created = await record(people[1]);
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[1].id, date: day, expectedRecordId: null, expectedVersion: null })).status, 409);
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[1].id, date: day, expectedRecordId: created.id, expectedVersion: -1 })).status, 400);
  const fresh = await Attendance.findById(original._id);
  assert.equal((await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day, expectedRecordId: fresh.id, expectedVersion: fresh.__v })).status, 200);
});

test('historical rosters respect inactive gaps, departure dates and legacy joining-date fallback', async () => {
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-01', '00:00'), employmentGaps: [{ start: p.atCompanyTime('2026-10-02', '18:00'), end: p.atCompanyTime('2026-10-09', '09:00') }] } });
  await User.updateOne({ _id: people[1]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-01', '00:00'), isActive: false, deactivatedAt: p.atCompanyTime('2026-10-06', '18:00') } });
  await User.collection.updateOne({ _id: people[2]._id }, { $unset: { joinDate: '' }, $set: { createdAt: p.atCompanyTime('2026-10-01', '00:00') } });
  const roster = require('../src/services/attendanceRecords').dailyRoster;
  const earlier = await roster('2026-10-05');
  assert.ok(!earlier.some(row => String(row.user._id) === people[0].id));
  assert.ok(earlier.some(row => String(row.user._id) === people[1].id)); assert.ok(earlier.some(row => String(row.user._id) === people[2].id));
  const later = await roster('2026-10-09');
  assert.ok(later.some(row => String(row.user._id) === people[0].id)); assert.ok(!later.some(row => String(row.user._id) === people[1].id));
  assert.ok(!later.some(row => String(row.user._id) === people[3].id));
});

test('no-show generation cannot miss a leave approval committed after its coverage read', async () => {
  const day = '2026-10-13';
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime(day, '00:00') } });
  const leave = await apply(people[0], day);
  const original = Attendance.bulkWrite;
  let approved = false;
  Attendance.bulkWrite = async function (...args) {
    if (!approved && args[0].some(operation => operation.updateOne?.update?.$setOnInsert?.status === 'absent')) {
      approved = true; assert.equal((await approve(leave)).status, 200);
    }
    return original.apply(this, args);
  };
  try { await require('../src/services/attendanceHistory').materializeHistory(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: day, $lte: day } }, p.atCompanyTime(day, '19:00')); }
  finally { Attendance.bulkWrite = original; }
  const stored = await Attendance.findOne({ user: people[0]._id, date: day });
  assert.equal(stored.status, 'on_leave'); assert.equal(stored.deductionAmount, 0); assert.equal(stored.financialReviewRequired, false); assert.equal(stored.checkIn, undefined);
});

test('calendar reconciliation resumes after an interrupted generation without duplicating attendance', async () => {
  const day = '2026-10-13';
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime(day, '00:00') } });
  const missing = await Attendance.create({ user: people[0]._id, date: day, status: 'absent', recordSource: 'automatic', financialReviewRequired: true, policySnapshot: p.DEFAULT_RULE });
  await LeaveRequest.create({ user: people[0]._id, leaveType: 'casual', startDate: p.atCompanyTime(day, '00:00'), endDate: p.atCompanyTime(day, '00:00'), totalDays: 1, workingDates: [day], reason: 'Approved while prior calendar generation was interrupted', status: 'approved' });
  await require('../src/services/attendanceHistory').materializeHistory(p.DEFAULT_RULE, { user: people[0]._id, date: { $gte: day, $lte: day } }, p.atCompanyTime(day, '19:00'));
  const stored = await Attendance.findById(missing._id); assert.equal(stored.status, 'on_leave'); assert.equal(stored.financialReviewRequired, false); assert.equal(stored.checkIn, undefined); assert.equal(await Attendance.countDocuments({ user: people[0]._id, date: day }), 1);
});

test('leave approval reduces later monthly repeat penalties using their saved policy and wage', async () => {
  const days = ['2026-10-09', '2026-10-12', '2026-10-13'];
  const saved = [];
  for (const [index, day] of days.entries()) saved.push(await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:35'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), minutesLate: 35, deductionAmount: index === 2 ? 75 : 50, deductionPercentage: index === 2 ? 7.5 : 5, policySnapshot: p.DEFAULT_RULE, wageSnapshot: 1000 }));
  const unrelated = await record(people[1], { date: days[2], deductionAmount: 75 });
  await User.updateOne({ _id: people[0]._id }, { $set: { dailyWage: 10000 } });
  await DeductionRule.updateOne({}, { $set: { percentageDeductionRate: 100 } });
  assert.equal((await approve(await apply(people[0], days[0]))).status, 200);
  const last = await Attendance.findById(saved[2]._id);
  assert.equal(last.deductionAmount, 50); assert.equal(last.deductionPercentage, 5); assert.equal(last.checkIn.getTime(), saved[2].checkIn.getTime());
  assert.equal(last.auditTrail.at(-1).previousState.deductionAmount, 75); assert.equal((await Attendance.findById(unrelated._id)).deductionAmount, 75);
});

test('administrator presence corrections also reduce later monthly repeat penalties', async () => {
  const days = ['2026-10-09', '2026-10-12', '2026-10-13'];
  const saved = [];
  for (const [index, day] of days.entries()) saved.push(await record(people[0], { date: day, checkIn: p.atCompanyTime(day, '09:35'), scheduledCheckOut: p.atCompanyTime(day, '18:00'), minutesLate: 35, deductionAmount: index === 2 ? 75 : 50, deductionPercentage: index === 2 ? 7.5 : 5, policySnapshot: p.DEFAULT_RULE, wageSnapshot: 1000 }));
  assert.equal((await request(people[2], '/attendance/mark-present', { userId: people[0].id, date: days[0], verifyPresence: true })).status, 200);
  assert.equal((await Attendance.findById(saved[2]._id)).deductionAmount, 50);
});

test('missing scheduled ends use saved overnight policy for automatic and explicit checkout', async () => {
  const day = '2026-10-14', previous = '2026-10-13', night = p.normalizeRule({ shiftStartTime: '22:00', shiftEndTime: '06:00' });
  const one = await record(people[0], { date: previous, checkIn: p.atCompanyTime(previous, '22:00'), scheduledCheckOut: null, policySnapshot: night });
  const two = await record(people[1], { date: previous, checkIn: p.atCompanyTime(previous, '22:00'), scheduledCheckOut: null, policySnapshot: night });
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '09:00', shiftEndTime: '18:00' } });
  const OriginalDate = Date, now = p.atCompanyTime(day, '02:00').getTime();
  global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])); } };
  try {
    const today = await request(people[0], '/attendance/today'); assert.equal(today.status, 200); assert.equal(today.body.openAttendance?._id, one.id); assert.equal(new Date(today.body.openAttendance.scheduledCheckOut).getTime(), p.atCompanyTime(day, '06:00').getTime()); assert.equal((await Attendance.findById(one._id)).checkOut, undefined); assert.equal((await Attendance.findById(one._id)).scheduledCheckOut, null);
    const checkout = await request(people[1], '/attendance/check-out', {}); assert.equal(checkout.status, 200); assert.equal(checkout.body.attendance.totalWorkHours, 4); assert.equal(new Date(checkout.body.attendance.checkOut).getTime(), now);
  } finally { global.Date = OriginalDate; }
  assert.equal((await Attendance.findById(two._id)).checkIn.getTime(), two.checkIn.getTime());
});

test('partial legacy policy snapshots cannot break history repair suggestions', async () => {
  const inserted = await Attendance.collection.insertOne({ user: people[0]._id, date: 'invalid-date', checkIn: p.atCompanyTime('2026-10-13', '09:00'), status: 'present', policySnapshot: { workingDays: [1,2,3,4,5] }, quarantine: { at: new Date(), reason: 'legacy' } });
  const result = await request(people[2], '/attendance/history');
  assert.equal(result.status, 200); assert.equal(result.body.records.find(row => row._id === String(inserted.insertedId)).suggestedRepairDate, '2026-10-13');
});

test('stale employee compensation edits cannot undo approved leave balances and unrelated edits preserve them', async () => {
  const day = '2026-11-02';
  assert.equal((await approve(await apply(people[0], day))).status, 200);
  const stale = await request(people[2], `/auth/users/${people[0].id}`, { leaveBalances: { casual: 20 }, expectedLeaveBalances: { casual: 10 } }, 'PUT');
  assert.equal(stale.status, 409); assert.equal((await User.findById(people[0]._id)).leaveBalances.casual, 9);
  const unrelated = await request(people[2], `/auth/users/${people[0].id}`, { phone: '+92 000 0000000' }, 'PUT');
  assert.equal(unrelated.status, 200); assert.equal(unrelated.body.user.leaveBalances.casual, 9);
  const fresh = await request(people[2], `/auth/users/${people[0].id}`, { leaveBalances: { casual: 20 }, expectedLeaveBalances: { casual: 9 } }, 'PUT');
  assert.equal(fresh.status, 200); assert.equal(fresh.body.user.leaveBalances.casual, 20);
});

test('non-finite compensation is rejected and explicit zero pay remains zero', async () => {
  for (const body of [{ leaveBalances: { casual: 'Infinity' } }, { leaveBalances: { casual: -1 } }, { dailyWage: 'Infinity' }, { baseSalary: -1 }]) {
    assert.equal((await request(people[2], `/auth/users/${people[0].id}`, body, 'PUT')).status, 400);
  }
  const invalid = await request(people[2], '/auth/users', { name: 'Synthetic New Employee', email: 'invalid-pay@example.test', password: 'isolated-password', department: 'Software Development', baseSalary: 'Infinity', dailyWage: 0 });
  assert.equal(invalid.status, 400);
  const zero = await request(people[2], '/auth/users', { name: 'Synthetic Zero Pay Employee', email: 'zero-pay@example.test', password: 'isolated-password', department: 'Software Development', baseSalary: 0, dailyWage: 0 });
  assert.equal(zero.status, 201); assert.equal(zero.body.user.baseSalary, 0); assert.equal(zero.body.user.dailyWage, 0);
  await User.deleteOne({ _id: zero.body.user._id });
  await User.updateOne({ _id: people[0]._id }, { $set: { baseSalary: 150000, dailyWage: 0 } });
  const unrelated = await request(people[2], `/auth/users/${people[0].id}`, { phone: '+92 000 0000000' }, 'PUT');
  assert.equal(unrelated.status, 200); assert.equal(unrelated.body.user.dailyWage, 6818.18);
});

test('attendance authorization fails closed when JWT_SECRET is missing', async () => {
  const previous = process.env.JWT_SECRET;
  const forged = jwt.sign({ id: people[2]._id }, 'neximet_super_secret_jwt_key_2026_enterprise_portal');
  delete process.env.JWT_SECRET;
  try {
    const response = await fetch(base + '/attendance/history', { headers: { Authorization: 'Bearer ' + forged } });
    assert.equal(response.status, 503);
  } finally { process.env.JWT_SECRET = previous; }
});

test('employee dashboards never disclose company attendance or wage deductions and return fresh personal leave balances', async () => {
  await record(people[0], { deductionAmount: 50 }); await record(people[1], { deductionAmount: 75 });
  await User.updateOne({ _id: people[0]._id }, { $set: { 'leaveBalances.casual': 9 } });
  for (const person of [people[0], people[4]]) {
    const result = await request(person, '/dashboard/stats'); assert.equal(result.status, 200);
    for (const key of ['totalEmployees','checkedInToday','presentCount','lateCount','absentCount','todayDeductions','monthlyDeductions']) assert.equal(result.body.attendance[key], undefined, key);
    if (person.id === people[0].id) { assert.equal(result.body.attendance.myMonthlyDeductions, undefined); assert.equal(result.body.attendance.myLeaveBalances.casual, 9); }
  }
  const executive = await request(people[2], '/dashboard/stats'); assert.equal(executive.body.attendance.todayDeductions, 125); assert.equal(executive.body.attendance.totalEmployees, 4);
});

test('malformed saved shift policies are quarantined without breaking personal or company reads', async () => {
  const bad = await record(people[0], { scheduledCheckOut: null, policySnapshot: { shiftStartTime: 'broken', shiftEndTime: 'broken' } });
  const legacy = await Attendance.collection.insertOne({ user: people[1]._id, date: 'invalid-date', checkIn: p.atCompanyTime(p.addDays(p.companyDate(), -1), '22:00'), status: 'present', policySnapshot: { shiftStartTime: 'broken', shiftEndTime: 'broken' }, quarantine: { at: new Date(), reason: 'Corrupt saved policy' } });
  const today = await request(people[0], '/attendance/today');
  assert.equal(today.status, 200); assert.ok(today.body.attendance.quarantine.at);
  assert.equal(today.body.openAttendance, null);
  for (const endpoint of ['/attendance/history', '/attendance/roster', '/dashboard/stats']) assert.equal((await request(people[2], endpoint)).status, 200, endpoint);
  const history = await request(people[2], '/attendance/history'); assert.equal(history.body.records.find(row => row._id === String(legacy.insertedId)).suggestedRepairDate, undefined);
  assert.equal((await request(people[0], '/attendance/check-out', {})).status, 409);
  const unchanged = await Attendance.findById(bad._id);
  assert.equal(unchanged.checkOut, undefined); assert.equal(unchanged.deductionAmount, 50); assert.equal(unchanged.checkIn.getTime(), bad.checkIn.getTime());
});

test('invalid expected arrival evidence is quarantined before calculating work hours', async () => {
  const bad = await record(people[0]);
  await Attendance.collection.updateOne({ _id: bad._id }, { $set: { expectedCheckIn: 'broken' } });
  const result = await request(people[0], '/attendance/check-out', {});
  assert.equal(result.status, 409);
  const stored = await Attendance.collection.findOne({ _id: bad._id });
  assert.ok(stored.quarantine.at); assert.equal(stored.expectedCheckIn, 'broken'); assert.equal(stored.checkOut, undefined);
});

test('quarantined days cannot be overwritten through direct check-in or override requests', async () => {
  const bad = await record(people[0], { checkIn: null, status: 'present', quarantine: { at: new Date(), reason: 'Missing original evidence' } });
  assert.equal((await request(people[0], '/attendance/check-in', payload())).status, 409);
  for (const endpoint of ['/attendance/mark-present', '/attendance/mark-absent']) assert.equal((await request(people[2], endpoint, { userId: people[0].id, date: bad.date, verifyPresence: endpoint.endsWith('present') ? true : undefined })).status, 409);
  const stored = await Attendance.findById(bad._id); assert.equal(stored.checkIn, null); assert.equal(stored.deductionAmount, 50); assert.equal(stored.auditTrail.length, 0);
});

test('working-date repair rejects missing arrival instead of accepting the Unix epoch', async () => {
  const bad = await record(people[0], { checkIn: null, quarantine: { at: new Date(), reason: 'Missing original evidence' } });
  const result = await request(people[2], `/attendance/records/${bad.id}/repair`, { date: bad.date });
  assert.equal(result.status, 400); assert.ok((await Attendance.findById(bad._id)).quarantine.at);
});

test('date repair cannot report success while corrupt expected arrival still requires quarantine', async () => {
  const bad = await record(people[0], { quarantine: { at: new Date(), reason: 'Corrupt expected arrival' } });
  await Attendance.collection.updateOne({ _id: bad._id }, { $set: { expectedCheckIn: 'broken' } });
  const result = await request(people[2], `/attendance/records/${bad.id}/repair`, { date: bad.date });
  assert.equal(result.status, 400);
  const stored = await Attendance.collection.findOne({ _id: bad._id }); assert.equal(stored.expectedCheckIn, 'broken'); assert.ok(stored.quarantine.at); assert.equal(stored.auditTrail.length, 0);
});

test('today materializes an overdue no-show without requiring a history or dashboard visit', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  await DeductionRule.updateOne({}, { $set: { workingDays: [0, 1, 2, 3, 4, 5, 6], shiftEndTime: '00:01' } });
  const response = await request(people[0], '/attendance/today');
  assert.equal(response.status, 200);
  assert.equal(response.body.attendance?.status, 'absent');
  assert.equal(response.body.attendance.financialReviewRequired, true);
  assert.equal(response.body.attendance.deductionAmount, undefined);
  assert.equal(await Attendance.countDocuments({ user: people[1]._id }), 0);
});

test('automatic no-shows retain the wage at generation when pay changes before review', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  const day = p.companyDate();
  await DeductionRule.updateOne({}, { $set: { workingDays: [0, 1, 2, 3, 4, 5, 6], shiftEndTime: '00:01' } });
  await request(people[3], '/attendance/roster');
  await User.updateOne({ _id: people[0]._id }, { $set: { baseSalary: 44000, dailyWage: 2000 } });
  const response = await request(people[2], '/attendance/mark-absent', { userId: people[0].id, date: day });
  assert.equal(response.status, 200);
  assert.equal(response.body.attendance.wageSnapshot, 1000);
  assert.equal(response.body.attendance.deductionAmount, 1000);
});

test('quarantined evidence remains visible but does not count as payable deductions or verified attendance', async () => {
  await record(people[0], { quarantine: { at: new Date(), reason: 'Needs review' }, deductionAmount: 500 });
  const personal = (await request(people[0], '/dashboard/stats')).body.attendance;
  assert.ok(personal.myTodayStatus.quarantine.at);
  assert.equal(personal.myMonthlyDeductions, undefined);
  assert.equal(personal.myMonthlyPresentCount, 0);
  assert.equal(personal.myMonthlyLateCount, 0);
  const company = (await request(people[2], '/dashboard/stats')).body.attendance;
  assert.equal(company.checkedInToday, 0);
  assert.equal(company.lateCount, 0);
  assert.equal(company.todayDeductions, 0);
  assert.equal(company.monthlyDeductions, 0);
  assert.equal((await request(people[2], '/deductions/monthly-report')).body.grandTotalDeductions, 0);
  const history = (await request(people[0], '/attendance/history')).body;
  assert.equal(history.records[0].deductionAmount, undefined);
  assert.equal(history.totalDeductions, undefined);
  assert.equal(history.lateCount, 0);
});

test('quarantined late incidents cannot increase a later real arrival repeat penalty', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  const day = p.companyDate();
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime(p.addDays(day, -3), '00:00') } });
  for (const offset of [-2, -1]) await record(people[0], { date: p.addDays(day, offset), checkOut: new Date(), quarantine: { at: new Date(), reason: 'Needs review' } });
  await DeductionRule.updateOne({}, { $set: { workingDays: [0, 1, 2, 3, 4, 5, 6], fullDayAbsentThresholdMinutes: 1440, halfDayThresholdMinutes: 1439, gracePeriodMinutes: 0 } });
  const response = await request(people[0], '/attendance/check-in', payload());
  assert.equal(response.status, 201);
  assert.equal((await Attendance.findOne({ user: people[0]._id, date: day })).deductionAmount, 0);
});

test('simulated late incidents cannot increase a later real arrival repeat penalty', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  const day = p.companyDate();
  await User.updateOne({ _id: people[2]._id }, { $set: { joinDate: p.atCompanyTime(p.addDays(day, -3), '00:00') } });
  for (const offset of [-2, -1]) await record(people[2], { date: p.addDays(day, offset), checkOut: new Date(), isSimulated: true });
  await DeductionRule.updateOne({}, { $set: { workingDays: [0, 1, 2, 3, 4, 5, 6], fullDayAbsentThresholdMinutes: 1440, halfDayThresholdMinutes: 1439, gracePeriodMinutes: 0 } });
  const response = await request(people[2], '/attendance/check-in', payload());
  assert.equal(response.status, 201);
  assert.equal(response.body.attendance.deductionAmount, 0);
  assert.equal(response.body.attendance.isSimulated, false);
});

test('overnight administrative alerts use the working day and exclude simulations/quarantined evidence', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-11-01', '02:00').getTime() });
  Date.now = actualNow;
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '22:00', shiftEndTime: '06:00' } });
  const fields = { date: '2026-10-31', checkIn: p.atCompanyTime('2026-10-31', '22:35'), scheduledCheckOut: p.atCompanyTime('2026-11-01', '06:00') };
  const real = await record(people[0], fields);
  await record(people[1], { ...fields, quarantine: { at: new Date(), reason: 'Needs review' } });
  await record(people[2], { ...fields, isSimulated: true });
  const response = await request(people[3], '/dashboard/admin-notifications');
  assert.equal(response.status, 200);
  assert.equal(response.body.counts.attendance, 1);
  assert.equal(response.body.notifications.attendance[0]._id, real.id);
});

test('legacy early overnight arrival retains worked hours in explicit and automatic checkout', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-14', '02:00').getTime() });
  Date.now = actualNow;
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '22:00', shiftEndTime: '06:00' } });
  const fields = { date: '2026-10-13', checkIn: p.atCompanyTime('2026-10-13', '21:00'), expectedCheckIn: p.atCompanyTime('2026-10-13', '22:00'), scheduledCheckOut: null };
  await record(people[0], fields);
  const automatic = await record(people[1], fields);
  const explicit = await request(people[0], '/attendance/check-out', {});
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.attendance.totalWorkHours, 5);
  t.mock.timers.setTime(p.atCompanyTime('2026-10-14', '07:00').getTime());
  assert.equal((await request(people[1], '/attendance/today')).status, 200);
  assert.equal((await Attendance.findById(automatic._id)).totalWorkHours, 9);
});

test('a narrow overnight history query cannot infer absence over next-morning quarantined arrival evidence', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  await DeductionRule.updateOne({}, { $set: { shiftStartTime: '22:00', shiftEndTime: '06:00' } });
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-13', '00:00') } });
  const legacy = await Attendance.collection.insertOne({ user: people[0]._id, date: 'unknown-day', checkIn: p.atCompanyTime('2026-10-14', '02:00'), status: 'late', quarantine: { at: new Date(), reason: 'Invalid working date' } });
  const response = await request(people[0], '/attendance/history?startDate=2026-10-13&endDate=2026-10-13');
  assert.equal(response.status, 200);
  assert.equal(await Attendance.countDocuments({ user: people[0]._id, date: '2026-10-13' }), 0);
  assert.ok((await Attendance.collection.findOne({ _id: legacy.insertedId })).quarantine.at);
});

test('repairing a working date reopens the completed calendar checkpoint so its vacated date is not lost', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-12', '00:00') } });
  const row = await record(people[0], { date: '2026-10-13', checkIn: p.atCompanyTime('2026-10-12', '09:00'), scheduledCheckOut: p.atCompanyTime('2026-10-12', '18:00'), quarantine: { at: new Date(), reason: 'Wrong working date' } });
  const range = '/attendance/history?startDate=2026-10-12&endDate=2026-10-13';
  assert.equal((await request(people[0], range)).status, 200);
  assert.equal((await User.findById(people[0]._id).select('+attendanceCalendarThrough')).attendanceCalendarThrough, '2026-10-13');
  assert.equal((await request(people[3], `/attendance/records/${row.id}/repair`, { date: '2026-10-12' })).status, 200);
  const response = await request(people[0], range);
  assert.equal(response.body.count, 2);
  assert.equal(response.body.records.find(item => item.date === '2026-10-13')?.financialReviewRequired, true);
});

test('working-date repair rejects a stale confirmation and preserves the newer quarantine evidence', async () => {
  const row = await record(people[0], { quarantine: { at: new Date(), reason: 'Original review' } });
  await Attendance.updateOne({ _id: row._id }, { $set: { 'quarantine.reason': 'New review evidence' }, $inc: { __v: 1 } });
  const response = await request(people[3], `/attendance/records/${row.id}/repair`, { date: row.date, expectedRecordId: row.id, expectedVersion: row.__v });
  assert.equal(response.status, 409);
  assert.equal((await Attendance.findById(row._id)).quarantine.reason, 'New review evidence');
});

test('a calendar scan finishing after a concurrent repair cannot reinstate its stale checkpoint', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  await User.updateOne({ _id: people[0]._id }, { $set: { joinDate: p.atCompanyTime('2026-10-12', '00:00') } });
  const row = await record(people[0], { date: '2026-10-13', checkIn: p.atCompanyTime('2026-10-12', '09:00'), scheduledCheckOut: p.atCompanyTime('2026-10-12', '18:00'), quarantine: { at: new Date(), reason: 'Wrong date' } });
  const original = User.updateOne;
  let release, reached;
  const paused = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let held = false;
  User.updateOne = function (...args) {
    if (!held && args[1]?.$max?.attendanceCalendarThrough && String(args[0]._id) === people[0].id) {
      held = true; reached();
      return gate.then(() => original.apply(this, args));
    }
    return original.apply(this, args);
  };
  const scan = require('../src/services/attendanceHistory').materializeHistory(p.normalizeRule({ shiftStartTime: '00:00', shiftEndTime: '23:59' }), { user: people[0]._id, date: { $gte: '2026-10-12', $lte: '2026-10-13' } });
  try {
    await paused;
    assert.equal((await request(people[3], `/attendance/records/${row.id}/repair`, { date: '2026-10-12' })).status, 200);
    release(); await scan;
    assert.equal((await User.findById(people[0]._id).select('+attendanceCalendarThrough')).attendanceCalendarThrough, undefined);
  } finally { release(); User.updateOne = original; await scan; }
  const response = await request(people[0], '/attendance/history?startDate=2026-10-12&endDate=2026-10-13');
  assert.equal(response.body.count, 2);
});

test('working-date repair aligns derived schedule bounds and hours while retaining original arrival/departure evidence', async t => {
  t.mock.timers.reset(); t.mock.timers.enable({ apis: ['Date'], now: p.atCompanyTime('2026-10-15', '12:00').getTime() });
  Date.now = actualNow;
  for (const [index, closed] of [false, true].entries()) {
    const row = await record(people[index], { date: '2026-10-14', checkIn: p.atCompanyTime('2026-10-13', '09:00'), expectedCheckIn: p.atCompanyTime('2026-10-14', '09:00'), scheduledCheckOut: p.atCompanyTime('2026-10-14', '18:00'), ...(closed ? { checkOut: p.atCompanyTime('2026-10-13', '17:00'), totalWorkHours: 0 } : {}), policySnapshot: p.DEFAULT_RULE, quarantine: { at: new Date(), reason: 'Wrong date' } });
    const response = await request(people[3], `/attendance/records/${row.id}/repair`, { date: '2026-10-13' });
    assert.equal(response.status, 200, response.body.message);
    const repaired = await Attendance.findById(row._id);
    assert.equal(repaired.scheduledCheckOut.getTime(), p.atCompanyTime('2026-10-13', '18:00').getTime());
    assert.equal(repaired.expectedCheckIn.getTime(), p.atCompanyTime('2026-10-13', '09:00').getTime());
    assert.equal(repaired.checkIn.getTime(), row.checkIn.getTime());
    assert.equal(repaired.totalWorkHours, closed ? 8 : 9);
    if (closed) assert.equal(repaired.checkOut.getTime(), row.checkOut.getTime());
    assert.equal(new Date(repaired.auditTrail[0].previousState.scheduledCheckOut).getTime(), row.scheduledCheckOut.getTime());
    assert.equal(repaired.deductionAmount, row.deductionAmount);
  }
});
