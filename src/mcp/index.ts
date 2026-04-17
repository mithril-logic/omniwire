#!/usr/bin/env node

// OmniWire MCP Entrypoint — dual transport: stdio + SSE
// stdio: for Claude Code subprocess spawning
// SSE (port 3200): for OpenCode, Oh-My-OpenAgent, remote HTTP clients

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NodeManager } from '../nodes/manager.js';
import { TransferEngine } from '../nodes/transfer.js';
import { createOmniWireServer } from './server.js';
import { registerSyncTools } from './sync-tools.js';
import { startSSEServer } from './sse.js';
import { startRESTServer } from './rest.js';
import { SyncDB } from '../sync/db.js';
import { SyncEngine } from '../sync/engine.js';
import { getManifests } from '../sync/manifest.js';
import { allNodes, getLocalNodeId } from '../protocol/config.js';
import { DEFAULT_SYNC_CONFIG } from '../sync/types.js';
import type { SyncConfig } from '../sync/types.js';
import { startEventServer, eventBus } from './events.js';

const args = process.argv.slice(2);
const useStdio = args.includes('--stdio');
const useJson = args.includes('--json');
const ssePort = parseInt(args.find((a) => a.startsWith('--sse-port='))?.split('=')[1] ?? '3200');
const restPort = parseInt(args.find((a) => a.startsWith('--rest-port='))?.split('=')[1] ?? '3201');
const eventPort = parseInt(args.find((a) => a.startsWith('--event-port='))?.split('=')[1] ?? '3202');
const bindAddr = args.find((a) => a.startsWith('--bind='))?.split('=')[1] ?? '127.0.0.1';
const noSync = args.includes('--no-sync');
const noEvents = args.includes('--no-events');

function log(msg: string, data?: Record<string, unknown>): void {
  if (useJson) {
    process.stderr.write(JSON.stringify({ msg, ...data }) + '\n');
  } else {
    process.stderr.write(msg + '\n');
  }
}

