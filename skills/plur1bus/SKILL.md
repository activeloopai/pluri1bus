---
name: plur1bus
description: Cloud-backed shared memory for AI agents powered by DeepLake. Install once, memory persists across sessions, machines, and channels. Use when agents need persistent memory, shared context, or cross-session recall.
allowed-tools: Bash, Read, Write, Edit
---

# Plur1bus — Shared Agent Memory

Cloud-backed memory that syncs across all your agents via DeepLake.

## Setup (one time)

### Step 1: Install the plugin
```bash
openclaw plugins install plur1bus
```

### Step 2: Restart the gateway
```bash
openclaw gateway restart
```

### Step 3: Send a message
The plugin will automatically:
1. Send you an authentication link — click it to sign in to DeepLake
2. Install the DeepLake CLI in the background
3. Create a cloud-backed mount at `~/deeplake`
4. Start syncing memory

After authenticating, send another message and memory is active.

## How it works

After setup, a folder appears at `~/deeplake`. Everything written there syncs to DeepLake cloud in real-time.

**The agent reads and writes memory using standard file operations:**

```bash
# Read memory
cat ~/deeplake/MEMORY.md

# Search memory
grep -rni "keyword" ~/deeplake/MEMORY.md ~/deeplake/memory/

# Write memory
echo "User prefers concise answers" >> ~/deeplake/MEMORY.md
```

**The plugin automatically:**
- Recalls relevant memories before each conversation turn
- Captures conversation context after each turn

## Memory structure

```
~/deeplake/
├── MEMORY.md          # Long-term facts and preferences
├── memory/            # Daily conversation logs
│   ├── 2026-04-01.md
│   └── 2026-04-02.md
├── CLAUDE.md          # Agent instructions (auto-generated)
└── README.md          # Mount documentation
```

## Shared memory

Multiple agents on different machines can share the same memory:
1. Both users must be in the same DeepLake organization
2. Both install plur1bus and authenticate
3. Memories written by one agent are instantly visible to the other

To invite someone to your org, use the DeepLake dashboard.

## Troubleshooting

**"DeepLake mount not found"** — Run `deeplake mount --all` or `deeplake init` to create a mount.

**Auth link not appearing** — The plugin sends the auth URL in the agent's response. If it doesn't appear, restart the gateway and try again.

**Mount not syncing** — Check `deeplake list` to verify the mount is running. If stopped, run `deeplake mount --all`.
