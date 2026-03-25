import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryBackend, PluginConfig } from "./types.js";
import { CliBackend } from "./backend-cli.js";
import { SdkBackend } from "./backend-sdk.js";

function extractOrgId(token: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString()
    );
    return payload.org_id ?? payload.orgId;
  } catch {
    return undefined;
  }
}

function findDeeplakeMount(): string | null {
  try {
    const mountsFile = join(homedir(), ".deeplake", "mounts.json");
    if (!existsSync(mountsFile)) return null;
    const data = JSON.parse(readFileSync(mountsFile, "utf-8"));
    const mounts = data.mounts ?? [];
    // Return first mount that exists on disk
    for (const m of mounts) {
      if (m.mountPath && existsSync(m.mountPath)) return m.mountPath;
    }
  } catch {}
  return null;
}

function resolveBackend(config: PluginConfig): MemoryBackend {
  const mode = config.mode ?? "auto";
  const mountPath = config.mountPath ?? findDeeplakeMount() ?? join(homedir(), "agent-memory");

  if (mode === "cli" || (mode === "auto" && existsSync(mountPath))) {
    return new CliBackend(mountPath);
  }

  // SDK mode
  const apiKey = config.apiKey ?? process.env.DEEPLAKE_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "DeepLake API key required for SDK mode. " +
      "Set plugins.deeplake-memory.apiKey or DEEPLAKE_API_KEY env var."
    );
  }

  const orgId = extractOrgId(apiKey);
  if (!orgId) {
    throw new Error("Could not extract org_id from DeepLake API token.");
  }

  return new SdkBackend({
    apiKey,
    apiUrl: config.apiUrl ?? process.env.DEEPLAKE_API_URL ?? "https://api.deeplake.ai",
    orgId,
    workspaceId: config.workspaceId ?? "default",
  });
}

let backend: MemoryBackend | null = null;

async function getBackend(config: PluginConfig): Promise<MemoryBackend> {
  if (!backend) {
    backend = resolveBackend(config);
    await backend.init();
  }
  return backend;
}

export default definePluginEntry({
  id: "deeplake-memory",
  name: "DeepLake Memory",
  description: "Cloud-backed agent memory with vector + BM25 search",
  kind: "memory",

  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const logger = api.logger;

    // Memory search tool
    api.registerTool({
      name: "memory_search",
      label: "Search Memory",
      description:
        "Search agent memory for relevant past context. " +
        "Uses semantic (BM25) search over stored memories. " +
        "Returns scored snippets with file paths and line numbers.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 50 })
        ),
      }),
      async execute(_id: string, params: { query: string; limit?: number }) {
        try {
          const b = await getBackend(config);
          const results = await b.search(params.query, params.limit ?? 10);
          if (!results.length) {
            return {
              details: {},
              content: [{ type: "text" as const, text: "No matching memories found." }],
            };
          }
          const text = results
            .map((r, i) => {
              const loc = r.lineStart ? ` (${r.entry.path}#${r.lineStart})` : ` (${r.entry.path})`;
              return `**${i + 1}.** [score: ${r.score.toFixed(2)}]${loc}\n${r.snippet}`;
            })
            .join("\n\n---\n\n");
          return { details: {}, content: [{ type: "text" as const, text }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`memory_search failed: ${msg}`);
          return { details: {}, content: [{ type: "text" as const, text: `Memory search error: ${msg}` }] };
        }
      },
    });

    // Memory get tool
    api.registerTool({
      name: "memory_get",
      label: "Read Memory",
      description:
        "Read a specific memory file by path. " +
        "Optionally read from a starting line for N lines.",
      parameters: Type.Object({
        path: Type.String({ description: "File path relative to memory root (e.g. MEMORY.md, memory/2026-03-24.md)" }),
        start_line: Type.Optional(Type.Number({ description: "Starting line number" })),
        num_lines: Type.Optional(Type.Number({ description: "Number of lines to read" })),
      }),
      async execute(_id: string, params: { path: string; start_line?: number; num_lines?: number }) {
        try {
          const b = await getBackend(config);
          const text = await b.read(params.path, params.start_line, params.num_lines);
          return {
            details: {},
            content: [{
              type: "text" as const,
              text: text || `(empty or not found: ${params.path})`,
            }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { details: {}, content: [{ type: "text" as const, text: `Memory read error: ${msg}` }] };
        }
      },
    });

    // System prompt section — tells the model how to use memory
    api.registerMemoryPromptSection(({ availableTools }) => {
      const lines: string[] = [];
      const modeName = backend instanceof CliBackend ? "CLI (FUSE mount)" : "SDK (cloud API)";

      lines.push(`## Memory (DeepLake — ${modeName})`);
      lines.push("");
      lines.push("Your memories are stored in DeepLake, a cloud-backed database.");
      lines.push("Memories persist across sessions and are searchable.");
      lines.push("");

      if (availableTools.has("memory_search")) {
        lines.push("- Use `memory_search` to find relevant past context by query.");
      }
      if (availableTools.has("memory_get")) {
        lines.push("- Use `memory_get` to read a specific memory file.");
      }
      lines.push("- Write memories to `MEMORY.md` (long-term) or `memory/YYYY-MM-DD.md` (daily).");
      lines.push("- When someone says \"remember this\", write it to memory immediately.");
      lines.push("");
      return lines;
    });

    // Auto-recall hook: inject relevant memories before each turn
    if (config.autoRecall !== false) {
      api.on("before_prompt_build", async (event) => {
        try {
          const b = await getBackend(config);
          // Use last user message as search query
          const messages = (event as { messages?: Array<{ role: string; content: string }> }).messages;
          if (!messages?.length) return;
          const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
          if (!lastUserMsg?.content) return;

          const query = lastUserMsg.content.slice(0, 200);
          const results = await b.search(query, 5);
          if (!results.length) return;

          const recalled = results
            .map(r => `[${r.entry.path}] ${r.snippet.slice(0, 300)}`)
            .join("\n\n");

          logger.info?.(`Auto-recalled ${results.length} memories`);

          // Inject as system context
          const ctx = event as { systemPromptAppend?: string };
          ctx.systemPromptAppend = (ctx.systemPromptAppend ?? "") +
            "\n\n<recalled-memories>\n" + recalled + "\n</recalled-memories>\n";
        } catch (err) {
          logger.error(`Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Auto-capture hook: save memories before compaction
    if (config.autoCapture !== false) {
      api.on("before_compaction", async (event) => {
        try {
          const b = await getBackend(config);
          const messages = (event as { messages?: Array<{ role: string; content: string }> }).messages;
          if (!messages?.length) return;

          // Extract assistant messages that mention "remember" or contain key decisions
          const toCapture = messages
            .filter(m => m.role === "assistant" && m.content)
            .map(m => m.content)
            .join("\n\n");

          if (toCapture.length < 50) return;

          const date = new Date().toISOString().split("T")[0];
          const path = `memory/${date}.md`;
          const existing = await b.read(path);
          const entry = `\n\n---\n_Auto-captured at ${new Date().toISOString()}_\n\n${toCapture.slice(0, 2000)}`;
          await b.write(path, existing + entry);

          logger.info?.(`Auto-captured ${toCapture.length} chars to ${path}`);
        } catch (err) {
          logger.error(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    logger.info(`DeepLake memory plugin registered (mode: ${config.mode ?? "auto"})`);
  },
});
