const mongoose = require('mongoose');
const item = new mongoose.Schema({
  description: { type: String, required: true, maxlength: 300 },
  quantity: { type: Number, required: true, min: 0.01 },
  rate: { type: Number, required: true, min: 0 },
  amount: { type: Number, required: true, min: 0 },
}, { _id: false });
const schema = new mongoose.Schema({
  number: { type: String, required: true, unique: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  billTo: { name: String, email: String, company: String, address: String },
  issuer: { name: { type: String, default: 'Neximet' }, email: String, phone: String, address: String, taxId: String },
  reference: { type: String, maxlength: 120, default: '' },
  paymentTerms: { type: String, maxlength: 300, default: '' },
  projectTitle: { type: String, default: '' },
  currency: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  dueAt: { type: Date, required: true },
  items: { type: [item], required: true },
  subtotal: { type: Number, required: true },
  taxRate: { type: Number, required: true },
  tax: { type: Number, required: true },
  total: { type: Number, required: true },
  status: { type: String, enum: ['issued', 'paid', 'void'], default: 'issued' },
  notes: { type: String, maxlength: 2000, default: '' },
  paymentDetails: { type: String, maxlength: 2000, default: '' },
}, { timestamps: true });
module.exports = mongoose.model('Invoice', schema);
