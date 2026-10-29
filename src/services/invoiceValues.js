const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
function invoiceValues(body) {
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) fail('Add 1–50 invoice items.');
  const number = (value, min, max, label) => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) fail(`Invalid ${label}.`);
    return Number(value);
  };
  const items = body.items.map(item => {
    if (!item || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 300) fail('Each item needs a description of at most 300 characters.');
    const quantity = number(item.quantity, 0.01, 100000, 'quantity'), rate = number(item.rate, 0, 100000000, 'rate');
    return { description: item.description.trim(), quantity, rate, amount: round(quantity * rate) };
  });
  const taxRate = number(body.taxRate ?? 0, 0, 100, 'tax rate');
  const currency = body.currency;
  if (!['PKR', 'USD', 'GBP', 'EUR', 'AED', 'CAD', 'AUD'].includes(currency)) fail('Choose a supported currency.');
  const parse = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value ? new Date(value) : null;
  let issuedAt, dueAt;
  try { issuedAt = parse(body.issuedAt); dueAt = parse(body.dueAt); } catch { fail('Enter valid invoice dates.'); }
  if (!issuedAt || !dueAt || dueAt < issuedAt) fail('Due date must be on or after the issue date.');
  for (const key of ['notes', 'paymentDetails']) if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 2000)) fail(`${key} must be at most 2,000 characters.`);
  const subtotal = round(items.reduce((sum, item) => sum + item.amount, 0)), tax = round(subtotal * taxRate / 100);
  if (subtotal > 1000000000000) fail('Invoice total is too large.');
  return { items, currency, issuedAt, dueAt, taxRate, subtotal, tax, total: round(subtotal + tax), notes: body.notes || '', paymentDetails: body.paymentDetails || '' };
}
module.exports = { invoiceValues };
