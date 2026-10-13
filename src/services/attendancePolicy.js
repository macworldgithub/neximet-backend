// All attendance calendar calculations use the company's timezone, never the host's TZ.
const TIME_ZONE = 'Asia/Karachi';
const DEFAULT_RULE = {
  shiftStartTime: '09:00', shiftEndTime: '18:00', gracePeriodMinutes: 15,
  lateThresholdMinutes: 30, deductionType: 'percentage', percentageDeductionRate: 5,
  fixedDeductionAmount: 1000, halfDayThresholdMinutes: 60, fullDayAbsentThresholdMinutes: 180,
  consecutiveLateThreshold: 3, consecutivePenaltyMultiplier: 1.5, currencySymbol: 'PKR',
  officeLocation: { officeAddress: 'Neximet Head Office, Karachi', latitude: 24.8607, longitude: 67.0011, radiusMeters: 200, enforceLocation: true },
  antiProxySettings: { enforceSingleDevicePerDay: true, requireSelfieVerification: true },
};
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function companyParts(date = new Date()) {
  const value = new Date(date);
  if (!Number.isFinite(value.getTime())) fail('Invalid attendance timestamp.');
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(p => [p.type, p.value]));
}
function companyDate(date = new Date()) { const p = companyParts(date); return `${p.year}-${p.month}-${p.day}`; }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validMonth(value) { return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function timeMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Shift times must use HH:mm (24-hour format).');
  const [h, m] = value.split(':').map(Number); return h * 60 + m;
}
function addDays(date, days) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function shiftDate(date, rule) {
  const p = companyParts(date), minutes = Number(p.hour) * 60 + Number(p.minute);
  const start = timeMinutes(rule.shiftStartTime), end = timeMinutes(rule.shiftEndTime);
  // An overnight shift belongs to the day it started.
  return end <= start && minutes < end ? addDays(companyDate(date), -1) : companyDate(date);
}
function atCompanyTime(date, time) {
  if (!validDate(date)) fail('Date must be a valid YYYY-MM-DD.');
  timeMinutes(time);
  const target = new Date(`${date}T${time}:00Z`).getTime();
  let instant = target;
  // Resolve local wall time through IANA timezone data, including historical offsets.
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = companyParts(new Date(instant));
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    instant += target - wall;
  }
  return new Date(instant);
}
function scheduledEnd(date, rule) { return atCompanyTime(timeMinutes(rule.shiftEndTime) <= timeMinutes(rule.shiftStartTime) ? addDays(date, 1) : date, rule.shiftEndTime); }
function normalizeRule(input = {}) {
  input = input || {};
  const value = input.toObject ? input.toObject() : input;
  return { ...DEFAULT_RULE, ...value, officeLocation: { ...DEFAULT_RULE.officeLocation, ...value.officeLocation }, antiProxySettings: { ...DEFAULT_RULE.antiProxySettings, ...value.antiProxySettings } };
}
function validateRule(rule) {
  timeMinutes(rule.shiftStartTime); timeMinutes(rule.shiftEndTime);
  if (rule.shiftStartTime === rule.shiftEndTime) fail('Shift start and end must be different.');
  for (const key of ['gracePeriodMinutes', 'lateThresholdMinutes', 'halfDayThresholdMinutes', 'fullDayAbsentThresholdMinutes', 'consecutiveLateThreshold']) {
    if (typeof rule[key] !== 'number' || !Number.isInteger(rule[key]) || rule[key] < 0 || rule[key] > 1440) fail(`${key} must be a non-negative whole number, at most 1440.`);
  }
  if (rule.halfDayThresholdMinutes <= rule.gracePeriodMinutes || rule.fullDayAbsentThresholdMinutes <= rule.halfDayThresholdMinutes) fail('Full-day threshold must exceed half-day threshold, which must exceed grace.');
  for (const key of ['percentageDeductionRate', 'fixedDeductionAmount', 'consecutivePenaltyMultiplier']) if (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]) || rule[key] < 0) fail(`${key} must be a non-negative number.`);
  if (rule.percentageDeductionRate > 100 || rule.consecutivePenaltyMultiplier < 1 || rule.consecutivePenaltyMultiplier > 10) fail('Percentage must be 0–100 and repeat multiplier must be 1–10.');
  if (!['percentage', 'fixed'].includes(rule.deductionType)) fail('Invalid deduction type.');
  const office = rule.officeLocation;
  if (typeof office.latitude !== 'number' || !Number.isFinite(office.latitude) || Math.abs(office.latitude) > 90 || typeof office.longitude !== 'number' || !Number.isFinite(office.longitude) || Math.abs(office.longitude) > 180) fail('Office GPS coordinates are invalid.');
  if (typeof office.radiusMeters !== 'number' || !Number.isFinite(office.radiusMeters) || office.radiusMeters <= 0 || office.radiusMeters > 100000) fail('Office radius must be greater than zero and at most 100000 meters.');
  if (typeof office.enforceLocation !== 'boolean' || Object.values(rule.antiProxySettings).some(value => typeof value !== 'boolean')) fail('Verification settings must be true or false.');
  return rule;
}
function dailyWage(user) {
  if (user.dailyWage !== null && user.dailyWage !== undefined && Number.isFinite(Number(user.dailyWage)) && Number(user.dailyWage) >= 0) return Number(user.dailyWage);
  if (user.baseSalary !== null && user.baseSalary !== undefined && Number.isFinite(Number(user.baseSalary)) && Number(user.baseSalary) >= 0) return Math.round(Number(user.baseSalary) / 30);
  return 0; // Unconfigured pay must never invent a financial deduction.
}
function calculateDeduction(minutes, wage, rule, priorLateCount = 0) {
  const elapsed = Math.max(0, minutes);
  const minutesLate = Math.ceil(elapsed);
  const isLate = elapsed > rule.gracePeriodMinutes;
  let status = 'present', percentage = 0, reason = minutesLate ? `Within ${rule.gracePeriodMinutes} minute grace period.` : 'On time.';
  if (isLate) {
    if (elapsed >= rule.fullDayAbsentThresholdMinutes) { status = 'absent'; percentage = 100; reason = `${minutesLate} minutes late: full-day absence threshold reached.`; }
    else if (elapsed >= rule.halfDayThresholdMinutes) { status = 'half_day'; percentage = 50; reason = `${minutesLate} minutes late: half-day threshold reached.`; }
    else { status = 'late'; percentage = rule.deductionType === 'percentage' ? rule.percentageDeductionRate : (wage > 0 ? rule.fixedDeductionAmount / wage * 100 : 0); reason = `${minutesLate} minutes late: ${rule.deductionType === 'fixed' ? `PKR ${rule.fixedDeductionAmount} fixed` : `${percentage}% daily wage`} penalty.`; }
    if (rule.consecutiveLateThreshold > 0 && priorLateCount + 1 >= rule.consecutiveLateThreshold) { percentage *= rule.consecutivePenaltyMultiplier; reason += ` Monthly late arrival #${priorLateCount + 1}: ${rule.consecutivePenaltyMultiplier}x repeat penalty.`; }
  }
  percentage = Math.min(100, Math.max(0, percentage));
  if (!wage && isLate) reason += ' Salary/daily wage is not configured; no monetary deduction applied.';
  return { status, isLate, minutesLate, deductionAmount: Math.round(wage * percentage / 100), deductionPercentage: Math.round(percentage * 100) / 100, deductionReason: reason };
}
function calculateAttendance(date, user, rule, priorLateCount = 0) {
  const day = shiftDate(date, rule);
  return calculateDeduction((new Date(date) - atCompanyTime(day, rule.shiftStartTime)) / 60000, dailyWage(user), rule, priorLateCount);
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function validateSelfie(photo) {
  if (typeof photo !== 'string') fail('Capture a selfie before checking in.');
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
  if (!match || match[2].length % 4 !== 0 || match[2].length > 700000) fail('Selfie must be a JPEG or PNG image of at most 500 KB.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 500 * 1024 || bytes.toString('base64') !== match[2]) fail('Invalid selfie image.');
  let width = 0, height = 0;
  if (match[1] === 'png' && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  if (match[1] === 'jpeg' && bytes.length > 20 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; }
      offset += length + 2;
    }
  }
  if (width < 32 || height < 32 || width > 2048 || height > 2048) fail('Selfie image is invalid or its dimensions are unsupported.');
  return photo;
}
module.exports = { TIME_ZONE, DEFAULT_RULE, fail, companyDate, validDate, validMonth, addDays, shiftDate, scheduledEnd, atCompanyTime, normalizeRule, validateRule, dailyWage, calculateDeduction, calculateAttendance, distanceMeters, validateSelfie };
