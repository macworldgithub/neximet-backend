const router = require('express').Router();
const { randomBytes } = require('node:crypto');
const { protect } = require('../middleware/auth');
const { authorize } = require('../middleware/rbac');
const User = require('../models/User');
const Project = require('../models/Project');
const Task = require('../models/Task');
const Invoice = require('../models/Invoice');
const { executive } = require('../services/clientAccess');
const { invoiceValues } = require('../services/invoiceValues');
const notifications = require('../services/notifications');
const activity = require('../services/activityNotifications');
const fail = (status, message) => Object.assign(new Error(message), { status });
const validId = id => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const wrap = handler => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error.code === 11000 ? fail(409, 'An account with this email already exists.') : ['CastError', 'ValidationError'].includes(error.name) ? fail(400, error.message) : error); } };
const admin = authorize('CEO', 'Super Admin');
const clientFields = 'name email company billingAddress phone isActive createdAt';
const taskFields = '_id project title description status priority deadline createdAt clientVisible clientRequested';
const projectFields = 'title description code client clientName clientRequested status completionPercentage startDate deadline milestones._id milestones.title milestones.deadline milestones.status milestones.progress';
const departments = ['Software Development', 'Digital Marketing (SEO)', 'Graphics Designing', 'WordPress Team'];
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
};
router.use(protect, authorize('CEO', 'Super Admin', 'Client'), (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
async function client(id) {
  if (!validId(id)) throw fail(400, 'Choose a valid client.');
  const value = await User.findOne({ _id: id, role: 'Client' }).select(clientFields);
  if (!value) throw fail(404, 'Client not found.');
  return value;
}
async function project(req, id) {
  if (!validId(id)) throw fail(400, 'Choose a valid project.');
  const value = await Project.findOne({ _id: id, ...(!executive(req.user) ? { client: req.user._id } : {}) });
  if (!value) throw fail(404, 'Project not found.');
  return value;
}
router.get('/clients', admin, wrap(async (req, res) => res.json({ success: true, clients: await User.find({ role: 'Client' }).select(clientFields).sort({ name: 1 }) })));
router.post('/clients', admin, wrap(async (req, res) => {
  const { name, email, password, company = '', billingAddress = '', phone = '' } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 8 || password.length > 128) throw fail(400, 'Enter a name, valid email, and password of 8–128 characters.');
  if ([company, billingAddress, phone].some(value => typeof value !== 'string') || company.length > 160 || billingAddress.length > 1000 || phone.length > 80) throw fail(400, 'Client contact details are too long.');
  const user = await User.create({ name: name.trim(), email: email.trim().toLowerCase(), password, company, billingAddress, phone, role: 'Client', department: 'Executive', designation: 'Client', leaveBalances: { casual: 0, sick: 0, annual: 0 } });
  res.status(201).json({ success: true, client: await User.findById(user._id).select(clientFields) });
}));
router.patch('/clients/:id', admin, wrap(async (req, res) => {
  const user = await client(req.params.id);
  for (const [key, max] of [['name', 160], ['company', 160], ['billingAddress', 1000], ['phone', 80]]) if (req.body[key] !== undefined) {
    if (typeof req.body[key] !== 'string' || req.body[key].length > max || (key === 'name' && !req.body[key].trim())) throw fail(400, `Invalid ${key}.`);
    user[key] = req.body[key].trim();
  }
  if (req.body.isActive !== undefined) {
    if (typeof req.body.isActive !== 'boolean') throw fail(400, 'Choose an account status.');
    user.isActive = req.body.isActive;
  }
  await user.save(); res.json({ success: true, client: user });
}));
router.get('/projects', wrap(async (req, res) => {
  const filter = executive(req.user) ? {} : { client: req.user._id };
  const projects = await Project.find(filter).select(`${projectFields}${executive(req.user) ? ' projectManager assignedMembers' : ''}`).sort({ createdAt: -1 }).lean();
  const tasks = await Task.find({ project: { $in: projects.map(item => item._id) }, clientVisible: true }).select(taskFields).lean();
  res.json({ success: true, projects: projects.map(item => {
    const visible = tasks.filter(task => String(task.project) === String(item._id));
    const done = visible.filter(task => ['done', 'completed'].includes(task.status)).length;
    return { ...item, totalTasks: visible.length, doneTasks: done, taskProgress: visible.length ? Math.round(done / visible.length * 100) : 0 };
  }) });
}));
router.post('/projects', wrap(async (req, res) => {
  const { title, description = '', department, deadline, priority = 'Medium' } = req.body;
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof description !== 'string' || description.length > 10000 || !departments.includes(department) || !validDate(deadline) || !['Low', 'Medium', 'High', 'Critical'].includes(priority)) throw fail(400, 'Enter a project name, service, valid due date, description, and priority.');
  const owner = req.user.role === 'Client' ? req.user : await client(req.body.clientId);
  if (!owner.isActive) throw fail(400, 'Choose an active client.');
  // The owner and staff-only fields are always decided by the server.
  const created = await Project.create({ title: title.trim(), description: description.trim(), department, deadline, priority,
    code: `NX-CL-${randomBytes(5).toString('hex').toUpperCase()}`, client: owner._id, clientName: owner.company || owner.name,
    requestedBy: req.user._id, clientRequested: req.user.role === 'Client', status: 'planning', completionPercentage: 0,
    budget: 0, estimatedHours: 0, spentHours: 0, assignedMembers: [], projectManager: null });
  await activity.executiveEvent({ key: `client-project:${created._id}`, actor: req.user._id, title: 'New client project', body: 'A project is ready for team assignment.', url: '/clients' });
  res.status(201).json({ success: true, project: await Project.findById(created._id).select(projectFields) });
}));
router.patch('/projects/:id/team', admin, wrap(async (req, res) => {
  const item = await project(req, req.params.id);
  const { memberIds, managerId = '' } = req.body;
  if (!Array.isArray(memberIds) || memberIds.length > 50 || memberIds.some(id => !validId(id)) || (managerId && !validId(managerId))) throw fail(400, 'Choose a valid project lead and up to 50 team members.');
  const ids = [...new Set([...memberIds, ...(managerId ? [managerId] : [])].map(id => id.toLowerCase()))];
  if (await User.countDocuments({ _id: { $in: ids }, isActive: true, role: { $ne: 'Client' } }) !== ids.length) throw fail(400, 'Choose active Neximet staff only.');
  const existing = new Map(item.assignedMembers.map(member => [String(member.user), member.toObject()]));
  item.projectManager = managerId || null;
  item.assignedMembers = [...new Set(memberIds.map(id => id.toLowerCase()))].map(user => existing.get(user) || { user });
  await item.save(); await activity.project(item, req.user._id);
  res.json({ success: true });
}));
router.patch('/projects/:id/client', admin, wrap(async (req, res) => {
  const item = await project(req, req.params.id);
  const owner = req.body.clientId ? await client(req.body.clientId) : null;
  item.client = owner?._id || null;
  if (owner) item.clientName = owner.company || owner.name;
  await item.save(); res.json({ success: true });
}));
router.get('/projects/:id/tasks', wrap(async (req, res) => {
  const item = await project(req, req.params.id);
  const query = Task.find({ project: item._id, ...(!executive(req.user) ? { clientVisible: true } : {}) }).select(`${taskFields}${executive(req.user) ? ' assignedTo' : ''}`).sort({ createdAt: -1 });
  if (executive(req.user)) query.populate('assignedTo', 'name');
  res.json({ success: true, tasks: await query });
}));
router.post('/projects/:id/tasks', wrap(async (req, res) => {
  const item = await project(req, req.params.id);
  const { title, description = '', priority = 'Medium', deadline } = req.body;
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof description !== 'string' || description.length > 10000 || !['Lowest', 'Low', 'Medium', 'High', 'Urgent'].includes(priority)) throw fail(400, 'Enter a valid title, description, and priority.');
  if (deadline && (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(+new Date(deadline)))) throw fail(400, 'Enter a valid due date.');
  const task = await Task.create({ project: item._id, title: title.trim(), description, priority, deadline: deadline || undefined, reporter: req.user._id, status: 'todo', clientVisible: true, clientRequested: req.user.role === 'Client', issueKey: `${item.code}-${randomBytes(3).toString('hex').toUpperCase()}` });
  await activity.executiveEvent({ key: `client-task:${task._id}`, actor: req.user._id, title: 'New portal task', body: 'A task is ready for assignment.', url: '/clients' });
  res.status(201).json({ success: true, task: await Task.findById(task._id).select(taskFields) });
}));
router.patch('/tasks/:id', admin, wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, 'Invalid task.');
  const task = await Task.findById(req.params.id);
  if (!task) throw fail(404, 'Task not found.');
  const previous = task.assignedTo;
  if (req.body.assignedTo !== undefined) {
    const id = req.body.assignedTo;
    if (id && (!validId(id) || !await User.exists({ _id: id, role: { $ne: 'Client' }, isActive: true }))) throw fail(400, 'Choose an active employee.');
    task.assignedTo = id || null;
  }
  if (req.body.status !== undefined) {
    if (!['backlog', 'todo', 'in_progress', 'review', 'done'].includes(req.body.status)) throw fail(400, 'Choose a valid status.');
    task.status = req.body.status;
  }
  if (req.body.clientVisible !== undefined) {
    if (typeof req.body.clientVisible !== 'boolean') throw fail(400, 'Choose task visibility.');
    task.clientVisible = req.body.clientVisible;
  }
  await task.save(); await activity.task(task, req.user._id, 'updated', previous);
  res.json({ success: true });
}));
router.get('/invoices', wrap(async (req, res) => {
  const filter = executive(req.user) ? {} : { client: req.user._id };
  res.json({ success: true, invoices: await Invoice.find(filter).select('-createdBy -__v').sort({ createdAt: -1 }).lean() });
}));
router.post('/invoices', admin, wrap(async (req, res) => {
  const owner = await client(req.body.clientId), values = invoiceValues(req.body);
  if (!owner.isActive) throw fail(400, 'Choose an active client.');
  let linked = null;
  if (req.body.projectId) {
    linked = await project(req, req.body.projectId);
    if (String(linked.client) !== String(owner._id)) throw fail(400, 'The project must belong to this client.');
  }
  const invoice = await Invoice.create({ ...values, number: `NX-${values.issuedAt.getUTCFullYear()}-${randomBytes(5).toString('hex').toUpperCase()}`, client: owner._id, project: linked?._id, projectTitle: linked?.title || '', createdBy: req.user._id, billTo: { name: owner.name, email: owner.email, company: owner.company, address: owner.billingAddress } });
  await notifications.safely({ key: `invoice:${invoice._id}`, users: [owner._id], actor: req.user._id, kind: 'finance', title: 'New invoice from Neximet', body: `${invoice.number} is available in Finance.`, url: '/client/finance' });
  res.status(201).json({ success: true, invoice });
}));
router.patch('/invoices/:id', admin, wrap(async (req, res) => {
  if (!validId(req.params.id) || !['issued', 'paid', 'void'].includes(req.body.status)) throw fail(400, 'Choose a valid invoice and status.');
  const invoice = await Invoice.findByIdAndUpdate(req.params.id, { $set: { status: req.body.status } }, { new: true });
  if (!invoice) throw fail(404, 'Invoice not found.');
  res.json({ success: true, invoice });
}));
router.get('/invoices/:id/pdf', wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail(400, 'Invalid invoice.');
  const invoice = await Invoice.findOne({ _id: req.params.id, ...(!executive(req.user) ? { client: req.user._id } : {}) });
  if (!invoice) throw fail(404, 'Invoice not found.');
  const buffer = await require('../services/invoicePdf').invoicePdf(invoice);
  res.type('pdf').set('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`).send(buffer);
}));
module.exports = router;
