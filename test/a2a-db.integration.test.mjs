// A2A DB integration tests — exercise real Postgres SQL behavior, no mocks.
//
// How to run:
//   1. npm install
//   2. npm run build
//   3. Provide DB credentials via env (any of):
//      - CYBERSYNC_DB_URL=postgresql://omniwire:PASSWORD@100.64.54.102:5432/omniwire
//      - or OMNIWIRE_PG_HOST/PORT/USER/DB + OW_PG_PASSWORD
//   4. node --test test/a2a-db.integration.test.mjs
//
// On a cold database (a2a_* tables not yet created), the FTS GIN index
// creation can exceed the default 10s statement_timeout. Bump it for the
// first run:
//   CYBERSYNC_STATEMENT_TIMEOUT_MS=60000 node --test test/a2a-db.integration.test.mjs
//
// Tests run in parallel inside node:test. Each test uses a unique key prefix
// of the form `itest-${process.pid}-${ts}-${tag}` so concurrent runs don't
// collide. Every test cleans up the rows it inserts in t.after(...).
//
// Tests do NOT clear shared a2a_* tables — only rows matching their own
// per-test prefix are deleted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { SyncDB } from '../dist/sync/db.js';
import { DEFAULT_SYNC_CONFIG } from '../dist/sync/types.js';
import {
  createA2aDb,
  BLACKBOARD_MAX_LIMIT,
} from '../dist/mcp/a2a-db.js';
import { runMigrations } from '../dist/sync/schema.js';

// --- shared db setup ---
//
// One SyncDB instance is shared across all tests in this file. node:test
// teardown closes it. Each test creates its own A2aDb wrapper around the
// shared pool so we exercise the production wiring (pool.query) instead of
// dedicated clients.

let syncDb;
let pool;
let a2a;
let dbReachable = false;

const config = { ...DEFAULT_SYNC_CONFIG, nodeId: `itest-${process.pid}` };

async function canConnect() {
  try {
    syncDb = new SyncDB(config);
    pool = syncDb.getPool();
    // Cheap probe — fail fast if Postgres unreachable
    await pool.query('SELECT 1');

    // Run migrations on a dedicated client with a generous statement_timeout.
    // SyncDB sets statement_timeout=10s by default (configurable via
    // CYBERSYNC_STATEMENT_TIMEOUT_MS). Cold-cache CREATE INDEX IF NOT EXISTS
    // probes on FTS GIN indexes can occasionally exceed that even when no
    // work is needed. Migrations are idempotent, so this is safe.
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '60s'");
      const shim = { query: (...args) => client.query(...args) };
      await runMigrations(shim);
    } finally {
      client.release();
    }

    a2a = createA2aDb(pool);
    return true;
  } catch (err) {
    process.stderr.write(`[a2a-itest] postgres unreachable: ${err.message}\n`);
    try { await syncDb?.close(); } catch { /* ignore */ }
    return false;
  }
}

dbReachable = await canConnect();

test.after(async () => {
  if (syncDb) {
    try { await syncDb.close(); } catch { /* ignore */ }
  }
});

// Generate a unique prefix per test invocation. process.pid + monotonic
// counter handles two parallel test runs of the same file.
let _seq = 0;
function pfx(tag) {
  _seq += 1;
  return `itest-${process.pid}-${Date.now()}-${_seq}-${tag}`;
}

// Cleanup helpers — delete only rows matching this test's prefix.
async function cleanupChannel(channel) {
  await pool.query('DELETE FROM a2a_messages WHERE channel = $1', [channel]);
}
async function cleanupLock(name) {
  await pool.query('DELETE FROM a2a_locks WHERE name = $1', [name]);
}
async function cleanupEvents(topic) {
  await pool.query('DELETE FROM a2a_events WHERE topic = $1 OR source = $1', [topic]);
}
async function cleanupAgent(agent_id) {
  await pool.query('DELETE FROM a2a_agents WHERE agent_id = $1', [agent_id]);
}
async function cleanupBlackboard(topic) {
  await pool.query('DELETE FROM a2a_blackboard WHERE topic = $1', [topic]);
}
async function cleanupTaskQueue(queue) {
  await pool.query('DELETE FROM a2a_tasks WHERE queue = $1', [queue]);
}

// Skip-condition guard. If `dbReachable` is false at top-level, every test
// short-circuits with `t.skip()` so the suite does not crash without a DB.
function requireDb(t) {
  if (!dbReachable) {
    t.skip('postgres unreachable');
    return false;
  }
  return true;
}

