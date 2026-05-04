// CyberSync — Daemon entrypoint
// Watches tool directories, syncs to PostgreSQL, bridges memory.db
//
// Usage:
//   node dist/sync/index.js --node windows                     # run daemon
//   node dist/sync/index.js --node windows --once              # single reconcile
//   node dist/sync/index.js --node windows --ingest-only       # memory.db only

import { SyncDB } from './db.js';
import { SyncEngine } from './engine.js';
import { SyncWatcher } from './watcher.js';
import { MemoryBridge } from './memory-bridge.js';
import { OpenClawBridge } from './openclaw-bridge.js';
import { getManifests } from './manifest.js';
import { NodeManager } from '../nodes/manager.js';
import { TransferEngine } from '../nodes/transfer.js';
import { allNodes, getLocalNodeId } from '../protocol/config.js';
import type { SyncConfig } from './types.js';
import { DEFAULT_SYNC_CONFIG } from './types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function parseArgs(argv: string[]): { nodeId: string; once: boolean; ingestOnly: boolean } {
  // Filter out the supervisor marker flag `--omniwire-daemon=...`. It's a
  // grep anchor for `pkill -f --omniwire-daemon=sync` and carries no
  // semantics of its own. Silently discard any value.
  const filtered = argv.filter((a) => !a.startsWith('--omniwire-daemon='));
  const nodeIdx = filtered.indexOf('--node');
  const nodeId = nodeIdx !== -1 && filtered[nodeIdx + 1] ? filtered[nodeIdx + 1] : getLocalNodeId();
  const once = filtered.includes('--once');
  const ingestOnly = filtered.includes('--ingest-only');
  return { nodeId, once, ingestOnly };
}

// Resolve lockfile path (env override or ~/.omniwire/sync.lock). Also
// ensures the parent directory exists.
function resolveLockPath(): string {
  const override = process.env.OMNIWIRE_SYNC_LOCK;
  const lockPath = override && override.length > 0
    ? override
    : path.join(os.homedir(), '.omniwire', 'sync.lock');
  const dir = path.dirname(lockPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; openSync below will surface a meaningful error if
    // the directory truly cannot be created.
  }
  return lockPath;
}

// Returns true if the given pid is a live process on this host.
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a liveness probe: no signal sent, but permission /
    // existence checks run. Throws ESRCH if the pid is gone.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the pid exists but we can't signal it — still alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

interface LockInfo {
  pid: number;
  hostname: string;
  timestamp: string;
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    };
  } catch {
    return null;
  }
}

function writeLockInfo(fd: number): void {
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  };
  const payload = JSON.stringify(info, null, 2) + '\n';
  fs.writeFileSync(fd, payload);
}

