const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/services/attendancePolicy');
const rule = p.normalizeRule();

test('geofence distances stay finite for identical and antipodal GPS points', () => {
  assert.equal(p.distanceMeters(24.8607, 67.0011, 24.8607, 67.0011), 0);
  const antipode = p.distanceMeters(-88.40000000000009, 10, 88.40000000000009, -170);
  assert.ok(Number.isFinite(antipode)); assert.ok(antipode > 20000000);
});

test('company dates and payroll month boundaries do not depend on server timezone', () => {
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const previous = process.env.TZ; process.env.TZ = tz;
    try {
      assert.equal(p.companyDate('2026-10-31T19:05:00Z'), '2026-11-01');
      assert.equal(p.calculateAttendance(new Date('2026-10-13T09:30:00+05:00'), { dailyWage: 1000 }, rule).minutesLate, 30);
      assert.equal(p.atCompanyTime('2026-10-13', '09:00').toISOString(), '2026-10-13T04:00:00.000Z');
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  }
});
test('grace closes at the exact boundary; half/full-day thresholds are inclusive', () => {
  assert.equal(p.calculateDeduction(15, 1000, rule).isLate, false);
  assert.equal(p.calculateDeduction(15 + 1 / 60, 1000, rule).isLate, true);
  assert.equal(p.calculateDeduction(59.99, 1000, rule).status, 'late');
  assert.equal(p.calculateDeduction(60, 1000, rule).deductionAmount, 500);
  assert.equal(p.calculateDeduction(179.99, 1000, rule).status, 'half_day');
  assert.equal(p.calculateDeduction(180, 1000, rule).deductionAmount, 1000);
});
test('third monthly late triggers repeat penalty and never exceeds one day of pay', () => {
  assert.equal(p.calculateDeduction(30, 1000, rule, 1).deductionAmount, 50);
  assert.equal(p.calculateDeduction(30, 1000, rule, 2).deductionAmount, 75);
  assert.equal(p.calculateDeduction(180, 1000, rule, 5).deductionAmount, 1000);
  assert.equal(p.calculateDeduction(30, 1000, { ...rule, consecutiveLateThreshold: 0 }, 10).deductionAmount, 50);
});
test('zero/unconfigured pay is respected and fixed penalties are bounded', () => {
  assert.equal(p.dailyWage({ dailyWage: 0, baseSalary: 90000 }), 0);
  assert.equal(p.dailyWage({ baseSalary: 30000 }), 1000);
  assert.equal(p.dailyWage({}), 0);
  assert.equal(p.calculateDeduction(30, 0, rule).deductionAmount, 0);
  assert.equal(p.calculateDeduction(30, 1000, { ...rule, deductionType: 'fixed', fixedDeductionAmount: 5000 }).deductionAmount, 1000);
});
test('overnight check-ins and scheduled ends belong to the shift start date', () => {
  const night = { ...rule, shiftStartTime: '22:00', shiftEndTime: '06:00' };
  assert.equal(p.shiftDate('2026-10-14T02:00:00+05:00', night), '2026-10-13');
  assert.equal(p.shiftDate('2026-11-01T02:00:00+05:00', night), '2026-10-31');
  assert.equal(p.scheduledEnd('2026-10-13', night).toISOString(), '2026-10-14T01:00:00.000Z');
  assert.equal(p.calculateAttendance(new Date('2026-10-14T00:30:00+05:00'), { dailyWage: 1000 }, night).minutesLate, 150);
});
test('invalid calendars, times and contradictory policy are rejected', () => {
  assert.equal(p.validDate('2026-02-30'), false);
  assert.equal(p.validMonth('2026-13'), false);
  for (const override of [{ shiftStartTime: '25:00' }, { shiftEndTime: '09:00' }, { halfDayThresholdMinutes: 10 }, { fullDayAbsentThresholdMinutes: 30 }, { percentageDeductionRate: -1 }, { consecutivePenaltyMultiplier: 0 }, { officeLocation: { latitude: 91 } }]) {
    assert.throws(() => p.validateRule(p.normalizeRule(override)));
  }
});
test('truthy strings, malformed/oversized image data are not accepted as selfies', async () => {
  for (const photo of ['true', 'data:image/jpeg;base64,abcd', 'data:image/png;base64,' + 'A'.repeat(800000), {}, 'data:image/svg+xml;base64,AAAA']) await assert.rejects(() => p.validateSelfie(photo));
});

test('approved morning/afternoon sessions adjust expected work and cap half-shift penalties', () => {
  const { attendanceCalculation } = require('../src/services/leavePolicy');
  const user = { _id: 'employee', dailyWage: 1000 }, day = '2026-10-13';
  const exemptions = session => ({ holiday: null, leaveUsers: new Set(), halfDayUsers: new Map([['employee', session]]) });
  const morning = attendanceCalculation(p.atCompanyTime(day, '13:00'), day, user, rule, exemptions('morning'));
  assert.equal(morning.isLate, false); assert.equal(morning.deductionAmount, 0); assert.equal(morning.expectedCheckIn.getTime(), p.atCompanyTime(day, '13:30').getTime());
  const afternoon = attendanceCalculation(p.atCompanyTime(day, '16:00'), day, user, rule, exemptions('afternoon'), 3);
  assert.equal(afternoon.deductionAmount, 500); assert.equal(afternoon.scheduledCheckOut.getTime(), p.atCompanyTime(day, '13:30').getTime());
});

test('Monday–Friday calendar and working-day validation are explicit', () => {
  assert.equal(p.isWorkingDay('2026-10-09', rule), true);
  assert.equal(p.isWorkingDay('2026-10-10', rule), false);
  for (const workingDays of [[], [1, 1], [7], ['1']]) assert.throws(() => p.validateRule(p.normalizeRule({ workingDays })));
});

test('legacy overnight schedules retain ordinary early-arrival hours when the saved policy is missing', () => {
  const night = p.normalizeRule({ shiftStartTime: '22:00', shiftEndTime: '06:00' });
  const record = { date: '2026-10-13', checkIn: p.atCompanyTime('2026-10-13', '21:00'), expectedCheckIn: p.atCompanyTime('2026-10-13', '22:00') };
  assert.equal(p.recordedShift(record, night).totalWorkHours, 9);
});