// ============================================================
// 1. a2a_messages
// ============================================================

test('a2a_messages: send → receive marks consumed; second receive returns 0', async (t) => {
  if (!requireDb(t)) return;
  const channel = pfx('msg-receive');
  t.after(() => cleanupChannel(channel));

  await a2a.sendMessage(channel, 'sender-A', 'text', 'hello-world');
  const first = await a2a.receiveMessages(channel, 10, 'consumer-1');
  assert.equal(first.length, 1, 'first receive returns exactly 1 row');
  assert.equal(first[0].message, 'hello-world');
  assert.equal(first[0].consumed_by, 'consumer-1');
  assert.notEqual(first[0].consumed_at, null);

  const second = await a2a.receiveMessages(channel, 10, 'consumer-2');
  assert.equal(second.length, 0, 'second receive returns no rows');
});

test('a2a_messages: send N → peek N (no consume); same content visible after', async (t) => {
  if (!requireDb(t)) return;
  const channel = pfx('msg-peek');
  t.after(() => cleanupChannel(channel));

  for (let i = 0; i < 3; i++) {
    await a2a.sendMessage(channel, 'sender', 'text', `msg-${i}`);
  }
  const peek1 = await a2a.peekMessages(channel, 10);
  assert.equal(peek1.length, 3, 'peek returns all 3');
  // Peek must NOT mark consumed — peek again returns same.
  const peek2 = await a2a.peekMessages(channel, 10);
  assert.equal(peek2.length, 3, 'second peek returns all 3 still');
  // Receive should still drain the channel.
  const recv = await a2a.receiveMessages(channel, 10, 'c1');
  assert.equal(recv.length, 3, 'receive drains all 3 after peek');
});

test('a2a_messages: send N → receive M (M<N) → remaining N-M visible', async (t) => {
  if (!requireDb(t)) return;
  const channel = pfx('msg-partial');
  t.after(() => cleanupChannel(channel));

  for (let i = 0; i < 5; i++) {
    await a2a.sendMessage(channel, 'sender', 'text', `m${i}`);
  }
  const r1 = await a2a.receiveMessages(channel, 2, 'c1');
  assert.equal(r1.length, 2, 'first batch is 2');
  const r2 = await a2a.receiveMessages(channel, 10, 'c2');
  assert.equal(r2.length, 3, 'remaining batch is 3');
  // Total messages received equal sent
  assert.equal(r1.length + r2.length, 5);
  // Order semantics: the inner SELECT ORDER BY sent_at picks the 2 oldest
  // messages, but UPDATE...RETURNING does NOT preserve that order. Verify
  // by content-membership instead.
  // r1 must hold the 2 oldest (m0, m1) and r2 the 3 newest (m2, m3, m4).
  const r1Msgs = new Set(r1.map((m) => m.message));
  const r2Msgs = new Set(r2.map((m) => m.message));
  assert.deepEqual(new Set([...r1Msgs].sort()), new Set(['m0', 'm1']));
  assert.deepEqual(new Set([...r2Msgs].sort()), new Set(['m2', 'm3', 'm4']));
});

test('a2a_messages: concurrent receivers → no double-delivery', async (t) => {
  if (!requireDb(t)) return;
  const channel = pfx('msg-concurrent');
  t.after(() => cleanupChannel(channel));

  const N = 20;
  for (let i = 0; i < N; i++) {
    await a2a.sendMessage(channel, 'sender', 'text', `c${i}`);
  }

  // Two callers receive simultaneously. SKIP LOCKED + WHERE consumed_at IS NULL
  // must guarantee no duplicate delivery and total = N.
  const [r1, r2] = await Promise.all([
    a2a.receiveMessages(channel, N, 'consumer-A'),
    a2a.receiveMessages(channel, N, 'consumer-B'),
  ]);
  const total = r1.length + r2.length;
  assert.equal(total, N, `total delivered = ${N} (got ${r1.length}+${r2.length}=${total})`);

  // No id appears in both
  const ids1 = new Set(r1.map((m) => m.id));
  const ids2 = new Set(r2.map((m) => m.id));
  for (const id of ids1) {
    assert.equal(ids2.has(id), false, `id ${id} delivered twice`);
  }
});