// Acquire an exclusive per-host lock. On EEXIST, check staleness (pid
// dead and on this host) and retry exactly once. Returns the lock path
// on success; exits the process with code 3 on contention.
function acquireSingletonLock(): string {
  const lockPath = resolveLockPath();
  const localHost = os.hostname();

  const tryOpen = (): number | null => {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  let fd = tryOpen();

  if (fd === null) {
    const existing = readLockInfo(lockPath);

    // Foreign-host lock (e.g. shared $HOME over NFS): we cannot verify
    // liveness of a pid on another host, so conservatively treat it as
    // held. Do not touch it.
    if (existing && existing.hostname && existing.hostname !== localHost) {
      process.stderr.write(
        `another sync daemon holds the lock on a different host (pid ${existing.pid} on ${existing.hostname}); exiting\n`,
      );
      process.exit(3);
    }

    // Live on this host: another instance is running — bail.
    if (existing && isProcessAlive(existing.pid)) {
      process.stderr.write(
        `another sync daemon is already running (pid ${existing.pid} on ${existing.hostname || localHost} since ${existing.timestamp || 'unknown'}); exiting\n`,
      );
      process.exit(3);
    }

    const staleReason = existing === null
      ? 'unreadable lockfile'
      : `pid ${existing.pid} not running`;

    // Stale: overwrite. We unlink then re-open exclusively so we don't
    // race with a concurrent launcher that also found it stale.
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `failed to clear stale lockfile at ${lockPath}: ${(err as Error).message}\n`,
        );
        process.exit(3);
      }
    }
    process.stderr.write(`[sync] cleared stale lockfile (${staleReason})\n`);
    fd = tryOpen();
    if (fd === null) {
      const racer = readLockInfo(lockPath);
      process.stderr.write(
        `another sync daemon acquired the lock during recovery${racer ? ` (pid ${racer.pid})` : ''}; exiting\n`,
      );
      process.exit(3);
    }
  }

  try {
    writeLockInfo(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
  return lockPath;
}

function releaseSingletonLock(lockPath: string | null): void {
  if (!lockPath) return;
  try {
    const info = readLockInfo(lockPath);
    // Only unlink if we still own it (our pid). Protects against a
    // weird race where another process already took over.
    if (info && info.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const { nodeId, once, ingestOnly } = parseArgs(process.argv.slice(2));
  const node = allNodes().find((n) => n.id === nodeId);

  if (!node) {
    process.stderr.write(`Unknown node: ${nodeId}\n`);
    process.exit(1);
  }

  // Singleton lock: only persistent-daemon mode. --once and --ingest-only
  // are short-lived maintenance runs and must coexist with the daemon.
  // Acquire BEFORE any side effects (Postgres, migrations, etc.) so a
  // contending invocation exits fast with exit code 3.
  const isDaemon = !once && !ingestOnly;
  let lockPath: string | null = null;
  if (isDaemon) {
    lockPath = acquireSingletonLock();
  }

  const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, nodeId };

  process.stderr.write(`CyberSync starting on ${nodeId} (${node.os})\n`);
  if (lockPath) {
    process.stderr.write(`[sync] holding singleton lock at ${lockPath}\n`);
  }

  // Connect to PostgreSQL
  const db = new SyncDB(config);
  await db.init();
  process.stderr.write(`PostgreSQL connected (${config.pgHost}:${config.pgPort}/${config.pgDatabase})\n`);

  // One-shot data migration: claim this node's legacy unnamespaced cron/**
  // rows into `cron/<nodeId>/**`. Idempotent — no-op after first run.
  try {
    const m = await db.migrateCronToNamespacedPaths(nodeId);
    if (m.migrated > 0 || m.skipped > 0) {
      process.stderr.write(`[sync] cron namespace migration: migrated=${m.migrated}, skipped=${m.skipped}\n`);
    }
  } catch (err) {
    process.stderr.write(`[sync] cron namespace migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Connect mesh nodes
  const manager = new NodeManager();
  await manager.connectAll();
  const transferEngine = new TransferEngine(manager);

  const os = node.os;
  const manifests = getManifests(os);

  // Memory bridge (SQLite -> PostgreSQL)
  const bridge = new MemoryBridge(db, nodeId);

  // OpenClaw knowledge bridge (filesystem -> PostgreSQL)
  const openclawBridge = new OpenClawBridge(db, nodeId);
  const openclawManifest = manifests.find((m) => m.tool === 'openclaw');

  if (ingestOnly) {
    const claudeManifest = manifests.find((m) => m.tool === 'claude-code');
    if (claudeManifest?.ingestDb) {
      const count = await bridge.ingest(claudeManifest.ingestDb);
      process.stderr.write(`Ingested ${count} claude memory entries\n`);
    }
    if (openclawManifest) {
      const count = await openclawBridge.ingest(openclawManifest.baseDir);
      process.stderr.write(`Ingested ${count} openclaw knowledge entries\n`);
    }
    await db.close();
    manager.disconnect();
    return;
  }

  // Sync engine
  const engine = new SyncEngine(db, config, manager, transferEngine);

  if (once) {
    // Single reconciliation pass
    const result = await engine.reconcile(manifests);
    process.stderr.write(`Reconcile: pushed=${result.pushed}, pulled=${result.pulled}, conflicts=${result.conflicts}\n`);

    // Ingest memory.db + openclaw
    const claudeManifest = manifests.find((m) => m.tool === 'claude-code');
    if (claudeManifest?.ingestDb) {
      const count = await bridge.ingest(claudeManifest.ingestDb);
      process.stderr.write(`Ingested ${count} claude memory entries\n`);
    }
    if (openclawManifest) {
      const count = await openclawBridge.ingest(openclawManifest.baseDir);
      process.stderr.write(`Ingested ${count} openclaw knowledge entries\n`);
    }

    await db.close();
    manager.disconnect();
    return;
  }

  // Daemon mode: watcher + periodic reconcile
  const watcher = new SyncWatcher(manifests, config.watchDebounceMs, async (event) => {
    try {
      if (event.type === 'unlink') {
        await engine.deleteFile(event.tool, event.relPath);
        process.stderr.write(`[sync] deleted ${event.tool}:${event.relPath}\n`);
      } else {
        await engine.pushFile(event.tool, event.relPath, event.absPath);
        process.stderr.write(`[sync] pushed ${event.tool}:${event.relPath}\n`);
      }
    } catch (err) {
      process.stderr.write(`[sync] error: ${(err as Error).message}\n`);
    }
  });

  watcher.start();
  process.stderr.write(`Watchers started for ${manifests.filter((m) => m.syncGlobs.length > 0).length} tools\n`);

  // Initial reconcile
  const initial = await engine.reconcile(manifests);
  process.stderr.write(`Initial reconcile: pushed=${initial.pushed}, pulled=${initial.pulled}, conflicts=${initial.conflicts}\n`);

  // Ingest on startup: claude memory.db + openclaw filesystem
  const claudeManifest = manifests.find((m) => m.tool === 'claude-code');
  if (claudeManifest?.ingestDb) {
    const count = await bridge.ingest(claudeManifest.ingestDb);
    process.stderr.write(`Ingested ${count} claude memory entries\n`);
  }
  if (openclawManifest) {
    const count = await openclawBridge.ingest(openclawManifest.baseDir);
    process.stderr.write(`Ingested ${count} openclaw knowledge entries\n`);
  }

  // Periodic reconciliation
  const reconcileInterval = setInterval(async () => {
    try {
      const result = await engine.reconcile(manifests);
      if (result.pushed > 0 || result.pulled > 0 || result.conflicts > 0) {
        process.stderr.write(`[reconcile] pushed=${result.pushed}, pulled=${result.pulled}, conflicts=${result.conflicts}\n`);
      }
      // heartbeat is already updated inside engine.reconcile() with real counts
    } catch (err) {
      process.stderr.write(`[reconcile] error: ${(err as Error).message}\n`);
    }
  }, config.reconcileIntervalMs);

  // Periodic knowledge ingestion (every 15 min): claude memory.db + openclaw filesystem
  const memoryInterval = setInterval(async () => {
    if (claudeManifest?.ingestDb) {
      try {
        await bridge.ingest(claudeManifest.ingestDb);
      } catch {
        // Silent fail for claude memory ingestion
      }
    }
    if (openclawManifest) {
      try {
        await openclawBridge.ingest(openclawManifest.baseDir);
      } catch {
        // Silent fail for openclaw ingestion
      }
    }
  }, 15 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    process.stderr.write('CyberSync shutting down...\n');
    clearInterval(reconcileInterval);
    clearInterval(memoryInterval);
    await watcher.stop();
    await db.close();
    manager.disconnect();
    releaseSingletonLock(lockPath);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Best-effort lock cleanup on unexpected exit paths (thrown errors
  // bubbling out of main, process.exit from elsewhere, etc.).
  process.on('exit', () => releaseSingletonLock(lockPath));

  process.stderr.write(`CyberSync daemon running (reconcile every ${config.reconcileIntervalMs / 1000}s)\n`);
}

// Export engine creation for MCP tools
export { SyncDB } from './db.js';
export { SyncEngine } from './engine.js';
export { MemoryBridge } from './memory-bridge.js';
export { OpenClawBridge } from './openclaw-bridge.js';
export { getManifests } from './manifest.js';
export type { SyncConfig } from './types.js';
export { DEFAULT_SYNC_CONFIG } from './types.js';
export { VaultBridge, createVaultBridge } from './vault-bridge.js';

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith('sync/index.js') || process.argv[1]?.endsWith('sync\\index.js');
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
