import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { MemoryBackend, MemoryEntry, SearchResult } from "./types.js";

/**
 * CLI backend — reads/writes memory through the deeplake FUSE mount.
 * Memory files are plain Markdown on the mounted filesystem.
 * Search falls back to simple substring matching (FUSE mount
 * doesn't expose vector search directly).
 */
export class CliBackend implements MemoryBackend {
  constructor(private mountPath: string) {}

  private safePath(path: string): string {
    const full = resolve(this.mountPath, path);
    if (!full.startsWith(resolve(this.mountPath))) {
      throw new Error(`Path traversal rejected: ${path}`);
    }
    return full;
  }

  async init(): Promise<void> {
    if (!existsSync(this.mountPath)) {
      throw new Error(
        `DeepLake FUSE mount not found at ${this.mountPath}. ` +
        `Run: deeplake mount ${this.mountPath}`
      );
    }
    // Ensure memory directories exist
    for (const dir of ["memory", ""]) {
      const p = join(this.mountPath, dir);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
  }

  async write(path: string, content: string): Promise<void> {
    const fullPath = this.safePath(path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  async read(path: string, startLine?: number, numLines?: number): Promise<string> {
    const fullPath = this.safePath(path);
    if (!existsSync(fullPath)) return "";
    const content = readFileSync(fullPath, "utf-8");
    if (startLine === undefined) return content;
    const lines = content.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = numLines ? start + numLines : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    const files = await this.list();
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const path of files) {
      const content = await this.read(path);
      if (!content) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          const snippetStart = Math.max(0, i - 1);
          const snippetEnd = Math.min(lines.length, i + 3);
          const snippet = lines.slice(snippetStart, snippetEnd).join("\n");
          results.push({
            entry: {
              id: `${path}:${i + 1}`,
              content,
              path,
              createdAt: new Date().toISOString(),
            },
            score: 1.0,
            snippet: snippet.slice(0, 700),
            lineStart: snippetStart + 1,
            lineEnd: snippetEnd,
          });
          break; // one match per file
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async list(): Promise<string[]> {
    const files: string[] = [];
    // Only index MEMORY.md and memory/ directory — not the entire mount
    const memoryMd = join(this.mountPath, "MEMORY.md");
    if (existsSync(memoryMd)) files.push("MEMORY.md");
    const memoryDir = join(this.mountPath, "memory");
    if (existsSync(memoryDir)) {
      for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(`memory/${entry.name}`);
        }
      }
    }
    return files;
  }

  async close(): Promise<void> {}
}
