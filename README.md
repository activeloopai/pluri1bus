# memory-deeplake

DeepLake memory plugin for [OpenClaw](https://openclaw.ai) — persistent cloud-backed agent memory with vector + BM25 search.

## Install

```bash
openclaw plugins install memory-deeplake
```

This automatically sets DeepLake as your memory backend. Restart the gateway to apply.

## How it works

The plugin replaces OpenClaw's default memory with DeepLake-backed storage. It provides two tools to the agent:

- **memory_search** — semantic search over stored memories (BM25 text search)
- **memory_get** — read a specific memory file by path

Plus automatic hooks:
- **Auto-recall** — injects relevant memories before each agent turn
- **Auto-capture** — saves conversation context before compaction

## Backends

### CLI mode (FUSE mount)

If you have [deeplake CLI](https://github.com/activeloopai/deeplake) installed, the plugin auto-detects your mounts from `~/.deeplake/mounts.json`. Memory files are read/written directly on the mounted filesystem.

```bash
npm install -g deeplake
deeplake init
# Plugin auto-detects the mount — no config needed
```

### SDK mode (REST API)

Without a FUSE mount, the plugin uses DeepLake's managed API directly. Set your API key:

```bash
# In your environment
export DEEPLAKE_API_KEY=dl_xxx

# Or in openclaw config
openclaw config set plugins.entries.memory-deeplake.config.apiKey "dl_xxx"
```

### Auto mode (default)

The plugin checks for existing FUSE mounts first. If found, uses CLI mode. Otherwise, falls back to SDK mode.

## Configuration

All config is optional — the plugin works with zero config if deeplake CLI is installed.

```json5
// In openclaw.json → plugins.entries.memory-deeplake.config
{
  "mode": "auto",           // "auto" | "sdk" | "cli"
  "apiKey": "dl_xxx",       // DeepLake API key (SDK mode)
  "apiUrl": "https://api.deeplake.ai",  // Custom API endpoint
  "workspaceId": "default", // DeepLake workspace (SDK mode)
  "mountPath": "/path/to/mount",  // Override FUSE mount path (CLI mode)
  "autoCapture": true,      // Auto-save memories before compaction
  "autoRecall": true        // Auto-inject memories before each turn
}
```

## License

MIT
