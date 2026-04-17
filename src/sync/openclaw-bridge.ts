// CyberSync — OpenClaw filesystem -> PostgreSQL knowledge ingestion
//
// Walks ~/.openclaw/ directories (agents, skills, memory, workspace, identity, cron)
// and ingests structured entries into the shared knowledge table.
// Unlike claude-code's SQLite bridge, OpenClaw stores data as files (JSON, MD, etc).

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { SyncDB } from './db.js';

const MAX_CONTENT_BYTES = 64 * 1024; // 64KB per entry
const SOURCE_TOOL = 'openclaw' as const;

interface ParsedFile {
  readonly name: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
}

export class OpenClawBridge {
  constructor(
    private readonly db: SyncDB,
    private readonly nodeId: string,
  ) {}

  async ingest(baseDir: string): Promise<number> {
    if (!existsSync(baseDir)) return 0;

    let ingested = 0;

    // Ingest each category directory
    ingested += await this.ingestDirectory(baseDir, 'agents', 'agent');
    ingested += await this.ingestDirectory(baseDir, 'skills', 'skill');
    ingested += await this.ingestDirectory(baseDir, 'memory', 'memory');
    ingested += await this.ingestDirectory(baseDir, 'workspace', 'workspace');
    ingested += await this.ingestDirectory(baseDir, 'identity', 'identity');
    ingested += await this.ingestDirectory(baseDir, 'cron', 'cron');

    // Ingest main config
    ingested += await this.ingestConfig(baseDir);

    return ingested;
  }

  private async ingestDirectory(baseDir: string, dirName: string, category: string): Promise<number> {
    const dirPath = join(baseDir, dirName);
    if (!existsSync(dirPath)) return 0;

    const files = await walkFiles(dirPath);
    let ingested = 0;

    // Per-node categories (e.g. cron) must namespace the knowledge key so
    // each node gets its own row in the shared knowledge table; otherwise
    // nodes overwrite each other on the (source_tool, key) unique index.
    const isPerNode = category === 'cron';

    for (const filePath of files) {
      try {
        const parsed = await parseFile(filePath);
        const relPath = filePath.slice(dirPath.length + 1).replaceAll('\\', '/');
        const keyName = deriveKeyName(relPath, parsed.name);
        const key = isPerNode
          ? `openclaw:${category}:${this.nodeId}:${keyName}`
          : `openclaw:${category}:${keyName}`;

        await this.db.upsertKnowledge(SOURCE_TOOL, key, {
          source: 'filesystem',
          category,
          name: parsed.name,
          filePath: `${dirName}/${relPath}`,
          node: this.nodeId,
          lastIngested: new Date().toISOString(),
          ...parsed.metadata,
          ...(parsed.content.length > 0 ? { content: parsed.content } : {}),
        });

        ingested++;
      } catch {
        // Skip files that fail to parse
      }
    }

    return ingested;
  }

  private async ingestConfig(baseDir: string): Promise<number> {
    const configPath = join(baseDir, 'openclaw.json');
    if (!existsSync(configPath)) return 0;

    try {
      const raw = await readFile(configPath, 'utf-8');
      const parsed = tryParseJson(raw);

      await this.db.upsertKnowledge(SOURCE_TOOL, 'openclaw:config:main', {
        source: 'filesystem',
        category: 'config',
        node: this.nodeId,
        lastIngested: new Date().toISOString(),
        ...(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { rawContent: raw }),
      });

      return 1;
    } catch {
      return 0;
    }
  }
}

// Parse a file based on extension
async function parseFile(filePath: string): Promise<ParsedFile> {
  const raw = await readFile(filePath, 'utf-8');
  const truncated = raw.length > MAX_CONTENT_BYTES ? raw.slice(0, MAX_CONTENT_BYTES) : raw;
  const name = basename(filePath, extname(filePath));
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    const parsed = tryParseJson(truncated);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      return {
        name: (obj.name as string) ?? name,
        content: '',
        metadata: obj,
      };
    }
    return { name, content: truncated, metadata: {} };
  }

  if (ext === '.md') {
    const { frontmatter, body } = extractFrontmatter(truncated);
    const description = extractFirstHeading(body) ?? body.slice(0, 200).trim();
    return {
      name: (frontmatter.name as string) ?? name,
      content: body,
      metadata: {
        ...frontmatter,
        description,
      },
    };
  }

  // All other file types — raw text
  return { name, content: truncated, metadata: {} };
}

// Extract YAML-like frontmatter between --- delimiters
function extractFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: text };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter: {}, body: text };
  }

  const fmBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  // Simple key: value parsing (no nested YAML — avoids adding a dep)
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key.length === 0) continue;

    // Handle arrays: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      frontmatter[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      frontmatter[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter, body };
}

// Extract first markdown heading as description
function extractFirstHeading(text: string): string | undefined {
  const match = text.match(/^#+\s+(.+)$/m);
  return match?.[1]?.trim();
}

// Derive a clean key name from relative path
function deriveKeyName(relPath: string, parsedName: string): string {
  // Use parsed name if available and clean, otherwise derive from path
  if (parsedName && !parsedName.includes('/') && !parsedName.includes('\\')) {
    return parsedName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  return relPath
    .replace(/\.[^.]+$/, '')
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

// Recursively walk a directory, returning all file paths
async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = await walkFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile()) {
        // Skip files larger than 1MB
        const st = await stat(fullPath);
        if (st.size <= 1024 * 1024) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission denied or broken symlink
    }
  }

  return results;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
