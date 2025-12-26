# Bare Application Specification

## Overview

**Bare** is a git repository management application built around the bare repository pattern with worktrees. It provides a modern web UI and CLI for managing multiple git repositories, creating worktrees for feature branches, and integrating with external development tools (VS Code, Terminal, Claude CLI).

### Core Philosophy

- **Bare Repository Pattern**: Clone repos as bare into `.bare/`, create `.git` file pointing to it
- **__main__ Worktree**: Primary worktree that acts as the source of truth for dependencies and shared files
- **Worktree-per-Feature**: Each feature branch gets its own worktree directory
- **Smart File Sharing**: Symlinks for shared files (`.env`, `.claude/`), copies for independent files
- **Warm Dependency Store**: Install deps in __main__, worktrees benefit from cached/linked modules
- **SSE Progress Streaming**: Long operations stream real-time progress to UI

### Target Use Case

Developers who:
- Work on multiple feature branches simultaneously
- Need isolated worktrees without duplicating dependencies
- Want visual management of git repositories and worktrees
- Use VS Code, Terminal, and Claude CLI for development

---

## Architecture

### Stack

- **Framework**: Next.js 16.1.1 (App Router, React Server Components)
- **React**: 19.2.3 (with React Compiler enabled)
- **TypeScript**: 5.9.3
- **Styling**: Tailwind CSS 4.1.18 (opacity-based color system)
- **Components**: @headlessui/react 2.2.9 for dialogs
- **Icons**: @heroicons/react 2.2.0
- **Theme**: next-themes 0.4.6 (dark mode support)
- **Font**: Geist 1.5.1
- **Process Execution**: execa 9.6.1 (replaces child_process)
- **CLI**: commander 14.0.2

### Configuration

**next.config.ts:**
```typescript
{
  cacheComponents: true,      // Enable Cache Components
  reactCompiler: true,        // Enable React Compiler
  devIndicators: false        // Hide dev indicators
}
```

### Color System

Tailwind v4 with opacity-based system:
- Light mode: `bg-black/5` (black at 5% opacity)
- Dark mode: `dark:bg-white/5` (white at 5% opacity)
- Borders: `border-black/10 dark:border-white/10`
- Text: `text-black/50 dark:text-white/50`

This creates adaptive colors that work seamlessly with theme changes.

---

## Data Models

### Repository

```typescript
interface Repository {
  id: string;                    // UUID (crypto.randomUUID())
  name: string;                  // Repository name from directory
  path: string;                  // Absolute path to repository
  remoteUrl?: string;            // Git remote URL (from git remote get-url)
  addedAt: string;               // ISO timestamp
  lastSynced: string;            // ISO timestamp (updated on sync operations)
  type?: "turborepo" | "nx" | "lerna" | "workspace" | "standard";
}
```

**Storage**: `~/.bare-bones/repos.json`

```json
{
  "repositories": [
    {
      "id": "uuid-here",
      "name": "my-app",
      "path": "/Users/username/GitHub/username/my-app",
      "remoteUrl": "git@github.com:username/my-app.git",
      "addedAt": "2024-01-01T00:00:00.000Z",
      "lastSynced": "2024-01-01T12:00:00.000Z",
      "type": "turborepo"
    }
  ]
}
```

### Worktree

```typescript
interface Worktree {
  path: string;                  // Absolute path to worktree
  head?: string;                 // Git HEAD commit hash (40 chars)
  branch?: string;               // refs/heads/branch-name
  bare?: boolean;                // Is this the bare repo (rare)
  detached?: boolean;            // Detached HEAD state
  commitMessage?: string;        // Commit message of HEAD
}
```

**Source**: Parsed from `git worktree list --porcelain`

**Example Output:**
```
worktree /path/to/repo/__main__
HEAD abc123def456...
branch refs/heads/main

worktree /path/to/repo/../feature-x
HEAD def789ghi012...
branch refs/heads/feature-x
```

### WorktreeConfig

```typescript
interface WorktreeConfig {
  symlink?: string[];            // Files/dirs to symlink from __main__
  copy?: string[];               // Files/dirs to copy from __main__
  upstreamRemote?: string;       // Remote to use for worktrees (default: "origin")
}
```

**Storage**: `~/.bare-config/worktree-config.json`

```json
{
  "/Users/username/GitHub/username/my-app": {
    "symlink": [".env", ".claude"],
    "copy": [".env.example"],
    "upstreamRemote": "upstream"
  }
}
```

**Per-repository config mapping**: `{ [repoPath: string]: WorktreeConfig }`

### Remote

```typescript
interface Remote {
  name: string;                  // Remote name (origin, upstream, etc.)
  url: string;                   // Remote URL
}
```

**Source**: Parsed from `git remote -v` (fetch lines only)

### RegistryFile

```typescript
interface RegistryFile {
  repositories: Repository[];
}
```

**Storage**: `~/.bare-bones/repos.json`

---

## Core Library Functions

### src/lib/git.ts (408 lines)

Central orchestration for all git operations via execa.

#### cloneRepository

```typescript
export async function cloneRepository(
  url: string,
  targetDir: string,
  onProgress: (line: string) => void
): Promise<string>
```

**Purpose**: Clone repository as bare with __main__ worktree setup

**Workflow**:
1. Extract GitHub username from URL (handles both SSH and HTTPS)
   - SSH: `git@github.com:username/repo.git` → `username`
   - HTTPS: `https://github.com/username/repo.git` → `username`
2. Create directory: `~/GitHub/[username]/[targetDir]`
3. Clone as bare: `git clone --bare [url] .bare/`
4. Create `.git` file: `gitdir: ./.bare`
5. Configure fetch: `git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"`
6. Create __main__ worktree:
   - Try: `git worktree add __main__ main`
   - Fallback: `git worktree add __main__ master`
7. Return full path to repository

**Progress Streaming**: Calls `onProgress(line)` for each git output line

**Example**:
```typescript
const repoPath = await cloneRepository(
  "git@github.com:user/repo.git",
  "repo",
  (line) => console.log(line)
);
// Returns: /Users/username/GitHub/user/repo
// Creates: /Users/username/GitHub/user/repo/.bare/
// Creates: /Users/username/GitHub/user/repo/__main__/
```

#### addWorktree

```typescript
export async function addWorktree(
  repoPath: string,
  worktreeName: string,
  branch?: string,
  upstreamRemote: string = "origin"
): Promise<string>
```

**Purpose**: Create new worktree with smart branch handling

**Workflow**:
1. If no branch specified, use worktreeName as branch
2. Construct command: `git worktree add -B [branch] ../${worktreeName} ${upstreamRemote}/main`
   - `-B`: Force-create branch if exists locally
   - `../${worktreeName}`: Create worktree as sibling directory
   - `${upstreamRemote}/main`: Start from upstream main
3. Run from repo path
4. Return absolute path to new worktree

**Branch Strategy**:
- Creates local branch if doesn't exist
- Resets local branch if exists (force)
- Always starts from `${upstreamRemote}/main`
- Allows switching upstream remote via config

**Example**:
```typescript
await addWorktree(
  "/Users/username/GitHub/user/repo",
  "feature-x",
  "feature/new-feature",
  "upstream"
);
// Creates: /Users/username/GitHub/user/feature-x/
// Branch: feature/new-feature (from upstream/main)
```

#### setupWorktreeFiles

```typescript
export async function setupWorktreeFiles(
  repoPath: string,
  worktreeName: string
): Promise<void>
```

**Purpose**: Setup file sharing between __main__ and new worktree

**Workflow**:
1. Load config from `~/.bare-config/worktree-config.json`
2. Get config for this repo (or use defaults)
3. Process symlinks:
   - Check if source exists in __main__
   - Create parent directories in worktree
   - Create symlink: `ln -s [source] [target]`
4. Process copies:
   - Check if source exists in __main__
   - Create parent directories in worktree
   - Copy: `cp -r [source] [target]`
5. Gracefully skip missing files (no errors)

**Default Behavior**: No symlinks/copies if config doesn't exist

