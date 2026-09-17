const express = require('express');
const router = express.Router();
const {
  getProjects,
  getProjectById,
  createProject,
  updateProject,
  deleteProject,
  uploadScopeDocument,
  deleteScopeDocument,
  addCredential,
  deleteCredential,
  updateResources,
  updateMilestones,
} = require('../controllers/projectController');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const upload = require('../middleware/upload');

router.use(protect);

router.route('/')
  .get(getProjects)
  .post(authorize('CEO', 'Project Manager'), createProject);

router.route('/:id')
  .get(getProjectById)
  .put(authorize('CEO', 'Project Manager'), updateProject)
  .delete(authorize('CEO'), deleteProject);

router.post('/:id/scope', authorize('CEO', 'Project Manager'), upload.single('scopeFile'), uploadScopeDocument);
router.delete('/:id/scope/:scopeId', authorize('CEO', 'Project Manager'), deleteScopeDocument);
router.post('/:id/credentials', authorize('CEO', 'Project Manager'), addCredential);
router.delete('/:id/credentials/:credId', authorize('CEO', 'Project Manager'), deleteCredential);
router.put('/:id/resources', authorize('CEO', 'Project Manager', 'Team Manager'), updateResources);
router.put('/:id/milestones', authorize('CEO', 'Project Manager'), updateMilestones);

module.exports = router;
