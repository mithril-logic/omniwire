// OmniWire mesh configuration
// Resolution order: env var → ~/.omniwire/mesh.json → built-in defaults
// Built-in defaults mirror the existing hardcoded topology so zero-config
// deployments behave the way they used to.
//
// Note: mesh.json is read once at module load. Changing the file at runtime
// does NOT take effect until the process restarts.

import { readFileSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { MeshConfig, MeshNode, NodeRole } from './types.js';

const home = homedir();
const sshDir = join(home, '.ssh');
const meshJsonPath = process.env.OMNIWIRE_MESH_JSON ?? join(home, '.omniwire', 'mesh.json');

// Fallback host resolution order: WireGuard → Tailscale → Public IP
// NodeManager tries each in order until one connects.
export interface HostFallback {
  readonly wg: string;
  readonly tailscale?: string;
  readonly publicIp?: string;
}

// Populated at module load from (in order, last-write-wins):
//   1. Built-in WG defaults + OW_<NODE>_TS / OW_<NODE>_PUB env vars.
//   2. mesh.json's per-node "hostFallbacks" field (overrides builtin).
// Consumers (NodeManager via getHostCandidates) should treat this as read-only
// after module init.
export const HOST_FALLBACKS: Record<string, HostFallback> = {};

interface MeshJsonNode {
  id: string;
  alias: string;
  host: string;
  port: number;
  user: string;
  identityFile: string;
  os: string;
  role?: string;
  isLocal?: boolean;
  tags?: string[];
  hostFallbacks?: HostFallback;
}

interface MeshJson {
  nodes: MeshJsonNode[];
  defaultNode?: string;
  meshSubnet?: string;
}

// Expand ~/ and $HOME / ${HOME} in identityFile paths, then resolve relative
// names against ~/.ssh/. Keeps absolute paths untouched.
function resolveIdentityFile(file: string): string {
  if (!file) return '';
  let f = file;
  if (f.startsWith('~/')) return join(home, f.slice(2));
  if (f === '~') return home;
  // $HOME / ${HOME} at the start of the path
  f = f.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (isAbsolute(f)) return f;
  return join(sshDir, f);
}

// Parse a port env var with NaN/bounds guard.
// parseInt('abc') → NaN; `pg` then defaults or errors depending on driver —
// undefined behavior. Reject NaN, negatives, and out-of-range values.
function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
}

interface MeshLoadResult {
  nodes: MeshNode[];
  rawNodes: MeshJsonNode[];
  defaultNode: string;
  meshSubnet: string;
}

function loadMeshJson(): MeshLoadResult | null {
  if (!existsSync(meshJsonPath)) return null;
  try {
    const raw = readFileSync(meshJsonPath, 'utf-8');
    const json: MeshJson = JSON.parse(raw);
    if (!Array.isArray(json.nodes)) {
      process.stderr.write(`[omniwire] warning: ${meshJsonPath} has no "nodes" array, falling back to builtins\n`);
      return null;
    }

    const nodes: MeshNode[] = json.nodes.map((n) => ({
      id: n.id,
      alias: n.alias ?? n.id,
      host: n.host,
      port: n.port ?? 22,
      user: n.user ?? 'admin',
      identityFile: resolveIdentityFile(n.identityFile ?? ''),
      os: (n.os ?? 'linux') as MeshNode['os'],
      isLocal: n.isLocal ?? false,
      tags: n.tags ?? [],
    }));

    // Overlay mesh.json "hostFallbacks" on top of env-var-populated builtins.
    for (const n of json.nodes) {
      if (n.hostFallbacks) {
        HOST_FALLBACKS[n.id] = n.hostFallbacks;
      }
    }

    return {
      nodes,
      rawNodes: json.nodes,
      defaultNode: json.defaultNode ?? 'local',
      meshSubnet: json.meshSubnet ?? '0.0.0.0/0',
    };
  } catch (err) {
    // ENOENT is handled by existsSync above; any remaining error is a real
    // problem (malformed JSON, permission error, encoding issue). Make it
    // loud so users don't silently run on the fallback builtins.
    const msg = (err as Error).message;
    process.stderr.write(`[omniwire] warning: failed to parse ${meshJsonPath}: ${msg}\n`);
    return null;
  }
}

