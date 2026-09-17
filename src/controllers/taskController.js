const Task = require('../models/Task');
const TimeLog = require('../models/TimeLog');
const Project = require('../models/Project');

// @desc    Get tasks for a project
// @route   GET /api/tasks/project/:projectId
exports.getTasksByProject = async (req, res) => {
  try {
    const tasks = await Task.find({ project: req.params.projectId })
      .populate('assignedTo', 'name email designation')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: tasks.length, tasks });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new task
// @route   POST /api/tasks
exports.createTask = async (req, res) => {
  try {
    const task = new Task(req.body);
    await task.save();
    const populated = await Task.findById(task._id).populate('assignedTo', 'name email');
    res.status(201).json({ success: true, task: populated });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update task status or details
// @route   PUT /api/tasks/:id
exports.updateTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true })
      .populate('assignedTo', 'name email');

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    res.json({ success: true, task });
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
    res.json({ success: true, message: 'Task deleted' });
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
      .populate('task', 'title');

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
      .populate('user', 'name email designation')
      .populate('task', 'title')
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
