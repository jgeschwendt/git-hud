# Bare Worktree Manager - Bun Rewrite Implementation Plan

**Version:** 2.0  
**Target:** Single binary distribution with Bun  
**Timeline:** 8-12 days  
**Status:** Planning

---

## Executive Summary

rewrite bare from current Next.js app into a single binary using Bun's `bun build --compile` feature. eliminate installation friction (no more `git clone` + `npm install` + `npm link`), fix race conditions in concurrent worktree creation, and add VSCode integration + git status tracking.

**Current State:**

- V1: Next.js app with amazing adoption despite being sloppy
- Issue: optimistic updates lost during revalidation with concurrent creates
- Issue: installation requires Node.js, git clone, npm install, npm link

**Target State:**

- V2: single binary (~50-80MB) installable via `curl | bash`
- fix: state reconciliation pattern (merge vs replace)
- add: VSCode window tracking
- add: git status indicators (dirty, ahead, behind)
- add: auto-updates in background

---

## Technology Stack

### Core

- **Runtime:** Bun (embeds runtime + compiles to binary)
- **Framework:** Next.js 15 (standalone mode)
- **Database:** SQLite (Bun built-in)
- **Patterns:** Server Actions + SSE (no WebSockets/GraphQL/tRPC)

---

## Architecture Decisions

**Why Server Actions + SSE?**

- ✅ Already using Server Actions with streaming
- ✅ SSE perfect for one-way progress updates
- ✅ No bi-directional communication needed
- ✅ Simpler than WebSockets/GraphQL
- ✅ Type-safe without tRPC overhead

**Why SQLite over JSON?**

- ✅ Atomic operations (no file race conditions)
- ✅ Built into Bun (zero dependencies)
- ✅ Fast queries with prepared statements
- ✅ Easy migrations and concurrent access

**Why Bun over pkg/nexe?**

- ✅ Active development, modern
- ✅ Single command: `bun build --compile`
- ✅ Works with Next.js standalone
- ✅ Fast compile times
- ❌ Larger binary size (acceptable trade-off)

---

## Project Structure

```
bare-v2/
├── cli/
│   ├── index.ts                  # Entry point
│   ├── server.ts                 # Custom Next.js server
│   ├── updater.ts                # Auto-update logic
│   ├── vscode-bridge.ts          # VSCode integration
│   ├── git-operations.ts         # Git commands
│   ├── git-watcher.ts            # FS watcher for status
│   ├── speed-engine.ts           # Fast worktree creation
│   └── db.ts                     # SQLite schema
│
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── actions.ts            # Server Actions
│   │   └── api/
│   │       └── worktree/[path]/progress/route.ts
│   │
│   ├── components/
│   │   ├── worktree-manager.tsx  # Main component
│   │   ├── worktree-row.tsx
│   │   └── ui/
│   │
│   └── lib/
│       ├── event-bus.ts
│       ├── types.ts
│       └── utils.ts
│
├── scripts/
│   ├── build.sh
│   └── build-all.sh
│
├── .github/workflows/
│   └── release.yml
│
├── install.sh
├── next.config.ts
└── package.json
```

---

## Implementation Phases

### Phase 1: Project Setup (Day 1)

```bash
# Initialize
mkdir bare-v2 && cd bare-v2
bun init -y
bun add next@latest react@latest react-dom@latest
bun add better-sqlite3
bun add -d @types/react @types/node typescript
```

**next.config.ts:**

```typescript
import path from "path";
export default {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "./"),
  experimental: {
    outputFileTracingIncludes: {
      "/": ["./cli/**/*"],
    },
  },
};
```

---

### Phase 2: Database Schema (Day 2)

**cli/db.ts:**

```typescript
import { Database } from "bun:sqlite";
import path from "path";
import os from "os";

const DB_DIR = path.join(os.homedir(), ".config", "bare");
const DB_PATH = path.join(DB_DIR, "bare.db");

await Bun.write(path.join(DB_DIR, ".keep"), "");

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    type TEXT,
    remote_url TEXT,
    last_synced INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS worktrees (
    path TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    head TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    commit_message TEXT,
    created_at INTEGER NOT NULL,
    vscode_pid INTEGER,
    vscode_opened_at INTEGER,
    git_dirty BOOLEAN DEFAULT 0,
    git_ahead INTEGER DEFAULT 0,
    git_behind INTEGER DEFAULT 0,
    FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
  );
`);

