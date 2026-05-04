// CyberSync — Tool manifests defining what to sync per AI tool

import type { ToolManifest, ToolName } from './types.js';
import { getHomeForOs, getToolBaseDir } from './paths.js';

function manifest(tool: ToolName, os: 'windows' | 'linux' | 'darwin', sync: string[], exclude: string[], ingestDb?: string, ingestDirs?: string[]): ToolManifest {
  return {
    tool,
    baseDir: getToolBaseDir(tool, os),
    syncGlobs: sync,
    excludeGlobs: exclude,
    ingestDb,
    ingestDirs,
  };
}

export function getManifests(os: 'windows' | 'linux' | 'darwin'): readonly ToolManifest[] {
  const home = getHomeForOs(os);

  return [
    // claude-code: syncGlobs intentionally empty.
    // yadm (https://yadm.io) tracks ~/.claude/ as a bare git repo over $HOME.
    // OmniWire MUST NOT write into yadm-tracked paths — concurrent edits race
    // the same files and were the architectural class of bug behind the
    // 2026-04-23 openclaw.json clobber loop. Knowledge ingest below remains
    // read-only-into-Postgres and does not write any local files.
    manifest('claude-code', os,
      [],
      [
        '.credentials.json',
        'history.jsonl',
        'logs/**',
        'cache/**',
        'sessions/**',
        'session-env/**',
        'file-history/**',
        'paste-cache/**',
        'downloads/**',
        'backups/**',
        'telemetry/**',
        'security_warnings_*',
        'shell-snapshots/**',
        'plans/**',
        'projects/**',
      ],
      `${home}/.claude/memory.db`,
      ['agents', 'skills', 'memory']
    ),
    manifest('opencode', os,
      [
        'opencode.json',
        'oh-my-opencode.json',
        'package.json',
        '.gitignore',
        'skills/**/*',
        'agents/**/*',
        'teams/**/*',
      ],
      [
        'node_modules/**',
        'bun.lock',
      ]
    ),
    manifest('openclaw', os,
      [
        'agents/**/*',
        'skills/**/*',
        'memory/**/*',
        'workspace/**/*',
        'openclaw.json',
        'identity/**/*',
        'cron/**/*',
      ],
      [
        'gateway.log',
        'update-check.json',
        'canvas/**',
        'telegram/**',
        'devices/**',
      ],
      undefined,
      ['agents', 'skills', 'memory', 'workspace', 'identity', 'cron']
    ),
    // codex: syncGlobs intentionally empty.
    // yadm (https://yadm.io) tracks ~/.codex/ as a bare git repo over $HOME.
    // OmniWire MUST NOT write into yadm-tracked paths — concurrent edits race
    // the same files and were the architectural class of bug behind the
    // 2026-04-23 openclaw.json clobber loop. Knowledge ingest (if added later)
    // remains read-only-into-Postgres and does not write any local files.
    manifest('codex', os,
      [],
      []
    ),
    // gemini: syncGlobs intentionally empty.
    // yadm (https://yadm.io) tracks ~/.gemini/ (or will) as a bare git repo
    // over $HOME. OmniWire MUST NOT write into yadm-tracked paths — concurrent
    // edits race the same files and were the architectural class of bug behind
    // the 2026-04-23 openclaw.json clobber loop. Knowledge ingest (if added
    // later) remains read-only-into-Postgres and does not write any local files.
    manifest('gemini', os,
      [],
      []
    ),
    manifest('paperclip', os,
      [
        'config.json',
        'agents/**/*',
      ],
      []
    ),
  ];
}

export function categorizeFile(relPath: string): string {
  const parts = relPath.split('/');
  if (parts.length > 1) return parts[0];
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json' || ext === 'jsonc') return 'config';
  if (ext === 'md') return 'docs';
  if (ext === 'toml' || ext === 'yaml' || ext === 'yml') return 'config';
  return 'other';
}

export const ALL_TOOLS: readonly ToolName[] = [
  'claude-code', 'opencode', 'openclaw', 'codex', 'gemini', 'paperclip',
];