// Built-in host fallbacks — the pre-refactor upstream topology. Preserved so
// `OW_<NODE>_TS` / `OW_<NODE>_PUB` env vars that upstream's docs reference keep
// working, and so getHostCandidates() returns a real 3-host chain in zero-config
// deployments (not just `[node.host]`).
function builtinHostFallbacks(): Record<string, HostFallback> {
  return {
    contabo:   { wg: '10.10.0.1', tailscale: process.env.OW_CONTABO_TS   ?? '', publicIp: process.env.OW_CONTABO_PUB   ?? '' },
    hostinger: { wg: '10.10.0.2', tailscale: process.env.OW_HOSTINGER_TS ?? '', publicIp: process.env.OW_HOSTINGER_PUB ?? '' },
    thinkpad:  { wg: '10.10.0.4', tailscale: process.env.OW_THINKPAD_TS  ?? '' },
  };
}

// Seed HOST_FALLBACKS from builtin + env vars BEFORE loadMeshJson runs, so
// mesh.json's per-node overrides win if both are set. Order: builtin → env →
// mesh.json (last-write-wins in loadMeshJson).
for (const [id, fb] of Object.entries(builtinHostFallbacks())) {
  HOST_FALLBACKS[id] = fb;
}

// Built-in defaults — used only if mesh.json is absent or malformed.
function builtinNodes(): MeshNode[] {
  return [
    { id: 'windows', alias: 'win', host: '127.0.0.1', port: 0, user: 'Admin', identityFile: '', os: 'windows', isLocal: true, tags: ['workstation', 'desktop'] },
    { id: 'contabo', alias: 'c1', host: '10.10.0.1', port: 22, user: 'root', identityFile: join(sshDir, 'cybernord_contabo'), os: 'linux', isLocal: false, tags: ['vps', 'hub', 'docker', 'primary', 'db', 'storage'] },
    { id: 'hostinger', alias: 'h1', host: '10.10.0.2', port: 22, user: 'root', identityFile: join(sshDir, 'cybernord_vps'), os: 'linux', isLocal: false, tags: ['vps', 'secondary'] },
    { id: 'thinkpad', alias: 'tp', host: '10.10.0.4', port: 22, user: 'root', identityFile: join(sshDir, 'cybernord_contabo'), os: 'linux', isLocal: false, tags: ['laptop', 'mobile', 'browser', 'gpu'] },
  ];
}

function builtinRoles(): Record<string, NodeRole> {
  return { windows: 'controller', contabo: 'storage', hostinger: 'compute', thinkpad: 'gpu+browser' };
}

const loaded = loadMeshJson();
const NODES: MeshNode[] = loaded?.nodes ?? builtinNodes();

// Build NODE_ROLES dynamically from mesh.json "role" field, or use defaults
function buildNodeRoles(rawNodes: MeshJsonNode[] | null): Record<string, NodeRole> {
  if (!rawNodes) return builtinRoles();
  const roles: Record<string, NodeRole> = {};
  for (const n of rawNodes) {
    if (n.role) roles[n.id] = n.role;
  }
  return roles;
}

export const NODE_ROLES: Record<string, NodeRole> = buildNodeRoles(loaded?.rawNodes ?? null);

// ─── Node resolution helpers ─────────────────────────────────────
// Each follows: env var → mesh.json (by tag/role/isLocal) → built-in default.

/** Which node am I?
 *  Resolution order:
 *    1. OMNIWIRE_NODE_ID env var
 *    2. mesh.json entry with isLocal: true
 *    3. os.hostname() match against NODES[].id or NODES[].alias
 *    4. process.platform === 'win32' ⇒ 'windows' (builtin windows node)
 *    5. Throw — silently returning NODES[0] routes commands to a random remote
 */
