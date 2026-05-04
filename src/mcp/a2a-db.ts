// A2A DB — Postgres-backed agent coordination primitives. Replaces /tmp + shell-exec substrate.

import type pg from 'pg';

// ---- Row types ----

export interface A2aMessageRow {
  id: string;
  channel: string;
  sender: string;
  schema_kind: 'text' | 'json' | 'any';
  message: string;
  sent_at: Date;
  consumed_at: Date | null;
  consumed_by: string | null;
}

export interface EventRow {
  id: string;
  topic: string;
  source: string;
  data: string;
  ts: Date;
}

export interface AgentRow {
  agent_id: string;
  capabilities: string[];
  metadata: string;
  node_id: string;
  last_heartbeat: Date;
}

export interface BlackboardRow {
  id: string;
  topic: string;
  author: string;
  content: string;
  source_node: string;
  posted_at: Date;
}

export interface TaskRow {
  id: string;
  queue: string;
  priority: number;
  task: unknown;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  enqueued_at: Date;
  result: string | null;
  error: string | null;
}

export interface LockRow {
  name: string;
  owner: string;
  acquired_at: Date;
  expires_at: Date;
}

// ---- Module API ----

export interface A2aDb {
  // a2a_message — queue semantics, FOR UPDATE SKIP LOCKED on receive
  sendMessage(channel: string, sender: string, schema_kind: 'text'|'json'|'any', message: string): Promise<{ id: string }>;
  receiveMessages(channel: string, count: number, consumer: string): Promise<A2aMessageRow[]>; // marks consumed_at
  peekMessages(channel: string, count: number): Promise<A2aMessageRow[]>; // does not mark
  listChannels(): Promise<Array<{ channel: string; pending: number }>>;
  clearChannel(channel: string): Promise<number>; // returns deleted count

  // semaphore — TTL via expires_at, cleanup on each acquire
  acquireLock(name: string, owner: string, ttlSec: number): Promise<{ acquired: boolean; current?: LockRow }>;
  releaseLock(name: string, owner: string): Promise<{ released: boolean }>;
  lockStatus(name: string): Promise<LockRow | null>;
  listLocks(): Promise<LockRow[]>; // expired rows excluded

  // event
  emitEvent(topic: string, source: string, data: string): Promise<{ id: string; ts: Date }>;
  pollEvents(opts: { topic?: string; since?: number; limit?: number; filter?: string }): Promise<EventRow[]>;
  eventHistoryCount(): Promise<number>;
  clearEvents(topic?: string): Promise<number>;

  // agent_registry — computed TTL from last_heartbeat (no expires_at column)
  registerAgent(agent_id: string, capabilities: string[], metadata: string, node_id: string): Promise<void>; // upsert
  deregisterAgent(agent_id: string): Promise<{ removed: boolean }>;
  heartbeatAgent(agent_id: string): Promise<{ touched: boolean }>;
  discoverAgents(capability: string, ttlSec: number): Promise<AgentRow[]>; // filter last_heartbeat > now - ttlSec
  listAgents(ttlSec: number): Promise<AgentRow[]>;

  // blackboard — bounded reads, optional FTS via search
  postBlackboard(topic: string, author: string, content: string, source_node: string): Promise<{ id: string }>;
  readBlackboard(topic: string, opts: { limit?: number; since?: number }): Promise<BlackboardRow[]>;
  blackboardTopics(): Promise<Array<{ topic: string; entries: number; latest: Date }>>;
  clearBlackboard(topic: string): Promise<number>;
  searchBlackboard(query: string, opts: { topic?: string; limit?: number }): Promise<BlackboardRow[]>;

