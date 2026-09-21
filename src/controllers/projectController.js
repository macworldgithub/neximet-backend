const Project = require('../models/Project');
const path = require('path');
const fs = require('fs');

// @desc    Get all projects with filters
// @route   GET /api/projects
exports.getProjects = async (req, res) => {
  try {
    const { department, status, search } = req.query;
    const filter = {};

    const isExecutive = ['CEO', 'Super Admin'].includes(req.user?.role);

    // Non-CEO/Super Admin can only see projects belonging to their particular team's department
    if (!isExecutive) {
      if (req.user?.department && req.user.department !== 'Executive') {
        filter.department = req.user.department;
      }
    } else if (department && department !== 'All') {
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

    const projects = await Project.find(filter)
      .select('-scopeDocument.fileData -scopeDocuments.fileData')
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
      .select('-scopeDocument.fileData -scopeDocuments.fileData')
      .populate('projectManager', 'name email role phone')
      .populate('assignedMembers.user', 'name email department designation baseSalary dailyWage')
      .populate('scopeDocuments.uploadedBy', 'name email role');

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // Role-based department restriction for non-CEOs/Super Admins
    const isExecutive = ['CEO', 'Super Admin'].includes(req.user?.role);
    if (!isExecutive && req.user?.department && req.user.department !== 'Executive') {
      const isSameDept = project.department === req.user.department;
      const isAssigned = project.assignedMembers?.some(
        (m) => (m.user?._id || m.user)?.toString() === req.user.id.toString()
      );
      const isPM = (project.projectManager?._id || project.projectManager)?.toString() === req.user.id.toString();

      if (!isSameDept && !isAssigned && !isPM) {
        return res.status(403).json({
          success: false,
          message: 'Access denied: You can only access projects of your particular team.',
        });
      }
    }

    // Role-based filtering of sensitive credentials
    const projectObj = project.toObject();
    const userRole = req.user ? req.user.role : 'Team Member';

    // Auto-migrate/populate scopeDocuments if legacy scopeDocument exists but scopeDocuments array is empty
    if ((!projectObj.scopeDocuments || projectObj.scopeDocuments.length === 0) && projectObj.scopeDocument?.fileName) {
      projectObj.scopeDocuments = [{
        _id: projectObj._id + '_scope_0',
        title: projectObj.scopeDocument.originalName || projectObj.scopeDocument.fileName,
        fileName: projectObj.scopeDocument.fileName,
        originalName: projectObj.scopeDocument.originalName || projectObj.scopeDocument.fileName,
        fileUrl: projectObj.scopeDocument.fileUrl,
        fileType: projectObj.scopeDocument.fileType || 'application/pdf',
        fileSize: projectObj.scopeDocument.fileSize || 0,
        uploadedAt: projectObj.scopeDocument.uploadedAt || new Date(),
        summary: projectObj.scopeDocument.summary || '',
      }];
    }

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

// @desc    Upload project scope document (supports multiple documents)
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

    const newDoc = {
      title: req.body.title || req.file.originalname.replace(ext, '').replace(/[-_]/g, ' '),
      fileName: filename,
      originalName: req.file.originalname,
      fileUrl: `/uploads/scopes/${filename}`,
      fileType: req.file.mimetype || 'application/pdf',
      fileSize: req.file.size,
      fileData: req.file.buffer.toString('base64'), // Persistent in MongoDB Atlas across all Vercel instances
      uploadedAt: new Date(),
      uploadedBy: req.user ? req.user.id : null,
      summary: req.body.summary || `Scope document uploaded on ${new Date().toLocaleDateString()}`,
    };

    if (!project.scopeDocuments) {
      project.scopeDocuments = [];
    }
    project.scopeDocuments.push(newDoc);

    // Keep legacy single scopeDocument synchronized for backward compatibility
    project.scopeDocument = {
      fileName: newDoc.fileName,
      originalName: newDoc.originalName,
      fileUrl: newDoc.fileUrl,
      fileType: newDoc.fileType,
      fileSize: newDoc.fileSize,
      fileData: newDoc.fileData,
      uploadedAt: newDoc.uploadedAt,
      summary: newDoc.summary,
    };

    await project.save();

    // Return response without huge fileData payload
    const scopeDocsResponse = project.scopeDocuments.map((doc) => {
      const d = doc.toObject ? doc.toObject() : { ...doc };
      delete d.fileData;
      return d;
    });

    res.json({
      success: true,
      message: 'Scope document uploaded successfully',
      scopeDocuments: scopeDocsResponse,
      scopeDocument: scopeDocsResponse[scopeDocsResponse.length - 1],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete a scope document
// @route   DELETE /api/projects/:id/scope/:scopeId
exports.deleteScopeDocument = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    project.scopeDocuments = (project.scopeDocuments || []).filter(
      (doc) => doc._id.toString() !== req.params.scopeId
    );

    // If legacy scopeDocument matched this deleted doc, update or clear it
    if (project.scopeDocuments.length > 0) {
      const latest = project.scopeDocuments[project.scopeDocuments.length - 1];
      project.scopeDocument = {
        fileName: latest.fileName,
        originalName: latest.originalName,
        fileUrl: latest.fileUrl,
        fileType: latest.fileType,
        fileSize: latest.fileSize,
        fileData: latest.fileData,
        uploadedAt: latest.uploadedAt,
        summary: latest.summary,
      };
    } else {
      project.scopeDocument = {
        fileName: '',
        originalName: '',
        fileUrl: '',
        fileType: 'application/pdf',
        fileSize: 0,
        uploadedAt: new Date(),
        summary: '',
        fileData: '',
      };
    }

    await project.save();

    const scopeDocsResponse = project.scopeDocuments.map((doc) => {
      const d = doc.toObject ? doc.toObject() : { ...doc };
      delete d.fileData;
      return d;
    });

    res.json({
      success: true,
      message: 'Scope document removed successfully',
      scopeDocuments: scopeDocsResponse,
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

// @desc    Update credential in vault
// @route   PUT /api/projects/:id/credentials/:credId
exports.updateCredential = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const cred = project.credentials.id ? project.credentials.id(req.params.credId) : null;
    const targetCred = cred || project.credentials.find((c) => c._id.toString() === req.params.credId);

    if (!targetCred) {
      return res.status(404).json({ success: false, message: 'Credential not found' });
    }

    const { platform, environment, usernameOrEmail, passwordOrKey, endpointUrl, notes, visibleToRoles } = req.body;

    if (platform !== undefined) targetCred.platform = platform;
    if (environment !== undefined) targetCred.environment = environment;
    if (usernameOrEmail !== undefined) targetCred.usernameOrEmail = usernameOrEmail;
    if (passwordOrKey !== undefined) targetCred.passwordOrKey = passwordOrKey;
    if (endpointUrl !== undefined) targetCred.endpointUrl = endpointUrl;
    if (notes !== undefined) targetCred.notes = notes;
    if (visibleToRoles !== undefined) targetCred.visibleToRoles = visibleToRoles;

    await project.save();
    res.json({ success: true, credentials: project.credentials, credential: targetCred });
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