export function getLocalNodeId(): string {
  if (process.env.OMNIWIRE_NODE_ID) return process.env.OMNIWIRE_NODE_ID;
  const local = NODES.find((n) => n.isLocal);
  if (local) return local.id;

  // Hostname match — useful when mesh.json lists this machine but forgot
  // to set isLocal: true.
  const hn = hostname().toLowerCase();
  const byHost = NODES.find((n) => n.id.toLowerCase() === hn || n.alias.toLowerCase() === hn);
  if (byHost) return byHost.id;

  // Windows builtin doesn't set isLocal in the legacy const list, keep that
  // path working on zero-config Windows installs.
  if (process.platform === 'win32') {
    const winNode = NODES.find((n) => n.id === 'windows');
    if (winNode) return winNode.id;
  }

  throw new Error(
    `[omniwire] could not determine local node id. Set OMNIWIRE_NODE_ID, ` +
    `or add isLocal: true to one of the nodes in ${meshJsonPath}. ` +
    `hostname=${hn}, available nodes=${NODES.map((n) => n.id).join(',')}`
  );
}

/** Which node has the database (PostgreSQL / CyberBase)? */
export function getDbNode(): string {
  if (process.env.OMNIWIRE_DB_NODE) return process.env.OMNIWIRE_DB_NODE;
  const byTag = NODES.find((n) => n.tags.includes('db') || n.tags.includes('storage'));
  if (byTag) return byTag.id;
  const byRole = Object.entries(NODE_ROLES).find(([, r]) => r === 'storage');
  if (byRole) return byRole[0];
  const remote = NODES.find((n) => !n.isLocal);
  return remote?.id ?? getLocalNodeId();
}

/** Which node runs Docker workloads? */
export function getDockerNode(): string {
  if (process.env.OMNIWIRE_DOCKER_NODE) return process.env.OMNIWIRE_DOCKER_NODE;
  const byTag = NODES.find((n) => n.tags.includes('docker'));
  if (byTag) return byTag.id;
  return getDbNode(); // often same node
}

/** Which node handles browser/GUI tasks? */
export function getBrowserNode(): string {
  if (process.env.OMNIWIRE_BROWSER_NODE) return process.env.OMNIWIRE_BROWSER_NODE;
  const byTag = NODES.find((n) => n.tags.includes('browser') || n.tags.includes('gui'));
  if (byTag) return byTag.id;
  const byRole = Object.entries(NODE_ROLES).find(([, r]) => r === 'gpu+browser');
  if (byRole) return byRole[0];
  return getLocalNodeId();
}

/** Which node handles compute-heavy tasks? */
export function getComputeNode(): string {
  if (process.env.OMNIWIRE_COMPUTE_NODE) return process.env.OMNIWIRE_COMPUTE_NODE;
  const byTag = NODES.find((n) => n.tags.includes('compute') || n.tags.includes('gpu'));
  if (byTag) return byTag.id;
  const byRole = Object.entries(NODE_ROLES).find(([, r]) => r === 'compute');
  if (byRole) return byRole[0];
  return getDbNode();
}

export function getNodeForRole(role: NodeRole): MeshNode | undefined {
  const id = Object.entries(NODE_ROLES).find(([, r]) => r === role)?.[0];
  return id ? NODES.find((n) => n.id === id) : undefined;
}

export function getDefaultNodeForTask(task: 'storage' | 'browser' | 'compute' | 'local'): string {
  switch (task) {
    case 'local': return getLocalNodeId();
    case 'storage': return getDbNode();
    case 'browser': return getBrowserNode();
    case 'compute': return getComputeNode();
  }
}

export const CONFIG: MeshConfig = {
  nodes: NODES,
  defaultNode: loaded?.defaultNode ?? 'local',
  meshSubnet: loaded?.meshSubnet ?? '10.10.0.0/24',
  claudePath: 'claude',
};

