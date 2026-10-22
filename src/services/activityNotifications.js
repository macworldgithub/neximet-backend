const { randomUUID } = require('node:crypto');
const Project = require('../models/Project');
const User = require('../models/User');
const notifications = require('./notifications');
const { idOf } = notifications;
async function run(work) { try { await work(); } catch (error) { console.error('Activity notification failed:', error.message); } }
const projectPeople = project => [project.projectManager, ...(project.assignedMembers || []).map(member => member.user)];
async function project(project, actor, action = 'updated') {
  return run(async () => notifications.notify({ key: `project:${idOf(project)}:${randomUUID()}`, users: projectPeople(project), actor,
    kind: 'project', title: action === 'created' ? 'You have been assigned to a project' : action === 'deleted' ? 'A project was deleted' : action === 'scope' ? 'Project scope documents changed' : 'Your project was updated',
    body: 'Open Projects & Scopes to review the latest details.', url: action === 'deleted' ? '/projects' : `/projects/${idOf(project)}` }));
}
async function task(task, actor, action = 'updated', previousAssignee) {
  return run(async () => {
    const project = await Project.findById(task.project).select('projectManager assignedMembers department');
    if (!project) return;
    const candidates = [task.assignedTo, task.reporter, project.projectManager, previousAssignee, ...(task.comments || []).map(comment => comment.user)];
    // Match the project's existing read policy before notifying watchers.
    const ids = candidates.map(idOf).filter(id => /^[a-f\d]{24}$/i.test(id));
    const members = projectPeople(project).map(idOf);
    const people = await User.find({ _id: { $in: ids }, isActive: true, $or: [
      { role: { $in: ['CEO', 'Super Admin'] } }, { department: project.department }, { department: 'Executive' }, { _id: { $in: members.filter(id => /^[a-f\d]{24}$/i.test(id)) } },
    ] }).distinct('_id');
    await notifications.notify({ key: `task:${idOf(task)}:${randomUUID()}`, users: people, actor, kind: 'task',
      title: { created: 'A task was assigned', updated: 'A task you follow was updated', status: 'Task status changed', comment: 'New task comment', progress: 'Task checklist changed', deleted: 'A task was deleted' }[action],
      body: 'Open the project task board to review the latest activity.', url: `/projects/${idOf(project)}` });
  });
}
async function vault(project, credential, actor) {
  return run(async () => {
    const people = await User.find({ _id: { $in: projectPeople(project).map(idOf).filter(id => /^[a-f\d]{24}$/i.test(id)) }, isActive: true,
      ...(credential?.visibleToRoles?.length ? { role: { $in: credential.visibleToRoles } } : {}) }).distinct('_id');
    await notifications.notify({ key: `vault:${idOf(project)}:${randomUUID()}`, users: people, actor, kind: 'project', title: 'Project vault updated',
      body: 'A credential available to your role changed. Open the project vault to review it.', url: `/projects/${idOf(project)}` });
  });
}
async function executiveEvent({ key, actor, title, body, url }) {
  return run(async () => notifications.notify({ key, users: await notifications.executives(), actor, kind: 'approval', title, body, url }));
}
async function broadcast({ key, actor, title, body, url }) {
  return run(async () => notifications.notify({ key, users: await notifications.everyone(), actor, kind: 'company', title, body, url }));
}
module.exports = { project, task, vault, executiveEvent, broadcast };