export const queries = {
  createWorktree: db.prepare(`
    INSERT INTO worktrees (path, repo_id, branch, head, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getWorktreesByRepo: db.prepare(`
    SELECT * FROM worktrees WHERE repo_id = ? ORDER BY path
  `),
  updateWorktreeStatus: db.prepare(`
    UPDATE worktrees SET status = ?, commit_message = ? WHERE path = ?
  `),
  updateVSCodePid: db.prepare(`
    UPDATE worktrees SET vscode_pid = ?, vscode_opened_at = ? WHERE path = ?
  `),
  updateGitStatus: db.prepare(`
    UPDATE worktrees SET git_dirty = ?, git_ahead = ?, git_behind = ? WHERE path = ?
  `),
};
```

---

### Phase 3: Git Operations (Day 3)

**cli/git-operations.ts:**

```typescript
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

export class GitOperations {
  async createWorktree(
    repoPath: string,
    branch: string,
    onProgress: (msg: string) => void
  ): Promise {
    const worktreeName = branch.replace(/[^a-zA-Z0-9-_]/g, "-");
    const worktreePath = path.join(path.dirname(repoPath), worktreeName);

    onProgress("Creating worktree...");
    await execAsync(`git worktree add "${worktreePath}" "${branch}"`, {
      cwd: repoPath,
    });

    onProgress("Installing dependencies...");
    await execAsync("pnpm install --frozen-lockfile", {
      cwd: worktreePath,
    });

    return worktreePath;
  }

  async getStatus(worktreePath: string) {
    const [porcelain, revList] = await Promise.all([
      execAsync("git status --porcelain", { cwd: worktreePath }),
      execAsync("git rev-list --left-right --count HEAD...@{u}", {
        cwd: worktreePath,
      }).catch(() => ({ stdout: "0\t0" })),
    ]);

    const dirty = porcelain.stdout.trim().length > 0;
    const [ahead, behind] = revList.stdout.trim().split("\t").map(Number);

    return { dirty, ahead: ahead || 0, behind: behind || 0 };
  }
}

export const git = new GitOperations();
```

---

### Phase 4: Event Bus (Day 3)

**cli/event-bus.ts:**

```typescript
import { EventEmitter } from "events";

class BareEventBus extends EventEmitter {
  emitWorktreeProgress(event: {
    worktreePath: string;
    type: "progress" | "complete" | "error";
    message: string;
  }) {
    this.emit("worktree:progress", event);
  }

  onWorktreeProgress(handler: (event: any) => void) {
    this.on("worktree:progress", handler);
    return () => this.off("worktree:progress", handler);
  }
}

export const eventBus = new BareEventBus();
```

---

### Phase 5: VSCode Integration (Day 4)

**cli/vscode-bridge.ts:**

```typescript
import { spawn } from "child_process";
import { queries } from "./db";
import { eventBus } from "./event-bus";

class VSCodeBridge {
  private instances = new Map();

  async open(worktreePath: string) {
    const proc = spawn("code", [worktreePath, "--new-window"], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();

    const instance = {
      worktreePath,
      pid: proc.pid!,
      openedAt: new Date(),
      status: "opening",
    };

    this.instances.set(worktreePath, instance);

    setTimeout(async () => {
      const isRunning = await this.isProcessRunning(proc.pid!);
      if (isRunning) {
        instance.status = "open";
        queries.updateVSCodePid.run(proc.pid, Date.now(), worktreePath);
        eventBus.emitVSCodeEvent({ worktreePath, action: "opened" });
      }
    }, 1000);

    return instance;
  }

  private async isProcessRunning(pid: number): Promise {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export const vscode = new VSCodeBridge();
```

---

### Phase 6: Server Actions (Day 5)

**src/app/actions.ts:**

```typescript
"use server";

import { queries } from "@/cli/db";
import { git } from "@/cli/git-operations";
import { eventBus } from "@/cli/event-bus";

export async function createWorktree(
  repoId: string,
  repoPath: string,
  branch: string
) {
  const tempPath = `${repoPath}/../${branch}`;

  // Create optimistic record
  queries.createWorktree.run(
    tempPath,
    repoId,
    branch,
    "",
    "creating",
    Date.now()
  );

  // Emit event
  eventBus.emitWorktreeProgress({
    worktreePath: tempPath,
    type: "progress",
    message: "Creating...",
  });

  // Start async work
  git
    .createWorktree(repoPath, branch, (message) => {
      eventBus.emitWorktreeProgress({
        worktreePath: tempPath,
        type: "progress",
        message,
      });
    })
    .then((actualPath) => {
      queries.updateWorktreeStatus.run("ready", "", actualPath);
      eventBus.emitWorktreeProgress({
        worktreePath: actualPath,
        type: "complete",
        message: "Done!",
      });
    });

  return { path: tempPath };
}
```

---

### Phase 7: SSE Endpoint (Day 5)

**src/app/api/worktree/[path]/progress/route.ts:**

```typescript
import { NextRequest } from "next/server";
import { eventBus } from "@/cli/event-bus";

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string } }
) {
  const worktreePath = decodeURIComponent(params.path);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = eventBus.onWorktreeProgress((event) => {
        if (event.worktreePath === worktreePath) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );

          if (event.type === "complete" || event.type === "error") {
            controller.close();
          }
        }
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
```

---

### Phase 8: State Reconciliation (Day 6)

**src/components/worktree-manager.tsx:**

```typescript
'use client';

import { useState, useMemo, useTransition } from 'react';

interface WorktreeState {
  server: Worktree[];
  creating: Map;
  deleting: Set;
  progress: Map;
}

function reconcile(state: WorktreeState): Worktree[] {
  const serverPaths = new Set(state.server.map(wt => wt.path));

  // Remove deleting
  let result = state.server.filter(wt => !state.deleting.has(wt.path));

  // Add creating items not in server yet
  const pendingCreates = Array.from(state.creating.values())
    .filter(({ realPath }) => !realPath || !serverPaths.has(realPath))
    .map(({ worktree }) => worktree);

  return [...result, ...pendingCreates];
}

export function WorktreeManager({ initial }: { initial: Worktree[] }) {
  const [state, setState] = useState({
    server: initial,
    creating: new Map(),
    deleting: new Set(),
    progress: new Map()
  });

  const worktrees = useMemo(() => reconcile(state), [state]);

  async function handleCreate(branch: string) {
    const tempId = crypto.randomUUID();
    const tempPath = `pending-${tempId}`;

    // Add placeholder
    setState(prev => ({
      ...prev,
      creating: new Map(prev.creating).set(tempId, {
        worktree: { path: tempPath, branch, status: 'creating' }
      })
    }));

    // Call server action
    const result = await createWorktree(repoId, repoPath, branch);

    // Update with real path
    setState(prev => {
      const creating = new Map(prev.creating);
      const item = creating.get(tempId);
      if (item) {
        item.realPath = result.path;
        item.worktree.path = result.path;
      }
      return { ...prev, creating };
    });

    // Subscribe to progress
    const es = new EventSource(`/api/worktree/${encodeURIComponent(result.path)}/progress`);

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'progress') {
        setState(prev => ({
          ...prev,
          progress: new Map(prev.progress).set(result.path, data.message)
        }));
      }

      if (data.type === 'complete') {
        // Refresh server state (MERGE, don't replace)
        startTransition(async () => {
          const fresh = await fetch('/api/worktrees').then(r => r.json());

          setState(prev => {
            const creating = new Map(prev.creating);
            creating.delete(tempId);

            return {
              ...prev,
              server: fresh,
              creating
            };
          });
        });

        es.close();
      }
    };
  }

  return (

      {worktrees.map(wt => (

      ))}

  );
}
```

---

### Phase 9: Build System (Day 7)

**scripts/build.sh:**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "Building Next.js standalone..."
bun run next build

echo "Copying static assets..."
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static

echo "Compiling to binary..."
bun build --compile \
  --minify \
  --target=bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m) \
  --outfile=dist/bare \
  ./cli/index.ts

echo "Binary created at: dist/bare"
echo "Size: $(du -h dist/bare | cut -f1)"
```

**scripts/build-all.sh:**

```bash
#!/usr/bin/env bash
set -euo pipefail

PLATFORMS=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
)

