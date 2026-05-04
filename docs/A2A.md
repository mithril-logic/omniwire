# A2A — Agent-to-Agent Coordination

OmniWire's A2A (agent-to-agent) primitives are Postgres-backed coordination tools shared across every mesh node. They replace a previous substrate that wrote to `/tmp/.omniwire-*` directories on whatever node the call happened to land on, then shelled out to read them back. That substrate was incoherent across nodes, lost state on `/tmp` reaping, and silently returned empty results when the file path didn't exist on the receiving node. The current implementation routes every call through `pg.Pool` connected to the CyberSync database on tank (`100.64.54.102:5432`, DB `omniwire`), so every agent on every node sees the same blackboard, the same channel queues, the same locks, and the same task queue.

This is the canonical reference. Six tools, six tables, one shared pool. If a tool returns `A2A unavailable: <reason>`, the database is unreachable and the call did not silently degrade — it failed loudly so the caller knows not to trust an empty result.

## Tools

The six tools are defined in `src/mcp/server.ts` and dispatch to the `A2aDb` interface in `src/mcp/a2a-db.ts`. Every tool accepts an optional `node` parameter for backwards-compat; it is informational only — the state lives in shared Postgres regardless of which node received the MCP call.

### `omniwire_blackboard` — shared notes per topic

Topic-scoped, append-only shared notes for multi-agent collaboration. Authors post content; consumers read recent entries, list topics, search across content (Postgres FTS with ILIKE fallback), or clear a topic. Backed by `a2a_blackboard`. Reads are bounded (default 20, max 500) so a runaway topic can't blow context.

Handler: `src/mcp/server.ts:3784`. SQL: `src/mcp/a2a-db.ts:443-526`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `post` | `topic`, `content` | `author` (default `agent`) | `{id, length}` confirmation |
| `read` | `topic` | `limit` (default 20, max 500) | Recent entries DESC by `posted_at` |
| `topics` | — | — | All topics with entry counts and latest timestamp |
| `search` | `query` | `topic` (scope), `limit` | FTS match on content; falls back to ILIKE if FTS produces zero |
| `clear` | `topic` | — | Count of deleted entries |

The `source_node` column on each row is set to `getLocalNodeId()` of the MCP process that received the post — useful for "which node's agent posted this" attribution. There is no per-author filter; if you need that, scope it via topic naming convention.

Examples:

```
omniwire_blackboard(action=post, topic=recon-findings, content="Found open SSH on 10.0.0.5", author=scanner-1)
omniwire_blackboard(action=read, topic=recon-findings, limit=10)
omniwire_blackboard(action=search, query="open SSH", topic=recon-findings)
```

Concurrency: posts are independent INSERTs; reads use a stable `posted_at DESC` order. No locking — multiple agents can post and read concurrently. The FTS fallback (`a2a-db.ts:511-523`) runs a second query only when the primary `to_tsvector @@ plainto_tsquery` returns zero rows, so a search for a single character or non-lexeme still finds substring matches.

### `omniwire_a2a_message` — channel queues

Channel-scoped message queue with mark-consumed semantics. Senders push messages; receivers atomically dequeue them via `FOR UPDATE SKIP LOCKED` so a single message is delivered to exactly one receiver even under concurrent consumers. Peeks are non-destructive. Backed by `a2a_messages`.

Handler: `src/mcp/server.ts:3458`. SQL: `src/mcp/a2a-db.ts:204-261`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `send` | `channel`, `message` | `sender`, `schema` (`text`/`json`/`any`, default `any`) | `{id}` |
| `receive` | `channel` | `count` (default 1, max 500), `sender` (consumer ID) | Up to `count` messages, marked consumed |
| `peek` | `channel` | `count` (default 5, max 500) | Up to `count` pending messages, NOT consumed |
| `list_channels` | — | — | Channels with non-zero pending counts |
| `clear` | `channel` | — | Count of deleted rows |

When `schema=json`, the handler validates the payload with `JSON.parse` before insert and returns `fail` if it doesn't parse. `schema_kind` is stored on the row so consumers can route based on payload shape.

Examples:

```
omniwire_a2a_message(action=send, channel=scan-tasks, message='{"target":"10.0.0.5"}', schema=json, sender=orchestrator)
omniwire_a2a_message(action=receive, channel=scan-tasks, count=1, sender=worker-3)
```

