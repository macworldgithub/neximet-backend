const path = require('node:path');
const fs = require('node:fs');

function canReadProject(user, project) {
  return ['CEO', 'Super Admin'].includes(user.role) || project.department === user.department ||
    project.assignedMembers?.some(member => String(member.user?._id || member.user) === String(user._id || user.id)) ||
    String(project.projectManager?._id || project.projectManager) === String(user._id || user.id);
}

function createScopeHandler({ Project = require('../models/Project'), uploadRoot = path.resolve(__dirname, '../../uploads/scopes') } = {}) {
  return async (req, res, next) => {
    try {
      const filename = req.params.filename;
      if (!/^[a-z\d][a-z\d_.-]{0,220}$/i.test(filename) || filename.includes('..')) return res.status(400).json({ success: false, message: 'Invalid document name.' });
      const project = await Project.findOne({ $or: [{ 'scopeDocuments.fileName': filename }, { 'scopeDocument.fileName': filename }] });
      if (!project || !canReadProject(req.user, project)) return res.status(404).json({ success: false, message: 'Document not found.' });
      const document = project.scopeDocuments?.find(item => item.fileName === filename) || project.scopeDocument;
      const localPath = path.join(uploadRoot, filename);
      if (!document.fileData && !fs.existsSync(localPath)) return res.status(404).json({ success: false, message: 'Document is no longer available. Re-upload it from the project page.' });
      const type = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' }[path.extname(filename).toLowerCase()];
      res.set({ 'Content-Type': type || 'application/octet-stream', 'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename="${encodeURIComponent(document.originalName || filename)}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
      if (document.fileData) return res.send(Buffer.from(document.fileData, 'base64'));
      return res.sendFile(localPath);
    } catch (error) { next(error); }
  };
}
module.exports = { canReadProject, createScopeHandler };