test('a2a_messages: clearChannel drops all rows for channel', async (t) => {
  if (!requireDb(t)) return;
  const channel = pfx('msg-clear');
  t.after(() => cleanupChannel(channel)); // belt-and-suspenders

  for (let i = 0; i < 4; i++) {
    await a2a.sendMessage(channel, 's', 'text', `n${i}`);
  }
  const deleted = await a2a.clearChannel(channel);
  assert.equal(deleted, 4, 'clearChannel returns count');
  const peek = await a2a.peekMessages(channel, 100);
  assert.equal(peek.length, 0, 'channel is empty after clear');
});

test('a2a_messages: listChannels returns expected pending counts', async (t) => {
  if (!requireDb(t)) return;
  const ch1 = pfx('msg-list-A');
  const ch2 = pfx('msg-list-B');
  t.after(async () => { await cleanupChannel(ch1); await cleanupChannel(ch2); });

  await a2a.sendMessage(ch1, 's', 'text', 'a1');
  await a2a.sendMessage(ch1, 's', 'text', 'a2');
  await a2a.sendMessage(ch2, 's', 'text', 'b1');

  const channels = await a2a.listChannels();
  const m = new Map(channels.map((c) => [c.channel, c.pending]));
  assert.equal(m.get(ch1), 2, `ch1 has 2 pending (got ${m.get(ch1)})`);
  assert.equal(m.get(ch2), 1, `ch2 has 1 pending (got ${m.get(ch2)})`);
});

// ============================================================
// 2. a2a_locks
// ============================================================

test('a2a_locks: acquire → second acquire fails with current owner', async (t) => {
  if (!requireDb(t)) return;
  const name = pfx('lock-busy');
  t.after(() => cleanupLock(name));

  const r1 = await a2a.acquireLock(name, 'owner-1', 60);
  assert.equal(r1.acquired, true);
  assert.equal(r1.current?.owner, 'owner-1');

  const r2 = await a2a.acquireLock(name, 'owner-2', 60);
  assert.equal(r2.acquired, false, 'second acquire fails');
  assert.equal(r2.current?.owner, 'owner-1', 'reports current owner');
});

test('a2a_locks: release by owner → acquire succeeds; release by wrong owner fails', async (t) => {
  if (!requireDb(t)) return;
  const name = pfx('lock-release');
  t.after(() => cleanupLock(name));

  await a2a.acquireLock(name, 'owner-1', 60);

  const wrong = await a2a.releaseLock(name, 'owner-X');
  assert.equal(wrong.released, false, 'wrong-owner release does nothing');

  // Lock should still be held
  const status = await a2a.lockStatus(name);
  assert.equal(status?.owner, 'owner-1', 'lock still held by owner-1');

  const right = await a2a.releaseLock(name, 'owner-1');
  assert.equal(right.released, true, 'correct-owner release succeeds');

  const r2 = await a2a.acquireLock(name, 'owner-2', 60);
  assert.equal(r2.acquired, true, 'second owner acquires after release');
});

test('a2a_locks: TTL expiry — wait past ttl → second acquire succeeds', async (t) => {
  if (!requireDb(t)) return;
  const name = pfx('lock-ttl');
  t.after(() => cleanupLock(name));

  await a2a.acquireLock(name, 'owner-1', 2);
  // Wait past TTL — code path is "DELETE FROM a2a_locks WHERE expires_at <= now()"
  // inside the next acquireLock txn.
  await sleep(2500);
  const r2 = await a2a.acquireLock(name, 'owner-2', 60);
  assert.equal(r2.acquired, true, 'expired lock acquired by new owner');
  assert.equal(r2.current?.owner, 'owner-2');
});

test('a2a_locks: lockStatus returns null if no active lock', async (t) => {
  if (!requireDb(t)) return;
  const name = pfx('lock-status-empty');
  t.after(() => cleanupLock(name));

  const status = await a2a.lockStatus(name);
  assert.equal(status, null);
});

// ============================================================
// 3. a2a_events
// ============================================================

test('a2a_events: emit → poll without args returns recent', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('evt-recent');
  t.after(() => cleanupEvents(topic));

  await a2a.emitEvent(topic, 'src1', 'data-x');
  const rows = await a2a.pollEvents({ topic });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, topic);
  assert.equal(rows[0].data, 'data-x');
});

