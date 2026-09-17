const mongoose = require('mongoose');

const projectCredentialSchema = new mongoose.Schema({
  platform: {
    type: String,
    required: true,
    trim: true,
  },
  environment: {
    type: String,
    enum: ['Production', 'Staging', 'Development', 'QA'],
    default: 'Production',
  },
  usernameOrEmail: {
    type: String,
    default: '',
  },
  passwordOrKey: {
    type: String,
    required: true,
  },
  endpointUrl: {
    type: String,
    default: '',
  },
  notes: {
    type: String,
    default: '',
  },
  visibleToRoles: {
    type: [String],
    default: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
  },
}, { timestamps: true });

const milestoneSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  deadline: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed'],
    default: 'pending',
  },
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0,
  },
});

const resourceAllocationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  roleInProject: {
    type: String,
    default: 'Contributor',
  },
  allocatedHoursPerWeek: {
    type: Number,
    default: 20,
  },
});

const scopeDocumentSchema = new mongoose.Schema({
  title: {
    type: String,
    default: '',
    trim: true,
  },
  fileName: {
    type: String,
    required: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  fileUrl: {
    type: String,
    required: true,
  },
  fileType: {
    type: String,
    default: 'application/pdf',
  },
  fileSize: {
    type: Number,
    default: 0,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  summary: {
    type: String,
    default: '',
  },
  fileData: {
    type: String,
    default: '',
  },
}, { timestamps: true });

const projectSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please enter project title'],
    trim: true,
  },
  code: {
    type: String,
    required: [true, 'Please enter project code'],
    unique: true,
    uppercase: true,
    trim: true,
  },
  clientName: {
    type: String,
    required: true,
    trim: true,
  },
  department: {
    type: String,
    enum: [
      'Software Development',
      'Digital Marketing (SEO)',
      'Graphics Designing',
      'WordPress Team',
    ],
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  status: {
    type: String,
    enum: ['planning', 'in_progress', 'review', 'completed', 'on_hold'],
    default: 'planning',
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Critical'],
    default: 'Medium',
  },
  // Multiple Scope Documents
  scopeDocuments: [scopeDocumentSchema],
  // Scope Document Information (Single/Latest reference)
  scopeDocument: {
    fileName: { type: String, default: '' },
    originalName: { type: String, default: '' },
    fileUrl: { type: String, default: '' },
    fileType: { type: String, default: 'application/pdf' },
    fileSize: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    summary: { type: String, default: '' },
    fileData: { type: String, default: '' }, // Base64 encoded document content for serverless persistence
  },
  // Credentials Vault
  credentials: [projectCredentialSchema],
  // Timeline & Progress
  startDate: {
    type: Date,
    default: Date.now,
  },
  deadline: {
    type: Date,
    required: true,
  },
  completionPercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 0,
  },
  milestones: [milestoneSchema],
  // Resource Allocation
  projectManager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  assignedMembers: [resourceAllocationSchema],
  // Time & Budget Management
  estimatedHours: {
    type: Number,
    default: 160,
  },
  spentHours: {
    type: Number,
    default: 0,
  },
  budget: {
    type: Number,
    default: 5000,
  },
}, { timestamps: true });

module.exports = mongoose.model('Project', projectSchema);
