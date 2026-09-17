const Project = require('../models/Project');
const path = require('path');
const fs = require('fs');

// @desc    Get all projects with filters
// @route   GET /api/projects
exports.getProjects = async (req, res) => {
  try {
    const { department, status, search } = req.query;
    const filter = {};

    if (department && department !== 'All') {
      filter.department = department;
    }
    if (status && status !== 'All') {
      filter.status = status;
    }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { clientName: { $regex: search, $options: 'i' } },
      ];
    }

    // If Team Member, let them see projects in their department or projects they're assigned to
    if (req.user && req.user.role === 'Team Member') {
      // Allow viewing all projects for company visibility, or highlight assignment
    }

    const projects = await Project.find(filter)
      .select('-scopeDocument.fileData')
      .populate('projectManager', 'name email')
      .populate('assignedMembers.user', 'name email department designation')
      .sort({ updatedAt: -1 });

    res.json({ success: true, count: projects.length, projects });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single project by ID
// @route   GET /api/projects/:id
exports.getProjectById = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .select('-scopeDocument.fileData')
      .populate('projectManager', 'name email role phone')
      .populate('assignedMembers.user', 'name email department designation baseSalary dailyWage');

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // Role-based filtering of sensitive credentials
    const projectObj = project.toObject();
    const userRole = req.user ? req.user.role : 'Team Member';

    if (projectObj.credentials && projectObj.credentials.length > 0) {
      projectObj.credentials = projectObj.credentials.filter((cred) => {
        if (!cred.visibleToRoles || cred.visibleToRoles.length === 0) return true;
        return cred.visibleToRoles.includes(userRole);
      });
    }

    res.json({ success: true, project: projectObj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new project
// @route   POST /api/projects
exports.createProject = async (req, res) => {
  try {
    const newProject = new Project({
      ...req.body,
      projectManager: req.body.projectManager || req.user.id,
    });

    const savedProject = await newProject.save();
    res.status(201).json({ success: true, project: savedProject });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update project
// @route   PUT /api/projects/:id
exports.updateProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    })
      .populate('projectManager', 'name email')
      .populate('assignedMembers.user', 'name email department designation');

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    res.json({ success: true, project });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete project (CEO only)
// @route   DELETE /api/projects/:id
exports.deleteProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }
    res.json({ success: true, message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Upload project scope document
// @route   POST /api/projects/:id/scope
exports.uploadScopeDocument = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'Please upload a document file' });
    }

    const ext = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${Date.now()}-${baseName}${ext}`;

    project.scopeDocument = {
      fileName: filename,
      originalName: req.file.originalname,
      fileUrl: `/uploads/scopes/${filename}`,
      fileType: req.file.mimetype || 'application/pdf',
      fileSize: req.file.size,
      fileData: req.file.buffer.toString('base64'), // Persistent in MongoDB Atlas across all Vercel instances
      uploadedAt: new Date(),
      summary: req.body.summary || `Scope document uploaded on ${new Date().toLocaleDateString()}`,
    };

    await project.save();

    // Return response without huge fileData payload
    const scopeDocResponse = { ...project.scopeDocument.toObject() };
    delete scopeDocResponse.fileData;

    res.json({
      success: true,
      message: 'Scope document uploaded successfully',
      scopeDocument: scopeDocResponse,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Add credential to project vault
// @route   POST /api/projects/:id/credentials
exports.addCredential = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const { platform, environment, usernameOrEmail, passwordOrKey, endpointUrl, notes, visibleToRoles } = req.body;

    project.credentials.push({
      platform,
      environment: environment || 'Production',
      usernameOrEmail: usernameOrEmail || '',
      passwordOrKey,
      endpointUrl: endpointUrl || '',
      notes: notes || '',
      visibleToRoles: visibleToRoles || ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
    });

    await project.save();
    res.json({ success: true, credentials: project.credentials });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete credential from vault
// @route   DELETE /api/projects/:id/credentials/:credId
exports.deleteCredential = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    project.credentials = project.credentials.filter(
      (c) => c._id.toString() !== req.params.credId
    );

    await project.save();
    res.json({ success: true, message: 'Credential removed', credentials: project.credentials });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update resource allocation
// @route   PUT /api/projects/:id/resources
exports.updateResources = async (req, res) => {
  try {
    const { assignedMembers } = req.body;
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    project.assignedMembers = assignedMembers;
    await project.save();

    const updated = await Project.findById(req.params.id)
      .populate('assignedMembers.user', 'name email department designation');

    res.json({ success: true, assignedMembers: updated.assignedMembers });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Update milestones
// @route   PUT /api/projects/:id/milestones
exports.updateMilestones = async (req, res) => {
  try {
    const { milestones } = req.body;
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    project.milestones = milestones;
    // Auto-calculate completion percentage from milestones if any
    if (milestones && milestones.length > 0) {
      const completedCount = milestones.filter((m) => m.status === 'completed').length;
      project.completionPercentage = Math.round((completedCount / milestones.length) * 100);
    }

    await project.save();
    res.json({
      success: true,
      milestones: project.milestones,
      completionPercentage: project.completionPercentage,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
