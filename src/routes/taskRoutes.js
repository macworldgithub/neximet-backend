const express = require('express');
const router = express.Router();
const {
  getTasksByProject,
  createTask,
  updateTask,
  deleteTask,
  logTime,
  getTimeLogsByProject,
} = require('../controllers/taskController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');

router.use(protect);

router.get('/project/:projectId', getTasksByProject);
router.post('/', authorize('CEO', 'Project Manager', 'Team Manager'), createTask);
router.put('/:id', updateTask);
router.delete('/:id', authorize('CEO', 'Project Manager', 'Team Manager'), deleteTask);

router.post('/timelogs', logTime);
router.get('/timelogs/project/:projectId', getTimeLogsByProject);

module.exports = router;