**Example**:
```typescript
// Config: { symlink: [".env", ".claude"], copy: [".env.example"] }
await setupWorktreeFiles("/path/to/repo", "feature-x");

// Creates:
// /path/to/feature-x/.env → symlink to __main__/.env
// /path/to/feature-x/.claude → symlink to __main__/.claude
// /path/to/feature-x/.env.example (copied)
```

#### updateMainWorktree

```typescript
export async function updateMainWorktree(
  repoPath: string,
  upstreamRemote: string = "origin"
): Promise<void>
```

**Purpose**: Sync __main__ worktree with upstream

**Workflow**:
1. `cd __main__`
2. `git fetch ${upstreamRemote}`
3. `git reset --hard ${upstreamRemote}/main`

**Note**: Destructive operation (hard reset)

#### installDependencies

```typescript
export async function installDependencies(repoPath: string): Promise<void>
```

**Purpose**: Install dependencies in __main__ using detected package manager

**Workflow**:
1. Detect package manager via `detectPackageManager()`
2. `cd __main__`
3. Run install command based on detection

#### installWorktreeDependencies

```typescript
export async function installWorktreeDependencies(
  repoPath: string,
  worktreeName: string
): Promise<void>
```

**Purpose**: Install dependencies in worktree (benefits from warm cache)

**Workflow**:
1. Detect package manager
2. `cd ../${worktreeName}`
3. Run install command

**Performance**: Leverages package manager cache from __main__ installation

#### removeWorktree

```typescript
export async function removeWorktree(
  repoPath: string,
  worktreeName: string
): Promise<void>
```

**Purpose**: Remove worktree and its branch

**Workflow**:
1. `git worktree remove ../${worktreeName} --force`
2. `git branch -D [branch]` (extracted from worktree list)

#### listWorktrees

```typescript
export async function listWorktrees(repoPath: string): Promise<Worktree[]>
```

**Purpose**: Get all worktrees with metadata

**Workflow**:
1. `git worktree list --porcelain`
2. Parse porcelain output into Worktree objects
3. For each worktree with HEAD, fetch commit message:
   - `git log -1 --format=%s [head]`
4. Return array

#### listBranches

```typescript
export async function listBranches(repoPath: string): Promise<string[]>
```

**Purpose**: Get all local branches

**Workflow**:
1. `git branch --format=%(refname:short)`
2. Return array of branch names

#### getRemoteUrl

```typescript
export async function getRemoteUrl(repoPath: string): Promise<string | undefined>
```

**Purpose**: Get origin remote URL

**Workflow**:
1. `cd __main__`
2. `git remote get-url origin`
3. Return URL or undefined

#### listRemotes

```typescript
export async function listRemotes(repoPath: string): Promise<Remote[]>
```

**Purpose**: Get all git remotes

**Workflow**:
1. `git remote -v`
2. Parse output (fetch lines only)
3. Return array of `{ name, url }`

#### addRemote

```typescript
export async function addRemote(
  repoPath: string,
  name: string,
  url: string
): Promise<void>
```

**Purpose**: Add new git remote

**Workflow**:
1. `cd __main__`
2. `git remote add [name] [url]`

#### removeRemote

```typescript
export async function removeRemote(repoPath: string, name: string): Promise<void>
```

**Purpose**: Remove git remote

**Workflow**:
1. `cd __main__`
2. `git remote remove [name]`

---

### src/lib/repos.ts (122 lines)

Repository registry management with JSON persistence.

#### ensureRegistry

```typescript
export async function ensureRegistry(): Promise<void>
```

Creates `~/.bare-bones/` directory and `repos.json` if missing.

#### readRegistry / writeRegistry

```typescript
export async function readRegistry(): Promise<RegistryFile>
export async function writeRegistry(registry: RegistryFile): Promise<void>
```

Low-level read/write operations for registry file.

#### getRepositories

```typescript
export async function getRepositories(): Promise<Repository[]>
```

Returns all repositories from registry.

#### getRepository

```typescript
export async function getRepository(id: string): Promise<Repository | null>
```

Find repository by ID.

#### addRepository

```typescript
export async function addRepository(
  repo: Omit<Repository, "id" | "addedAt" | "lastSynced">
): Promise<Repository>
```

**Workflow**:
1. Check for existing repo with same path (throws if exists)
2. Generate UUID for `id`
3. Set `addedAt` and `lastSynced` to current ISO timestamp
4. Add to registry
5. Write registry
6. Return new repo

#### removeRepository

```typescript
export async function removeRepository(id: string): Promise<void>
```

**Workflow**:
1. Find repo in registry (throws if not found)
2. Delete directory from disk: `rm -rf [repo.path]`
3. Continue even if disk deletion fails (logs warning)
4. Remove from registry
5. Write registry

**Note**: Deletes the actual directory, not just the registry entry.

#### updateRepository

```typescript
export async function updateRepository(
  id: string,
  updates: Partial<Omit<Repository, "id" | "addedAt">>
): Promise<Repository>
```

**Workflow**:
1. Find repo (throws if not found)
2. Merge updates
3. **Always** set `lastSynced` to current ISO timestamp
4. Write registry
5. Return updated repo

**Key Behavior**: Empty PATCH request still updates `lastSynced`.

---

### src/lib/worktree-config.ts (48 lines)

Per-repository configuration persistence.

#### readWorktreeConfig

```typescript
export async function readWorktreeConfig(repoPath: string): Promise<WorktreeConfig>
```

Returns config for repo or empty object if not configured.

#### writeWorktreeConfig

```typescript
export async function writeWorktreeConfig(
  repoPath: string,
  config: WorktreeConfig
): Promise<void>
```

Saves config for specific repository path.

**Storage Pattern**: Map of repo paths to configs.

---

### src/lib/detect.ts (38 lines)

Package manager detection.

#### detectPackageManager

```typescript
export async function detectPackageManager(
  repoPath: string
): Promise<"pnpm" | "yarn" | "bun" | "npm">
```

**Detection Order**:
1. Check for `pnpm-lock.yaml` → return "pnpm"
2. Check for `yarn.lock` → return "yarn"
3. Check for `bun.lockb` → return "bun"
4. Check for `package-lock.json` → return "npm"
5. Default: return "pnpm"

**Location**: Checks in `__main__` directory.

#### detectRepositoryType

```typescript
export async function detectRepositoryType(
  repoPath: string
): Promise<"turborepo" | "nx" | "lerna" | "workspace" | "standard">
```

**Detection Order**:
1. Check for `turbo.json` → "turborepo"
2. Check for `nx.json` → "nx"
3. Check for `lerna.json` → "lerna"
4. Check for `workspaces` in `package.json` → "workspace"
5. Default: "standard"

---

## API Routes

### GET /api/repos

**Purpose**: Fetch all repositories

**Response**:
```json
[
  {
    "id": "uuid",
    "name": "repo-name",
    "path": "/Users/username/GitHub/username/repo-name",
    "remoteUrl": "git@github.com:username/repo-name.git",
    "addedAt": "2024-01-01T00:00:00.000Z",
    "lastSynced": "2024-01-01T12:00:00.000Z",
    "type": "turborepo"
  }
]
```

### POST /api/repos

**Purpose**: Add new repository

**Request**:
```json
{
  "name": "repo-name",
  "path": "/absolute/path",
  "remoteUrl": "git@github.com:user/repo.git",
  "type": "turborepo"
}
```

**Response**: `201` with created Repository object

**Validation**: Requires `name` and `path`

**Error**: `400` if repo with same path already exists

### PATCH /api/repos?id=uuid

**Purpose**: Update repository (triggers lastSynced update)

**Request**: Any partial updates

**Response**: Updated Repository object

**Side Effect**: Always updates `lastSynced` to current timestamp

**Use Case**: Called after syncing __main__ to update "last synced" time

### DELETE /api/repos?id=uuid

**Purpose**: Remove repository and delete from disk

**Response**: `{ success: true }`

**Side Effect**: Deletes directory from filesystem

---

### GET /api/worktree?repoPath=/path/to/repo

**Purpose**: List all worktrees for repository