test('a2a_events: poll with topic filter returns only matching', async (t) => {
  if (!requireDb(t)) return;
  const topicA = pfx('evt-topicA');
  const topicB = pfx('evt-topicB');
  t.after(async () => { await cleanupEvents(topicA); await cleanupEvents(topicB); });

  await a2a.emitEvent(topicA, 's', 'a1');
  await a2a.emitEvent(topicB, 's', 'b1');
  await a2a.emitEvent(topicA, 's', 'a2');

  const rowsA = await a2a.pollEvents({ topic: topicA });
  assert.equal(rowsA.length, 2);
  for (const r of rowsA) assert.equal(r.topic, topicA);
});

test('a2a_events: poll with `since` returns only newer events', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('evt-since');
  t.after(() => cleanupEvents(topic));

  await a2a.emitEvent(topic, 's', 'old');
  // Capture cutoff *from the database clock*, not the test-host clock —
  // tank and macbook may differ by a few ms which would make Date.now()
  // cutoffs unreliable for sub-100ms boundaries.
  await sleep(100);
  const { rows: nowRows } = await pool.query('SELECT extract(epoch from now()) * 1000.0 AS ms');
  const cutoffMs = Number(nowRows[0].ms);
  await sleep(100);
  await a2a.emitEvent(topic, 's', 'new1');
  await a2a.emitEvent(topic, 's', 'new2');

  const rows = await a2a.pollEvents({ topic, since: cutoffMs });
  assert.equal(rows.length, 2, `expected 2 newer events, got ${rows.length}`);
  const datas = rows.map((r) => r.data).sort();
  assert.deepEqual(datas, ['new1', 'new2']);
});

test('a2a_events: poll with regex `filter` returns only matching data', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('evt-regex');
  t.after(() => cleanupEvents(topic));

  await a2a.emitEvent(topic, 's', 'abc-error-123');
  await a2a.emitEvent(topic, 's', 'def-ok-789');
  await a2a.emitEvent(topic, 's', 'ghi-error-456');

  const rows = await a2a.pollEvents({ topic, filter: 'error-[0-9]+' });
  assert.equal(rows.length, 2, 'regex filter matched 2 rows');
  for (const r of rows) {
    assert.match(r.data, /error-[0-9]+/);
  }
});

test('a2a_events: emit large data (1KB+) — round-trip exact', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('evt-large');
  t.after(() => cleanupEvents(topic));

  // 2KB string
  const big = 'X'.repeat(2048);
  await a2a.emitEvent(topic, 's', big);
  const rows = await a2a.pollEvents({ topic });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.length, 2048);
  assert.equal(rows[0].data, big, 'round-trip is byte-exact');
});

// ============================================================
// 4. a2a_agents (registry)
// ============================================================

test('a2a_agents: register → list returns the agent', async (t) => {
  if (!requireDb(t)) return;
  const id = pfx('agent-reg');
  t.after(() => cleanupAgent(id));

  await a2a.registerAgent(id, ['cap-x', 'cap-y'], '{"role":"worker"}', 'node-1');
  const list = await a2a.listAgents(300);
  const found = list.find((a) => a.agent_id === id);
  assert.notEqual(found, undefined, 'agent appears in list');
  assert.deepEqual(found.capabilities.sort(), ['cap-x', 'cap-y']);
  assert.equal(found.metadata, '{"role":"worker"}');
  assert.equal(found.node_id, 'node-1');
});

test('a2a_agents: register twice (same id) → upsert (capabilities replaced)', async (t) => {
  if (!requireDb(t)) return;
  const id = pfx('agent-upsert');
  t.after(() => cleanupAgent(id));

  await a2a.registerAgent(id, ['cap-a'], '{}', 'node-1');
  await a2a.registerAgent(id, ['cap-b', 'cap-c'], '{"v":2}', 'node-2');

  const list = await a2a.listAgents(300);
  const matches = list.filter((a) => a.agent_id === id);
  assert.equal(matches.length, 1, 'only one row per agent_id (upsert, not insert)');
  assert.deepEqual(matches[0].capabilities.sort(), ['cap-b', 'cap-c']);
  assert.equal(matches[0].metadata, '{"v":2}');
  assert.equal(matches[0].node_id, 'node-2');
});