bun run next build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static

mkdir -p dist

for platform in "${PLATFORMS[@]}"; do
  echo "Building for $platform..."
  bun build --compile \
    --minify \
    --target="$platform" \
    --outfile="dist/bare-$platform" \
    ./cli/index.ts
done

ls -lh dist/
```

---

### Phase 10: Installation & Auto-Update (Day 8)

**install.sh:**

```bash
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/bare"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
fi

BINARY="bare-${OS}-${ARCH}"
URL="https://github.com/jgeschwendt/bare/releases/latest/download/${BINARY}"

echo "Installing bare for ${OS}-${ARCH}..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

echo "Downloading from $URL..."
curl -fsSL "$URL" -o "${INSTALL_DIR}/bare"

chmod +x "${INSTALL_DIR}/bare"

if [ ! -f "${CONFIG_DIR}/config.json" ]; then
  echo '{"repositories":[]}' > "${CONFIG_DIR}/config.json"
fi

echo "Installation complete!"
echo "Run: bare start"
```

**cli/updater.ts:**

```typescript
import { version } from "../package.json";

export async function checkForUpdates(): Promise {
  const response = await fetch(
    "https://api.github.com/repos/jgeschwendt/bare/releases/latest"
  );

  const release = await response.json();
  const latestVersion = release.tag_name.replace("v", "");

  if (latestVersion === version) return;

  console.log(`Update available: ${version} → ${latestVersion}`);

  const platform = process.platform;
  const arch = process.arch === "x64" ? "x64" : "arm64";
  const assetName = `bare-${platform}-${arch}`;

  const asset = release.assets.find((a: any) => a.name === assetName);
  if (!asset) return;

  console.log("Downloading update...");
  const binaryData = await fetch(asset.browser_download_url).then((r) =>
    r.arrayBuffer()
  );

  await Bun.write(process.execPath, binaryData);
  await chmod(process.execPath, 0o755);

  console.log("Updated! Restart to use new version");
}
```

**cli/index.ts:**

```typescript
import { checkForUpdates } from "./updater";
import { startServer } from "./server";
import { migrateFromV1 } from "./migrate-from-v1";

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "start":
      checkForUpdates().catch(() => {});
      await migrateFromV1();
      await startServer();
      break;

    case "update":
      await checkForUpdates();
      break;

    case "version":
      console.log(require("../package.json").version);
      break;

    default:
      console.log("Usage: bare [start|update|version]");
  }
}

