import { ManagedClient, initializeWasm } from "deeplake";
import type { MemoryBackend, SearchResult } from "./types.js";

const MEMORY_TABLE = "openclaw_memory";

export interface SdkConfig {
  apiKey: string;
  apiUrl?: string;
  workspaceId?: string;
}

/**
 * SDK backend — stores memories in a DeepLake managed table via the JS SDK.
 * Uses pg_deeplake's BM25 text search for retrieval.
 * No local filesystem or FUSE dependency needed.
 */
export class SdkBackend implements MemoryBackend {
  private client: ManagedClient;

  constructor(config: SdkConfig) {
    this.client = new ManagedClient({
      token: config.apiKey,
      workspaceId: config.workspaceId ?? "default",
      apiUrl: config.apiUrl,
    });
  }

  async init(): Promise<void> {
    // @ts-expect-error — installed version requires path arg but runtime default works
    await initializeWasm();

    // Ensure memory table exists
    try {
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS ${MEMORY_TABLE} (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          content TEXT NOT NULL,
          category TEXT DEFAULT 'general',
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        )
      `);
    } catch {
      // Table might already exist
    }

    // Create BM25 text search index
    try {
      await this.client.createIndex(MEMORY_TABLE, "content");
    } catch {
      // Index might already exist
    }
  }

  async write(path: string, content: string): Promise<void> {
    const id = path.replace(/[^a-zA-Z0-9_-]/g, "_");
    await this.client.query(
      `INSERT INTO ${MEMORY_TABLE} (id, path, content, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET content = $3, updated_at = now()`,
      [id, path, content]
    );
  }

  async read(path: string, startLine?: number, numLines?: number): Promise<string> {
    const id = path.replace(/[^a-zA-Z0-9_-]/g, "_");
    const rows = await this.client.query(
      `SELECT content FROM ${MEMORY_TABLE} WHERE id = $1`,
      [id]
    );
    if (!rows.length) return "";
    const content = rows[0].content as string;
    if (startLine === undefined) return content;
    const lines = content.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = numLines ? start + numLines : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    let rows: Record<string, unknown>[];
    try {
      // BM25 text search via deeplake_index
      rows = await this.client.query(
        `SELECT id, path, content, category, created_at,
                content <#> $1 AS score
         FROM ${MEMORY_TABLE}
         ORDER BY score DESC
         LIMIT $2`,
        [query, limit]
      );
    } catch {
      // Fallback to ILIKE if deeplake_index not available
      rows = await this.client.query(
        `SELECT id, path, content, category, created_at, 1.0 AS score
         FROM ${MEMORY_TABLE}
         WHERE content ILIKE $1
         LIMIT $2`,
        [`%${query}%`, limit]
      );
    }

    return rows.map(row => {
      const content = row.content as string;
      const idx = content.toLowerCase().indexOf(query.toLowerCase());
      const snippetStart = Math.max(0, idx - 100);
      const snippet = content.slice(snippetStart, snippetStart + 700);

      return {
        entry: {
          id: row.id as string,
          content,
          path: row.path as string,
          createdAt: (row.created_at as string) ?? new Date().toISOString(),
          category: row.category as string | undefined,
        },
        score: Number(row.score ?? 0),
        snippet,
      };
    });
  }

  async list(): Promise<string[]> {
    const rows = await this.client.query(
      `SELECT path FROM ${MEMORY_TABLE} ORDER BY updated_at DESC`
    );
    return rows.map(r => r.path as string);
  }

  async close(): Promise<void> {}
}
