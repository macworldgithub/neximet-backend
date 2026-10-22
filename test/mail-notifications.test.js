const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMailNotifications } = require('../src/services/mailNotifications');

function harness({ previous, nextUid = 11, validity = '123', enabled = true, active = true, fails = false } = {}) {
  const account = { _id: 'mail-fixture', user: 'owner-fixture', email: 'owner@example.test', passwordEncrypted: 'encrypted-fixture', pushCheckpoint: previous };
  const events = [], updates = []; let stillConnected = true;
  const Account = { exists: async () => enabled && stillConnected, updateOne: async (filter, update) => { updates.push(update); if (update.$set.pushCheckpoint) account.pushCheckpoint = update.$set.pushCheckpoint; } };
  const service = { checkpoint: async credentials => { assert.equal(credentials.password, 'decrypted-fixture'); if (fails) throw Error('Private provider error'); return { nextUid, validity }; } };
  const worker = createMailNotifications({ Account, Users: { exists: async () => active }, service, notify: async event => { events.push(event); }, decrypt: () => 'decrypted-fixture' });
  return { account, events, updates, worker, disconnect: () => { stillConnected = false; } };
}
test('mail push establishes a baseline without notifying about old messages', async () => {
  const h = harness(); await h.worker.poll(h.account); assert.equal(h.events.length, 0); assert.equal(h.account.pushCheckpoint.nextUid, 11);
});
test('new mail creates a private, deterministic per-owner event without requiring any browser', async () => {
  const h = harness({ previous: { validity: '123', nextUid: 9 } }); await h.worker.poll(h.account); await h.worker.poll(h.account);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].key, 'mail:mail-fixture:123:11'); assert.deepEqual(h.events[0].users, ['owner-fixture']);
  assert.equal(h.events[0].url, '/mail'); assert.equal(JSON.stringify(h.events).includes('decrypted-fixture'), false);
});
test('mailbox reset, inactive owner, disabled notifications and disconnected mailboxes cannot alert', async () => {
  for (const options of [{ previous: { validity: 'old', nextUid: 1 } }, { previous: { validity: '123', nextUid: 9 }, active: false }, { previous: { validity: '123', nextUid: 9 }, enabled: false }]) {
    const h = harness(options); await h.worker.poll(h.account); assert.equal(h.events.length, 0);
  }
  const h = harness({ previous: { validity: '123', nextUid: 9 } }); h.disconnect(); await h.worker.poll(h.account); assert.equal(h.events.length, 0);
});
test('provider or enqueue failure retains the checkpoint for retry and defers the next poll', async () => {
  const h = harness({ previous: { validity: '123', nextUid: 9 }, fails: true }); await h.worker.poll(h.account);
  assert.equal(h.account.pushCheckpoint.nextUid, 9); assert.ok(h.updates[0].$set.notificationPollAt > new Date());
  const account = { _id: 'mail', user: 'owner', email: 'owner@example.test', passwordEncrypted: 'fixture', pushCheckpoint: { nextUid: 1, validity: '1' } };
  const updates = [];
  const worker = createMailNotifications({ Account: { exists: async () => true, updateOne: async (filter, update) => updates.push(update) }, Users: { exists: async () => true },
    service: { checkpoint: async () => ({ nextUid: 2, validity: '1' }) }, decrypt: () => 'fixture', notify: async () => { throw Error('Database unavailable'); } });
  await worker.poll(account); assert.equal(updates.some(update => update.$set.pushCheckpoint), false);
});
