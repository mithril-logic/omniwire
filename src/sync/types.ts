import { getDbCredentials } from '../protocol/config.js';

// CyberSyncâ Type definitions for unified mesh sync

export interface SyncItem {
  readonly id: string;
  readonly tool: ToolName;
  readonly category: string;
  readonly relPath: string;
  readonly contentHash: string;
  readonly content: Buffer | null;
  readonly contentSize: number;
  readonly metadata: Record<string, unknown>;
  readonly updatedAt: Date;
  readonly updatedByNode: string;
  readonly isDeleted: boolean;
  readonly encrypted: boolean;
}

export interface NodeSyncState {
  readonly nodeId: string;
  readonly itemId: string;
  readonly contentHash: string;
  readonly syncedAt: Date;
}

export interface SyncEvent {
  readonly id: number;
  readonly itemId: string | null;
  readonly nodeId: string;
  readonly eventType: SyncEventType;
  readonly detail: string | null;
  readonly createdAt: Date;
}

export type SyncEventType = 'push' | 'pull' | 'conflict' | 'delete' | 'reconcile' | 'error';

export interface KnowledgeEntry {
  readonly id: string;
  readonly sourceTool: ToolName;
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaudeMemoryEntry {
  readonly id: number;
  readonly nodeId: string;
  readonly key: string;
  readonly value: string;
  readonly ingestedAt: Date;
}

export interface NodeHeartbeat {
  readonly nodeId: string;
  readonly lastSeen: Date;
  readonly itemsCount: number;
  readonly pendingSync: number;
}

export type ToolName = 'claude-code' | 'opencode' | 'openclaw' | 'codex' | 'gemini' | 'paperclip';

export interface ToolManifest {
  readonly tool: ToolName;
  readonly baseDir: string;
  readonly syncGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly ingestDb?: string;
  readonly ingestDirs?: readonly string[];
}

export interface SyncDiff {
  readonly itemId: string;
  readonly relPath: string;
  readonly tool: ToolName;
  readonly localHash: string | null;
  readonly remoteHash: string;
  readonly direction: 'push' | 'pull' | 'conflict';
}

export interface SyncStatus {
  readonly nodeId: string;
  readonly totalItems: number;
  readonly pendingSync: number;
  readonly lastSync: Date | null;
  readonly online: boolean;
}

export interface SyncConfig {
  readonly nodeId: string;
  readonly pgHost: string;
  readonly pgPort: number;
  readonly pgDatabase: string;
  readonly pgUser: string;
  readonly pgPassword: string;
  readonly watchDebounceMs: number;
  readonly reconcileIntervalMs: number;
}

// Parse CYBERSYNC_DB_URL (postgresql://user:pass@host:port/db) if set.
// Port is parsed with Number.isFinite + 1-65535 bounds guard — bare parseInt
// returns NaN on malformed input, which pg interprets variably (silent default
// or crash).
function parseDbUrl(): Partial<Pick<SyncConfig, 'pgHost' | 'pgPort' | 'pgDatabase' | 'pgUser' | 'pgPassword'>> {
  const url = process.env.CYBERSYNC_DB_URL;
  if (!url) return {};
  try {
    const u = new URL(url);
    let port: number | undefined;
    if (u.port) {
      const n = parseInt(u.port, 10);
      if (Number.isFinite(n) && n > 0 && n <= 65535) {
        port = n;
      } else {
        process.stderr.write(`Warning: invalid port '${u.port}' in CYBERSYNC_DB_URL, ignoring\n`);
      }
    }
    return {
      pgHost: u.hostname || undefined,
      pgPort: port,
      pgDatabase: u.pathname.slice(1) || undefined,
      pgUser: decodeURIComponent(u.username) || undefined,
      pgPassword: decodeURIComponent(u.password) || undefined,
    };
  } catch {
    process.stderr.write(`Warning: invalid CYBERSYNC_DB_URL, using defaults\n`);
    return {};
  }
}

// Parse a millisecond-valued env var. Rejects non-numeric and negative values,
// falling back to `defaultMs` with a stderr warning. Guards against the
// `Number('30s') === NaN` case, which node-postgres treats as falsy and would
// silently ship a pool with NO statement_timeout at all.
// Accepts 0 — Postgres interprets statement_timeout=0 as "no limit".
export function parseEnvMs(envName: string, raw: string | undefined, defaultMs: number): number {
  if (raw === undefined || raw === '') return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`Warning: invalid ${envName}='${raw}', using default ${defaultMs}ms\n`);
    return defaultMs;
  }
  return n;
}

const _dbUrl = parseDbUrl();
const _dbCreds = getDbCredentials();

function resolvePgPassword(): string {
  if (_dbUrl.pgPassword !== undefined) return _dbUrl.pgPassword;
  const envPw = process.env.OW_PG_PASSWORD;
  if (envPw !== undefined) return envPw;
  // Falling back to the legacy literal — loud on stderr so it surfaces in
  // logs if it ever fires in production. Set OW_PG_PASSWORD (or embed a
  // password in CYBERSYNC_DB_URL) to silence this.
  process.stderr.write(
    `[cybersync] warning: no CYBERSYNC_DB_URL password and no OW_PG_PASSWORD — ` +
    `using legacy default password.\n`
  );
  return 'cyberbase';
}

export const DEFAULT_SYNC_CONFIG: Omit<SyncConfig, 'nodeId'> = {
  pgHost: _dbUrl.pgHost ?? _dbCreds.host,
  pgPort: _dbUrl.pgPort ?? _dbCreds.port,
  pgDatabase: _dbUrl.pgDatabase ?? _dbCreds.database,
  pgUser: _dbUrl.pgUser ?? _dbCreds.user,
  pgPassword: resolvePgPassword(),
  watchDebounceMs: 300,
  reconcileIntervalMs: 2 * 60 * 1000,  // 2min (was 5min)  faster convergence
};
