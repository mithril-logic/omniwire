// CyberBase Obsidian Vault Bridge — mirrors PostgreSQL data as Obsidian markdown
// Every sync item, knowledge entry, and memory gets a .md file in the vault
// Obsidian Sync handles cloud backup automatically

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getVaultPath } from '../protocol/config.js';

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function toFrontmatter(meta: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

export class VaultBridge {
  private vaultPath: string;

  constructor(vaultPathOverride?: string) {
    this.vaultPath = vaultPathOverride ?? getVaultPath();
  }

  getVaultPath(): string {
    return this.vaultPath;
  }

  // Write a sync item as markdown
  async writeSyncItem(tool: string, relPath: string, content: string | Buffer, meta?: Record<string, unknown>): Promise<void> {
    const folder = join(this.vaultPath, 'sync', sanitizeFilename(tool));
    const filename = sanitizeFilename(relPath.replace(/\//g, '_'));
    const absPath = join(folder, filename.endsWith('.md') ? filename : `${filename}.md`);

    const textContent = Buffer.isBuffer(content) ? content.toString('utf-8') : content;

    const frontmatter = toFrontmatter({
      tool,
      path: relPath,
      synced: new Date().toISOString(),
      ...meta,
    });

    const md = `${frontmatter}\n\n${textContent}\n`;

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, md, 'utf-8');
  }

  // Write a knowledge entry
  async writeKnowledge(sourceTool: string, key: string, value: Record<string, unknown>): Promise<void> {
    const folder = join(this.vaultPath, 'knowledge', sanitizeFilename(sourceTool));
    const filename = sanitizeFilename(key);
    const absPath = join(folder, `${filename}.md`);

    const frontmatter = toFrontmatter({
      source: sourceTool,
      key,
      updated: new Date().toISOString(),
    });

    const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const md = `${frontmatter}\n\n${body}\n`;

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, md, 'utf-8');
  }

  // Write a Claude memory entry
  async writeMemory(nodeId: string, key: string, value: string): Promise<void> {
    const folder = join(this.vaultPath, 'memory', sanitizeFilename(nodeId));
    const filename = sanitizeFilename(key);
    const absPath = join(folder, `${filename}.md`);

    const frontmatter = toFrontmatter({
      node: nodeId,
      key,
      ingested: new Date().toISOString(),
    });

    const md = `${frontmatter}\n\n${value}\n`;

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, md, 'utf-8');
  }

  // Write a sync event log entry (append to daily log)
  async logEvent(eventType: string, detail: string, nodeId: string): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const folder = join(this.vaultPath, 'logs');
    const absPath = join(folder, `${today}.md`);

    const line = `- **${new Date().toISOString().split('T')[1].slice(0, 8)}** \`${eventType}\` [${nodeId}] ${detail}\n`;

    await mkdir(folder, { recursive: true });

    try {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(absPath, line, 'utf-8');
    } catch {
      await writeFile(absPath, `# CyberBase Sync Log \u2014 ${today}\n\n${line}`, 'utf-8');
    }
  }

  // Delete a sync item from vault
  async deleteSyncItem(tool: string, relPath: string): Promise<void> {
    const folder = join(this.vaultPath, 'sync', sanitizeFilename(tool));
    const filename = sanitizeFilename(relPath.replace(/\//g, '_'));
    const absPath = join(folder, filename.endsWith('.md') ? filename : `${filename}.md`);

    try {
      await unlink(absPath);
    } catch {
      // File doesn't exist, that's fine
    }
  }

  // Write vault index (MOC - Map of Content)
  async writeIndex(): Promise<void> {
    const absPath = join(this.vaultPath, 'CyberBase.md');

    const md = `---
aliases: [CyberBase, Home]
---

# CyberBase

> Unified knowledge layer \u2014 PostgreSQL primary + Obsidian backup

## Sections

- [[sync/]] \u2014 Synced config files across all nodes
- [[knowledge/]] \u2014 Tool knowledge base entries  
- [[memory/]] \u2014 Claude memory entries per node
- [[logs/]] \u2014 Daily sync event logs

## Nodes

| Node | Role | Status |
|------|------|--------|
| windows | controller | local |
| contabo | storage | remote |
| hostinger | compute | remote |
| thinkpad | gpu | remote |

## Database

- **Host:** 10.10.0.1:5432
- **Database:** cyberbase
- **Engine:** PostgreSQL 16
`;

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, md, 'utf-8');
  }
}

export function createVaultBridge(vaultPath?: string): VaultBridge {
  return new VaultBridge(vaultPath);
}