Concurrency: `receiveMessages` (`a2a-db.ts:214-230`) wraps the dequeue in `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Two workers calling `receive` on the same channel at the same time will each get a disjoint slice; neither blocks on the other. The `consumed_at`/`consumed_by` columns are set atomically in the UPDATE — there is no window where a row is selected but not yet marked. `clear` deletes rows entirely (including consumed); `receive` only marks them. Audit trail is preserved on consumed rows until `clear` runs.

### `omniwire_task_queue` — priority work distribution

Priority-ordered work queue. Producers enqueue JSON tasks with a priority 0–9; consumer agents dequeue (highest priority, then oldest), process, and report `complete`/`fail`. Backed by `a2a_tasks` with a partial index on `(queue, priority DESC, enqueued_at) WHERE status = 'pending'` for fast dequeue.

Handler: `src/mcp/server.ts:3851`. SQL: `src/mcp/a2a-db.ts:531-608`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `enqueue` | `task` (JSON string) | `queue` (default `default`), `priority` (0–9, default 5) | `{id}` |
| `dequeue` | — | `queue` | Single task, marked `in_progress`; or `(empty queue)` |
| `complete` | `task_id` | `result` | `{found}` |
| `fail` | `task_id` | `error` | `{found}` |
| `status` | — | `queue` | Counts by status: `pending`, `in_progress`, `complete`, `failed` |
| `pending` | — | `queue` | Up to 20 pending tasks ordered as dequeue would |

The `task` payload must parse as JSON or `enqueue` returns `fail`. Tasks are stored in `JSONB`. The `worker` column is set on dequeue to `getLocalNodeId()` of the receiving MCP process (used for "which node picked this up"); `started_at`/`finished_at` are stamped automatically.

Examples:

```
omniwire_task_queue(action=enqueue, queue=scan, task='{"target":"10.0.0.5"}', priority=7)
omniwire_task_queue(action=dequeue, queue=scan)
omniwire_task_queue(action=complete, task_id=<uuid>, result='{"open_ports":[22,80]}')
```

Concurrency: `dequeueTask` (`a2a-db.ts:541-557`) uses `FOR UPDATE SKIP LOCKED` on the priority-ordered subquery. Multiple workers calling `dequeue` on the same queue get disjoint tasks, no waiting. `completeTask` and `failTask` only transition rows in `('pending','in_progress')` — calling `complete` twice on the same task returns `{found: false}` on the second call.

### `omniwire_agent_registry` — discoverable agents with capabilities

Agents register their `agent_id`, capability list, free-form metadata, and `node_id`. Other agents discover by capability or list everything. There is no `expires_at` column — TTL is computed on read against `last_heartbeat` (default 300s). Stale agents disappear from `discover`/`list` automatically without a sweeper.

Handler: `src/mcp/server.ts:3722`. SQL: `src/mcp/a2a-db.ts:388-438`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `register` | `agent_id` | `capabilities[]`, `metadata` (JSON string), `node` | upserts row, refreshes `last_heartbeat` |
| `deregister` | `agent_id` | — | `{removed}` |
| `heartbeat` | `agent_id` | — | `{touched}` — bumps `last_heartbeat` to `now()` |
| `discover` | `capability` | — | Live agents whose `capabilities` array contains `capability` |
| `list` | — | — | All agents with heartbeat within TTL |

Register is an `INSERT … ON CONFLICT (agent_id) DO UPDATE` — calling it again is a no-op-with-refresh, not an error. The `node_id` column is set from the supplied `node` param or auto-detected via `getLocalNodeId()`; this is the node where the agent lives, not the Postgres host.

Examples:

```
omniwire_agent_registry(action=register, agent_id=scanner-1, capabilities=["scan","exploit"], metadata='{"version":"3.5"}')
omniwire_agent_registry(action=heartbeat, agent_id=scanner-1)
omniwire_agent_registry(action=discover, capability=scan)
```

Concurrency: TTL filtering is computed in SQL: `last_heartbeat > now() - ($ttl || ' seconds')::interval`. No client clock involved. `discoverAgents` uses a GIN index on the `capabilities` array (`idx_a2a_agents_capabilities`) so capability lookup stays O(log n) in registry size. Agents that crash without `deregister` simply fall out of the registry once their heartbeat ages past TTL.

### `omniwire_event` — pub/sub event log

Append-only event stream. Producers `emit` events on topics; subscribers `poll` with optional topic filter, `since` (epoch ms), regex `filter` against payload, and `limit`. History is unbounded until `clear` is called. Backed by `a2a_events`.

Handler: `src/mcp/server.ts:3587`. SQL: `src/mcp/a2a-db.ts:330-383`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `emit` | `topic` | `data`, `source` (default `agent`) | `{id, ts}` |
| `poll` | — | `topic`, `since` (epoch ms string), `limit` (default 10, max 500), `filter` (POSIX regex on `data`) | Events DESC by `ts` |
| `history` | — | — | Total event count across all topics |
| `clear` | — | `topic` (scoped clear if provided) | Count of deleted events |

Unlike `omniwire_a2a_message`, events are not consumed on read — multiple subscribers see the same event. Use `since` to implement long-poll patterns: store the last seen `ts.getTime()`, pass it back as `since`, get only newer events.

Examples:

```
omniwire_event(action=emit, topic=deploy.complete, source=ci-bot, data='{"version":"3.5.1"}')
omniwire_event(action=poll, topic=deploy.complete, since=1714521600000, limit=20)
```

Concurrency: emits are independent INSERTs; polls are read-only. The `idx_a2a_events_topic_ts` and `idx_a2a_events_ts` indexes (both `ts DESC`) keep recent-events queries fast as history grows. The `filter` regex is parameterized and applied server-side via the Postgres `~` operator — Postgres treats the pattern as untrusted text, so a malformed regex returns a SQL error rather than executing arbitrary code.

### `omniwire_semaphore` — distributed locks

Named locks with TTL. Owner takes a lock, holds it for up to `ttl` seconds, and is auto-evicted on TTL even if the owner crashes. Subsequent `acquire` calls clean up expired rows before attempting insert, so there is no separate sweeper. Backed by `a2a_locks`.

Handler: `src/mcp/server.ts:3527`. SQL: `src/mcp/a2a-db.ts:266-325`.

| Action | Required params | Optional params | Returns |
|--------|-----------------|-----------------|---------|
| `acquire` | `lock_name` | `owner` (default `agent`), `ttl` (seconds, default 300) | `{acquired, current?}` — current row returned when lock already held |
| `release` | `lock_name` | `owner` (must match) | `{released}` — false if not held by `owner` |
| `status` | `lock_name` | — | Current row or null |
| `list` | — | — | All non-expired locks |

`acquire` uses `INSERT … ON CONFLICT (name) DO NOTHING` inside a transaction that first deletes expired rows. The transaction guarantees that "expired-then-acquired" is atomic — no window where the lock appears free but isn't. `release` only deletes when `owner` matches, so a stale call cannot accidentally release a lock that has been re-acquired by someone else.

Examples:

```
omniwire_semaphore(action=acquire, lock_name=db-migration, owner=scanner-1, ttl=600)
omniwire_semaphore(action=release, lock_name=db-migration, owner=scanner-1)
```

Concurrency: contention returns `{acquired: false, current: <row>}` synchronously — there is no built-in wait/retry. Callers that want blocking behavior must implement their own polling loop. The `idx_a2a_locks_expires` index makes the cleanup-on-acquire deletion cheap.

## Data Model

Six tables, all created by the migration runner in `src/sync/schema.ts:146-150`. Migrations run unconditionally at MCP startup (see Architecture below) — `--no-sync` only disables the sync fanout, not the A2A schema.

### `a2a_messages` — channel queues

DDL: `src/sync/schema.ts:72-81`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `gen_random_uuid()` |
| `channel` | TEXT NOT NULL | Logical queue name |
| `sender` | TEXT NOT NULL | Caller-supplied |
| `schema_kind` | TEXT NOT NULL DEFAULT `'any'` | `'text'` / `'json'` / `'any'` |
| `message` | TEXT NOT NULL | Payload (JSON or plain text per `schema_kind`) |
| `sent_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `consumed_at` | TIMESTAMPTZ | NULL while pending |
| `consumed_by` | TEXT | Consumer ID, set on receive |

