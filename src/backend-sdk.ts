import type { MemoryBackend, SearchResult } from "./types.js";

const MEMORY_TABLE = "openclaw_memory";

interface SdkConfig {
  apiKey: string;
  apiUrl: string;
  orgId: string;
  workspaceId: string;
}

/**
 * SDK backend — stores memories in a DeepLake managed table via REST API.
 * Uses pg_deeplake's BM25 text search for retrieval.
 * No local filesystem or FUSE dependency needed.
 */
export class SdkBackend implements MemoryBackend {
  private config: SdkConfig;

  constructor(config: SdkConfig) {
    this.config = config;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.config.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "X-Activeloop-Org-Id": this.config.orgId,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DeepLake API ${method} ${path}: ${res.status} ${text}`);
    }
    return res.json().catch(() => null);
  }

  private async query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const path = `/workspaces/${this.config.workspaceId}/tables/query`;
    const body: Record<string, unknown> = { sql };
    if (params?.length) body.params = params;
    const result = await this.request("POST", path, body) as { data?: Record<string, unknown>[] };
    return result?.data ?? [];
  }

  async init(): Promise<void> {
    // Ensure memory table exists with text search support
    try {
      await this.query(`
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
      // Table might already exist, that's fine
    }

    // Create text search index if not exists
    try {
      await this.query(
        `CREATE INDEX IF NOT EXISTS idx_${MEMORY_TABLE}_content ON ${MEMORY_TABLE} USING deeplake_index (content)`
      );
    } catch {
      // Index might already exist or deeplake_index not available
    }
  }

  async write(path: string, content: string): Promise<void> {
    const id = path.replace(/[^a-zA-Z0-9_-]/g, "_");
    await this.query(
      `INSERT INTO ${MEMORY_TABLE} (id, path, content, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET content = $3, updated_at = now()`,
      [id, path, content]
    );
  }

  async read(path: string, startLine?: number, numLines?: number): Promise<string> {
    const id = path.replace(/[^a-zA-Z0-9_-]/g, "_");
    const rows = await this.query(
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
    // Use BM25 text search via deeplake_index
    let rows: Record<string, unknown>[];
    try {
      rows = await this.query(
        `SELECT id, path, content, category, created_at,
                content <#> $1 AS score
         FROM ${MEMORY_TABLE}
         ORDER BY score DESC
         LIMIT $2`,
        [query, limit]
      );
    } catch {
      // Fallback to ILIKE if deeplake_index not available
      rows = await this.query(
        `SELECT id, path, content, category, created_at, 1.0 AS score
         FROM ${MEMORY_TABLE}
         WHERE content ILIKE $1
         LIMIT $2`,
        [`%${query}%`, limit]
      );
    }

    return rows.map(row => {
      const content = row.content as string;
      // Extract snippet around first match
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
    const rows = await this.query(
      `SELECT path FROM ${MEMORY_TABLE} ORDER BY updated_at DESC`
    );
    return rows.map(r => r.path as string);
  }

  async close(): Promise<void> {}
}
