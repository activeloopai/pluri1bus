import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryBackend, MemoryEntry, SearchResult } from "./types.js";

/**
 * CLI backend — reads/writes memory through the deeplake FUSE mount.
 * Memory files are plain Markdown on the mounted filesystem.
 * Search falls back to simple substring matching (FUSE mount
 * doesn't expose vector search directly).
 */
export class CliBackend implements MemoryBackend {
  constructor(private mountPath: string) {}

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
    const fullPath = join(this.mountPath, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  async read(path: string, startLine?: number, numLines?: number): Promise<string> {
    const fullPath = join(this.mountPath, path);
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
    const walk = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), rel);
        } else if (entry.name.endsWith(".md")) {
          files.push(rel);
        }
      }
    };
    walk(this.mountPath, "");
    return files;
  }

  async close(): Promise<void> {}
}