Indexes: partial `idx_a2a_messages_channel_pending (channel, sent_at) WHERE consumed_at IS NULL` (hot path for `receive`/`peek`/`list_channels`); secondary `idx_a2a_messages_channel_sent (channel, sent_at DESC)`.

### `a2a_locks` — semaphores

DDL: `src/sync/schema.ts:87-92`.

| Column | Type | Notes |
|--------|------|-------|
| `name` | TEXT PK | Lock name |
| `owner` | TEXT NOT NULL | |
| `acquired_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `expires_at` | TIMESTAMPTZ NOT NULL | Absolute, computed as `now() + ttl` |

Index: `idx_a2a_locks_expires (expires_at)` — used by the cleanup-on-acquire delete and by `lockStatus`/`listLocks` filters.

### `a2a_events` — pub/sub log

DDL: `src/sync/schema.ts:95-101`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `gen_random_uuid()` |
| `topic` | TEXT NOT NULL | |
| `source` | TEXT NOT NULL | |
| `data` | TEXT NOT NULL DEFAULT `''` | Free-form payload |
| `ts` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `idx_a2a_events_topic_ts (topic, ts DESC)`; `idx_a2a_events_ts (ts DESC)`.

### `a2a_agents` — registry

DDL: `src/sync/schema.ts:105-111`.

| Column | Type | Notes |
|--------|------|-------|
| `agent_id` | TEXT PK | |
| `capabilities` | TEXT[] NOT NULL DEFAULT `'{}'` | Array, GIN-indexed |
| `metadata` | TEXT NOT NULL DEFAULT `'{}'` | Stored as JSON string, not JSONB |
| `node_id` | TEXT NOT NULL | Mesh node where the agent process runs |
| `last_heartbeat` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `idx_a2a_agents_heartbeat (last_heartbeat DESC)` for live-agent listing; `idx_a2a_agents_capabilities` (GIN on `capabilities`) for capability discovery.

There is no `expires_at` — TTL is computed at query time as `last_heartbeat > now() - interval`. This means changing the TTL is a per-query parameter, not a schema migration.

### `a2a_blackboard` — shared notes

DDL: `src/sync/schema.ts:115-122`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `gen_random_uuid()` |
| `topic` | TEXT NOT NULL | |
| `author` | TEXT NOT NULL | |
| `content` | TEXT NOT NULL | |
| `source_node` | TEXT NOT NULL | Auto-set to `getLocalNodeId()` of MCP process |
| `posted_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `idx_a2a_blackboard_topic_posted (topic, posted_at DESC)`; `idx_a2a_blackboard_fts` (GIN on `to_tsvector('english', content)`) for `search`.