async function main(): Promise<void> {
  const manager = new NodeManager();
  await manager.connectAll();

  const transfer = new TransferEngine(manager);
  const server = createOmniWireServer(manager, transfer);

  // Initialize CyberSync if not disabled
  let syncDb: SyncDB | null = null;
  if (!noSync) {
    try {
      const nodeId = getLocalNodeId();
      const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, nodeId };
      syncDb = new SyncDB(config);
      await syncDb.init();

      const node = allNodes().find((n) => n.id === nodeId);
      const os = node?.os ?? 'linux';
      const manifests = getManifests(os);
      const engine = new SyncEngine(syncDb, config, manager, transfer);

      registerSyncTools(server, syncDb, engine, manifests, nodeId, manager, transfer);
      log('CyberSync: 17 tools registered', { tools: 17, node: nodeId });
    } catch (err) {
      log(`CyberSync init failed (continuing without sync): ${(err as Error).message}`, { error: (err as Error).message });
    }
  }

  // Start auto-update background checker (non-blocking, unref'd timer)
  const noAutoUpdate = args.includes('--no-auto-update');
  if (!noAutoUpdate) {
    try {
      const { startAutoUpdate } = await import('../update.js');
      startAutoUpdate(3_600_000, (result) => {
        if (result.updated) log(`auto-updated: ${result.message}`, { autoUpdate: true, version: result.latestVersion });
      });
      log('auto-update: enabled (1h interval)');
    } catch { /* non-critical — continue without auto-update */ }
  }

  if (useStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    startSSEServer(server, ssePort, bindAddr);
    startRESTServer(manager, transfer, restPort, bindAddr);
    if (!noEvents) {
      startEventServer(eventPort, bindAddr);
      log(`Events: WS+SSE+Webhooks on ${bindAddr}:${eventPort}`, { eventPort });
    }
    log(`OmniWire MCP: SSE on ${bindAddr}:${ssePort}, REST on ${bindAddr}:${restPort}`, { ssePort, restPort });
  }

  let shuttingDown = false;
  const shutdown = async (reason: string, parentDeath = false): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Hard-exit watchdog: arm BEFORE any await so we always exit within 2s,
    // even if syncDb.close() or manager.disconnect() hangs (wedged pg pool,
    // half-closed ssh socket, etc). This is the class of bug this whole PR
    // was trying to kill — never allow graceful shutdown to become a new
    // source of orphan accumulation. Always exit(1) on the hard path: if we
    // reached the timeout we did NOT cleanly close resources.
    const hardExit = setTimeout(() => {
      try { process.stderr.write('[shutdown] hard exit after 2s\n'); } catch { /* EPIPE */ }
      process.exit(1);
    }, 2_000);
    hardExit.unref();

    // Parent pipe may already be closed by the time we log — wrap to avoid EPIPE
    // crashing the shutdown path (the one log line we most need when debugging
    // parent-death is exactly the one most likely to throw).
    try { log(`shutdown: ${reason}`, { shutdown: true, reason }); } catch { /* EPIPE */ }

    try { if (syncDb) await syncDb.close(); } catch { /* best effort */ }
    try { manager.disconnect(); } catch { /* best effort */ }
    clearTimeout(hardExit);

    // exit(1) on parent-death so supervisors / log analyzers can distinguish
    // "meant to exit" (0) from "parent vanished, we bailed" (1). Supervisors
    // treat 0 as intentional termination and won't restart.
    process.exit(parentDeath ? 1 : 0);
  };

  // Avoid EPIPE crashing the process if the parent pipe closes mid-write.
  process.stderr.on('error', () => { /* swallow EPIPE */ });

  // Signal-based shutdown. SIGINT/SIGTERM apply to both stdio and SSE —
  // they're the standard "please exit" signals. SIGHUP is stdio-only
  // (registered below): on SSE/REST daemons, SIGHUP conventionally means
  // "reload config" and supervisors routinely send it; treating it as
  // shutdown killed the windows daemon on 2026-04-12 when Node translated
  // a console-disconnect event to SIGHUP.
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  if (useStdio) {
    // SIGHUP-as-shutdown is only safe under stdio (Claude Code restarts the
    // child rather than signaling it, so there's no "reload" meaning).
    process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

    // StdioServerTransport only registers 'data'/'error' on stdin and never
    // closes it, so 'end'/'close' only fire when the parent closes the pipe.
    process.stdin.on('end', () => { void shutdown('stdin-end'); });
    process.stdin.on('close', () => { void shutdown('stdin-close'); });

    // Parent-PID watchdog: NodeManager's ssh2 keepalive pins the event loop,
    // so Node won't exit naturally when the parent dies. Poll ppid and probe
    // parent existence every 5s. Unref so the timer itself doesn't keep us
    // alive.
    const initialPpid = process.ppid;
    const ppidTimer = setInterval(() => {
      // Windows has no reparent-to-init semantics and aggressively recycles
      // PIDs, so both signals this watchdog relies on are unreliable:
      //   - `currentPpid !== initialPpid` never fires (no reparent).
      //   - `kill(ppid, 0)` can succeed against a recycled PID belonging to
      //     an unrelated new process, masking the parent's death.
      // The Windows scheduled task acts as the supervisor there — skip.
      if (process.platform === 'win32') return;

      const currentPpid = process.ppid;
      if (currentPpid !== initialPpid || currentPpid <= 1) {
        void shutdown('parent-gone (reparent)', true);
        return;
      }
      try {
        process.kill(currentPpid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          void shutdown('parent-gone (ESRCH)', true);
        }
      }
    }, 5_000);
    ppidTimer.unref();
  }
}

main().catch((err) => {
  log(`Fatal: ${(err as Error).message}`, { fatal: true, error: (err as Error).message });
  process.exit(1);
});
