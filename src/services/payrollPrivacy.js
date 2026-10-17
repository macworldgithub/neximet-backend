const { dailyWage } = require('./attendancePolicy');
const privateFields = new Set(['baseSalary', 'dailyWage', 'wageSnapshot', 'deductionAmount', 'totalDeductions', 'grandTotalDeductions', 'todayDeductions', 'monthlyDeductions', 'myMonthlyDeductions', 'deduction', 'expectedPay']);

// Applies after Mongoose/Date/ObjectId JSON conversion, including nested
// populated users, overrides and audit snapshots. Deduction money also reveals
// salary (one day's deduction * 22), so it has the same CEO-only boundary.
function payrollView(value, viewer) {
  const ceo = viewer?.role === 'CEO';
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (!ceo && privateFields.has(key)) return undefined;
    if (ceo && item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, 'baseSalary')) return { ...item, dailyWage: item.baseSalary == null ? null : dailyWage(item) };
    return item;
  }));
}
function protectPayroll(req, res) {
  if (res.payrollProtected) return;
  res.payrollProtected = true;
  const json = res.json;
  res.json = function (body) { res.set('Cache-Control', 'private, no-store'); return json.call(this, payrollView(body, req.user)); };
}
module.exports = { payrollView, protectPayroll };
