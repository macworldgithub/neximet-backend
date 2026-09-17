const mongoose = require('mongoose');

const subtaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  completed: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const commentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: {
    type: String,
    required: true,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const taskSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
  },
  issueKey: {
    type: String,
    trim: true,
    index: true,
  },
  issueType: {
    type: String,
    enum: ['story', 'task', 'bug', 'epic'],
    default: 'task',
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  status: {
    type: String,
    enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'completed'],
    default: 'todo',
  },
  priority: {
    type: String,
    enum: ['Lowest', 'Low', 'Medium', 'High', 'Urgent'],
    default: 'Medium',
  },
  storyPoints: {
    type: Number,
    default: 3,
    min: 0,
    max: 100,
  },
  labels: {
    type: [String],
    default: [],
  },
  subtasks: [subtaskSchema],
  comments: [commentSchema],
  order: {
    type: Number,
    default: 0,
  },
  estimatedHours: {
    type: Number,
    default: 8,
  },
  spentHours: {
    type: Number,
    default: 0,
  },
  startDate: {
    type: Date,
    default: Date.now,
  },
  deadline: {
    type: Date,
  },
}, { timestamps: true });

// Normalize status 'completed' -> 'done' on save
taskSchema.pre('save', function (next) {
  if (this.status === 'completed') {
    this.status = 'done';
  }
  next();
});

module.exports = mongoose.model('Task', taskSchema);
