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
  assert.equal(p.dailyWage({ dailyWage: 0, baseSalary: 22000 }), 1000);
  assert.equal(p.dailyWage({ baseSalary: 22000 }), 1000);
  assert.equal(p.dailyWage({ baseSalary: null, dailyWage: 5000 }), 0);
  assert.equal(p.dailyWage({}), 0);
  assert.equal(p.calculateDeduction(30, 0, rule).deductionAmount, 0);
  assert.equal(p.calculateDeduction(30, 1000, { ...rule, deductionType: 'fixed', fixedDeductionAmount: 5000 }).deductionAmount, 1000);
});

test('company policy charges exactly one daily wage for each monthly late pair', () => {
  const rule = p.companyRule();
  assert.deepEqual(rule.workingDays, [1, 2, 3, 4, 5]);
  for (let prior = 0; prior < 8; prior++) {
    const result = p.calculateDeduction(90, 1000.25, rule, prior);
    assert.equal(result.status, 'late'); assert.equal(result.isLate, true);
    assert.equal(result.deductionAmount, prior % 2 === 1 ? 1000.25 : 0);
  }
  assert.equal(p.dailyWage({ baseSalary: 150000, dailyWage: 5000 }), 6818.18);
  assert.equal(p.dailyWage({ baseSalary: 0, dailyWage: 5000 }), 0);
});
test('the company absence cutoff is strictly after 2 PM, independent of shift start', () => {
  for (const start of ['09:00', '10:00', '11:00']) {
    const rule = p.companyRule({ shiftStartTime: start });
    const user = { baseSalary: 22000 };
    for (const time of ['13:59:59', '14:00:00']) {
      const result = p.calculateAttendance(`2026-10-19T${time}+05:00`, user, rule, 0);
      assert.equal(result.status, 'late'); assert.equal(result.deductionAmount, 0);
    }
    const absent = p.calculateAttendance('2026-10-19T14:00:01+05:00', user, rule, 1);
    assert.equal(absent.status, 'absent'); assert.equal(absent.isLate, false); assert.equal(absent.deductionAmount, 1000);
  }
});
test('pair counts are monthly, policy-versioned, and exclude full-day absences and simulations', () => {
  const query = p.lateCountFilter('employee', '2026-11-02', p.companyRule());
  assert.equal(query.date.$gte, '2026-11-01'); assert.equal(query.date.$lt, '2026-11-02');
  assert.equal(query.status, 'late'); assert.equal(query.isSimulated.$ne, true);
  assert.equal(query['policySnapshot.policyVersion'], p.COMPANY_POLICY_VERSION);
});
test('salary visibility is CEO-only even in nested populated users, audits and deduction totals', () => {
  const { payrollView } = require('../src/services/payrollPrivacy');
  const payload = { user: { baseSalary: 22000, dailyWage: 999 }, auditTrail: [{ previousState: { wageSnapshot: 1000, deductionAmount: 1000 } }], totalDeductions: 1000, status: 'late' };
  for (const role of ['Super Admin', 'Project Manager', 'Team Manager', 'Team Member']) {
    const result = payrollView(payload, { role });
    assert.equal(result.user.baseSalary, undefined); assert.equal(result.user.dailyWage, undefined);
    assert.equal(result.auditTrail[0].previousState.wageSnapshot, undefined); assert.equal(result.totalDeductions, undefined);
    assert.equal(result.status, 'late');
  }
  assert.equal(payrollView(payload, { role: 'CEO' }).user.dailyWage, 1000);
  assert.equal(payload.user.dailyWage, 999);
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

test('the new policy retains approved half-day coverage with currency precision', () => {
  const { attendanceCalculation } = require('../src/services/leavePolicy');
  const employee = { _id: 'employee', baseSalary: 150000 }, day = '2026-10-13';
  const exemptions = { holiday: null, leaveUsers: new Set(), halfDayUsers: new Map([['employee', 'morning']]) };
  const calculation = attendanceCalculation(p.atCompanyTime(day, '14:01'), day, employee, p.companyRule(), exemptions, 1);
  assert.equal(calculation.status, 'absent'); assert.equal(calculation.isLate, false);
  assert.equal(calculation.deductionAmount, 3409.09); assert.equal(calculation.deductionPercentage, 50);
});

test('legacy overnight schedules retain ordinary early-arrival hours when the saved policy is missing', () => {
  const night = p.normalizeRule({ shiftStartTime: '22:00', shiftEndTime: '06:00' });
  const record = { date: '2026-10-13', checkIn: p.atCompanyTime('2026-10-13', '21:00'), expectedCheckIn: p.atCompanyTime('2026-10-13', '22:00') };
  assert.equal(p.recordedShift(record, night).totalWorkHours, 9);
});
