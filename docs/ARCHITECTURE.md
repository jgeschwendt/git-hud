# git-hud v2 Architecture

This document outlines the foundational architectural decisions that guide all implementation.

---

## Directory Architecture

```
~/.git-hud/                         # Installation root
├── bin/
│   └── git-hud                     # Compiled binary
├── data/
│   └── repos.db                    # SQLite database
├── clones/                         # All cloned repositories
│   └── github/
│       └── {username}/
│           └── {repo}/
│               ├── .bare/          # Bare git repository
│               ├── .git            # File pointing to .bare
│               ├── __main__/       # Primary worktree
│               └── ../{worktree}/  # Feature worktrees (siblings)
└── logs/
    └── git-hud.log                 # Application logs
```

**Key Decisions**:
- **Centralized clones**: All repositories under `~/.git-hud/clones/` prevents path conflicts
- **Provider hierarchy**: `github/{user}/{repo}` pattern extensible to `gitlab/`, `bitbucket/`
- **Sibling worktrees**: Keep feature worktrees as siblings to main repo directory
- **Single database**: SQLite for all metadata (repos, worktrees, config)

**Rationale**:
- Predictable paths enable automation and scripting
- Provider-based hierarchy supports multi-platform git hosting
- Centralization prevents user path conflicts (no more `~/GitHub/user/repo` assumptions)
- SQLite provides atomic operations and referential integrity

---

## Process Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     git-hud Binary                          │
│                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   HTTP      │    │   Event      │    │   File       │  │
│  │   Server    │───▶│   Bus        │◀───│   Watcher    │  │
│  │  (Next.js)  │    │  (EventEmitter)  │  (chokidar)  │  │
│  └─────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                    │        │
│         ▼                    ▼                    ▼        │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Server     │    │   Git        │    │   Database   │  │
│  │  Actions    │───▶│   Operations │───▶│   (SQLite)   │  │
│  └─────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                             │
│         ▼                    ▼                             │
│  ┌─────────────┐    ┌──────────────┐                      │
│  │   SSE       │    │   External   │                      │
│  │  Streams    │    │   Processes  │                      │
│  │             │    │  (git, vscode)│                     │
│  └─────────────┘    └──────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

**Data Flow**:
1. User action → Server Action
2. Server Action → Git Operations → Database
3. Git Operations → Event Bus
4. Event Bus → SSE Stream → Client
5. File Watcher → Event Bus → SSE Stream → Client

**Concurrency Model**:
- **Server Actions**: Async, non-blocking
- **Git Operations**: Queued per repository (prevent conflicts)
- **SSE Streams**: One per long operation
- **File Watcher**: Debounced events (500ms)
- **Database**: WAL mode for concurrent reads

---

## State Management Architecture

**Problem**: Concurrent worktree creation causes UI race conditions when server revalidations overwrite optimistic updates.

**Solution**: Three-tier state reconciliation

```typescript
type ClientState = {
  // Source of truth from server
  server: Worktree[]

  // Optimistic creates (not yet in server)
  creating: Map<UUID, {
    worktree: Worktree     // Placeholder with temporary path
    realPath?: string      // Actual path after creation starts
  }>

  // Pending deletes (still in server)
  deleting: Set<string>    // Worktree paths marked for deletion

  // Live progress messages
  progress: Map<string, string>  // path → message
}

function reconcile(state: ClientState): Worktree[] {
  const serverPaths = new Set(state.server.map(w => w.path))

  // 1. Remove deleting items
  let result = state.server.filter(w => !state.deleting.has(w.path))

  // 2. Add creating items not yet in server
  const pending = Array.from(state.creating.values())
    .filter(({ realPath }) => !realPath || !serverPaths.has(realPath))
    .map(({ worktree }) => worktree)

  return [...result, ...pending]
}
```

**State Transitions**:
```
[User clicks create]
  → Add to creating map with temp UUID
  → Call server action (async)
  → Server action returns real path
  → Update creating map with real path
  → Subscribe to SSE stream

[SSE: progress]
  → Update progress map

[SSE: complete]
  → Refetch server state (MERGE with current)
  → Remove from creating map
  → Clear progress
```