export function findNode(query: string): MeshNode | undefined {
  const q = query.toLowerCase();
  return CONFIG.nodes.find(
    (n) => n.id === q || n.alias === q || n.host === q
  );
}

export function remoteNodes(): MeshNode[] {
  return CONFIG.nodes.filter((n) => !n.isLocal);
}

export function allNodes(): MeshNode[] {
  return [...CONFIG.nodes];
}

// Get ordered list of hosts to try for a node (WG → Tailscale → Public IP).
export function getHostCandidates(nodeId: string): string[] {
  const fb = HOST_FALLBACKS[nodeId];
  if (!fb) {
    const host = NODES.find((n) => n.id === nodeId)?.host;
    return host ? [host] : [];
  }
  const hosts: string[] = [];
  if (fb.wg) hosts.push(fb.wg);
  if (fb.tailscale) hosts.push(fb.tailscale);
  if (fb.publicIp) hosts.push(fb.publicIp);
  if (hosts.length === 0) {
    const host = NODES.find((n) => n.id === nodeId)?.host;
    if (host) hosts.push(host);
  }
  return hosts;
}

// ─── Database credentials ────────────────────────────────────────
// Resolution: CYBERSYNC_DB_URL → individual OMNIWIRE_PG_* env vars → defaults.
// Defaults are localhost-oriented: sync daemons assume Postgres is reachable
// at 127.0.0.1 on the DB node (the node selected by getDbNode()). The
// `psql` commands in mcp/server.ts run ON that node via SSH, so 127.0.0.1
// means "the DB node's own loopback" — not the caller's machine.
export interface DbCredentials {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}

// Emit a stderr warning at most once when credentials default across the board —
// helps users notice misconfiguration before it turns into a connection refusal.
let dbDefaultWarned = false;
function warnDbDefaults(): void {
  if (dbDefaultWarned) return;
  dbDefaultWarned = true;
  process.stderr.write(
    `[omniwire] warning: no CYBERSYNC_DB_URL / OMNIWIRE_PG_* env vars set; ` +
    `using defaults host=127.0.0.1 port=5432 user=cyberbase db=cyberbase\n`
  );
}

export function getDbCredentials(): DbCredentials {
  const dbUrl = process.env.CYBERSYNC_DB_URL;
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      return {
        host: u.hostname || '127.0.0.1',
        port: parsePort(u.port, 5432),
        user: u.username || 'cyberbase',
        database: u.pathname.slice(1) || 'cyberbase',
      };
    } catch { /* fall through */ }
  }
  const hostEnv = process.env.OMNIWIRE_PG_HOST;
  const portEnv = process.env.OMNIWIRE_PG_PORT;
  const userEnv = process.env.OMNIWIRE_PG_USER;
  const dbEnv = process.env.OMNIWIRE_PG_DB;
  if (!hostEnv && !portEnv && !userEnv && !dbEnv) warnDbDefaults();
  return {
    host: hostEnv ?? '127.0.0.1',
    port: parsePort(portEnv, 5432),
    user: userEnv ?? 'cyberbase',
    database: dbEnv ?? 'cyberbase',
  };
}

/** Returns a psql command prefix suitable for SSH exec on the DB node. */
export function pgExecPrefix(): string {
  const c = getDbCredentials();
  return `psql -h ${c.host} -p ${c.port} -U ${c.user} -d ${c.database}`;
}

// ─── Vault paths ─────────────────────────────────────────────────
// Used by sync/vault-bridge for the Obsidian mirror directory.
export function getVaultPath(): string {
  if (process.env.OMNIWIRE_VAULT_PATH) return process.env.OMNIWIRE_VAULT_PATH;
  if (process.platform === 'win32') {
    return join(home, 'Documents', 'CyberBase');
  }
  return join(home, '.cyberbase', 'vault');
}
