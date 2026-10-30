const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const logoPath = require.resolve('../../assets/neximet-logo.avif');
let logo;
async function invoicePdf(invoice) {
  logo ||= sharp(logoPath).flatten({ background: '#ffffff' }).png().toBuffer().catch(error => { logo = null; throw error; });
  const image = await logo;
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: invoice.number, Author: invoice.issuer?.name || 'Neximet', Subject: 'Client invoice' } });
  const chunks = [], result = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const issuer = invoice.issuer || { name: 'Neximet' }, edge = 547, width = 499, bottom = 746;
  const money = value => `${invoice.currency} ${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = value => new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  function write(value, x, y, w, { size = 10, color = '#334155', bold = false, align = 'left', spacing = 0 } = {}) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(String(value ?? ''), x, y, { width: w, align, lineGap: 3, characterSpacing: spacing });
    return doc.y;
  }
  const height = (value, w, size = 10) => doc.font('Helvetica').fontSize(size).heightOfString(String(value || ' '), { width: w, lineGap: 3 });
  const caption = (value, x, y, w) => write(value, x, y, w, { size: 8, color: '#64748b', bold: true, spacing: 1 });
  const rule = y => doc.moveTo(48, y).lineTo(edge, y).strokeColor('#e2e8f0').lineWidth(0.6).stroke();
  function continuation() {
    doc.rect(0, 0, 596, 4).fill('#5470f4'); doc.image(image, 48, 30, { fit: [115, 34] });
    write(`INVOICE  /  ${invoice.number}`, 255, 40, 292, { size: 9, align: 'right', color: '#64748b' }); rule(80); doc.y = 100;
  }
  function room(required) { if (doc.y + required > bottom) { doc.addPage(); continuation(); } }
  doc.rect(0, 0, 596, 5).fill('#5470f4');
  doc.image(image, 48, 43, { fit: [146, 45] });
  write('INVOICE', 330, 45, 217, { size: 28, color: '#0f172a', align: 'right', spacing: 2 });
  write(invoice.number, 300, 86, 247, { size: 10, color: '#4662cc', align: 'right' });
  write(invoice.status === 'issued' ? 'PAYMENT PENDING' : invoice.status.toUpperCase(), 330, 108, 217, { size: 8, color: invoice.status === 'paid' ? '#047857' : '#64748b', bold: true, align: 'right', spacing: 1 });
  let y = 111;
  y = write(issuer.name || 'Neximet', 48, y, 242, { size: 10, bold: true }) + 6;
  for (const value of [issuer.address, issuer.email, issuer.phone, issuer.taxId && `Tax / registration ID: ${issuer.taxId}`].filter(Boolean)) y = write(value, 48, y, 242, { size: 8.5, color: '#64748b' }) + 3;
  y = Math.max(y, 135) + 18; rule(y); y += 22;
  caption('BILL TO', 48, y, 245);
  let left = write(invoice.billTo.company || invoice.billTo.name, 48, y + 22, 245, { size: 12, bold: true }) + 6;
  for (const value of [invoice.billTo.company && invoice.billTo.company !== invoice.billTo.name ? invoice.billTo.name : '', invoice.billTo.email, invoice.billTo.address].filter(Boolean)) left = write(value, 48, left, 245, { size: 9, color: '#64748b' }) + 4;
  let right = y;
  for (const [key, value] of [['Invoice date', date(invoice.issuedAt)], ['Payment due', date(invoice.dueAt)], ['Currency', invoice.currency], ...(invoice.reference ? [['Reference / PO', invoice.reference]] : [])]) {
    write(key, 335, right, 88, { size: 9, color: '#64748b' });
    right = Math.max(write(value, 430, right, 117, { size: 9, bold: true, align: 'right' }), right + 13) + 10;
  }
  doc.y = Math.max(left, right) + 22;
  if (invoice.projectTitle) { room(55); const start = doc.y; doc.rect(48, start, width, height(invoice.projectTitle, 420, 9) + 20).fill('#f8fafc'); write('Project', 60, start + 10, 45, { size: 9, color: '#64748b' }); const end = write(invoice.projectTitle, 110, start + 10, 420, { size: 9, bold: true }); doc.y = end + 22; }
  function tableHeader() {
    const start = doc.y; doc.rect(48, start, width, 30).fill('#172238');
    for (const [value, x, w, align] of [['#', 58, 20, 'left'], ['Description', 84, 216, 'left'], ['Qty', 307, 43, 'right'], ['Unit price', 358, 80, 'right'], ['Amount', 446, 91, 'right']]) write(value, x, start + 10, w, { size: 8.5, bold: true, color: '#ffffff', align });
    doc.y = start + 30;
  }
  room(90); tableHeader();
  invoice.items.forEach((item, index) => {
    const rowHeight = Math.max(45, height(item.description, 216, 9) + 20);
    if (doc.y + rowHeight > bottom) { doc.addPage(); continuation(); tableHeader(); }
    const start = doc.y;
    if (index % 2 === 1) doc.rect(48, start, width, rowHeight).fill('#f8fafc');
    write(String(index + 1).padStart(2, '0'), 58, start + 12, 20, { size: 8, color: '#94a3b8' });
    write(item.description, 84, start + 12, 216, { size: 9 });
    write(item.quantity, 307, start + 12, 43, { size: 9, align: 'right' });
    write(Number(item.rate).toFixed(2), 358, start + 12, 80, { size: 9, align: 'right' });
    write(Number(item.amount).toFixed(2), 446, start + 12, 91, { size: 9, align: 'right', bold: true });
    rule(start + rowHeight); doc.y = start + rowHeight;
  });
  doc.y += 22; room(155); y = doc.y;
  write('Subtotal', 310, y, 95, { size: 9, color: '#64748b' }); write(money(invoice.subtotal), 410, y, 137, { size: 9, align: 'right' });
  write(`Tax (${invoice.taxRate}%)`, 310, y + 24, 95, { size: 9, color: '#64748b' }); write(money(invoice.tax), 410, y + 24, 137, { size: 9, align: 'right' });
  doc.moveTo(310, y + 47).lineTo(edge, y + 47).strokeColor('#e2e8f0').stroke();
  write('Invoice total', 310, y + 60, 95, { size: 9, bold: true }); write(money(invoice.total), 410, y + 60, 137, { size: 9, align: 'right', bold: true });
  doc.rect(300, y + 86, 247, 64).fill('#eef2ff'); caption(invoice.status === 'void' ? 'VOIDED INVOICE' : 'AMOUNT DUE', 314, y + 99, 215);
  write(money(invoice.status === 'issued' ? invoice.total : 0), 314, y + 119, 219, { size: 17, bold: true, color: '#293e91', align: 'right' });
  const payment = [['PAYMENT INSTRUCTIONS', invoice.paymentDetails], ['PAYMENT TERMS', invoice.paymentTerms]].filter(([, content]) => content);
  const paymentHeight = payment.reduce((sum, [, content]) => sum + height(content, 220, 9) + 32, 0);
  const compactPayment = paymentHeight <= 150;
  if (compactPayment) {
    let paymentY = y;
    for (const [title, content] of payment) {
      caption(title, 48, paymentY, 220);
      paymentY = write(content, 48, paymentY + 23, 220, { size: 9, color: '#64748b' }) + 16;
    }
  }
  doc.y = y + 166;
  for (const [title, content] of [...(compactPayment ? [] : payment), ['NOTES', invoice.notes]]) {
    if (!content) continue;
    const lines = String(content).split('\n');
    room(35 + height(lines[0], width, 9)); caption(title, 48, doc.y, width); doc.y += 13;
    for (const line of lines) { room(height(line, width, 9) + 8); const start = doc.y; write(line || ' ', 48, start, width, { size: 9, color: '#64748b' }); doc.y += 5; }
    doc.y += 17;
  }
  room(32); rule(doc.y); write(`Thank you for choosing ${issuer.name || 'Neximet'}.`, 48, doc.y + 12, width, { size: 9, color: '#64748b' });
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) { doc.switchToPage(i); doc.page.margins.bottom = 24; rule(777); write(`${invoice.number}  |  Please use this reference with your payment.`, 48, 790, 420, { size: 7, color: '#94a3b8' }); write(`${i + 1} / ${pages.count}`, 487, 790, 60, { size: 7, color: '#94a3b8', align: 'right' }); }
  doc.end(); return result;
}
module.exports = { invoicePdf };
