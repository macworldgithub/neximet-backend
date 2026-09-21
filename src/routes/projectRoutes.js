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
  .post(authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), createProject);

router.route('/:id')
  .get(getProjectById)
  .put(authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), updateProject)
  .delete(authorize('CEO', 'Super Admin'), deleteProject);

router.post('/:id/scope', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), upload.single('scopeFile'), uploadScopeDocument);
router.delete('/:id/scope/:scopeId', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), deleteScopeDocument);
router.post('/:id/credentials', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), addCredential);
router.delete('/:id/credentials/:credId', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), deleteCredential);
router.put('/:id/resources', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), updateResources);
router.put('/:id/milestones', authorize('CEO', 'Super Admin', 'Project Manager', 'Team Manager'), updateMilestones);

module.exports = router;