  // task_queue — FOR UPDATE SKIP LOCKED on dequeue, priority DESC, ts ASC
  enqueueTask(queue: string, priority: number, task: unknown): Promise<{ id: string }>;
  dequeueTask(queue: string, worker: string): Promise<TaskRow | null>; // marks status=in_progress
  completeTask(task_id: string, result: string): Promise<{ found: boolean }>;
  failTask(task_id: string, error: string): Promise<{ found: boolean }>;
  queueStatus(queue: string): Promise<{ pending: number; in_progress: number; complete: number; failed: number }>;
  pendingTasks(queue: string, limit: number): Promise<TaskRow[]>;
}

// ---- Constants ----

export const BLACKBOARD_DEFAULT_LIMIT = 20;
export const BLACKBOARD_MAX_LIMIT = 500;
export const EVENT_DEFAULT_LIMIT = 10;
export const EVENT_MAX_LIMIT = 500;
export const REGISTRY_DEFAULT_TTL_SEC = 300;
export const SEMAPHORE_DEFAULT_TTL_SEC = 300;

// ---- Helpers ----

function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  const intVal = Math.floor(requested);
  if (intVal > max) return max;
  return intVal;
}

function clampPositiveInt(requested: number, fallback: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return fallback;
  return Math.floor(requested);
}

function rowToMessage(r: Record<string, unknown>): A2aMessageRow {
  return {
    id: String(r.id),
    channel: String(r.channel),
    sender: String(r.sender),
    schema_kind: r.schema_kind as 'text' | 'json' | 'any',
    message: String(r.message),
    sent_at: r.sent_at as Date,
    consumed_at: (r.consumed_at as Date | null) ?? null,
    consumed_by: (r.consumed_by as string | null) ?? null,
  };
}

function rowToEvent(r: Record<string, unknown>): EventRow {
  return {
    id: String(r.id),
    topic: String(r.topic),
    source: String(r.source),
    data: String(r.data ?? ''),
    ts: r.ts as Date,
  };
}

function rowToAgent(r: Record<string, unknown>): AgentRow {
  return {
    agent_id: String(r.agent_id),
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
    metadata: String(r.metadata ?? '{}'),
    node_id: String(r.node_id),
    last_heartbeat: r.last_heartbeat as Date,
  };
}

