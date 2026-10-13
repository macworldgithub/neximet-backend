const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/services/attendancePolicy');
const rule = p.normalizeRule();

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
test('truthy strings, malformed/oversized image data are not accepted as selfies', () => {
  for (const photo of ['true', 'data:image/jpeg;base64,abcd', 'data:image/png;base64,' + 'A'.repeat(800000), {}, 'data:image/svg+xml;base64,AAAA']) assert.throws(() => p.validateSelfie(photo));
});