**Critical Insight**: Track both temporary paths (for instant UI feedback) and real paths (from server). Only remove placeholder when real path appears in server data. This prevents the race condition where server revalidation overwrites optimistic state.

---

## Installation Architecture

**Single Binary Approach**:
```
Bun Runtime + Next.js Standalone + SQLite
  ↓
bun build --compile
  ↓
Single 50-80MB binary (no external dependencies)
```

**Installation Flow**:
```bash
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/git-hud/main/install.sh | bash
  ↓
1. Detect OS + Architecture
2. Download appropriate binary from GitHub releases
3. Place in ~/.git-hud/bin/git-hud
4. Add ~/.git-hud/bin to PATH
5. Initialize database and directory structure
6. Ready to launch: git-hud start
```

**Auto-Update Strategy**:
- Check GitHub releases API on startup (non-blocking)
- Download new binary in background if available
- Replace binary atomically on next restart
- Preserve database with schema migrations

**Supported Platforms**:
- macOS (x64, arm64)
- Linux (x64, arm64)

---

## Technology Stack

**Core**:
- **Runtime**: Bun (embeds runtime + compiles to binary)
- **Framework**: Next.js 15 (standalone mode)
- **Database**: SQLite (Bun built-in via better-sqlite3)
- **Patterns**: Server Actions + SSE (no WebSockets/GraphQL/tRPC)

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

## Design Principles

1. **Instant Feedback**: Placeholders and optimistic updates
2. **Real-time Progress**: SSE streams for all long operations
3. **Smart Caching**: Warm dependency store, package manager caching
4. **File Sharing**: Symlinks for shared, copies for independent
5. **Minimal Configuration**: Sensible defaults, optional overrides
6. **Repository Scoping**: Operations scoped to prevent cross-repo issues
7. **External Integration**: Seamless handoff to VS Code, Terminal, Claude
8. **Bare Repository Pattern**: Efficient disk usage, shared git database
9. **Upstream Flexibility**: Configure base remote per repository
10. **Type Safety**: Full TypeScript, shared types across client/server

---

## Event System

**Event Bus Pattern**:
```typescript
class EventBus extends EventEmitter {
  emitWorktreeEvent(event: WorktreeEvent) {
    this.emit(`worktree:${event.worktreePath}`, event)
  }

  onWorktreeEvents(worktreePath: string, handler: (event) => void) {
    this.on(`worktree:${worktreePath}`, handler)
    return () => this.off(`worktree:${worktreePath}`, handler)
  }
}
```

**Event Types**:
- `worktree:progress` - Progress updates during creation
- `worktree:complete` - Worktree ready
- `worktree:error` - Operation failed

**Flow**:
```
Git Operation → Event Bus → SSE Endpoint → Client EventSource
```

---

## File System Organization

**Repository Structure** (example: `github/jgeschwendt/git-hud`):
```
~/.git-hud/clones/github/jgeschwendt/git-hud/
├── .bare/                    # Bare git repository (all objects)
├── .git                      # File: "gitdir: ./.bare"
└── __main__/                 # Primary worktree

~/.git-hud/clones/github/jgeschwendt/feature-x/
└── [worktree files]          # Sibling to repo directory

~/.git-hud/clones/github/jgeschwendt/bugfix-y/
└── [worktree files]          # Another sibling
```

**Bare Repository Benefits**:
- Single git database shared across worktrees
- No duplicate objects (saves disk space)
- Worktrees are just working directories
- Can delete worktree without losing git data
- All worktrees share same refs (branches/tags)

**Worktree File Sharing**:
```
__main__/.env            → symlinked to all worktrees (shared config)
__main__/.claude/        → symlinked to all worktrees (shared context)
__main__/.env.example    → copied to worktrees (independent template)
__main__/node_modules/   → warm cache for fast installs
```
