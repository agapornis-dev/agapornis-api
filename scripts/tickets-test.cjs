const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { TicketsService } = require('../src/modules/tickets/tickets.service.ts');

const documents = {
  enabled: true,
  hydrateCollection: async (_namespace, fallback) => fallback,
  replaceCollection: async () => undefined
};
const events = [];
const activityLog = { log: event => events.push(event) };
const staffUsers = [
  { id: 'support-1', name: 'Support', email: 'support@example.com', role: 'support' },
  { id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'admin' }
];
const users = { list: () => staffUsers };
const notificationRecords = [];
const notifications = {
  create: item => notificationRecords.push(item),
  createForUsers: (userIds, item) => userIds.forEach(recipientUserId => notificationRecords.push({ ...item, recipientUserId }))
};
const settings = {
  enforceTicketSupport: () => undefined,
  ticketNotificationsEnabled: () => true,
  publicSettings: () => ({ branding: { publicUrl: 'https://panel.example.com' } })
};
const mailRecords = [];
const mail = { send: async (template, recipient, values) => { mailRecords.push({ template, recipient, values }); return true; } };

async function main() {
  users.findById = id => staffUsers.find(user => user.id === id);
  users.findByEmail = email => staffUsers.find(user => user.email === email);
  const tickets = new TicketsService(documents, activityLog, users, notifications, settings, mail);
  tickets.tickets.clear();

  const user = { id: 'user-1', name: 'User One', email: 'user@example.com', role: 'user' };
  const otherUser = { id: 'user-2', name: 'User Two', email: 'other@example.com', role: 'user' };
  const support = { id: 'support-1', name: 'Support', email: 'support@example.com', role: 'support' };

  const created = tickets.create({ subject: 'Server will not start', category: 'technical', priority: 'high', message: 'It exits after startup.' }, user);
  assert.match(created.id, /^TKT-[A-F0-9]{8}$/);
  assert.equal(created.status, 'waiting_on_staff');
  assert.equal(created.requesterEmail, undefined, 'requesters must not receive redundant identity fields');
  assert.equal(tickets.list(user).length, 1);
  assert.equal(tickets.list(otherUser).length, 0);
  assert.throws(() => tickets.find(created.id, otherUser), /ticket access denied/);

  const staffReply = tickets.reply(created.id, { message: 'Please attach the latest log.' }, support);
  assert.equal(staffReply.status, 'waiting_on_user');
  assert.equal(staffReply.messages.length, 2);
  assert.equal(staffReply.messages[0].authorUserId, undefined, 'staff must not receive requester IDs in message payloads');

  const noted = tickets.reply(created.id, { message: 'Likely an egg configuration issue.', internal: true }, support);
  assert.equal(noted.messages.at(-1).internal, true);
  assert.equal(tickets.find(created.id, user).messages.some(message => message.body.includes('egg configuration')), false, 'internal notes must never reach requester payloads');

  const assigned = tickets.update(created.id, { assignedUserId: 'admin-1' }, support);
  assert.equal(assigned.assignedUserId, 'admin-1');
  assert.equal(assigned.assignedUserName, 'Admin');

  const userReply = tickets.reply(created.id, { message: 'The log is attached in the server files.' }, user);
  assert.equal(userReply.status, 'waiting_on_staff');

  const resolved = tickets.update(created.id, { status: 'resolved', priority: 'normal' }, support);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.priority, 'normal');
  assert.throws(() => tickets.update(created.id, { status: 'closed' }, user), /support role required/);

  const closed = tickets.close(created.id, user);
  assert.equal(closed.status, 'closed');
  assert.throws(() => tickets.reply(created.id, { message: 'One more thing' }, user), /closed tickets cannot receive replies/);
  const reopened = tickets.reopen(created.id, user);
  assert.equal(reopened.status, 'waiting_on_staff');
  assert.ok(events.some(event => event.event === 'ticket.created'));
  assert.ok(events.some(event => event.event === 'ticket.replied'));
  assert.ok(notificationRecords.some(item => item.recipientUserId === 'support-1' && item.type === 'ticket_created'));
  assert.ok(notificationRecords.some(item => item.recipientUserId === 'user-1' && item.type === 'ticket_reply'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(mailRecords.some(item => item.template === 'ticketCreated' && item.recipient === user.email));
  assert.ok(mailRecords.some(item => item.template === 'ticketReply' && item.recipient === user.email));
  assert.ok(mailRecords.some(item => item.template === 'ticketStaffNotification' && item.recipient === 'admin@example.com'));

  console.log('ticket ownership and workflow tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