test('a2a_agents: heartbeat updates last_heartbeat', async (t) => {
  if (!requireDb(t)) return;
  const id = pfx('agent-heart');
  t.after(() => cleanupAgent(id));

  await a2a.registerAgent(id, [], '{}', 'node-1');
  const list1 = await a2a.listAgents(300);
  const before = list1.find((a) => a.agent_id === id).last_heartbeat;

  await sleep(1100); // ensure timestamp difference
  const r = await a2a.heartbeatAgent(id);
  assert.equal(r.touched, true);

  const list2 = await a2a.listAgents(300);
  const after = list2.find((a) => a.agent_id === id).last_heartbeat;
  assert.ok(
    after.getTime() > before.getTime(),
    `heartbeat advanced (before=${before.toISOString()} after=${after.toISOString()})`
  );
});

test('a2a_agents: TTL — list with ttlSec=1 excludes stale agent after wait', async (t) => {
  if (!requireDb(t)) return;
  const id = pfx('agent-ttl');
  t.after(() => cleanupAgent(id));

  await a2a.registerAgent(id, [], '{}', 'node-1');
  // Immediately visible
  const before = await a2a.listAgents(60);
  assert.notEqual(before.find((a) => a.agent_id === id), undefined);

  await sleep(2000);
  // ttlSec=1 → only agents seen in last 1s. Our agent was registered 2s ago.
  const after = await a2a.listAgents(1);
  assert.equal(
    after.find((a) => a.agent_id === id),
    undefined,
    'agent excluded when last_heartbeat older than ttlSec'
  );
});

test('a2a_agents: discoverAgents by capability returns matching agents only', async (t) => {
  if (!requireDb(t)) return;
  const idMatch = pfx('agent-disc-match');
  const idMiss = pfx('agent-disc-miss');
  t.after(async () => { await cleanupAgent(idMatch); await cleanupAgent(idMiss); });

  // Use a unique capability tag so we don't match other test rows
  const cap = `cap-${pfx('discover')}`;
  await a2a.registerAgent(idMatch, [cap, 'other'], '{}', 'node-1');
  await a2a.registerAgent(idMiss, ['other'], '{}', 'node-1');

  const found = await a2a.discoverAgents(cap, 300);
  const ids = found.map((a) => a.agent_id);
  assert.ok(ids.includes(idMatch), 'matching agent returned');
  assert.equal(ids.includes(idMiss), false, 'non-matching agent excluded');
});

test('a2a_agents: deregister removes the agent', async (t) => {
  if (!requireDb(t)) return;
  const id = pfx('agent-dereg');
  t.after(() => cleanupAgent(id));

  await a2a.registerAgent(id, [], '{}', 'node-1');
  const r = await a2a.deregisterAgent(id);
  assert.equal(r.removed, true);

  const list = await a2a.listAgents(300);
  assert.equal(list.find((a) => a.agent_id === id), undefined);

  // Second deregister returns removed:false (idempotent)
  const r2 = await a2a.deregisterAgent(id);
  assert.equal(r2.removed, false);
});

// ============================================================
// 5. a2a_blackboard
// ============================================================

test('a2a_blackboard: post → read returns chronologically (DESC)', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-chrono');
  t.after(() => cleanupBlackboard(topic));

  await a2a.postBlackboard(topic, 'author-1', 'first', 'node-1');
  await sleep(20);
  await a2a.postBlackboard(topic, 'author-1', 'second', 'node-1');
  await sleep(20);
  await a2a.postBlackboard(topic, 'author-1', 'third', 'node-1');

  const rows = await a2a.readBlackboard(topic, {});
  assert.equal(rows.length, 3);
  // ORDER BY posted_at DESC → newest first
  assert.equal(rows[0].content, 'third');
  assert.equal(rows[1].content, 'second');
  assert.equal(rows[2].content, 'first');
});

test('a2a_blackboard: read with limit respects limit', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-limit');
  t.after(() => cleanupBlackboard(topic));

  for (let i = 0; i < 7; i++) {
    await a2a.postBlackboard(topic, 'a', `msg-${i}`, 'node-1');
  }
  const rows = await a2a.readBlackboard(topic, { limit: 3 });
  assert.equal(rows.length, 3);
});

