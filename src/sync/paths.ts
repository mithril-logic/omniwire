// CyberSync — Windows/Linux/Darwin path adaptation for JSON content

import { homedir } from 'node:os';

// Two distinct roles for "home" in this module:
//
//   1. CANONICAL — the literal string that appears in synced JSON content
//      and is used by PATH_MAPS for cross-node string rewriting. This MUST
//      be stable across every node in the mesh or content will silently
//      corrupt (e.g. node A writes "/home/alice/...", node B can't match
//      it because B's canonical is "/home/bob/..."). These values match
//      upstream's container-style assumptions: Windows runs as "Admin",
//      Linux runs as root inside a container.
//
//   2. LOCAL — where this particular host looks on disk when discovering
//      manifests or resolving tool base directories. This can (and should)
//      vary per host, so non-root Linux users and Windows boxes with other
//      usernames don't need to fork.
//
// Only LOCAL is influenced by env vars / uid / homedir(). CANONICAL is
// frozen so cross-node rewriting keeps working.

const CANONICAL_WIN_HOME = 'C:/Users/Admin';
const CANONICAL_WIN_HOME_BACKSLASH = 'C:\\Users\\Admin';
const CANONICAL_LINUX_HOME = '/root';

/** Treat undefined, null, and whitespace-only env values as "unset". */
function envOverride(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const winOverride = envOverride('OMNIWIRE_WIN_HOME');
const LOCAL_WIN_HOME = (winOverride
  ?? (process.platform === 'win32' ? homedir() : CANONICAL_WIN_HOME)
).replaceAll('\\', '/');

const linuxOverride = envOverride('OMNIWIRE_LINUX_HOME');
const LOCAL_LINUX_HOME = linuxOverride
  ?? (process.platform === 'linux'
      ? (process.getuid?.() === 0 ? CANONICAL_LINUX_HOME : homedir())
      : CANONICAL_LINUX_HOME);

const darwinOverride = envOverride('OMNIWIRE_DARWIN_HOME');
const LOCAL_DARWIN_HOME = darwinOverride ?? homedir();

/**
 * Returns the LOCAL home directory for the given OS target — i.e. where
 * this host looks on disk. Used by manifest discovery and getToolBaseDir.
 * NOT safe to use for cross-node content rewriting; PATH_MAPS below uses
 * the frozen CANONICAL_* values for that.
 */
export function getHomeForOs(os: 'windows' | 'linux' | 'darwin'): string {
  switch (os) {
    case 'windows': return LOCAL_WIN_HOME;
    case 'linux': return LOCAL_LINUX_HOME;
    case 'darwin': return LOCAL_DARWIN_HOME;
  }
}

// Cross-node rewriting table — always uses the canonical literals so every
// node produces the same output regardless of its own local home.
const PATH_MAPS: ReadonlyArray<readonly [string, string]> = [
  [CANONICAL_WIN_HOME_BACKSLASH, CANONICAL_LINUX_HOME],
  [CANONICAL_WIN_HOME, CANONICAL_LINUX_HOME],
];

export function toLinuxPath(content: string): string {
  let result = content;
  for (const [win, linux] of PATH_MAPS) {
    result = result.replaceAll(win, linux);
  }
  return result.replaceAll('\\\\', '/').replaceAll('\\', '/');
}

export function toWindowsPath(content: string): string {
  let result = content;
  for (const [win, linux] of PATH_MAPS) {
    result = result.replaceAll(linux, win);
  }
  return result;
}

export function toDarwinPath(content: string): string {
  let result = content;
  // Replace canonical Windows paths with local Darwin home
  result = result.replaceAll(CANONICAL_WIN_HOME_BACKSLASH, LOCAL_DARWIN_HOME);
  result = result.replaceAll(CANONICAL_WIN_HOME, LOCAL_DARWIN_HOME);
  // Replace canonical Linux home with local Darwin home
  result = result.replaceAll(CANONICAL_LINUX_HOME, LOCAL_DARWIN_HOME);
  // Normalize backslashes to forward slashes
  return result.replaceAll('\\\\', '/').replaceAll('\\', '/');
}

export function adaptPathsForNode(content: string, targetOs: 'windows' | 'linux' | 'darwin'): string {
  if (targetOs === 'windows') return toWindowsPath(content);
  if (targetOs === 'darwin') return toDarwinPath(content);
  return toLinuxPath(content);
}

export function getToolBaseDir(tool: string, os: 'windows' | 'linux' | 'darwin'): string {
  const home = getHomeForOs(os);

  switch (tool) {
    case 'claude-code':
      return os === 'windows' ? `${home}/.claude` : `${home}/.claude`;
    case 'opencode':
      return os === 'windows' ? `${home}/.config/opencode` : `${home}/.config/opencode`;
    case 'openclaw':
      return `${home}/.openclaw`;
    case 'codex':
      return `${home}/.codex`;
    case 'gemini':
      return `${home}/.gemini`;
    case 'paperclip':
      return `${home}/.paperclip`;
    default:
      return `${home}/.${tool}`;
  }
}

export function isJsonFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.jsonc');
}

export function normalizeRelPath(relPath: string): string {
  return relPath.replaceAll('\\', '/');
}
