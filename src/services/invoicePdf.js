const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const logoPath = require.resolve('../../assets/neximet-logo.avif');
let logo;
async function invoicePdf(invoice) {
  // The logo is bundled with the backend so PDFs work on independent deployments.
  logo ||= sharp(logoPath).flatten({ background: '#111827' }).png().toBuffer().catch(error => { logo = null; throw error; });
  const image = await logo;
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: invoice.number, Author: 'Neximet' } });
  const chunks = [], result = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const money = amount => `${invoice.currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const text = (value, x, y, width, size = 10, color = '#111827') => doc.font('Helvetica').fontSize(size).fillColor(color).text(String(value || ''), x, y, { width, lineGap: 3 });
  function header() {
    doc.rect(0, 0, 596, 116).fill('#111827');
    doc.image(image, 48, 34, { fit: [145, 48] });
    text('INVOICE', 350, 32, 195, 24, '#ffffff');
    text(invoice.number, 350, 69, 195, 10, '#b9c6ff');
    doc.y = 140;
  }
  function room(height) { if (doc.y + height > 748) { doc.addPage(); header(); } }
  header();
  let y = doc.y;
  text('BILL TO', 48, y, 285, 10, '#64748b');
  text([invoice.billTo.company, invoice.billTo.name, invoice.billTo.email, invoice.billTo.address].filter(Boolean).join('\n'), 48, y + 20, 280, 11);
  const billBottom = doc.y;
  text(`Issued: ${new Date(invoice.issuedAt).toISOString().slice(0, 10)}\nDue: ${new Date(invoice.dueAt).toISOString().slice(0, 10)}\nStatus: ${invoice.status.toUpperCase()}`, 360, y + 20, 185, 11);
  doc.y = Math.max(billBottom, doc.y) + 30;
  function tableHeader() {
    y = doc.y; doc.rect(48, y, 499, 28).fill('#eef2ff');
    text('Description', 58, y + 8, 240, 10); text('Qty', 307, y + 8, 40); text('Rate', 352, y + 8, 84); text('Amount', 443, y + 8, 100); doc.y = y + 38;
  }
  tableHeader();
  for (const item of invoice.items) {
    doc.fontSize(10);
    const height = Math.max(36, doc.heightOfString(item.description, { width: 235, lineGap: 3 }) + 18);
    if (doc.y + height > 748) { doc.addPage(); header(); tableHeader(); }
    y = doc.y;
    text(item.description, 58, y, 235); text(item.quantity, 307, y, 40); text(Number(item.rate).toFixed(2), 352, y, 84); text(Number(item.amount).toFixed(2), 443, y, 100);
    doc.moveTo(48, y + height - 8).lineTo(547, y + height - 8).strokeColor('#e2e8f0').stroke(); doc.y = y + height;
  }
  room(115); y = doc.y + 12;
  text('Subtotal', 310, y, 100); text(money(invoice.subtotal), 415, y, 132);
  text(`Tax (${invoice.taxRate}%)`, 310, y + 25, 100); text(money(invoice.tax), 415, y + 25, 132);
  doc.rect(300, y + 50, 247, 38).fill('#eef2ff'); text('TOTAL', 310, y + 62, 75, 12); text(money(invoice.total), 390, y + 62, 155, 12); doc.y = y + 108;
  for (const [label, value] of [['PAYMENT DETAILS', invoice.paymentDetails], ['NOTES', invoice.notes]]) {
    if (!value) continue;
    doc.fontSize(10);
    const lines = String(value).split('\n');
    room(60); text(label, 48, doc.y, 499, 10, '#64748b'); doc.y += 10;
    for (const line of lines) {
      const height = doc.heightOfString(line || ' ', { width: 499, lineGap: 3 }); room(height + 8); text(line || ' ', 48, doc.y, 499); doc.y += 5;
    }
    doc.y += 16;
  }
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(i); text(`Neximet  |  ${invoice.number}  |  Page ${i + 1} of ${range.count}`, 48, 780, 499, 8, '#64748b'); }
  doc.end(); return result;
}
module.exports = { invoicePdf };