main();
```

---

### Phase 11: GitHub Actions (Day 9)

**.github/workflows/release.yml:**

```yaml
name: Release

on:
  push:
    tags: ["v*.*.*"]

jobs:
  build:
    strategy:
      matrix:
        include:
          - {
              os: ubuntu-latest,
              target: bun-linux-x64,
              artifact: bare-linux-x64,
            }
          - {
              os: ubuntu-latest,
              target: bun-linux-arm64,
              artifact: bare-linux-arm64,
            }
          - {
              os: macos-latest,
              target: bun-darwin-x64,
              artifact: bare-darwin-x64,
            }
          - {
              os: macos-latest,
              target: bun-darwin-arm64,
              artifact: bare-darwin-arm64,
            }

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run next build
      - run: |
          cp -r public .next/standalone/public
          cp -r .next/static .next/standalone/.next/static
      - run: |
          bun build --compile \
            --minify \
            --target=${{ matrix.target }} \
            --outfile=${{ matrix.artifact }} \
            ./cli/index.ts
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: artifacts/**/*
          generate_release_notes: true
```

---

## Testing Strategy (Days 10-11)

### Manual Testing Checklist

- [ ] Install via `curl | bash`
- [ ] Create 4 worktrees concurrently
- [ ] Verify no UI race conditions
- [ ] Test VSCode opening/closing tracking
- [ ] Test git status indicators update
- [ ] Test bulk delete operations
- [ ] Test sync main with concurrent creates
- [ ] Test auto-update mechanism
- [ ] Test migration from V1
- [ ] Binary size < 100MB
- [ ] Startup time < 2 seconds

### Automated Tests

```typescript
// tests/reconciliation.test.ts
import { describe, it, expect } from "bun:test";