**Response**:
```json
{
  "worktrees": [
    {
      "path": "/path/to/repo/__main__",
      "head": "abc123...",
      "branch": "refs/heads/main",
      "commitMessage": "Initial commit"
    },
    {
      "path": "/path/to/repo/../feature-x",
      "head": "def456...",
      "branch": "refs/heads/feature-x",
      "commitMessage": "Add feature X"
    }
  ]
}
```

### GET /api/worktree?repoPath=/path/to/repo&action=branches

**Purpose**: List all local branches

**Response**:
```json
{
  "branches": ["main", "feature-x", "bugfix-y"]
}
```

### POST /api/worktree

**Purpose**: Create new worktree with full setup

**Request**:
```json
{
  "repoPath": "/path/to/repo",
  "worktreeName": "feature-x",
  "branch": "feature/new-feature"  // optional, defaults to worktreeName
}
```

**Response**: SSE stream

**SSE Format**:
```
data: Updating __main__ from origin/main...
data: [+0.5s | 2.3s total] ✓ __main__ updated
data: Installing dependencies in __main__...
data: [+12.1s | 14.4s total] ✓ Dependencies installed in __main__
data: Creating worktree from origin/main...
data: [+0.3s | 14.7s total] ✓ Worktree created at /path/to/feature-x
data: [WORKTREE_CREATED]
data: Setting up config files (symlinks/copies)...
data: [+0.1s | 14.8s total] ✓ Config files setup complete
data: Installing dependencies from warm store...
data: [+3.2s | 18.0s total] ✓ Dependencies installed in worktree
data: [DONE]
```

**Critical Signals**:
- `[WORKTREE_CREATED]`: Worktree exists, buttons can be enabled (UI refetches data)
- `[DONE]`: All operations complete including dependency installation
- `ERROR: [message]`: Operation failed

**Workflow**:
1. Load config to get `upstreamRemote` (default: "origin")
2. Stream: "Updating __main__ from {upstreamRemote}/main..."
3. Call `updateMainWorktree(repoPath, upstreamRemote)`
4. Stream timed: "✓ __main__ updated"
5. Add 300ms delay for UX
6. Stream: "Installing dependencies in __main__..."
7. Call `installDependencies(repoPath)`
8. Stream timed: "✓ Dependencies installed in __main__"
9. Add 300ms delay
10. Stream: "Creating worktree from {upstreamRemote}/main..."
11. Call `addWorktree(repoPath, worktreeName, branch, upstreamRemote)`
12. Stream timed: "✓ Worktree created at {path}"
13. Stream: `[WORKTREE_CREATED]` **← UI refetches data here**
14. Add 300ms delay
15. Stream: "Setting up config files (symlinks/copies)..."
16. Call `setupWorktreeFiles(repoPath, worktreeName)`
17. Stream timed: "✓ Config files setup complete"
18. Add 300ms delay
19. Stream: "Installing dependencies from warm store..."
20. Call `installWorktreeDependencies(repoPath, worktreeName)`
21. Stream timed: "✓ Dependencies installed in worktree"
22. Stream: `[DONE]` **← UI clears "creating" state here**

**Timed Messages**: Format `[+{stepTime}s | {totalTime}s total]`

### PATCH /api/worktree

**Purpose**: Sync __main__ worktree with upstream

**Request**:
```json
{
  "repoPath": "/path/to/repo",
  "action": "sync-main"
}
```

**Response**: SSE stream

**SSE Format**:
```
data: Fetching latest from origin...
data: [+1.2s | 1.2s total] ✓ Fetched
data: Resetting __main__ to origin/main...
data: [+0.3s | 1.5s total] ✓ Reset complete
data: Installing dependencies...
data: [+8.4s | 9.9s total] ✓ Dependencies installed
data: [DONE]
```

**Workflow**:
1. Load config to get `upstreamRemote`
2. Stream: "Fetching latest from {upstreamRemote}..."
3. Call `updateMainWorktree(repoPath, upstreamRemote)`
4. Stream timed: "✓ Fetched" and "✓ Reset complete"
5. Stream: "Installing dependencies..."
6. Call `installDependencies(repoPath)`
7. Stream timed: "✓ Dependencies installed"
8. Stream: `[DONE]`

### DELETE /api/worktree?repoPath=/path/to/repo&worktreeName=feature-x

**Purpose**: Remove worktree and its branch

**Response**: `{ success: true }`

**Side Effect**: Deletes worktree directory and local branch

---

### POST /api/clone

**Purpose**: Clone repository with bare setup

**Request**:
```json
{
  "url": "git@github.com:user/repo.git",
  "targetDir": "repo-name"
}
```

**Response**: SSE stream

**SSE Format**:
```
data: Cloning into bare repository...
data: [git output lines...]
data: [+5.2s | 5.2s total] Clone complete
data: [+0.1s | 5.3s total] Detected type: turborepo
data: [+0.1s | 5.4s total] Repository added successfully!
data: [DONE]
```

**Workflow**:
1. Call `cloneRepository(url, targetDir, onProgress)`
   - Streams git output lines
2. Call `detectRepositoryType(repoPath)`
3. Stream timed: "Detected type: {type}"
4. Call `getRemoteUrl(repoPath)`
5. Call `addRepository({ name, path, remoteUrl, type })`
6. Stream timed: "Repository added successfully!"
7. Stream: `[DONE]`

**Error Handling**: Streams `ERROR: {message}` on failure

---

### GET /api/worktree-config?repoPath=/path/to/repo

**Purpose**: Get worktree configuration

**Response**:
```json
{
  "config": {
    "symlink": [".env", ".claude"],
    "copy": [".env.example"],
    "upstreamRemote": "upstream"
  }
}
```

### PUT /api/worktree-config

**Purpose**: Save worktree configuration

**Request**:
```json
{
  "repoPath": "/path/to/repo",
  "config": {
    "symlink": [".env", ".claude"],
    "copy": [".env.example"],
    "upstreamRemote": "upstream"
  }
}
```

**Response**: `{ success: true }`

---

### GET /api/remotes?repoPath=/path/to/repo

**Purpose**: List git remotes

**Response**:
```json
{
  "remotes": [
    { "name": "origin", "url": "git@github.com:user/repo.git" },
    { "name": "upstream", "url": "git@github.com:original/repo.git" }
  ]
}
```

### POST /api/remotes

**Purpose**: Add git remote

**Request**:
```json
{
  "repoPath": "/path/to/repo",
  "name": "upstream",
  "url": "git@github.com:original/repo.git"
}
```

**Response**: `{ success: true }`

### DELETE /api/remotes?repoPath=/path/to/repo&name=upstream

**Purpose**: Remove git remote

**Response**: `{ success: true }`

---

### POST /api/open

**Purpose**: Open path in VS Code or Terminal

**Request**:
```json
{
  "path": "/path/to/directory",
  "app": "vscode"  // or "terminal"
}
```

**Behavior**:
- **vscode**: Executes `code [path]`
- **terminal**: Uses AppleScript to open Terminal at path

**Response**: `{ success: true }`

---

### POST /api/open-with-claude

**Purpose**: Open path in VS Code with Claude CLI

**Request**:
```json
{
  "path": "/path/to/directory"
}
```

**Response**: SSE stream

**SSE Format**:
```
data: Checking for existing Claude session...
data: Opening VS Code...
data: Launching new Claude session...
data: ✓ Claude launched
data: [DONE]
```

**Advanced Logic**:
1. Check if Claude CLI is already running in this directory:
   - `ps -axo pid,command` to find all `claude` processes
   - For each PID: `lsof -p [pid] -a -d cwd -Fn` to get working directory
   - Compare working directory to target path
2. Open VS Code: `code [path]`
3. If existing Claude session found:
   - Stream: "✓ Found existing Claude session - VS Code activated"