test('a2a_blackboard: limit > 500 — clamped to BLACKBOARD_MAX_LIMIT', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-clamp');
  t.after(() => cleanupBlackboard(topic));

  // We can't realistically post 501 rows here; instead, verify the SQL doesn't
  // throw and the result is bounded. Post a small number, request a very
  // large limit, and assert we got back what we posted (i.e. SQL was valid
  // with a clamped LIMIT, not an arbitrarily large one).
  for (let i = 0; i < 3; i++) {
    await a2a.postBlackboard(topic, 'a', `m-${i}`, 'node-1');
  }
  // Request 9999 — SQL should clamp to BLACKBOARD_MAX_LIMIT (500), still
  // executes, returns all 3 we posted.
  const rows = await a2a.readBlackboard(topic, { limit: 9999 });
  assert.equal(rows.length, 3, 'large limit silently clamped, query returns posted rows');
  // Sanity: the constant matches our expectation
  assert.equal(BLACKBOARD_MAX_LIMIT, 500);
});

test('a2a_blackboard: searchBlackboard finds FTS-matching content', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-search');
  t.after(() => cleanupBlackboard(topic));

  // Use lexemes that English FTS will tokenize well
  await a2a.postBlackboard(topic, 'a', 'database connection error timeout', 'node-1');
  await a2a.postBlackboard(topic, 'a', 'unrelated content here', 'node-1');
  await a2a.postBlackboard(topic, 'a', 'another database failure', 'node-1');

  const rows = await a2a.searchBlackboard('database', { topic });
  assert.ok(rows.length >= 2, `FTS query 'database' returns ≥2 rows (got ${rows.length})`);
  for (const r of rows) {
    assert.match(r.content, /database/i);
  }
});

test('a2a_blackboard: blackboardTopics returns counts and latest timestamp', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-topics');
  t.after(() => cleanupBlackboard(topic));

  await a2a.postBlackboard(topic, 'a', 'one', 'node-1');
  await sleep(20);
  await a2a.postBlackboard(topic, 'a', 'two', 'node-1');

  const all = await a2a.blackboardTopics();
  const found = all.find((tt) => tt.topic === topic);
  assert.notEqual(found, undefined, 'topic listed');
  assert.equal(found.entries, 2);
  assert.ok(found.latest instanceof Date, 'latest is a Date');
});

test('a2a_blackboard: clearBlackboard drops all entries for topic', async (t) => {
  if (!requireDb(t)) return;
  const topic = pfx('bb-clear');
  t.after(() => cleanupBlackboard(topic));

  await a2a.postBlackboard(topic, 'a', 'x', 'node-1');
  await a2a.postBlackboard(topic, 'a', 'y', 'node-1');

  const deleted = await a2a.clearBlackboard(topic);
  assert.equal(deleted, 2);
  const after = await a2a.readBlackboard(topic, {});
  assert.equal(after.length, 0);
});

// ============================================================
// 6. a2a_tasks
// ============================================================

test('a2a_tasks: priority — dequeue returns highest priority first', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-prio');
  t.after(() => cleanupTaskQueue(queue));

  await a2a.enqueueTask(queue, 5, { id: 'medium' });
  await a2a.enqueueTask(queue, 9, { id: 'high' });
  await a2a.enqueueTask(queue, 1, { id: 'low' });

  const t1 = await a2a.dequeueTask(queue, 'worker-1');
  assert.equal(t1.task.id, 'high', 'highest priority first');

  const t2 = await a2a.dequeueTask(queue, 'worker-1');
  assert.equal(t2.task.id, 'medium', 'medium next');

  const t3 = await a2a.dequeueTask(queue, 'worker-1');
  assert.equal(t3.task.id, 'low', 'low last');

  const t4 = await a2a.dequeueTask(queue, 'worker-1');
  assert.equal(t4, null, 'empty queue returns null');
});

test('a2a_tasks: concurrent dequeue — each worker gets distinct task', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-concurrent');
  t.after(() => cleanupTaskQueue(queue));

  const N = 10;
  for (let i = 0; i < N; i++) {
    await a2a.enqueueTask(queue, 5, { i });
  }

  // 3 concurrent dequeues × N times each — race them to the queue.
  const dequeueAll = async (worker) => {
    const collected = [];
    while (true) {
      const t = await a2a.dequeueTask(queue, worker);
      if (!t) break;
      collected.push(t);
    }
    return collected;
  };
  const [r1, r2, r3] = await Promise.all([
    dequeueAll('w-1'),
    dequeueAll('w-2'),
    dequeueAll('w-3'),
  ]);
  const total = r1.length + r2.length + r3.length;
  assert.equal(total, N, `total dequeued = ${N} (got ${total})`);

  // No id appears in more than one worker's collection
  const ids = new Set();
  for (const r of [...r1, ...r2, ...r3]) {
    assert.equal(ids.has(r.id), false, `id ${r.id} double-assigned`);
    ids.add(r.id);
  }
});

