export interface MemoryEntry {
  id: string;
  content: string;
  path: string;
  /** ISO timestamp */
  createdAt: string;
  /** Optional category: decision, preference, fact, daily */
  category?: string;
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface MemoryBackend {
  /** Initialize connection / verify mount */
  init(): Promise<void>;
  /** Store a memory entry */
  write(path: string, content: string): Promise<void>;
  /** Read a memory file */
  read(path: string, startLine?: number, numLines?: number): Promise<string>;
  /** Search memories by query (semantic + BM25) */
  search(query: string, limit?: number): Promise<SearchResult[]>;
  /** List memory files */
  list(): Promise<string[]>;
  /** Close connections */
  close(): Promise<void>;
}

export interface PluginConfig {
  mode?: "auto" | "sdk" | "cli";
  apiKey?: string;
  apiUrl?: string;
  workspaceId?: string;
  mountPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
}