4. If no existing session:
   - Use AppleScript to:
     - Activate VS Code
     - Wait 0.5s
     - Press Ctrl+` (open terminal)
     - Wait 0.3s
     - Type "claude"
     - Press Enter
   - Stream: "✓ Claude launched"
5. Stream: `[DONE]`

**Benefit**: Reuses existing Claude session instead of spawning duplicate

---

## V2 Components

### OverviewDashboard (779 lines)

**Location**: `src/app/v2/components/overview-dashboard.tsx`

Main dashboard for managing repositories and worktrees.

#### State Management

```typescript
const [repoWorktrees, setRepoWorktrees] = useState<Map<string, Worktree[]>>(new Map());
const [creatingWorktrees, setCreatingWorktrees] = useState<Map<string, string>>(new Map());
const [syncingWorktrees, setSyncingWorktrees] = useState<Map<string, string>>(new Map());
const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set());
const [worktreeNames, setWorktreeNames] = useState<Map<string, string>>(new Map());
```

**Key Maps**:
- `repoWorktrees`: Maps repo ID to sorted array of worktrees
- `creatingWorktrees`: Maps worktree path to progress message
- `syncingWorktrees`: Maps __main__ path to sync progress message
- `selectedWorktrees`: Set of worktree paths selected for deletion
- `worktreeNames`: Maps repo ID to input value for new worktree name

#### Repository Grouping

```typescript
const groupedRepos = useMemo(() => {
  const groups: { [username: string]: Repository[] } = {};
  for (const repo of repositories) {
    const pathParts = repo.path.split("/");
    const githubIndex = pathParts.findIndex((p) => p === "GitHub");
    const username = githubIndex >= 0 ? pathParts[githubIndex + 1] : "unknown";

    if (!groups[username]) groups[username] = [];
    groups[username].push(repo);
  }

  // Sort repos by lastSynced within each group
  Object.values(groups).forEach((repos) =>
    repos.sort((a, b) =>
      new Date(b.lastSynced).getTime() - new Date(a.lastSynced).getTime()
    )
  );

  return groups;
}, [repositories]);
```

**Grouping Logic**:
1. Extract username from path: `/Users/x/GitHub/[username]/[repo]`
2. Group repos by username
3. Sort each group by `lastSynced` descending (most recent first)

#### Worktree Fetching

```typescript
useEffect(() => {
  const fetchAllWorktrees = async () => {
    setIsLoading(true);
    const worktreesMap = new Map<string, Worktree[]>();

    await Promise.all(
      repositories.map(async (repo) => {
        const res = await fetch(`/api/worktree?repoPath=${encodeURIComponent(repo.path)}`);
        const data = await res.json();
        const wts = data.worktrees || [];

        const mainWorktree = wts.find((wt: Worktree) => wt.path.endsWith("__main__"));
        const otherWorktrees = wts
          .filter((wt: Worktree) => !wt.path.endsWith("__main__"))
          .sort((a: Worktree, b: Worktree) => a.path.localeCompare(b.path));

        const sorted = mainWorktree ? [mainWorktree, ...otherWorktrees] : otherWorktrees;
        worktreesMap.set(repo.id, sorted);
      })
    );

    setRepoWorktrees(worktreesMap);
    setIsLoading(false);
  };

  if (repositories.length > 0) {
    fetchAllWorktrees();
  }
}, [repositories]);
```

**Sorting Strategy**:
1. Separate __main__ from other worktrees
2. Sort other worktrees alphabetically by name
3. Place __main__ first, followed by sorted others

#### Worktree Creation Flow

```typescript
const handleAddWorktree = async (e: React.FormEvent, repoPath: string, repoId: string) => {
  e.preventDefault();
  const worktreeName = worktreeNames.get(repoId) || "";
  if (!worktreeName.trim()) return;

  // 1. Clear input immediately
  setWorktreeNames((prev) => {
    const next = new Map(prev);
    next.delete(repoId);
    return next;
  });

  // 2. Create placeholder worktree
  const existing = repoWorktrees.get(repoId) || [];
  const mainWorktree = existing.find((wt) => wt.path.endsWith("__main__"));
  const mainHead = mainWorktree?.head || "";

  const tempPath = `${repoPath}/../${worktreeName.trim()}`;
  const placeholderWorktree: Worktree = {
    path: tempPath,
    branch: worktreeName.trim(),
    head: mainHead,
    commitMessage: "Creating...",
  };

  // 3. Insert placeholder in sorted position
  setRepoWorktrees((prev) => {
    const existing = prev.get(repoId) || [];
    const mainWorktree = existing.find((wt) => wt.path.endsWith("__main__"));
    const otherWorktrees = existing.filter((wt) => !wt.path.endsWith("__main__"));

    const allOthers = [...otherWorktrees, placeholderWorktree].sort((a, b) => {
      const nameA = a.path.split("/").pop() || "";
      const nameB = b.path.split("/").pop() || "";
      return nameA.localeCompare(nameB);
    });

    const sorted = mainWorktree ? [mainWorktree, ...allOthers] : allOthers;
    return new Map(prev).set(repoId, sorted);
  });

  setCreatingWorktrees((prev) => new Map(prev).set(tempPath, "Creating..."));

  // 4. Stream SSE
  const response = await fetch("/api/worktree", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, worktreeName: worktreeName.trim() }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n\n");

    for (const line of lines) {
      if (!line.trim() || !line.startsWith("data: ")) continue;

      const message = line.slice(6);

      if (message === "[WORKTREE_CREATED]") {
        // 5. Fetch real data (worktree exists, buttons need to work)
        const res = await fetch(`/api/worktree?repoPath=${encodeURIComponent(repoPath)}`);
        const data = await res.json();
        const wts = data.worktrees || [];

        const mainWorktree = wts.find((wt: Worktree) => wt.path.endsWith("__main__"));
        const otherWorktrees = wts
          .filter((wt: Worktree) => !wt.path.endsWith("__main__"))
          .sort((a: Worktree, b: Worktree) => a.path.localeCompare(b.path));

        const sorted = mainWorktree ? [mainWorktree, ...otherWorktrees] : otherWorktrees;
        setRepoWorktrees((prev) => new Map(prev).set(repoId, sorted));

      } else if (message === "[DONE]") {
        // 6. Clear creating state after 500ms
        setTimeout(() => {
          setCreatingWorktrees((prev) => {
            const next = new Map(prev);
            next.delete(tempPath);
            return next;
          });
        }, 500);

      } else if (!message.startsWith("ERROR:")) {
        // 7. Update progress message
        setCreatingWorktrees((prev) => new Map(prev).set(tempPath, message));
      }
    }
  }
};
```

**Critical Insight**: Placeholder allows instant UI feedback, but real data is refetched on `[WORKTREE_CREATED]` signal so that buttons (VS Code, Claude, etc.) work correctly.

#### Multi-Select Deletion

```typescript
const handleDeleteSelected = async (repoPath: string, repoId: string) => {
  if (selectedWorktrees.size === 0) return;

  const worktrees = repoWorktrees.get(repoId) || [];
  const repoWorktreePaths = new Set(worktrees.map((wt) => wt.path));

  // Only delete worktrees that belong to this repository
  const toDelete = Array.from(selectedWorktrees).filter((path) =>
    repoWorktreePaths.has(path)
  );

  if (toDelete.length === 0) return;

  // Delete in parallel
  await Promise.all(
    toDelete.map(async (wtPath) => {
      const wt = worktrees.find((w) => w.path === wtPath);
      if (!wt) return;

      const name = wt.path.split("/").pop() || "";
      if (name === "__main__") return; // Never delete __main__

      await fetch(
        `/api/worktree?repoPath=${encodeURIComponent(repoPath)}&worktreeName=${encodeURIComponent(name)}`,
        { method: "DELETE" }
      );
    })
  );

  // Refresh worktrees
  const res = await fetch(`/api/worktree?repoPath=${encodeURIComponent(repoPath)}`);
  const data = await res.json();
  const wts = data.worktrees || [];

  const mainWorktree = wts.find((wt: Worktree) => wt.path.endsWith("__main__"));
  const otherWorktrees = wts
    .filter((wt: Worktree) => !wt.path.endsWith("__main__"))
    .sort((a: Worktree, b: Worktree) => a.path.localeCompare(b.path));

  const sorted = mainWorktree ? [mainWorktree, ...otherWorktrees] : otherWorktrees;
  setRepoWorktrees((prev) => new Map(prev).set(repoId, sorted));

  // Clear selections for deleted worktrees
  setSelectedWorktrees((prev) => {
    const next = new Set(prev);
    toDelete.forEach((path) => next.delete(path));
    return next;
  });
};
```

**Scoping**: Only deletes worktrees belonging to the current repo (prevents cross-repo deletion).

#### Sync Main Flow

```typescript
const handleSyncMain = async (repoPath: string, repoId: string, mainPath: string) => {
  setSyncingWorktrees((prev) => new Map(prev).set(mainPath, "Syncing..."));

  const response = await fetch("/api/worktree", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, action: "sync-main" }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n\n");

    for (const line of lines) {
      if (!line.trim() || !line.startsWith("data: ")) continue;

      const message = line.slice(6);

      if (message === "[DONE]") {
        // Refresh worktrees
        const res = await fetch(`/api/worktree?repoPath=${encodeURIComponent(repoPath)}`);
        const data = await res.json();
        const wts = data.worktrees || [];

        const mainWorktree = wts.find((wt: Worktree) => wt.path.endsWith("__main__"));
        const otherWorktrees = wts
          .filter((wt: Worktree) => !wt.path.endsWith("__main__"))
          .sort((a: Worktree, b: Worktree) => a.path.localeCompare(b.path));

        const sorted = mainWorktree ? [mainWorktree, ...otherWorktrees] : otherWorktrees;

        // Update lastSynced in registry
        await fetch(`/api/repos?id=${encodeURIComponent(repoId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        setTimeout(() => {
          setRepoWorktrees((prev) => new Map(prev).set(repoId, sorted));
          setSyncingWorktrees((prev) => {
            const next = new Map(prev);
            next.delete(mainPath);
            return next;
          });

          router.refresh(); // Refresh to get updated lastSynced time
        }, 500);

      } else if (!message.startsWith("ERROR:")) {
        setSyncingWorktrees((prev) => new Map(prev).set(mainPath, message));
      }
    }
  }
};
```

**Key Side Effect**: Updates `lastSynced` timestamp in registry via PATCH request.

#### External App Integration

```typescript
const openInVSCode = async (path: string) => {
  await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, app: "vscode" }),
  });
};

const openInClaude = async (path: string) => {
  await fetch("/api/open-with-claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
};

const openInTerminal = async (path: string) => {
  await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, app: "terminal" }),
  });
};
```

#### Date Formatting

```typescript
const formatDate = (dateStr: string) => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};
```

**Display**: Shows relative time for recent syncs, absolute date for older.

#### UI Structure

Table-based layout with grouped repositories:

```typescript
<table className="table w-full bg-transparent">
  <colgroup>
    <col style={{ width: "1%" }} />  {/* Worktree name */}
    <col style={{ width: "1%" }} />  {/* Separator */}
    <col style={{ width: "1%" }} />  {/* Branch */}
    <col style={{ width: "1%" }} />  {/* Separator */}
    <col style={{ width: "1%" }} />  {/* Hash */}
    <col style={{ width: "auto" }} /> {/* Commit message */}
    <col style={{ width: "1%" }} />  {/* Actions */}
  </colgroup>
  <tbody>
    {Object.entries(groupedRepos).map(([username, repos]) => (
      <React.Fragment key={username}>
        {/* Username header */}
        <tr><td colSpan={7}><h2>{username}</h2></td></tr>

        {repos.map((repo) => (
          <React.Fragment key={repo.id}>
            {/* Repo row */}
            <tr onClick={() => navigateToRepo(repo)}>
              <td colSpan={7}>
                {repo.name} | {repo.type} | {repo.remoteUrl}
                <ClockIcon /> {formatDate(repo.lastSynced)}
                <button onClick={openInVSCode}>VS Code</button>
                <button onClick={openInTerminal}>Terminal</button>
              </td>
            </tr>

            {/* Input row */}
            <tr>
              <td colSpan={7}>
                <input placeholder="feature/new-branch" />
                {selectedInThisRepo.length > 0 && (
                  <button onClick={handleDeleteSelected}>
                    Delete {selectedInThisRepo.length}
                  </button>
                )}
              </td>
            </tr>

            {/* Worktree rows */}
            {worktrees.map((wt) => (
              <tr key={wt.path}>
                <td>{name}</td>
                <td>/</td>
                <td>{branchName}</td>
                <td>/</td>
                <td>{shortHash}</td>
                <td>{progressMessage || wt.commitMessage}</td>
                <td>
                  {isMain && <button onClick={handleSyncMain}>Sync</button>}
                  <button onClick={openInClaude}>Claude</button>
                  <button onClick={openInVSCode}>VS Code</button>
                  {!isMain && <button onClick={toggleSelection}>Delete</button>}
                </td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </React.Fragment>
    ))}
  </tbody>
</table>
```

**Row Types**:
1. Username header (colSpan=7)
2. Repository summary (clickable, navigates to detail page)
3. Input row with delete button
4. Worktree rows (main + sorted others)

**Styling**:
- Text size: `text-[10px]` for worktree rows (ultra-compact)
- Hover: `hover:bg-black/5 dark:hover:bg-white/5`
- Main worktree: `font-bold`

---

### AddRepoDialog (196 lines)

**Location**: `src/app/v2/components/add-repo-dialog.tsx`

Modal dialog for cloning repositories with SSE progress.

#### State

```typescript
const [url, setUrl] = useState("");
const [targetDir, setTargetDir] = useState("");
const [isCloning, setIsCloning] = useState(false);
const [progress, setProgress] = useState<string[]>([]);
const [error, setError] = useState<string | null>(null);
```

#### Auto-fill Directory

```typescript
const handleUrlChange = (value: string) => {
  setUrl(value);
  // Auto-fill targetDir if it's empty or matches the previous URL's repo name
  if (!targetDir || targetDir === url.split("/").pop()?.replace(".git", "")) {
    setTargetDir(value.split("/").pop()?.replace(".git", "") || "");
  }
};
```

**Logic**: As user types URL, automatically extract repo name for directory.

#### SSE Streaming

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setIsCloning(true);
  setProgress([]);
  setError(null);

  const response = await fetch("/api/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, targetDir }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);

        if (data === "[DONE]") {
          setIsCloning(false);
          onComplete(); // Callback to parent to refresh repos
        } else if (data.startsWith("ERROR: ")) {
          setError(data.slice(7));
          setIsCloning(false);
        } else {
          setProgress((prev) => [...prev, data]);
        }
      }
    }
  }
};
```

#### Console Display

```typescript
<div className="bg-black text-white/90 max-h-80 overflow-y-auto p-3 rounded font-mono text-xs">
  {progress.map((line, i) => (
    <pre key={i}><code>&gt; {line}</code></pre>
  ))}
  {isCloning && <pre><code>&gt; Cloning...</code></pre>}
  {error && progress.length > 0 && (
    <pre className="text-red-400"><code>✗ {error}</code></pre>
  )}
</div>
```

**Styling**: Black terminal-style console with monospace font.

#### Form Structure

```typescript
<form onSubmit={handleSubmit}>
  <input
    type="text"
    required
    value={url}
    onChange={(e) => handleUrlChange(e.target.value)}
    placeholder="git@github.com:user/repo.git"
  />

  <input
    type="text"
    required
    value={targetDir}
    onChange={(e) => setTargetDir(e.target.value)}
    placeholder="repo-name"
  />
  <span className="text-xs opacity-60">
    Created in ~/GitHub/[username]/
  </span>

  <button type="button" onClick={handleClose}>Cancel</button>
  <button type="submit">Clone</button>
</form>
```

**Modal**: Uses Headless UI Dialog component.

---

### RemotesManagerV2 (249 lines)

**Location**: `src/app/v2/components/remotes-manager-v2.tsx`

Manage git remotes and set upstream remote for worktrees.

#### State

```typescript
const [remotes, setRemotes] = useState<Remote[]>([]);
const [config, setConfig] = useState<WorktreeConfig>({});
const [isLoading, setIsLoading] = useState(true);
const [error, setError] = useState<string | null>(null);
const [isAdding, setIsAdding] = useState(false);
const [newRemoteName, setNewRemoteName] = useState("");
const [newRemoteUrl, setNewRemoteUrl] = useState("");
```

#### Fetch Data

```typescript
const fetchData = async () => {
  const [remotesRes, configRes] = await Promise.all([
    fetch(`/api/remotes?repoPath=${encodeURIComponent(repoPath)}`),
    fetch(`/api/worktree-config?repoPath=${encodeURIComponent(repoPath)}`),
  ]);

  const remotesData = await remotesRes.json();
  const configData = await configRes.json();

  setRemotes(remotesData.remotes || []);
  setConfig(configData.config || {});
};
```

**Parallel Fetch**: Fetches both remotes and config simultaneously.

#### Add Remote

```typescript
const handleAddRemote = async (e: React.FormEvent) => {
  e.preventDefault();

  await fetch("/api/remotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, name: newRemoteName, url: newRemoteUrl }),
  });

  setNewRemoteName("");
  setNewRemoteUrl("");
  setIsAdding(false);
  await fetchData();
};
```

#### Remove Remote

```typescript
const handleRemoveRemote = async (name: string) => {
  if (!confirm(`Remove remote "${name}"?`)) return;

  await fetch(
    `/api/remotes?repoPath=${encodeURIComponent(repoPath)}&name=${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );

  await fetchData();
};
```

**Confirmation**: Prompts user before deleting remote.

#### Set Upstream

```typescript
const handleSetUpstream = async (name: string) => {
  const newConfig = { ...config, upstreamRemote: name };

  await fetch("/api/worktree-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, config: newConfig }),
  });

  setConfig(newConfig);
};
```

**Purpose**: Sets which remote to use as base when creating worktrees.

#### UI Structure

```typescript
<div>
  <h2>Git Remotes</h2>
  {!isAdding && <button onClick={() => setIsAdding(true)}>+ Add Remote</button>}

  {isAdding && (
    <form onSubmit={handleAddRemote}>
      <input placeholder="upstream" value={newRemoteName} />
      <input placeholder="https://github.com/owner/repo.git" value={newRemoteUrl} />
      <button type="button" onClick={cancel}>Cancel</button>
      <button type="submit">Add</button>
    </form>
  )}

  {remotes.map((remote) => (
    <div key={remote.name}>
      <span>{remote.name}</span>
      {remote.name === upstreamRemote && <span>base</span>}
      <span className="font-mono">{remote.url}</span>

      {remote.name !== upstreamRemote && (
        <button onClick={() => handleSetUpstream(remote.name)}>Set Base</button>
      )}
      {remote.name !== "origin" && (
        <button onClick={() => handleRemoveRemote(remote.name)}>Remove</button>
      )}
    </div>
  ))}

  <p>Worktrees branch from <strong>{upstreamRemote}/main</strong></p>
</div>
```

**Badge**: Shows "base" badge on current upstream remote.

**Protection**: Cannot remove "origin" remote.

---

### WorktreeConfigV2 (189 lines)

**Location**: `src/app/v2/components/worktree-config-v2.tsx`

Configure file sharing patterns for worktrees.

#### State

```typescript
const [config, setConfig] = useState<WorktreeConfig>({ symlink: [], copy: [] });
const [isEditing, setIsEditing] = useState(false);
const [isLoading, setIsLoading] = useState(true);
const [isSaving, setIsSaving] = useState(false);
const [error, setError] = useState<string | null>(null);
const [symlinkInput, setSymlinkInput] = useState("");
const [copyInput, setCopyInput] = useState("");
```

#### Fetch Config

```typescript
const fetchConfig = async () => {
  const response = await fetch(
    `/api/worktree-config?repoPath=${encodeURIComponent(repoPath)}`
  );
  const data = await response.json();

  setConfig(data.config || { symlink: [], copy: [] });
  setSymlinkInput((data.config?.symlink || []).join(", "));
  setCopyInput((data.config?.copy || []).join(", "));
};
```

**Display Format**: Comma-separated string for editing.

#### Save Config

```typescript
const handleSave = async () => {
  setIsSaving(true);

  const newConfig: WorktreeConfig = {
    symlink: symlinkInput.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    copy: copyInput.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  };

  await fetch("/api/worktree-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoPath, config: newConfig }),
  });

  setConfig(newConfig);
  setIsEditing(false);
  setIsSaving(false);
};
```

**Parsing**: Split by comma, trim whitespace, filter empty strings.

#### UI Structure

```typescript
<div>
  <h2>Worktree File Config</h2>
  {!isEditing && <button onClick={() => setIsEditing(true)}>Edit</button>}

  {isEditing ? (
    <div>
      <label>Symlink (comma-separated)</label>
      <input
        value={symlinkInput}
        onChange={(e) => setSymlinkInput(e.target.value)}
        placeholder=".env, .claude"
      />
      <span className="text-xs opacity-60">
        Files/dirs to symlink from __main__ (shared across worktrees)
      </span>

      <label>Copy (comma-separated)</label>
      <input
        value={copyInput}
        onChange={(e) => setCopyInput(e.target.value)}
        placeholder=".env.example"
      />
      <span className="text-xs opacity-60">
        Files/dirs to copy from __main__ (independent per worktree)
      </span>

      <button onClick={cancel}>Cancel</button>
      <button onClick={handleSave} disabled={isSaving}>
        {isSaving ? "Saving..." : "Save"}
      </button>
    </div>
  ) : (
    <div>
      <div>
        <strong>Symlink:</strong>{" "}
        {config.symlink && config.symlink.length > 0 ? config.symlink.join(", ") : "None"}
      </div>
      <div>
        <strong>Copy:</strong>{" "}
        {config.copy && config.copy.length > 0 ? config.copy.join(", ") : "None"}
      </div>
    </div>
  )}
</div>
```

**Edit Mode**: Toggle between read-only display and edit form.

---

### NavbarV2 (44 lines)

**Location**: `src/app/v2/components/navbar-v2.tsx`

Top navigation bar with theme toggle and add repo button.

#### Structure

```typescript
interface NavbarV2Props {
  repositories: Repository[];
  onAddRepo: () => void;
}

export function NavbarV2({ repositories, onAddRepo }: NavbarV2Props) {
  const repoCount = repositories.length;

  return (
    <nav className="bg-black/5 dark:bg-white/2 border-b border-black/10 dark:border-white/10 min-h-12 h-12 px-3 flex items-center justify-between">
      <div className="flex-1 flex items-center gap-3">
        {/* Logo SVG */}
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path d="M23 2.5L12 21.5L1 2.5H23Z" />
        </svg>

        {/* Separator */}
        <svg className="h-5 opacity-50" viewBox="0 0 15 24">
          <path d="M13.5 2.5L2.5 21.5H1L12 2.5H13.5Z" />
        </svg>

        {/* Repo count */}
        <span className="text-sm font-medium">
          {repoCount === 0
            ? "No repositories"
            : `${repoCount} ${repoCount === 1 ? "repository" : "repositories"}`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <ThemeToggle />
        <button onClick={onAddRepo} className="px-3 py-1.5 text-sm rounded border">
          + Add Repo
        </button>
      </div>
    </nav>
  );
}
```

**Logo**: Triangle SVG with separator.

**Repo Count**: Dynamic text based on count (singular/plural).

**Fixed Height**: `min-h-12 h-12` ensures consistent navbar height.

---

## Key Workflows

### 1. Adding a Repository

**User Flow**:
1. Click "+ Add Repo" button in navbar
2. Dialog opens with URL and directory inputs
3. User enters git URL (SSH or HTTPS)
4. Directory auto-fills with repo name
5. User clicks "Clone"
6. SSE console displays git output and progress
7. On `[DONE]`, dialog shows success button
8. User clicks "Done", dialog closes
9. Repository list refreshes with new repo

**Backend Flow**:
1. POST /api/clone with `{ url, targetDir }`
2. Extract username from URL
3. Create directory at `~/GitHub/[username]/[targetDir]`
4. Clone as bare: `git clone --bare [url] .bare/`
5. Create `.git` file pointing to `.bare`
6. Configure fetch for remote
7. Create __main__ worktree (try main, fallback master)
8. Detect repository type (turborepo/nx/lerna/workspace/standard)
9. Get remote URL
10. Add to registry with type and metadata
11. Stream `[DONE]`

### 2. Creating a Worktree

**User Flow**:
1. Type worktree name in input field for repo
2. Press Enter
3. Input clears immediately
4. Placeholder worktree appears with "Creating..." message
5. Progress messages update in real-time
6. On completion, worktree shows actual commit info
7. "Creating..." indicator fades after 500ms

**Backend Flow**:
1. POST /api/worktree with `{ repoPath, worktreeName }`
2. Load config to get `upstreamRemote` (default: "origin")
3. Update __main__: `git fetch [upstreamRemote]` + `git reset --hard [upstreamRemote]/main`
4. Install deps in __main__ (warm cache)
5. Create worktree: `git worktree add -B [branch] ../[name] [upstreamRemote]/main`
6. Stream `[WORKTREE_CREATED]` ← **UI refetches data**
7. Setup symlinks (`.env`, `.claude/`) and copies (`.env.example`)
8. Install deps in worktree (uses warm cache)
9. Stream `[DONE]` ← **UI clears "creating" state**

**Critical Signals**:
- `[WORKTREE_CREATED]`: Worktree exists, fetch real data for buttons
- `[DONE]`: All operations complete, clear progress state

### 3. Syncing __main__

**User Flow**:
1. Click sync button (↻) on __main__ worktree
2. Progress message appears: "Syncing..."
3. Real-time updates show fetch/reset/install progress
4. On completion, __main__ shows updated commit
5. "Last synced" timestamp updates
6. Progress indicator fades after 500ms

**Backend Flow**:
1. PATCH /api/worktree with `{ repoPath, action: "sync-main" }`
2. Load config to get `upstreamRemote`
3. Fetch: `git fetch [upstreamRemote]`
4. Reset: `git reset --hard [upstreamRemote]/main`
5. Install dependencies
6. Stream `[DONE]`

**Side Effect**: Frontend calls PATCH /api/repos?id=[id] with empty body to update `lastSynced` timestamp.

### 4. Deleting Worktrees

**User Flow**:
1. Click trash icon on worktrees to select (multi-select)
2. Trash icons turn red for selected
3. "Delete N" button appears in input row
4. Click "Delete N"
5. All selected worktrees for this repo are deleted in parallel
6. Worktree list refreshes
7. Selection state clears

**Backend Flow**:
1. For each selected worktree in repo:
   - DELETE /api/worktree?repoPath=[path]&worktreeName=[name]
   - `git worktree remove ../[name] --force`
   - `git branch -D [branch]`
2. Parallel deletion for performance

**Scoping**: Selections are scoped per repository (cannot delete across repos).

### 5. Configuring File Sharing

**User Flow**:
1. Navigate to repository detail page
2. Click "Edit" on Worktree File Config card
3. Enter comma-separated patterns:
   - Symlink: `.env, .claude`
   - Copy: `.env.example`
4. Click "Save"
5. Config persists to `~/.bare-config/worktree-config.json`

**Effect**: All future worktrees for this repo will:
- Symlink `.env` and `.claude/` from __main__ (shared)
- Copy `.env.example` from __main__ (independent)

### 6. Managing Remotes

**User Flow**:
1. Navigate to repository detail page
2. Click "+ Add Remote" on Git Remotes card
3. Enter name (e.g., "upstream") and URL
4. Click "Add"
5. Remote appears in list
6. Click "Set Base" to use as upstream for worktrees
7. "base" badge appears on selected remote

**Effect**: Worktrees will branch from `[upstreamRemote]/main` instead of `origin/main`.

### 7. Opening in External Apps

**VS Code**:
- Click VS Code icon on repo or worktree
- POST /api/open with `{ path, app: "vscode" }`
- Executes `code [path]`

**Terminal**:
- Click Terminal icon on repo
- POST /api/open with `{ path, app: "terminal" }`
- Uses AppleScript to open Terminal at path

**Claude CLI**:
- Click Claude icon on worktree
- POST /api/open-with-claude with `{ path }`
- Checks for existing Claude process in directory
- If exists: Activates VS Code window
- If not: Opens VS Code, opens terminal, types "claude", presses Enter

---

## File System Structure

### Application Files

```
~/.bare-bones/
  repos.json                    # Repository registry

~/.bare-config/
  worktree-config.json          # Per-repo worktree configs

~/GitHub/
  [username]/
    [repo-name]/
      .bare/                    # Bare git repository
      .git                      # File containing: gitdir: ./.bare
      __main__/                 # Main worktree (main or master branch)
        .env                    # Shared file (symlinked from worktrees)
        .claude/                # Shared directory (symlinked from worktrees)
        .env.example            # Template file (copied to worktrees)
        node_modules/           # Warm dependency cache
        package.json
        ...
    [worktree-1]/               # Sibling to repo directory
      .env -> ../__main__/.env  # Symlink
      .claude -> ../__main__/.claude  # Symlink
      .env.example              # Independent copy
      node_modules/             # Links to __main__ cache (pnpm) or own copy
      ...
    [worktree-2]/
      ...
```

### Directory Layout Strategy

**Bare Repo**: `.bare/` inside repo directory
- Contains all git objects
- Pointed to by `.git` file

**Main Worktree**: `__main__/` inside repo directory
- Primary checkout
- Source of truth for dependencies
- Contains shared files

**Feature Worktrees**: Sibling directories to repo
- `~/GitHub/username/repo/` (repo + __main__)
- `~/GitHub/username/feature-x/` (worktree)
- `~/GitHub/username/feature-y/` (worktree)

**Rationale**: Worktrees as siblings keep them at same level, easier to navigate.

---

## CLI Implementation

### Location

`cli/index.ts`

### Command

```bash
bare start [options]
```

### Options

```typescript
program
  .command("start")
  .option("-p, --port <port>", "Port to run on", "3000")
  .action(async (options) => {
    // Implementation
  });
```

### Auto-Update Flow

```typescript
async function autoUpdate() {
  // 1. Fetch latest from origin
  await execa("git", ["fetch", "origin"]);

  // 2. Check if behind
  const { stdout: status } = await execa("git", ["status", "-uno"]);

  if (status.includes("Your branch is behind")) {
    console.log("Updating Bare CLI...");

    // 3. Reset to origin/main
    await execa("git", ["reset", "--hard", "origin/main"]);

    // 4. Reinstall dependencies
    await execa("pnpm", ["install"]);

    console.log("✓ Updated to latest version");
  }
}
```

**When**: Runs before starting dev server.

### Start Command

```typescript
async function start(port: string) {
  await autoUpdate();

  const cwd = join(__dirname, "..");

  await execa("pnpm", ["dev", "--port", port], {
    cwd,
    stdio: "inherit", // Stream output to terminal
  });
}
```

**Behavior**: Spawns Next.js dev server with specified port.

---

## External Integrations

### VS Code

**Mechanism**: Shell command via execa

```typescript
await execa("code", [path]);
```

**Behavior**: Opens directory in VS Code (new window or existing).

### Terminal

**Mechanism**: AppleScript via execa

```typescript
const script = `
  tell application "Terminal"
    do script "cd ${path}"
    activate
  end tell
`;

await execa("osascript", ["-e", script]);
```

**Behavior**: Opens new Terminal window at path.

### Claude CLI

**Mechanism**: Process detection + AppleScript automation

**Phase 1: Detection**
```typescript
// Find all claude processes
const psResult = await execa("ps", ["-axo", "pid,command"]);
const processes = psResult.stdout.split('\n');
const pids = processes
  .filter((line) => line.includes('claude'))
  .map((line) => line.trim().split(/\s+/)[0]);

// Check working directory for each PID
for (const pid of pids) {
  const cwdResult = await execa("lsof", ["-p", pid, "-a", "-d", "cwd", "-Fn"]);
  const cwd = cwdResult.stdout.split('\n').find((line) => line.startsWith('n'));
  const workingDir = cwd.substring(1); // Remove 'n' prefix

  if (workingDir === targetPath) {
    hasClaudeProcess = true;
    break;
  }
}
```

**Phase 2: Activation or Launch**
```typescript
// Always open VS Code first
await execa("code", [path]);
await new Promise((resolve) => setTimeout(resolve, 500));

if (hasClaudeProcess) {
  // Just activate - claude is already running
  send("✓ Found existing Claude session - VS Code activated");
} else {
  // Automate terminal and launch claude
  const script = `
    tell application "Visual Studio Code"
      activate
    end tell
    delay 0.5
    tell application "System Events"
      keystroke "\`" using {control down}  # Ctrl+` (open terminal)
      delay 0.3
      keystroke "claude"
      delay 0.1
      keystroke return
    end tell
  `;

  await execa("osascript", ["-e", script]);
  send("✓ Claude launched");
}
```

**Benefits**:
1. Reuses existing Claude session (avoids duplicates)
2. Just activates VS Code window if claude is running
3. Only automates terminal if new session needed

---

## Technical Patterns and Highlights

### SSE Progress Streaming

**Pattern**: ReadableStream with TextEncoder

```typescript
const encoder = new TextEncoder();
const stream = new ReadableStream({
  async start(controller) {
    const send = (message: string) => {
      controller.enqueue(encoder.encode(`data: ${message}\n\n`));
    };

    try {
      send("Step 1...");
      await operation1();
      send("Step 2...");
      await operation2();
      send("[DONE]");
    } catch (error) {
      send(`ERROR: ${error.message}`);
    } finally {
      controller.close();
    }
  },
});

return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  },
});
```

**Client Parsing**:
```typescript
const reader = response.body?.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split("\n\n");

  for (const line of lines) {
    if (!line.trim() || !line.startsWith("data: ")) continue;
    const message = line.slice(6);

    if (message === "[DONE]") {
      // Handle completion
    } else if (message === "[SIGNAL]") {
      // Handle signal
    } else {
      // Update progress
    }
  }
}
```

### Timed Progress Messages

**Pattern**: Track start time and individual step durations

```typescript
let startTime = Date.now();
let lastTime = startTime;

const sendTimed = (message: string) => {
  const now = Date.now();
  const stepTime = ((now - lastTime) / 1000).toFixed(1);
  const totalTime = ((now - startTime) / 1000).toFixed(1);
  lastTime = now;

  send(`[+${stepTime}s | ${totalTime}s total] ${message}`);
};

// Usage
send("Fetching...");
await fetch();
sendTimed("✓ Fetched"); // [+1.2s | 1.2s total] ✓ Fetched

send("Installing...");
await install();
sendTimed("✓ Installed"); // [+8.4s | 9.6s total] ✓ Installed
```

**Display**: Shows both step duration and cumulative time.

### Placeholder + Refetch Pattern

**Problem**: Long SSE operation, want instant UI feedback, but need real data for buttons.

**Solution**: Two-phase update

```typescript
// Phase 1: Add placeholder immediately
const placeholder = {
  path: tempPath,
  commitMessage: "Creating...",
};
setData([...existing, placeholder]);

// Phase 2: Stream SSE
for (const message of stream) {
  if (message === "[SIGNAL_CREATED]") {
    // Fetch real data from API
    const realData = await fetch("/api/data").then(r => r.json());
    setData(realData);
  } else if (message === "[DONE]") {
    // Clear loading state
    clearLoadingState();
  }
}
```

**Benefit**: Instant feedback + correct data for interactions.

### Per-Repository Scoping

**Pattern**: Map paths to repo, filter selections

```typescript
const handleDeleteSelected = (repoId: string) => {
  const worktrees = repoWorktrees.get(repoId) || [];
  const repoWorktreePaths = new Set(worktrees.map((wt) => wt.path));

  // Only delete worktrees that belong to this repository
  const toDelete = Array.from(selectedWorktrees).filter((path) =>
    repoWorktreePaths.has(path)
  );

  // Delete only filtered set
  await Promise.all(toDelete.map((path) => deleteWorktree(path)));
};
```

**Benefit**: Global selection state, but operations scoped to current repo.

### Warm Dependency Store

**Concept**: Install once in __main__, share cache with worktrees

**Implementation**:
1. Install in __main__: Creates `node_modules/` with full deps
2. Package manager stores cache globally (pnpm: `~/.pnpm-store`)
3. Install in worktree: Links to cached packages (pnpm) or copies faster
4. Net result: 10-20x faster installs in worktrees

**Code**:
```typescript
// Install in __main__ (slow, populates cache)
await installDependencies(repoPath);

// Install in worktree (fast, uses cache)
await installWorktreeDependencies(repoPath, worktreeName);
```

### Bare Repository Benefits

**Traditional Clone**:
```
~/projects/repo/.git/          # Full git database
~/projects/repo/src/           # Working directory
```

**Bare Clone**:
```
~/projects/repo/.bare/         # Git database
~/projects/repo/.git           # File: "gitdir: ./.bare"
~/projects/repo/__main__/      # Worktree 1
~/projects/feature-x/          # Worktree 2
```

**Benefits**:
1. Single git database shared across worktrees
2. No duplicate objects (saves disk space)
3. Worktrees are just working directories
4. Can delete worktree without losing git data
5. All worktrees share same refs (branches/tags)

---

## Configuration Files

### next.config.ts

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,      // Enable Cache Components (Next.js 16)
  reactCompiler: true,        // Enable React Compiler
  devIndicators: {
    appIsrStatus: false,      // Disable ISR indicator
    buildActivity: false,     // Disable build activity indicator
  },
};

export default nextConfig;
```

### tailwind.config.ts

Uses Tailwind CSS v4 with new `@import` syntax in CSS instead of config file.

**app/globals.css**:
```css
@import "tailwindcss";
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "jsx": "preserve",
    "strict": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

## Development Environment

### Package Manager

Default: **pnpm**

Detection order: pnpm → yarn → bun → npm

### Scripts

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint"
}
```

### CLI Usage

```bash
# Start dev server (with auto-update)
./cli/index.ts start

