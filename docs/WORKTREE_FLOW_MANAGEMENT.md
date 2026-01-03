---
title: Worktree Flow Diagrams
type: note
permalink: docs/worktree-flow-diagrams
---

# Worktree Flow Diagrams

## Architecture Overview

Grove uses a **server-pushed state** architecture:
- Single SSE endpoint (`/api/state`) pushes full state on every change
- Fire-and-forget API calls - no response needed, state arrives via SSE
- Progress tracked in-memory on server, included in state pushes
- No optimistic UI - server is single source of truth

## Clone Repository Flow

```mermaid
sequenceDiagram
    participant UI as Repository Table
    participant API as /api/clone
    participant Clone as clone.ts
    participant State as state.ts
    participant DB as SQLite
    participant Git as Git CLI

    UI->>API: POST /api/clone {url}
    API->>Clone: cloneRepository(url) [fire-and-forget]
    API-->>UI: {ok: true}

    Clone->>State: setProgress(tempKey, "Cloning...")
    State-->>UI: SSE push (full state + progress)
    Clone->>Git: git clone --bare

    Clone->>Git: git config remote.origin.fetch
    Clone->>Git: git fetch origin
    Clone->>State: setProgress(tempKey, "Fetching branches...")
    State-->>UI: SSE push

    Clone->>Git: git symbolic-ref (detect default branch)
    Clone->>DB: insertRepository()
    Clone->>State: onDbChange()
    State-->>UI: SSE push (repo appears)

    Clone->>DB: insertWorktree(.main, status="creating")
    Clone->>State: onDbChange()
    State-->>UI: SSE push (worktree appears)

    Clone->>Git: git worktree add .main
    Clone->>Clone: detectPackageManager(.main)
    Clone->>Clone: runInstall(.main)
    Clone->>State: setProgress(repoId, "Installing...")
    State-->>UI: SSE push

    Clone->>Git: getGitStatus(.main)
    Clone->>DB: updateWorktreeStatus("ready")
    Clone->>State: setProgress(repoId, null)
    Clone->>State: onDbChange()
    State-->>UI: SSE push (final state)
```

## Create Worktree Flow

```mermaid
sequenceDiagram
    participant UI as Repository Table
    participant API as /api/worktree
    participant WT as worktree.ts
    participant Sync as mainSyncInProgress Map
    participant State as state.ts
    participant DB as SQLite
    participant Git as Git CLI

    UI->>API: POST /api/worktree {repo_id, branch}
    API->>WT: createWorktree(repoId, branch) [fire-and-forget]
    API-->>UI: {ok: true}

    Note over WT: Step 1: DB insert (immediate visibility)
    WT->>State: setProgress(worktreePath, "Queued...")
    WT->>DB: insertWorktree(status="creating")
    WT->>State: onDbChange()
    State-->>UI: SSE push (worktree appears with "creating" status)

    Note over WT,Sync: Step 2: Sync main (shared across concurrent requests)
    WT->>Sync: Check mainSyncInProgress[repoId]
    alt Sync already running
        WT->>State: setProgress(repoId, "Waiting for sync...")
        WT->>Sync: await existing promise
    else No sync running
        WT->>Sync: Create sync promise
        WT->>State: setProgress(repoId, "Fetching...")
        WT->>Git: git fetch (bare repo)
        WT->>State: setProgress(repoId, "Pulling main...")
        WT->>Git: git pull (.main worktree)
        WT->>WT: detectPackageManager(.main)
        WT->>WT: runInstall(.main)
        WT->>Sync: Delete promise, set lastSyncedAt
    end

    Note over WT: Step 3: Create git worktree
    WT->>State: setProgress(worktreePath, "Creating worktree...")
    WT->>Git: git worktree add (try existing branch)
    alt Branch not found
        WT->>Git: git worktree add -b (create new branch)
    end

    Note over WT: Step 4: Share files from .main
    WT->>State: setProgress(worktreePath, "Sharing files...")
    WT->>DB: getWorktreeConfig()
    WT->>Git: shareFiles(.main → worktree)

    Note over WT: Step 5: Install dependencies
    WT->>WT: detectPackageManager(worktree)
    WT->>WT: runInstall(worktree)
    WT->>State: setProgress(worktreePath, "Installing...")
    State-->>UI: SSE push

    Note over WT: Step 6: Finalize
    WT->>Git: getGitStatus(worktree)
    WT->>DB: updateWorktreeStatus("ready")
    WT->>DB: updateWorktreeGitStatus(dirty, ahead, behind)
    WT->>State: setProgress(worktreePath, null)
    WT->>State: setProgress(repoId, null)
    WT->>State: onDbChange()
    State-->>UI: SSE push (final state)
```

## Concurrent Worktree Creation

The `mainSyncInProgress` Map ensures main sync is shared across concurrent requests:

```mermaid
sequenceDiagram
    participant WT1 as Worktree 1
    participant WT2 as Worktree 2
    participant WT3 as Worktree 3
    participant Sync as mainSyncInProgress
    participant Main as .main worktree

    Note over WT1,WT3: All 3 requests arrive simultaneously

    WT1->>Sync: Check map - empty
    WT1->>Sync: Create promise, add to map
    WT2->>Sync: Check map - promise exists
    WT2->>Sync: await promise (no new sync)
    WT3->>Sync: Check map - promise exists
    WT3->>Sync: await promise (no new sync)

    WT1->>Main: Fetch → Pull → Install
    Note over WT1: Only WT1 does the actual work
    WT1->>Sync: Promise resolves, set lastSyncedAt

    Note over WT2,WT3: WT2 and WT3 resume immediately

    Note over WT1,WT3: All 3 create their worktrees in parallel
```

Additionally, a 10-second cooldown (`SYNC_COOLDOWN_MS`) skips sync entirely if main was recently synced.

## Server State

```typescript
// state.ts - Server-side state manager
type FullState = {
  repositories: RepoWithWorktrees[];
  progress: Record<string, string>;  // path → message
};

// In-memory progress tracking
const progress = new Map<string, string>();

// SSE listeners
const listeners = new Set<(state: FullState) => void>();

// Called after any mutation
function pushState(): void {
  const state = getFullState();
  for (const listener of listeners) {
    listener(state);
  }
}
```

## UI State

The UI simply receives and renders server state:

```typescript
// repository-table.tsx
const [state, setState] = useState<FullState>({
  repositories: initialRepositories,
  progress: {},
});

useEffect(() => {
  const eventSource = new EventSource("/api/state");
  eventSource.onmessage = (event) => {
    setState(JSON.parse(event.data));
  };
  return () => eventSource.close();
}, []);
```

## Key Design Decisions

### 1. Server-Pushed State
- No polling, no debounced fetches
- Server pushes complete state on every change
- UI is a pure renderer of server state

### 2. DB Insert Before Work
Worktree is inserted to DB immediately (status="creating") so:
- UI sees it right away via SSE push
- Progress can be tracked against the record
- Cleanup is straightforward on error (delete from DB)

### 3. Main Sync Sharing
Concurrent worktree creations share the same main sync:
- First request does fetch/pull/install
- Others wait on the same promise
- 10-second cooldown skips sync if recently done

### 4. Warm Cache Pattern
Main is installed before worktree install so:
- Package manager cache is populated
- Worktree install is fast (cache hit)
- Works with npm, pnpm, yarn, bun

### 5. Fire-and-Forget APIs
- POST requests return immediately with `{ok: true}`
- Actual work happens async
- Results arrive via SSE state push