### `a2a_tasks` — priority queue

DDL: `src/sync/schema.ts:128-140`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | `gen_random_uuid()` |
| `queue` | TEXT NOT NULL | |
| `priority` | INTEGER NOT NULL DEFAULT 5 | 0–9; higher dequeues first |
| `task` | JSONB NOT NULL | Payload |
| `status` | TEXT NOT NULL DEFAULT `'pending'` | `pending`/`in_progress`/`complete`/`failed` |
| `enqueued_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `started_at` | TIMESTAMPTZ | Set on dequeue |
| `finished_at` | TIMESTAMPTZ | Set on complete/fail |
| `worker` | TEXT | Set on dequeue to `getLocalNodeId()` |
| `result` | TEXT | Set on complete |
| `error` | TEXT | Set on fail |

Indexes: partial `idx_a2a_tasks_queue_pending (queue, priority DESC, enqueued_at) WHERE status = 'pending'` (hot dequeue path); `idx_a2a_tasks_status (status)`.

## Architecture

A tool call flows:

1. Client (Claude Code, OpenCode, etc.) issues an MCP `tools/call` over stdio or SSE.
2. MCP subprocess (`src/mcp/index.ts`) routes to the registered handler in `src/mcp/server.ts`.
3. Handler invokes a method on the `A2aDb` interface (`src/mcp/a2a-db.ts`).
4. `A2aDb` implementation issues a parameterized SQL query against the shared `pg.Pool`.
5. The pool is owned by `SyncDB` (`src/sync/db.ts`) and exposed via `SyncDB.getPool()` (`src/sync/db.ts:45`).
6. Postgres lives on tank at `100.64.54.102:5432`, DB `omniwire`, credentials resolved by the standard CyberSync env-var chain (see `src/protocol/config.ts` `getDbCredentials`).

The pool is configured at `src/sync/db.ts:20-36`: `max=8`, 5s connection timeout, 30s idle timeout, statement timeout from `CYBERSYNC_STATEMENT_TIMEOUT_MS` (default 10s), TCP keepalive at 60s. The keepalive matters — without it a host sleep or network drop wedges connections for the OS default (~2h on Linux), and A2A calls would hang on the wedged socket.

### Migrations always run

`src/mcp/index.ts:54-62` initializes `SyncDB` and runs migrations unconditionally, before tool handlers register. The previous behavior gated migrations behind sync being enabled; that meant `--no-sync` deployments had no A2A tables at all and every call returned `relation "a2a_messages" does not exist`. Now, sync fanout is gated on `--no-sync` (`src/mcp/index.ts:67`) but the A2A schema is always present. If migration fails, the process exits — A2A is treated as required infrastructure, not best-effort.

### Single shared pool

`createA2aDb(syncDb.getPool())` (`src/mcp/index.ts:57`) hands the same `pg.Pool` to A2A and to the sync engine. Connection budget is 8 across both. The pool is closed on shutdown (`src/mcp/index.ts:128`), with a 2s hard-exit watchdog so a wedged pool can't block process termination.

## Failure Modes

| Condition | Behavior |
|-----------|----------|
| DB unreachable at startup | Process exits with `A2A DB init failed: <err>` (`src/mcp/index.ts:58-62`). MCP does not start. |
| DB unreachable mid-session | Each handler catches and returns `fail('A2A unavailable: <message>')` — see e.g. `server.ts:3522`. No silent empty reads. |
| Statement timeout exceeded | pg returns an error; handler surfaces it via the same `A2A unavailable:` path. Default 10s, override via `CYBERSYNC_STATEMENT_TIMEOUT_MS`. |
| Peer agent offline | Registry `discover`/`list` filter on `last_heartbeat > now() - ttl`, so a peer that hasn't heartbeated within 300s simply doesn't appear. No error, no stale data. |
| Concurrent `receive` on same channel | `FOR UPDATE SKIP LOCKED` (`a2a-db.ts:224`) ensures each pending message is delivered to exactly one consumer. Other consumers either get a different row or `(empty queue)`. |
| Concurrent `dequeue` on same queue | Same pattern (`a2a-db.ts:550`). Highest-priority oldest task goes to the first acquirer; others skip the locked row and either pick the next task or get empty. |
| Lock contention | `acquire` returns `{acquired: false, current: <row>}` synchronously. The current holder, owner, and remaining TTL are surfaced in the response so the caller can decide to back off, retry, or escalate. No blocking. |
| Lock holder crashes | The row's `expires_at` is absolute. The next `acquire` call on the same name runs `DELETE FROM a2a_locks WHERE expires_at <= now()` first (`a2a-db.ts:272`), then attempts insert. The lock auto-clears on TTL even with no live owner. |
| Worker crashes mid-task | Task remains in `status = 'in_progress'` indefinitely. There is currently no automatic recovery — see Limitations. |
| Malformed regex in `event poll filter` | Postgres returns a SQL error; surfaced as `A2A unavailable: <regex error>`. Pattern is parameterized — no injection vector. |

## Differences from the pre-fix substrate

| Aspect | Before | After |
|--------|--------|-------|
| Storage | `/tmp/.omniwire-{a2a,blackboard,events,agents,tasks,locks}/` on whatever node the call landed on | `a2a_*` tables on tank, single source of truth |
| Cross-node | Impossible — no shared filesystem; rei-pc and macbook had different `/tmp` contents | Works — every node hits the same Postgres |
| Persistence | Lost on `/tmp` reap, host reboot, or container restart | Durable rows; survive restarts |
| Failure mode on missing state | Silent empty read (file-not-found returned as "no messages") | Explicit `A2A unavailable: <reason>` |
| Audit trail | None — files were either present or grep'd in place | Full row history; consumed messages retain `consumed_at`/`consumed_by` until `clear` |
| Concurrency | Best-effort `flock` on per-file basis; races on dir creation | `FOR UPDATE SKIP LOCKED` for queue dequeue; ON CONFLICT for lock insert |
| Discovery | `ls /tmp/.omniwire-agents/` per node, no TTL | `last_heartbeat`-based TTL filtered in SQL; one query, all nodes |
| Search | `grep` shelled out to whichever node was current | Postgres FTS with ILIKE fallback |

## Pattern: cross-agent broadcast

There is no separate broadcast tool. Convention: agents subscribe by reading a known channel/topic.

- For fire-and-forget pub/sub, use `omniwire_event` — emit on a topic; every poller of that topic sees the event.
- For "deliver to exactly one agent of a pool", use `omniwire_a2a_message` — multiple workers `receive` from the same channel, `FOR UPDATE SKIP LOCKED` distributes work.
- For "post a finding any agent might want", use `omniwire_blackboard` — append to topic, anyone can read.

The convention for a "broadcast to all" message is: post to a well-known blackboard topic and have every agent read that topic on startup or on a timer. The upper-level `AGENTS.md` A2A protocol section uses `omniwire_blackboard` for the `agent-protocol` (coordination instructions, read on session start) and `status-report` (task summaries on completion) topics. `omniwire_event` is an alternative for high-frequency event-style emissions where you want every poller to see every event without consuming it. There is no "recipient" column in `a2a_messages`; if you need targeted delivery, encode the recipient in the channel name (e.g. `to-scanner-1`) or in the message payload.

## Limitations and Open Work

- **No app-level encryption.** Blackboard `content`, message `message`, event `data`, and task `task` are stored in plaintext. Postgres can be configured for at-rest encryption at the volume level, and the connection is over Tailscale-encrypted transport, but there is no per-row encryption like the `encrypted` flag on `sync_items`. Flag this as P2 — adversaries with DB read access see plaintext A2A.
- **No worker-crash recovery for tasks.** A worker that calls `dequeue` and then crashes leaves the task in `status='in_progress'` forever. There is no visibility timeout, no requeue. Consumers needing this must implement an external sweeper that flips stale `in_progress` rows back to `pending` based on `started_at < now() - threshold`.
- **No deadline enforcement.** `task` payloads can carry a deadline, but the queue itself doesn't enforce it. Consumers must check.
- **`omniwire_workflow` (Tool 41) still uses the old `/tmp/.omniwire-workflows/` substrate** (see `src/mcp/server.ts:3645-3720`). It is out of scope for this rewrite. Workflows defined on one node are invisible to other nodes and lost on `/tmp` reap.
- **No FK constraints between A2A tables.** Tasks reference no agent; messages reference no agent. Joining requires application-level convention.
- **No retention policy.** Events and consumed messages accumulate forever until explicit `clear`. For a long-running mesh, schedule periodic `clear` calls scoped by topic/channel.
- **Listen/notify not used.** `poll` is poll, not push. Subscribers waiting for fresh events should call `poll` on a timer or use `since` to fetch only new rows.

## Verification Recipe

A2A is correct when a write on one node is visible to a read on another node. The cleanest cross-node check is a direct psql query — bypassing the MCP layer confirms the substrate, and bypassing the local node confirms the shared-DB property. The DB password is in `pass omniwire/db-password`.

```
# On macbook — post via the MCP tool from any connected client (stdio or SSE).
# In an MCP client, invoke:
#   omniwire_blackboard(action=post, topic=verify, content="hello from macbook", author=test)
```

```bash
# Confirm cross-node visibility from rei-pc by querying Postgres directly:
ssh rei-pc 'PGPASSWORD=$(pass omniwire/db-password) psql \
  -h 100.64.54.102 -U omniwire -d omniwire \
  -c "SELECT posted_at, source_node, author, content
       FROM a2a_blackboard
      WHERE topic = '\''verify'\''
      ORDER BY posted_at DESC
      LIMIT 5;"'
```

If the row appears in the rei-pc query, A2A is working: the macbook MCP wrote to tank, rei-pc read from tank, and the topic was visible across nodes without any /tmp involvement.

For a no-credentials sanity check that the schema itself is in place on tank:

```bash
ssh tank "sudo docker exec -i omniwire-postgres psql -U omniwire -d omniwire -c '\dt a2a_*'"
```

Expected output: six tables — `a2a_agents`, `a2a_blackboard`, `a2a_events`, `a2a_locks`, `a2a_messages`, `a2a_tasks`.

To verify queue semantics under concurrency, post one message and have two clients race to `receive`:

```
# Client A and Client B simultaneously:
omniwire_a2a_message(action=receive, channel=race-test, count=1, sender=A)
omniwire_a2a_message(action=receive, channel=race-test, count=1, sender=B)
```

Exactly one of A or B sees the message; the other sees `(empty queue)`. This proves `FOR UPDATE SKIP LOCKED` is working end-to-end.