describe("State Reconciliation", () => {
  it("merges server data with creating placeholders", () => {
    const server = [{ path: "/wt1", status: "ready" }];
    const creating = new Map([
      ["id1", { worktree: { path: "/wt2", status: "creating" } }],
    ]);

    const result = reconcile({
      server,
      creating,
      deleting: new Set(),
      progress: new Map(),
    });

    expect(result).toHaveLength(2);
  });

  it("removes placeholders when they appear in server", () => {
    const server = [
      { path: "/wt1", status: "ready" },
      { path: "/wt2", status: "ready" },
    ];
    const creating = new Map([
      [
        "id1",
        {
          worktree: { path: "/wt2", status: "creating" },
          realPath: "/wt2",
        },
      ],
    ]);

    const result = reconcile({
      server,
      creating,
      deleting: new Set(),
      progress: new Map(),
    });

    expect(result).toHaveLength(2);
    expect(result.find((w) => w.path === "/wt2")?.status).toBe("ready");
  });
});
```

---

## Success Metrics

**Installation:**

- ✅ Single `curl` command
- ✅ No Node.js required
- ✅ <30 seconds to install
- ✅ <100MB binary size

**Performance:**

- ✅ Binary starts in <2 seconds
- ✅ Handles 10+ concurrent creates
- ✅ No state race conditions

**Features:**

- ✅ VSCode window tracking
- ✅ Git status (dirty, ahead, behind)
- ✅ Streaming progress updates
- ✅ Auto-updates

---

## Migration Strategy

1. **Week 1-2:** Build V2 in parallel repo
2. **Week 3:** Beta test with 3-5 users
3. **Week 4:** Gradual migration (5 users/day)
4. **Week 5:** Full cutover, archive V1

---

## Known Issues to Fix

### Critical

1. Race condition with concurrent creates ✅ FIXED via reconciliation
2. Installation friction ✅ FIXED via single binary
3. Placeholder worktrees disappearing ✅ FIXED via merge pattern

### Future Enhancements

1. Hardlink node_modules for speed
2. Claude Code LSP integration
3. Multi-user support
4. Windows native support

---

## Timeline Estimate

| Phase     | Days     | Description             |
| --------- | -------- | ----------------------- |
| 1-2       | 1-2      | Setup + Database        |
| 3-4       | 1-2      | Git Operations + Events |
| 5         | 1        | VSCode Integration      |
| 6-7       | 1-2      | Server Actions + SSE    |
| 8         | 1-2      | State Reconciliation    |
| 9         | 1        | Build System            |
| 10        | 1        | Auto-Update             |
| 11        | 1        | GitHub Actions          |
| 12-13     | 2        | Testing                 |
| **Total** | **8-12** |                         |

---

## Next Actions for Claude Code

Execute these steps in order:

1. `mkdir bare-v2 && cd bare-v2`
2. `bun init -y`
3. Install dependencies from Phase 1
4. Create `cli/db.ts` with schema
5. Create `cli/git-operations.ts`
6. Create `cli/event-bus.ts`
7. Create `cli/vscode-bridge.ts`
8. Create `src/app/actions.ts`
9. Create SSE endpoint
10. Create reconciliation component
11. Create build scripts
12. Test locally
13. Deploy

---

**Status:** Ready for implementation  
**Confidence:** High  
**Risk:** Low (proven patterns)