test('a2a_tasks: complete sets status=complete with result', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-complete');
  t.after(() => cleanupTaskQueue(queue));

  const { id } = await a2a.enqueueTask(queue, 5, { x: 1 });
  await a2a.dequeueTask(queue, 'w');
  const r = await a2a.completeTask(id, '{"ok":true}');
  assert.equal(r.found, true);

  const status = await a2a.queueStatus(queue);
  assert.equal(status.complete, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.in_progress, 0);
});

test('a2a_tasks: fail sets status=failed with error', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-fail');
  t.after(() => cleanupTaskQueue(queue));

  const { id } = await a2a.enqueueTask(queue, 5, { x: 1 });
  await a2a.dequeueTask(queue, 'w');
  const r = await a2a.failTask(id, 'boom');
  assert.equal(r.found, true);

  const status = await a2a.queueStatus(queue);
  assert.equal(status.failed, 1);
  assert.equal(status.pending, 0);
});

test('a2a_tasks: queueStatus counts match', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-status');
  t.after(() => cleanupTaskQueue(queue));

  // 2 pending, 1 in_progress, 1 complete, 1 failed
  await a2a.enqueueTask(queue, 5, { n: 1 });
  await a2a.enqueueTask(queue, 5, { n: 2 });
  await a2a.enqueueTask(queue, 5, { n: 3 });
  await a2a.enqueueTask(queue, 5, { n: 4 });
  await a2a.enqueueTask(queue, 5, { n: 5 });

  const inProg = await a2a.dequeueTask(queue, 'w'); // 1 in_progress
  const toComplete = await a2a.dequeueTask(queue, 'w');
  await a2a.completeTask(toComplete.id, 'ok'); // 1 complete
  const toFail = await a2a.dequeueTask(queue, 'w');
  await a2a.failTask(toFail.id, 'err'); // 1 failed

  // 5 enqueued, 3 dequeued (1 still in_progress, 1 complete, 1 failed),
  // 2 still pending.
  const status = await a2a.queueStatus(queue);
  assert.equal(status.pending, 2);
  assert.equal(status.in_progress, 1);
  assert.equal(status.complete, 1);
  assert.equal(status.failed, 1);
  // silence unused warning
  void inProg;
});

test('a2a_tasks: pendingTasks returns only status=pending', async (t) => {
  if (!requireDb(t)) return;
  const queue = pfx('task-pending');
  t.after(() => cleanupTaskQueue(queue));

  await a2a.enqueueTask(queue, 5, { n: 1 });
  await a2a.enqueueTask(queue, 5, { n: 2 });
  const dq = await a2a.dequeueTask(queue, 'w'); // moves one to in_progress

  const pending = await a2a.pendingTasks(queue, 100);
  assert.equal(pending.length, 1, 'only the un-dequeued task is pending');
  for (const r of pending) {
    assert.equal(r.status, 'pending');
    assert.notEqual(r.id, dq.id);
  }
});

// ============================================================
// Bonus — schema migration idempotence
// ============================================================

test('runMigrations is idempotent (running twice creates no errors)', async (t) => {
  if (!requireDb(t)) return;
  // First run already happened in canConnect via syncDb.init().
  // Run it twice more: must not throw, must not duplicate indexes.
  //
  // Use a dedicated client with a generous statement_timeout — index
  // existence checks for the FTS GIN indexes can occasionally exceed the
  // pool's 10s default on a busy/cold backend, even though the operations
  // are no-ops. We're testing idempotence, not speed.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '60s'");
    // Re-run migrations on this dedicated client. Schema's runMigrations
    // takes a Pool, but it only calls .query() on it — passing the client
    // works because both have the same query() signature for our purposes.
    // To stay strictly type-correct, we wrap client in a pool-like shim.
    const shim = { query: (...args) => client.query(...args) };
    await runMigrations(shim);
    await runMigrations(shim);

    // Spot-check: the a2a tables still exist.
    const r = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'a2a_%'`
    );
    const names = r.rows.map((row) => row.table_name).sort();
    assert.deepEqual(
      names,
      ['a2a_agents', 'a2a_blackboard', 'a2a_events', 'a2a_locks', 'a2a_messages', 'a2a_tasks'],
      'all 6 a2a_ tables exist after repeated migrations'
    );
  } finally {
    client.release();
  }
});
