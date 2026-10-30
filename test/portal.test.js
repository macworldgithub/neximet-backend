// Real HTTP/auth, MongoDB, and realtime signaling using isolated synthetic data.
// Does not load .env or connect to production services.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { createApp } = require('../src/app');
const { createRealtimeServer } = require('../src/services/realtime');
const User = require('../src/models/User');
const Project = require('../src/models/Project');
const Task = require('../src/models/Task');
const Invoice = require('../src/models/Invoice');
const Conversation = require('../src/models/Conversation');
const Notification = require('../src/models/Notification');
const { invoiceValues } = require('../src/services/invoiceValues');
process.env.JWT_SECRET = 'isolated-client-portal-test-secret';
let directory, mongo, realtime, base, ceo, admin, employee, alice, bob, projectA, projectB, privateTask, chat, invoice, submitted;
const sockets = [];
const id = value => String(value._id || value);
async function request(user, endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user._id }, process.env.JWT_SECRET)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const binary = response.headers.get('content-type')?.includes('application/pdf');
  return { status: response.status, body: binary ? Buffer.from(await response.arrayBuffer()) : await response.json(), headers: response.headers };
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'neximet-portal-test-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  mongo = spawn(process.env.MONGOD_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe' : 'mongod'), ['--dbpath', directory, '--port', String(port), '--bind_ip', '127.0.0.1', '--logpath', path.join(directory, 'mongo.log')], { windowsHide: true, stdio: 'ignore' });
  let failure; mongo.on('error', error => { failure = error; });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (failure) throw failure;
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/portal_tests`, { serverSelectionTimeoutMS: 300 }); break; } catch (error) { if (attempt === 39) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  await Promise.all([User.init(), Invoice.init(), Conversation.init(), Notification.init()]);
  [ceo, admin, employee, alice, bob] = await User.create([
    ['CEO', 'CEO'], ['Admin', 'Super Admin'], ['Private employee', 'Team Member'], ['Alice', 'Client'], ['Bob', 'Client'],
  ].map(([name, role]) => ({ name, role, email: `${name.replaceAll(' ', '').toLowerCase()}@portal.test`, password: 'test-only-password', department: role === 'Client' ? 'Executive' : 'Software Development', company: role === 'Client' ? `${name} Company` : '', baseSalary: 123456 })));
  [projectA, projectB] = await Project.create([alice, bob].map((owner, index) => ({ title: `${owner.name} project`, code: `NX-TEST-${index}`, clientName: owner.name, client: owner._id, department: 'Software Development', deadline: '2026-12-31', completionPercentage: 40, milestones: [{ title: 'Client milestone', description: 'private-milestone-notes', deadline: '2026-12-01' }], credentials: [{ platform: 'Internal vault', passwordOrKey: 'secret-vault-password' }], assignedMembers: [{ user: employee._id }] })));
  privateTask = await Task.create({ project: projectA._id, title: 'Confidential implementation', assignedTo: employee._id, comments: [{ user: employee._id, text: 'private-comment' }] });
  await Task.create({ project: projectA._id, title: 'Public milestone', status: 'done', clientVisible: true, assignedTo: employee._id, comments: [{ user: employee._id, text: 'private-comment' }] });
  const app = createApp({ connect: async () => mongoose }); realtime = createRealtimeServer(app); await new Promise(resolve => realtime.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${realtime.server.address().port}/api`;
});
after(async () => {
  sockets.forEach(socket => socket.disconnect());
  if (realtime) { await realtime.closeCalls(); await new Promise(resolve => realtime.io.close(resolve)); }
  await mongoose.disconnect();
  if (mongo && mongo.exitCode === null) { const stopped = new Promise(resolve => mongo.once('exit', resolve)); mongo.kill(); await stopped; }
  const target = directory && path.resolve(directory);
  if (target && path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('neximet-portal-test-')) await rm(target, { recursive: true, force: true });
});
test('only executives can provision clients; login and inactive-account checks apply', async () => {
  assert.equal((await request(null, '/portal/clients')).status, 401);
  for (const user of [employee, alice]) assert.equal((await request(user, '/portal/clients', {})).status, 403);
  const created = await request(admin, '/portal/clients', { name: 'New client', email: 'new@portal.test', password: 'new-client-password', role: 'CEO', company: 'New Co' });
  assert.equal(created.status, 201); assert.ok(!JSON.stringify(created.body).includes('password'));
  const saved = await User.findById(created.body.client._id); assert.equal(saved.role, 'Client');
  const login = await request(null, '/auth/login', { email: ' NEW@portal.test ', password: 'new-client-password' }); assert.equal(login.status, 200); assert.equal(login.body.user.role, 'Client');
  assert.equal((await request(admin, `/portal/clients/${saved._id}`, { isActive: false }, 'PATCH')).status, 200);
  assert.equal((await request(saved, '/portal/projects')).status, 401);
  assert.equal((await request(null, '/auth/login', { email: 'new@portal.test', password: 'new-client-password' })).status, 401);
  assert.equal((await request(ceo, '/portal/clients', { name: 'Duplicate', email: 'new@portal.test', password: 'new-client-password' })).status, 409);
});
test('staff APIs and project files are blocked for clients even with known IDs', async () => {
  for (const endpoint of ['/auth/users', '/dashboard/stats', '/attendance/today', '/leaves', '/deductions', '/projects', `/projects/${projectA._id}`, `/tasks/project/${projectA._id}`, `/tasks/timelogs/project/${projectA._id}`, '/mail/status', '/ai/connections', '/announcements']) {
    const response = await request(alice, endpoint); assert.equal(response.status, 403, endpoint);
  }
  assert.equal((await request(alice, `/tasks/${privateTask._id}`, { assignedTo: alice._id }, 'PUT')).status, 403);
  const file = await fetch(`${base.replace('/api', '')}/uploads/scopes/private.pdf`, { headers: { Authorization: `Bearer ${jwt.sign({ id: alice._id }, process.env.JWT_SECRET)}` } }); assert.equal(file.status, 403); await file.body.cancel();
});
test('client project/task projections hide internal people, vault, comments, and private tasks', async () => {
  const projects = await request(alice, '/portal/projects'); assert.equal(projects.status, 200); assert.equal(projects.body.projects.length, 1);
  const own = projects.body.projects[0]; assert.equal(own._id, id(projectA)); assert.equal(own.totalTasks, 1); assert.equal(own.doneTasks, 1); assert.equal(own.taskProgress, 100);
  const tasks = await request(alice, `/portal/projects/${projectA._id}/tasks`); assert.equal(tasks.body.tasks.length, 1);
  for (const result of [projects.body, tasks.body]) for (const value of ['assignedTo', 'assignedMembers', 'reporter', 'private-comment', 'Confidential implementation', 'secret-vault-password', 'Private employee', 'private-milestone-notes', id(employee)]) assert.ok(!JSON.stringify(result).includes(value), value);
  for (const method of ['GET', 'POST']) assert.equal((await request(alice, `/portal/projects/${projectB._id}/tasks`, method === 'POST' ? { title: 'Forbidden' } : undefined, method)).status, 404);
  assert.equal((await request(alice, `/portal/projects/${projectA._id}/client`, { clientId: bob._id }, 'PATCH')).status, 403);
});
test('client tasks enter the actual employee board; executives assign and employees update delivery privately', async () => {
  const result = await request(alice, `/portal/projects/${projectA._id}/tasks`, { title: 'Build landing page', description: 'Mobile first', priority: 'High', assignedTo: alice._id, status: 'done', clientVisible: false, comments: [{ text: 'injected' }] });
  assert.equal(result.status, 201); submitted = result.body.task; assert.equal(submitted.status, 'todo'); assert.equal(submitted.clientVisible, true); assert.equal(submitted.assignedTo, undefined);
  const saved = await Task.findById(submitted._id); assert.equal(saved.assignedTo, undefined); assert.equal(saved.comments.length, 0); assert.equal(saved.clientRequested, true);
  assert.ok(await Notification.exists({ user: admin._id, key: `client-task:${saved._id}` }));
  assert.equal((await request(alice, `/portal/tasks/${saved._id}`, { assignedTo: employee._id }, 'PATCH')).status, 403);
  assert.equal((await request(admin, `/portal/tasks/${saved._id}`, { assignedTo: bob._id }, 'PATCH')).status, 400);
  assert.equal((await request(admin, `/portal/tasks/${saved._id}`, { assignedTo: employee._id }, 'PATCH')).status, 200);
  const internal = await request(employee, `/tasks/project/${projectA._id}`); assert.ok(internal.body.tasks.some(task => task._id === submitted._id && task.assignedTo._id === id(employee)));
  assert.equal((await request(employee, `/tasks/${saved._id}/status`, { status: 'done' }, 'PATCH')).status, 200);
  const visible = await request(alice, `/portal/projects/${projectA._id}/tasks`); const task = visible.body.tasks.find(item => item._id === submitted._id); assert.equal(task.status, 'done'); assert.equal(task.assignedTo, undefined);
  assert.equal((await request(alice, '/portal/projects')).body.projects[0].doneTasks, 2);
  assert.equal(await Notification.countDocuments({ user: alice._id, kind: 'task' }), 0);
});
test('clients contact executives and only executives may add people to an existing chat', async () => {
  const people = await request(alice, '/chat/people'); assert.deepEqual(new Set(people.body.people.map(person => person.role)), new Set(['CEO', 'Super Admin']));
  assert.equal((await request(alice, '/chat/conversations', { kind: 'direct', participantIds: [id(employee)] })).status, 403);
  assert.equal((await request(employee, '/chat/conversations', { kind: 'direct', participantIds: [id(alice)] })).status, 403);
  const created = await request(alice, '/chat/conversations', { kind: 'direct', participantIds: [id(admin)] }); assert.equal(created.status, 201); chat = created.body.conversation;
  assert.equal((await request(alice, `/chat/conversations/${chat._id}/members`, { participantIds: [id(employee)] })).status, 403);
  assert.equal((await request(ceo, `/chat/conversations/${chat._id}/members`, { participantIds: [id(employee)] })).status, 404);
  const added = await request(admin, `/chat/conversations/${chat._id}/members`, { participantIds: [id(employee)] }); assert.equal(added.status, 200); assert.equal(added.body.conversation.kind, 'group'); assert.equal(added.body.conversation.members.length, 3);
  const repeats = await Promise.all([1, 2].map(() => request(admin, `/chat/conversations/${chat._id}/members`, { participantIds: [id(employee)] }))); assert.ok(repeats.every(result => result.status === 200));
  assert.equal((await Conversation.findById(chat._id)).members.length, 3);
  const sent = await request(employee, `/chat/conversations/${chat._id}/messages`, { text: 'Hello client', clientId: 'portal-test-employee-message' }); assert.equal(sent.status, 201);
  assert.equal((await request(alice, `/chat/conversations/${chat._id}/messages`)).body.messages[0].text, 'Hello client');
  assert.equal((await request(bob, `/chat/conversations/${chat._id}/messages`)).status, 404);
});
test('client meeting invitations reuse existing rooms, scheduling, and voice/video/screen-share signaling', async () => {
  assert.equal((await request(alice, '/meetings/rooms', { participantIds: [id(employee)] })).status, 403);
  const room = await request(alice, '/meetings/rooms', { participantIds: [id(admin)], title: 'Client delivery review' }); assert.equal(room.status, 201);
  const scheduled = await request(alice, '/meetings', { participantIds: [id(ceo)], title: 'Project review', mode: 'video', timezone: 'Asia/Karachi', startsAt: new Date(Date.now() + 3600000).toISOString(), endsAt: new Date(Date.now() + 7200000).toISOString() }); assert.equal(scheduled.status, 201);
  assert.equal((await request(bob, `/meetings/rooms/${room.body.room._id}`)).status, 404);
  async function connect(user) { const socket = io(base.replace('/api', ''), { path: '/api/socket.io', transports: ['websocket'], auth: { token: jwt.sign({ id: user._id }, process.env.JWT_SECRET) }, reconnection: false }); sockets.push(socket); await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); }); return socket; }
  const [client, executive] = await Promise.all([connect(alice), connect(admin)]);
  const command = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);
  const conversationId = room.body.room._id;
  const joined = await command(client, 'call:join', { conversationId, mode: 'video', microphone: true, camera: true }); assert.equal(joined.success, true);
  const accepted = await command(executive, 'call:join', { conversationId, mode: 'video', microphone: true, camera: true, callId: joined.call.id }); assert.equal(accepted.success, true); assert.equal(accepted.call.participants.length, 2);
  const payload = { conversationId, callId: joined.call.id };
  assert.equal((await command(client, 'call:state', { ...payload, sharing: true })).success, true);
  assert.equal((await command(client, 'call:signal', { ...payload, to: executive.id, signal: { description: { type: 'offer', sdp: 'v=0' } } })).success, true);
  assert.equal((await command(client, 'call:invite', { ...payload, participantIds: [id(employee)] })).success, false);
  assert.equal((await command(client, 'call:end', payload)).success, true);
  client.disconnect(); executive.disconnect();
});
test('invoice totals are server controlled, validated, tenant isolated, and branded PDFs download', async () => {
  const body = { clientId: id(alice), projectId: id(projectA), currency: 'USD', issuedAt: '2026-10-29', dueAt: '2026-11-15', items: [{ description: 'Website design and implementation', quantity: 2, rate: 500, amount: 1 }], taxRate: 5, total: 1, status: 'paid', issuer: { name: 'Neximet', email: 'billing@example.test', phone: '+92 000 0000000', address: 'Example office address (sample data)' }, reference: 'PO-2026-104', paymentTerms: 'Payment due within 17 days of issue.', paymentDetails: 'Bank: Example Bank\nReference: invoice number', notes: 'Thank you for working with Neximet.' };
  assert.equal((await request(alice, '/portal/invoices', body)).status, 403);
  assert.equal((await request(admin, '/portal/invoices', { ...body, projectId: id(projectB) })).status, 400);
  for (const value of [-1, 'NaN', null, true]) assert.equal((await request(admin, '/portal/invoices', { ...body, items: [{ description: 'Invalid', quantity: value, rate: 50 }] })).status, 400);
  const created = await request(admin, '/portal/invoices', body); assert.equal(created.status, 201); invoice = created.body.invoice; assert.equal(invoice.total, 1050); assert.equal(invoice.items[0].amount, 1000); assert.equal(invoice.status, 'issued');
  assert.equal(invoice.reference, body.reference); assert.equal(invoice.issuer.email, body.issuer.email); assert.equal(invoice.projectTitle, projectA.title); assert.equal(invoice.paymentTerms, body.paymentTerms);
  assert.equal((await request(alice, '/portal/invoices')).body.invoices.length, 1); assert.equal((await request(bob, '/portal/invoices')).body.invoices.length, 0);
  assert.equal((await request(bob, `/portal/invoices/${invoice._id}/pdf`)).status, 404);
  assert.equal((await request(alice, `/portal/invoices/${invoice._id}`, { status: 'paid' }, 'PATCH')).status, 403);
  const pdf = await request(admin, `/portal/invoices/${invoice._id}/pdf`); assert.equal(pdf.status, 200); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF'); assert.match(pdf.headers.get('content-disposition'), /attachment/); assert.ok(pdf.body.includes(Buffer.from('/Subtype /Image'))); assert.equal((pdf.body.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'A standard invoice fits one page without blank footer pages');
  assert.equal((await request(alice, `/portal/invoices/${invoice._id}/pdf`)).status, 200);
  await mkdir(path.resolve('../tmp/pdfs'), { recursive: true }); await writeFile(path.resolve('../tmp/pdfs/portal-invoice-sample.pdf'), pdf.body);
  const long = { ...invoice, items: Array.from({ length: 50 }, (_, i) => ({ description: `Service ${i + 1}: ` + 'Detailed deliverable description. '.repeat(8), quantity: 1, rate: 20, amount: 20 })), paymentDetails: 'Payment instructions. '.repeat(80), notes: 'Terms and notes. '.repeat(80) };
  await writeFile(path.resolve('../tmp/pdfs/portal-invoice-multipage.pdf'), await require('../src/services/invoicePdf').invoicePdf(long));
  assert.equal((await request(ceo, `/portal/invoices/${invoice._id}`, { status: 'paid' }, 'PATCH')).body.invoice.status, 'paid');
  assert.ok(await Notification.exists({ user: alice._id, kind: 'finance' }));
});
test('invoice validation rejects impossible dates and handles decimal rounding', () => {
  const body = { items: [{ description: 'Fractional item', quantity: 3, rate: 0.1 }], taxRate: 5, currency: 'USD', issuedAt: '2026-10-29', dueAt: '2026-11-30' };
  assert.equal(invoiceValues(body).subtotal, 0.3); assert.equal(invoiceValues(body).total, 0.32);
  for (const patch of [{ issuedAt: '2026-02-30' }, { dueAt: '2026-01-01' }, { taxRate: 101 }, { currency: '<USD>' }, { items: [] }, { issuer: [] }, { issuer: { email: 'invalid' } }, { reference: 'x'.repeat(121) }, { paymentTerms: {} }]) assert.throws(() => invoiceValues({ ...body, ...patch }));
});
test('clients create owned projects and tasks; executives exclusively choose staff assignments', async () => {
  const body = { title: 'Client-owned launch', description: 'Build the new product site.', department: 'Software Development', deadline: '2026-12-01', priority: 'High', clientId: id(bob), client: id(bob), assignedMembers: [{ user: id(employee) }], projectManager: id(employee), budget: 99999, completionPercentage: 100, status: 'completed', code: 'INJECTED' };
  assert.equal((await request(null, '/portal/projects', body)).status, 401);
  assert.equal((await request(employee, '/portal/projects', body)).status, 403);
  assert.equal((await request(alice, '/portal/projects', { ...body, deadline: '2026-02-30' })).status, 400);
  const created = await request(alice, '/portal/projects', body); assert.equal(created.status, 201);
  const item = await Project.findById(created.body.project._id); assert.equal(id(item.client), id(alice)); assert.equal(item.projectManager, null); assert.equal(item.assignedMembers.length, 0); assert.equal(item.budget, 0); assert.equal(item.status, 'planning'); assert.equal(item.clientRequested, true); assert.notEqual(item.code, 'INJECTED');
  assert.equal(created.body.project.assignedMembers, undefined); assert.equal(created.body.project.requestedBy, undefined);
  assert.ok(await Notification.exists({ user: admin._id, key: `client-project:${item._id}` }));
  assert.equal((await request(bob, `/portal/projects/${item._id}/tasks`)).status, 404);
  const team = { memberIds: [id(employee)], managerId: id(admin) };
  assert.equal((await request(alice, `/portal/projects/${item._id}/team`, team, 'PATCH')).status, 403);
  assert.equal((await request(admin, `/portal/projects/${item._id}/team`, { ...team, memberIds: [id(bob)] }, 'PATCH')).status, 400);
  assert.equal((await request(admin, `/portal/projects/${item._id}/team`, team, 'PATCH')).status, 200);
  const assigned = await Project.findById(item._id); assert.equal(id(assigned.projectManager), id(admin)); assert.equal(id(assigned.assignedMembers[0].user), id(employee));
  const publicView = (await request(alice, '/portal/projects')).body.projects.find(project => project._id === id(item)); assert.equal(publicView.assignedMembers, undefined); assert.equal(publicView.projectManager, undefined);
  const task = await request(alice, `/portal/projects/${item._id}/tasks`, { title: 'Prepare launch assets', assignedTo: id(employee) }); assert.equal(task.status, 201);
  assert.equal((await request(employee, `/tasks/${task.body.task._id}`, { assignedTo: id(ceo) }, 'PUT')).status, 403);
  assert.equal((await request(employee, '/tasks', { project: id(item), title: 'Self-assigned', assignedTo: id(employee) })).status, 403);
  assert.equal((await request(admin, `/portal/tasks/${task.body.task._id}`, { assignedTo: id(employee) }, 'PATCH')).status, 200);
  assert.equal((await request(employee, `/tasks/${task.body.task._id}`, { assignedTo: id(employee), project: id(item), description: 'Delivery update' }, 'PUT')).status, 200);
  assert.equal((await request(employee, `/tasks/${task.body.task._id}`, { $set: { assignedTo: id(ceo) } }, 'PUT')).status, 400);
  assert.equal((await request(employee, `/tasks/${task.body.task._id}/status`, { status: 'in_progress' }, 'PATCH')).status, 200);
  await User.updateOne({ _id: employee._id }, { role: 'Project Manager' });
  assert.equal((await request(employee, `/projects/${item._id}`, { assignedMembers: [] }, 'PUT')).status, 403);
  assert.equal((await request(employee, `/projects/${item._id}/resources`, { assignedMembers: [] }, 'PUT')).status, 403);
  assert.equal((await request(employee, `/projects/${item._id}`, { description: 'Updated delivery brief' }, 'PUT')).status, 200);
});
