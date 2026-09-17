const express = require('express');
const router = express.Router();
const {
  getTasksByProject,
  createTask,
  updateTask,
  updateTaskStatus,
  addSubtask,
  toggleSubtask,
  deleteSubtask,
  addComment,
  deleteTask,
  logTime,
  getTimeLogsByProject,
} = require('../controllers/taskController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);

// Task collection & project tasks
router.get('/project/:projectId', getTasksByProject);
router.post('/', createTask);
router.put('/:id', updateTask);
router.delete('/:id', authorize('CEO', 'Project Manager', 'Team Manager'), deleteTask);

// Jira fast status transitions (Kanban drag / click)
router.patch('/:id/status', updateTaskStatus);

// Subtasks checklist endpoints
router.post('/:id/subtasks', addSubtask);
router.patch('/:id/subtasks/:subtaskId', toggleSubtask);
router.delete('/:id/subtasks/:subtaskId', deleteSubtask);

// Comments stream
router.post('/:id/comments', addComment);

// Time logs
router.post('/timelogs', logTime);
router.get('/timelogs/project/:projectId', getTimeLogsByProject);

module.exports = router;