# Start on custom port
./cli/index.ts start --port 4000
```

---

## Database and Persistence

**No database server**: All data stored as JSON files

**Registry**: `~/.bare-bones/repos.json`
- Contains all Repository objects
- Updated via atomic write operations

**Worktree Config**: `~/.bare-config/worktree-config.json`
- Maps repo paths to WorktreeConfig objects
- Separate file for config vs data

**Git Data**: Managed by git itself in `.bare/` directory

---

## Error Handling Patterns

### API Routes

```typescript
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { field } = body;

    if (!field) {
      return NextResponse.json(
        { error: "Missing required field: field" },
        { status: 400 }
      );
    }

    const result = await operation(field);
    return NextResponse.json(result);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Pattern**: Catch all errors, extract message, return JSON with error field.

### SSE Streams

```typescript
const stream = new ReadableStream({
  async start(controller) {
    try {
      send("Starting...");
      await operation();
      send("[DONE]");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(`ERROR: ${message}`);
    } finally {
      controller.close();
    }
  },
});
```

**Pattern**: Stream `ERROR: {message}` instead of throwing.

### Client-Side

```typescript
try {
  await operation();
} catch (err) {
  console.error("Operation failed:", err);
  setError(err instanceof Error ? err.message : "Operation failed");
}
```

**Pattern**: Log to console, set error state for UI display.

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

## Future Enhancements (Not Implemented)

These are potential features that could be added:

- Branch switching within worktrees
- PR integration (GitHub API)
- Commit and push from UI
- Multi-repo operations (sync all, create worktree in all)
- Custom file sharing templates
- Docker integration
- Worktree templates (pre-configured setups)
- Analytics (worktree usage, sync frequency)
- Notifications (worktree created, sync complete)
- Mobile app for monitoring

---

## Summary

**Bare** is a comprehensive git worktree management application that simplifies working with multiple feature branches simultaneously. It leverages:

- **Bare repositories** for efficient storage
- **Worktrees** for isolated feature development
- **File sharing** via symlinks and copies
- **Warm dependency caching** for fast installs
- **SSE streaming** for real-time progress
- **External tool integration** for seamless workflows
- **Modern stack** (Next.js 16, React 19, TypeScript, Tailwind v4)

The application provides both a web UI (V2 components) and CLI for managing repositories, creating worktrees, syncing with upstream, and integrating with development tools. All state is persisted to JSON files, with git itself managing version control data.

This spec captures the complete architecture, implementation details, and workflows as of the current codebase state.
