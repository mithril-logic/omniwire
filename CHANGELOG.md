# Changelog

## [Unreleased]

### Changed

- **A2A coordination is now Postgres-backed.** The 6 A2A tools
  (`omniwire_a2a_message`, `omniwire_blackboard`, `omniwire_agent_registry`,
  `omniwire_task_queue`, `omniwire_event`, `omniwire_semaphore`) previously
  used local `/tmp` directories on each mesh node and silently failed to
  share state cross-node. They now write directly to a shared `pg.Pool`
  on tank Postgres (db `omniwire`) using dedicated tables. Cross-node
  agent coordination works for the first time.

### Added

- `src/mcp/a2a-db.ts` — typed Postgres-backed module exposing the
  `A2aDb` interface (29 methods across the 6 tool surfaces).
- 6 new tables in the `omniwire` database: `a2a_messages`, `a2a_locks`,
  `a2a_events`, `a2a_agents`, `a2a_blackboard`, `a2a_tasks`. Schema
  migrations in `src/sync/schema.ts` are idempotent (`CREATE TABLE IF NOT EXISTS`).
- `docs/A2A.md` — comprehensive reference for the new A2A system.
- `docs/arch/*.dot` — Graphviz architecture diagrams (mesh topology,
  MCP tool surface, data layer, process runtime, incident forensics).

### Fixed

- Coalition review caught and fixed 3 blockers (truncation-after-consume in
  `receive` and `dequeue`, agent_registry `register` falling back to
  `getDbNode()` instead of `getLocalNodeId()`).
- All A2A tool handlers now surface DB unavailability as
  `fail('A2A unavailable: ...')` — no silent empty reads.
- Migrations now run at MCP startup regardless of `--no-sync` flag.

### Breaking

- **Postgres on tank is now a hard prerequisite for MCP server startup.**
  Previously it was opt-in (only when sync was enabled). The MCP server
  will fail-fast at boot if Postgres is unreachable.

### Deprecated

- The `node` parameter on the 6 A2A tools is now informational only —
  state is shared in Postgres regardless of the node argument. Will be
  removed in a future major release.

### Notes

- `omniwire_workflow` (Tool 41) still uses the legacy `/tmp` + shell-exec
  pattern. Not addressed in this rewrite. Track as a follow-up.
- `cb('blackboard', ...)` mirroring to the `knowledge` table was removed
  from the blackboard handler; CyberBase no longer receives blackboard
  posts. Other `cb()` callers (`store`, `audit`, `2fa`) are unchanged.
