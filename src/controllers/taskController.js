const Task = require('../models/Task');
const TimeLog = require('../models/TimeLog');
const Project = require('../models/Project');

// Helper to auto-generate issue key like NX-AI-101
async function generateIssueKey(projectId) {
  try {
    const project = await Project.findById(projectId);
    if (!project) return 'ISSUE-101';

    // Base prefix from project code, e.g. "NX-AI-01" -> "NX-AI" or use full code
    let prefix = project.code || 'NX';
    
    // Find all tasks with this project to find highest number
    const count = await Task.countDocuments({ project: projectId });
    const nextNumber = 101 + count;
    return `${prefix}-${nextNumber}`;
  } catch (e) {
    return `ISSUE-${Date.now().toString().slice(-4)}`;
  }
}

// @desc    Get tasks for a project with optional filters
// @route   GET /api/tasks/project/:projectId
exports.getTasksByProject = async (req, res) => {
  try {
    const { issueType, status, priority, assignedTo, search } = req.query;
    const query = { project: req.params.projectId };

    if (issueType && issueType !== 'all') {
      query.issueType = issueType;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    if (priority && priority !== 'all') {
      query.priority = priority;
    }

    if (assignedTo && assignedTo !== 'all') {
      query.assignedTo = assignedTo;
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { issueKey: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { labels: { $regex: search, $options: 'i' } },
      ];
    }

    const tasks = await Task.find(query)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation')
      .sort({ order: 1, createdAt: 1 });

    res.json({ success: true, count: tasks.length, tasks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new Jira task/issue
// @route   POST /api/tasks
exports.createTask = async (req, res) => {
  try {
    const taskData = { ...req.body };

    // Auto-generate issueKey if not provided
    if (!taskData.issueKey && taskData.project) {
      taskData.issueKey = await generateIssueKey(taskData.project);
    }

    // Default reporter to current user
    if (!taskData.reporter && req.user) {
      taskData.reporter = req.user.id;
    }

    const task = new Task(taskData);
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    res.status(201).json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update task details
// @route   PUT /api/tasks/:id
exports.updateTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    res.json({ success: true, task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Quick status transition (Kanban move)
// @route   PATCH /api/tasks/:id/status
exports.updateTaskStatus = async (req, res) => {
  try {
    const { status, order } = req.body;
    const updateData = {};
    if (status) updateData.status = status === 'completed' ? 'done' : status;
    if (order !== undefined) updateData.order = order;

    const task = await Task.findByIdAndUpdate(req.params.id, updateData, { new: true })
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    res.json({ success: true, task });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Add subtask checklist item
// @route   POST /api/tasks/:id/subtasks
exports.addSubtask = async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Subtask title is required' });
    }

    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    task.subtasks.push({ title: title.trim(), completed: false });
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    res.json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Toggle subtask completion
// @route   PATCH /api/tasks/:id/subtasks/:subtaskId
exports.toggleSubtask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const subtask = task.subtasks.id(req.params.subtaskId);
    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found' });
    }

    subtask.completed = req.body.completed !== undefined ? req.body.completed : !subtask.completed;
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    res.json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete subtask
// @route   DELETE /api/tasks/:id/subtasks/:subtaskId
exports.deleteSubtask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    task.subtasks = task.subtasks.filter((s) => s._id.toString() !== req.params.subtaskId);
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    res.json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Add comment to issue discussion
// @route   POST /api/tasks/:id/comments
exports.addComment = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }

    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    task.comments.push({
      user: req.user.id,
      text: text.trim(),
      createdAt: new Date(),
    });
    await task.save();

    const populated = await Task.findById(task._id)
      .populate('assignedTo', 'name email department designation role')
      .populate('reporter', 'name email department designation role')
      .populate('comments.user', 'name email role department designation');

    res.json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete task
// @route   DELETE /api/tasks/:id
exports.deleteTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    res.json({ success: true, message: 'Task deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Log time for project/task
// @route   POST /api/tasks/timelogs
exports.logTime = async (req, res) => {
  try {
    const { project, task, hours, description, billable, date } = req.body;

    const timeLog = new TimeLog({
      project,
      task: task || null,
      user: req.user.id,
      hours: Number(hours),
      description,
      billable: billable !== undefined ? billable : true,
      date: date || new Date(),
    });

    await timeLog.save();

    // Increment spentHours on Project
    await Project.findByIdAndUpdate(project, { $inc: { spentHours: Number(hours) } });

    // Increment spentHours on Task if task is linked
    if (task) {
      await Task.findByIdAndUpdate(task, { $inc: { spentHours: Number(hours) } });
    }

    const populated = await TimeLog.findById(timeLog._id)
      .populate('user', 'name role')
      .populate('task', 'title issueKey');

    res.status(201).json({ success: true, timeLog: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get time logs for a project
// @route   GET /api/tasks/timelogs/project/:projectId
exports.getTimeLogsByProject = async (req, res) => {
  try {
    const timeLogs = await TimeLog.find({ project: req.params.projectId })
      .populate('user', 'name email designation role')
      .populate('task', 'title issueKey')
      .sort({ date: -1 });

    const totalHours = timeLogs.reduce((acc, log) => acc + log.hours, 0);
    const billableHours = timeLogs.filter((l) => l.billable).reduce((acc, log) => acc + log.hours, 0);

    res.json({
      success: true,
      count: timeLogs.length,
      totalHours,
      billableHours,
      timeLogs,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update time log
// @route   PUT /api/tasks/timelogs/:id
exports.updateTimeLog = async (req, res) => {
  try {
    const { id } = req.params;
    const { hours, description, billable, date } = req.body;

    const timeLog = await TimeLog.findById(id);
    if (!timeLog) {
      return res.status(404).json({ success: false, message: 'Time log not found' });
    }

    const isOwner = timeLog.user.toString() === req.user.id.toString();
    const isManager = ['CEO', 'Super Admin', 'Project Manager', 'Team Manager'].includes(req.user.role);
    if (!isOwner && !isManager) {
      return res.status(403).json({ success: false, message: 'Not authorized to edit this time log' });
    }

    const oldHours = timeLog.hours || 0;
    const newHours = hours !== undefined ? Number(hours) : oldHours;
    const diff = newHours - oldHours;

    timeLog.hours = newHours;
    if (description !== undefined) timeLog.description = description;
    if (billable !== undefined) timeLog.billable = billable;
    if (date !== undefined) timeLog.date = date;

    await timeLog.save();

    // Adjust spentHours on Project and Task
    if (diff !== 0 && timeLog.project) {
      await Project.findByIdAndUpdate(timeLog.project, { $inc: { spentHours: diff } });
    }
    if (diff !== 0 && timeLog.task) {
      await Task.findByIdAndUpdate(timeLog.task, { $inc: { spentHours: diff } });
    }

    const populated = await TimeLog.findById(timeLog._id)
      .populate('user', 'name email designation role')
      .populate('task', 'title issueKey');

    res.json({ success: true, timeLog: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete time log
// @route   DELETE /api/tasks/timelogs/:id
exports.deleteTimeLog = async (req, res) => {
  try {
    const { id } = req.params;
    const timeLog = await TimeLog.findById(id);
    if (!timeLog) {
      return res.status(404).json({ success: false, message: 'Time log not found' });
    }

    const isOwner = timeLog.user.toString() === req.user.id.toString();
    const isManager = ['CEO', 'Super Admin', 'Project Manager', 'Team Manager'].includes(req.user.role);
    if (!isOwner && !isManager) {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this time log' });
    }

    const hours = timeLog.hours || 0;
    const projectId = timeLog.project;
    const taskId = timeLog.task;

    await TimeLog.findByIdAndDelete(id);

    // Decrement spentHours
    if (hours > 0 && projectId) {
      await Project.findByIdAndUpdate(projectId, { $inc: { spentHours: -hours } });
    }
    if (hours > 0 && taskId) {
      await Task.findByIdAndUpdate(taskId, { $inc: { spentHours: -hours } });
    }

    res.json({ success: true, message: 'Time log deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