function rowToBlackboard(r: Record<string, unknown>): BlackboardRow {
  return {
    id: String(r.id),
    topic: String(r.topic),
    author: String(r.author),
    content: String(r.content),
    source_node: String(r.source_node),
    posted_at: r.posted_at as Date,
  };
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    queue: String(r.queue),
    priority: Number(r.priority),
    task: r.task,
    status: r.status as TaskRow['status'],
    enqueued_at: r.enqueued_at as Date,
    result: (r.result as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

function rowToLock(r: Record<string, unknown>): LockRow {
  return {
    name: String(r.name),
    owner: String(r.owner),
    acquired_at: r.acquired_at as Date,
    expires_at: r.expires_at as Date,
  };
}

// ---- Factory ----

export function createA2aDb(pool: pg.Pool): A2aDb {
  return {
    // ============================================================
    // a2a_messages
    // ============================================================
    async sendMessage(channel, sender, schema_kind, message) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO a2a_messages (channel, sender, schema_kind, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [channel, sender, schema_kind, message]
      );
      return { id: res.rows[0]!.id };
    },

    async receiveMessages(channel, count, consumer) {
      const limit = clampPositiveInt(count, 1);
      const res = await pool.query(
        `UPDATE a2a_messages
         SET consumed_at = now(), consumed_by = $3
         WHERE id IN (
           SELECT id FROM a2a_messages
           WHERE channel = $1 AND consumed_at IS NULL
           ORDER BY sent_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [channel, limit, consumer]
      );
      return res.rows.map(rowToMessage);
    },

    async peekMessages(channel, count) {
      const limit = clampPositiveInt(count, 1);
      const res = await pool.query(
        `SELECT * FROM a2a_messages
         WHERE channel = $1 AND consumed_at IS NULL
         ORDER BY sent_at
         LIMIT $2`,
        [channel, limit]
      );
      return res.rows.map(rowToMessage);
    },

    async listChannels() {
      const res = await pool.query<{ channel: string; pending: string }>(
        `SELECT channel, COUNT(*)::text AS pending
         FROM a2a_messages
         WHERE consumed_at IS NULL
         GROUP BY channel
         ORDER BY channel`
      );
      return res.rows.map(r => ({ channel: r.channel, pending: Number(r.pending) }));
    },

    async clearChannel(channel) {
      const res = await pool.query(
        `DELETE FROM a2a_messages WHERE channel = $1`,
        [channel]
      );
      return res.rowCount ?? 0;
    },

    // ============================================================
    // a2a_locks (semaphore)
    // ============================================================
    async acquireLock(name, owner, ttlSec) {
      const ttl = clampPositiveInt(ttlSec, SEMAPHORE_DEFAULT_TTL_SEC);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Cleanup expired
        await client.query(`DELETE FROM a2a_locks WHERE expires_at <= now()`);
        // Try to insert
        const ins = await client.query(
          `INSERT INTO a2a_locks (name, owner, expires_at)
           VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
           ON CONFLICT (name) DO NOTHING
           RETURNING *`,
          [name, owner, String(ttl)]
        );
        if (ins.rowCount === 1) {
          await client.query('COMMIT');
          return { acquired: true, current: rowToLock(ins.rows[0]) };
        }
        // Already held — fetch current
        const cur = await client.query(
          `SELECT * FROM a2a_locks WHERE name = $1`,
          [name]
        );
        await client.query('COMMIT');
        if (cur.rowCount && cur.rows[0]) {
          return { acquired: false, current: rowToLock(cur.rows[0]) };
        }
        return { acquired: false };
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
        throw err;
      } finally {
        client.release();
      }
    },

    async releaseLock(name, owner) {
      const res = await pool.query(
        `DELETE FROM a2a_locks WHERE name = $1 AND owner = $2`,
        [name, owner]
      );
      return { released: (res.rowCount ?? 0) > 0 };
    },

    async lockStatus(name) {
      const res = await pool.query(
        `SELECT * FROM a2a_locks WHERE name = $1 AND expires_at > now()`,
        [name]
      );
      if (!res.rowCount || !res.rows[0]) return null;
      return rowToLock(res.rows[0]);
    },

    async listLocks() {
      const res = await pool.query(
        `SELECT * FROM a2a_locks WHERE expires_at > now() ORDER BY acquired_at`
      );
      return res.rows.map(rowToLock);
    },

    // ============================================================
    // a2a_events
    // ============================================================
    async emitEvent(topic, source, data) {
      const res = await pool.query<{ id: string; ts: Date }>(
        `INSERT INTO a2a_events (topic, source, data)
         VALUES ($1, $2, $3)
         RETURNING id, ts`,
        [topic, source, data]
      );
      const row = res.rows[0]!;
      return { id: row.id, ts: row.ts };
    },

    async pollEvents(opts) {
      const limit = clampLimit(opts.limit, EVENT_DEFAULT_LIMIT, EVENT_MAX_LIMIT);
      const conditions: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      if (opts.topic) {
        conditions.push(`topic = $${p++}`);
        params.push(opts.topic);
      }
      if (typeof opts.since === 'number' && Number.isFinite(opts.since)) {
        conditions.push(`ts > to_timestamp($${p++} / 1000.0)`);
        params.push(opts.since);
      }
      if (opts.filter && opts.filter.length > 0) {
        // POSIX regex; parameterized — DB engine treats as untrusted text.
        conditions.push(`data ~ $${p++}`);
        params.push(opts.filter);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const sql = `SELECT * FROM a2a_events ${where} ORDER BY ts DESC LIMIT $${p}`;
      const res = await pool.query(sql, params);
      return res.rows.map(rowToEvent);
    },

    async eventHistoryCount() {
      const res = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM a2a_events`
      );
      return Number(res.rows[0]?.count ?? 0);
    },

    async clearEvents(topic) {
      if (topic) {
        const res = await pool.query(`DELETE FROM a2a_events WHERE topic = $1`, [topic]);
        return res.rowCount ?? 0;
      }
      const res = await pool.query(`DELETE FROM a2a_events`);
      return res.rowCount ?? 0;
    },

    // ============================================================
    // a2a_agents (registry)
    // ============================================================
    async registerAgent(agent_id, capabilities, metadata, node_id) {
      await pool.query(
        `INSERT INTO a2a_agents (agent_id, capabilities, metadata, node_id, last_heartbeat)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET capabilities = EXCLUDED.capabilities,
               metadata = EXCLUDED.metadata,
               node_id = EXCLUDED.node_id,
               last_heartbeat = now()`,
        [agent_id, capabilities, metadata, node_id]
      );
    },

    async deregisterAgent(agent_id) {
      const res = await pool.query(
        `DELETE FROM a2a_agents WHERE agent_id = $1`,
        [agent_id]
      );
      return { removed: (res.rowCount ?? 0) > 0 };
    },

    async heartbeatAgent(agent_id) {
      const res = await pool.query(
        `UPDATE a2a_agents SET last_heartbeat = now() WHERE agent_id = $1`,
        [agent_id]
      );
      return { touched: (res.rowCount ?? 0) > 0 };
    },

    async discoverAgents(capability, ttlSec) {
      const ttl = clampPositiveInt(ttlSec, REGISTRY_DEFAULT_TTL_SEC);
      const res = await pool.query(
        `SELECT * FROM a2a_agents
         WHERE $1 = ANY(capabilities)
           AND last_heartbeat > now() - ($2 || ' seconds')::interval
         ORDER BY last_heartbeat DESC`,
        [capability, String(ttl)]
      );
      return res.rows.map(rowToAgent);
    },

    async listAgents(ttlSec) {
      const ttl = clampPositiveInt(ttlSec, REGISTRY_DEFAULT_TTL_SEC);
      const res = await pool.query(
        `SELECT * FROM a2a_agents
         WHERE last_heartbeat > now() - ($1 || ' seconds')::interval
         ORDER BY last_heartbeat DESC`,
        [String(ttl)]
      );
      return res.rows.map(rowToAgent);
    },

    // ============================================================
    // a2a_blackboard
    // ============================================================
    async postBlackboard(topic, author, content, source_node) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO a2a_blackboard (topic, author, content, source_node)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [topic, author, content, source_node]
      );
      return { id: res.rows[0]!.id };
    },

    async readBlackboard(topic, opts) {
      const limit = clampLimit(opts.limit, BLACKBOARD_DEFAULT_LIMIT, BLACKBOARD_MAX_LIMIT);
      const params: unknown[] = [topic];
      let sql = `SELECT * FROM a2a_blackboard WHERE topic = $1`;
      let p = 2;
      if (typeof opts.since === 'number' && Number.isFinite(opts.since)) {
        sql += ` AND posted_at > to_timestamp($${p++} / 1000.0)`;
        params.push(opts.since);
      }
      sql += ` ORDER BY posted_at DESC LIMIT $${p}`;
      params.push(limit);
      const res = await pool.query(sql, params);
      return res.rows.map(rowToBlackboard);
    },

    async blackboardTopics() {
      const res = await pool.query<{ topic: string; entries: string; latest: Date }>(
        `SELECT topic, COUNT(*)::text AS entries, MAX(posted_at) AS latest
         FROM a2a_blackboard
         GROUP BY topic
         ORDER BY latest DESC`
      );
      return res.rows.map(r => ({
        topic: r.topic,
        entries: Number(r.entries),
        latest: r.latest,
      }));
    },

    async clearBlackboard(topic) {
      const res = await pool.query(
        `DELETE FROM a2a_blackboard WHERE topic = $1`,
        [topic]
      );
      return res.rowCount ?? 0;
    },

    async searchBlackboard(query, opts) {
      const limit = clampLimit(opts.limit, BLACKBOARD_DEFAULT_LIMIT, BLACKBOARD_MAX_LIMIT);
      const trimmed = (query ?? '').trim();
      if (!trimmed) return [];

      const params: unknown[] = [trimmed];
      let p = 2;
      // plainto_tsquery is safe with arbitrary user input — converts to tsquery without throwing on weird chars.
      let sql = `SELECT * FROM a2a_blackboard
                 WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)`;

      if (opts.topic) {
        sql += ` AND topic = $${p++}`;
        params.push(opts.topic);
      }

      sql += ` ORDER BY posted_at DESC LIMIT $${p}`;
      params.push(limit);

      let res = await pool.query(sql, params);

      // Fallback to ILIKE if FTS produced no results (handles single-character / non-lexeme queries)
      if (res.rowCount === 0) {
        const fbParams: unknown[] = [trimmed];
        let fp = 2;
        let fbSql = `SELECT * FROM a2a_blackboard WHERE content ILIKE '%' || $1 || '%'`;
        if (opts.topic) {
          fbSql += ` AND topic = $${fp++}`;
          fbParams.push(opts.topic);
        }
        fbSql += ` ORDER BY posted_at DESC LIMIT $${fp}`;
        fbParams.push(limit);
        res = await pool.query(fbSql, fbParams);
      }

      return res.rows.map(rowToBlackboard);
    },

    // ============================================================
    // a2a_tasks (priority queue)
    // ============================================================
    async enqueueTask(queue, priority, task) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO a2a_tasks (queue, priority, task)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id`,
        [queue, priority, JSON.stringify(task)]
      );
      return { id: res.rows[0]!.id };
    },

    async dequeueTask(queue, worker) {
      const res = await pool.query(
        `UPDATE a2a_tasks
         SET status = 'in_progress', started_at = now(), worker = $2
         WHERE id = (
           SELECT id FROM a2a_tasks
           WHERE queue = $1 AND status = 'pending'
           ORDER BY priority DESC, enqueued_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [queue, worker]
      );
      if (!res.rowCount || !res.rows[0]) return null;
      return rowToTask(res.rows[0]);
    },

    async completeTask(task_id, result) {
      const res = await pool.query(
        `UPDATE a2a_tasks
         SET status = 'complete', finished_at = now(), result = $2
         WHERE id = $1 AND status IN ('pending', 'in_progress')`,
        [task_id, result]
      );
      return { found: (res.rowCount ?? 0) > 0 };
    },

    async failTask(task_id, error) {
      const res = await pool.query(
        `UPDATE a2a_tasks
         SET status = 'failed', finished_at = now(), error = $2
         WHERE id = $1 AND status IN ('pending', 'in_progress')`,
        [task_id, error]
      );
      return { found: (res.rowCount ?? 0) > 0 };
    },

    async queueStatus(queue) {
      const res = await pool.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n
         FROM a2a_tasks
         WHERE queue = $1
         GROUP BY status`,
        [queue]
      );
      const out = { pending: 0, in_progress: 0, complete: 0, failed: 0 };
      for (const r of res.rows) {
        const n = Number(r.n);
        if (r.status === 'pending') out.pending = n;
        else if (r.status === 'in_progress') out.in_progress = n;
        else if (r.status === 'complete') out.complete = n;
        else if (r.status === 'failed') out.failed = n;
      }
      return out;
    },

    async pendingTasks(queue, limit) {
      const lim = clampPositiveInt(limit, 50);
      const res = await pool.query(
        `SELECT * FROM a2a_tasks
         WHERE queue = $1 AND status = 'pending'
         ORDER BY priority DESC, enqueued_at
         LIMIT $2`,
        [queue, lim]
      );
      return res.rows.map(rowToTask);
    },
  };
}
