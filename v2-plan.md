# git-hud v2 Implementation Plan

**Target**: Single binary installable via curl, no dependencies
**First Milestone**: Hello world web UI accessible after install
**Philosophy**: Architecture → Documentation → Implementation

---

## Phase 0: Architecture Foundation

Before writing any application code, establish the structural patterns that will guide all implementation.

### 0.1 Directory Architecture

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

### 0.2 Data Architecture

**SQLite Schema** (`~/.git-hud/data/repos.db`):

```sql
-- Core entities
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,                -- UUID
  provider TEXT NOT NULL,             -- github, gitlab, bitbucket
  username TEXT NOT NULL,             -- Repository owner
  name TEXT NOT NULL,                 -- Repository name
  clone_url TEXT NOT NULL,            -- Original clone URL
  local_path TEXT NOT NULL UNIQUE,    -- ~/.git-hud/clones/{provider}/{user}/{repo}
  type TEXT,                          -- turborepo, nx, lerna, workspace, standard
  last_synced INTEGER NOT NULL,       -- Unix timestamp
  created_at INTEGER NOT NULL,
  UNIQUE(provider, username, name)
);

CREATE TABLE worktrees (
  path TEXT PRIMARY KEY,              -- Absolute path to worktree
  repo_id TEXT NOT NULL,              -- Foreign key to repositories
  branch TEXT NOT NULL,               -- Branch name
  head TEXT,                          -- Git HEAD commit hash
  status TEXT NOT NULL,               -- ready, creating, error
  commit_message TEXT,                -- Latest commit message
  created_at INTEGER NOT NULL,

  -- Git status tracking
  dirty BOOLEAN DEFAULT 0,            -- Has uncommitted changes
  ahead INTEGER DEFAULT 0,            -- Commits ahead of upstream
  behind INTEGER DEFAULT 0,           -- Commits behind upstream
  last_status_check INTEGER,          -- Unix timestamp

  -- Integration tracking
  vscode_pid INTEGER,                 -- VSCode process ID if open
  vscode_opened_at INTEGER,           -- Unix timestamp

  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE worktree_config (
  repo_id TEXT PRIMARY KEY,           -- One config per repository
  symlink_patterns TEXT,              -- JSON array: [".env", ".claude"]
  copy_patterns TEXT,                 -- JSON array: [".env.example"]
  upstream_remote TEXT DEFAULT 'origin',
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE remotes (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX idx_worktrees_repo ON worktrees(repo_id);
CREATE INDEX idx_worktrees_status ON worktrees(status);
CREATE INDEX idx_repos_path ON repositories(local_path);
```

**Rationale**:
- Atomic operations prevent race conditions
- Prepared statements for performance
- Foreign keys maintain referential integrity
- JSON columns for flexible array storage
- Indexes on frequently queried fields

### 0.3 Process Architecture

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

### 0.4 State Management Architecture

**Problem**: Concurrent worktree creation causes UI race conditions

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

### 0.5 Installation Architecture

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
2. Download appropriate binary
3. Place in ~/.git-hud/bin/git-hud
4. Add to PATH
5. Initialize database
6. Launch server
```

**Auto-Update Strategy**:
- Check GitHub releases on startup
- Download new binary in background
- Replace on next restart
- Preserve database schema migrations

---

## Phase 1: Hello World Installation

**Goal**: `curl | bash` installs and serves a hello world page on `http://localhost:3000`

**Success Criteria**:
- ✅ No Node.js required on target machine
- ✅ Single binary < 100MB
- ✅ Installs in < 30 seconds
- ✅ Server starts in < 2 seconds
- ✅ Web UI accessible immediately

### 1.1 Project Initialization

```bash
# Create new project
mkdir git-hud-v2
cd git-hud-v2
bun init -y

# Install dependencies
bun add next@latest react@latest react-dom@latest
bun add better-sqlite3
bun add -d @types/react @types/react-dom @types/node typescript
```

### 1.2 Minimal Next.js Setup

**next.config.ts**:
```typescript
import type { NextConfig } from 'next'
import path from 'path'

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, './'),
  experimental: {
    outputFileTracingIncludes: {
      '/': ['./cli/**/*', './data/**/*']
    }
  }
}

export default config
```

**src/app/layout.tsx**:
```typescript
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>git-hud</title>
      </head>
      <body>{children}</body>
    </html>
  )
}
```

**src/app/page.tsx**:
```typescript
export default function HomePage() {
  return (
    <main style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '1rem' }}>
          git-hud v2
        </h1>
        <p style={{ fontSize: '1.25rem', opacity: 0.7 }}>
          Installation successful!
        </p>
        <p style={{ fontSize: '0.875rem', opacity: 0.5, marginTop: '2rem' }}>
          Running from {process.env.GIT_HUD_ROOT || '~/.git-hud'}
        </p>
      </div>
    </main>
  )
}
```

### 1.3 CLI Entry Point

**cli/index.ts**:
```typescript
#!/usr/bin/env bun
import { startServer } from './server'
import { initializeDatabase } from './database'
import path from 'path'
import os from 'os'

const GIT_HUD_ROOT = path.join(os.homedir(), '.git-hud')
process.env.GIT_HUD_ROOT = GIT_HUD_ROOT

async function main() {
  const command = process.argv[2] || 'start'

  switch (command) {
    case 'start':
      await initializeDatabase()
      await startServer()
      break

    case 'version':
      console.log(require('../package.json').version)
      break

    default:
      console.log('Usage: git-hud [start|version]')
  }
}

main().catch(console.error)
```

**cli/database.ts**:
```typescript
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const GIT_HUD_ROOT = process.env.GIT_HUD_ROOT!
const DB_PATH = path.join(GIT_HUD_ROOT, 'data', 'repos.db')

export async function initializeDatabase() {
  const dataDir = path.dirname(DB_PATH)

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  // Minimal schema for Phase 1
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT OR IGNORE INTO meta (key, value)
    VALUES ('version', '2.0.0');
  `)

  db.close()
  console.log('✓ Database initialized at', DB_PATH)
}
```

**cli/server.ts**:
```typescript
import { spawn } from 'child_process'
import path from 'path'

export async function startServer() {
  const port = process.env.PORT || 3000
  const nextDir = path.join(__dirname, '..', '.next', 'standalone')

  console.log('Starting git-hud server...')
  console.log(`  → http://localhost:${port}`)
  console.log(`  → Data: ${process.env.GIT_HUD_ROOT}/data`)
  console.log('')

  const server = spawn('node', [path.join(nextDir, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '0.0.0.0'
    },
    stdio: 'inherit'
  })

  server.on('exit', (code) => {
    console.log('Server exited with code', code)
    process.exit(code || 0)
  })
}
```

### 1.4 Build Script

**scripts/build.sh**:
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> Building Next.js standalone..."
bun run next build

echo "==> Copying assets..."
cp -r public .next/standalone/public 2>/dev/null || true
cp -r .next/static .next/standalone/.next/static

echo "==> Compiling binary..."
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
fi

TARGET="bun-${OS}-${ARCH}"
OUTPUT="dist/git-hud-${OS}-${ARCH}"

mkdir -p dist

bun build --compile \
  --minify \
  --target="$TARGET" \
  --outfile="$OUTPUT" \
  ./cli/index.ts

echo "==> Binary created at: $OUTPUT"
du -h "$OUTPUT"
```

**package.json** scripts:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "bash scripts/build.sh",
    "start": "./cli/index.ts start"
  }
}
```

### 1.5 Installation Script

**install.sh** (to be hosted on GitHub):
```bash
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.git-hud"
BIN_DIR="${INSTALL_DIR}/bin"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
fi

BINARY_NAME="git-hud-${OS}-${ARCH}"
RELEASE_URL="https://github.com/jgeschwendt/git-hud/releases/latest/download/${BINARY_NAME}"

echo "Installing git-hud for ${OS}-${ARCH}..."

# Create directories
mkdir -p "$BIN_DIR"
mkdir -p "${INSTALL_DIR}/data"
mkdir -p "${INSTALL_DIR}/clones"
mkdir -p "${INSTALL_DIR}/logs"

# Download binary
echo "Downloading from $RELEASE_URL..."
if command -v curl &> /dev/null; then
  curl -fsSL "$RELEASE_URL" -o "${BIN_DIR}/git-hud"
elif command -v wget &> /dev/null; then
  wget -q -O "${BIN_DIR}/git-hud" "$RELEASE_URL"
else
  echo "Error: curl or wget required"
  exit 1
fi

chmod +x "${BIN_DIR}/git-hud"

# Add to PATH if not already
SHELL_RC="${HOME}/.zshrc"
if [ -f "${HOME}/.bashrc" ]; then
  SHELL_RC="${HOME}/.bashrc"
fi

if ! grep -q ".git-hud/bin" "$SHELL_RC" 2>/dev/null; then
  echo '' >> "$SHELL_RC"
  echo '# git-hud' >> "$SHELL_RC"
  echo 'export PATH="$HOME/.git-hud/bin:$PATH"' >> "$SHELL_RC"
  echo "Added to PATH in $SHELL_RC"
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Start git-hud:"
echo "  ${BIN_DIR}/git-hud start"
echo ""
echo "Or reload your shell and run:"
echo "  git-hud start"
```

### 1.6 GitHub Release Workflow

**.github/workflows/release.yml**:
```yaml
name: Release

on:
  push:
    tags: ['v*.*.*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: bun-linux-x64
          - os: ubuntu-latest
            target: bun-linux-arm64
          - os: macos-latest
            target: bun-darwin-x64
          - os: macos-latest
            target: bun-darwin-arm64

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile
      - run: bun run next build

      - run: |
          cp -r public .next/standalone/public 2>/dev/null || true
          cp -r .next/static .next/standalone/.next/static

      - name: Extract platform name
        id: platform
        run: |
          TARGET="${{ matrix.target }}"
          PLATFORM="${TARGET#bun-}"
          echo "name=$PLATFORM" >> $GITHUB_OUTPUT

      - run: |
          bun build --compile \
            --minify \
            --target=${{ matrix.target }} \
            --outfile=git-hud-${{ steps.platform.outputs.name }} \
            ./cli/index.ts

      - uses: actions/upload-artifact@v4
        with:
          name: git-hud-${{ steps.platform.outputs.name }}
          path: git-hud-${{ steps.platform.outputs.name }}

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Flatten artifacts
        run: |
          mkdir -p binaries
          find artifacts -type f -exec mv {} binaries/ \;
          ls -lh binaries/

      - uses: softprops/action-gh-release@v2
        with:
          files: binaries/*
          generate_release_notes: true
```

### 1.7 Testing Phase 1

**Manual Test Checklist**:
```bash
# Local build test
cd git-hud-v2
bun install
bun run build

# Verify binary works
./dist/git-hud-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/') start

# Should see:
# ✓ Database initialized at /Users/you/.git-hud/data/repos.db
# Starting git-hud server...
#   → http://localhost:3000
#   → Data: /Users/you/.git-hud/data
#
# Visit http://localhost:3000 → See "git-hud v2" page

# Test installation script (after GitHub release)
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/git-hud/main/install.sh | bash
git-hud start
```

**Success Criteria**:
- [ ] Binary compiles without errors
- [ ] Binary size < 100MB
- [ ] Database initializes correctly
- [ ] Server starts in < 2 seconds
- [ ] Web UI loads and displays hello world
- [ ] Installation script works on macOS
- [ ] Installation script works on Linux
- [ ] Binary added to PATH automatically

---

## Phase 2: Core Data Models

**Goal**: Implement repository and worktree data models with full CRUD operations

### 2.1 Complete Database Schema

**cli/database.ts** (full schema):
```typescript
export async function initializeDatabase() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      type TEXT,
      last_synced INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, username, name)
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      path TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT,
      status TEXT NOT NULL,
      commit_message TEXT,
      created_at INTEGER NOT NULL,
      dirty BOOLEAN DEFAULT 0,
      ahead INTEGER DEFAULT 0,
      behind INTEGER DEFAULT 0,
      last_status_check INTEGER,
      vscode_pid INTEGER,
      vscode_opened_at INTEGER,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worktree_config (
      repo_id TEXT PRIMARY KEY,
      symlink_patterns TEXT,
      copy_patterns TEXT,
      upstream_remote TEXT DEFAULT 'origin',
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS remotes (
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (repo_id, name),
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
    CREATE INDEX IF NOT EXISTS idx_repos_path ON repositories(local_path);
  `)

  db.close()
}
```

### 2.2 Database Queries Module

**cli/queries.ts**:
```typescript
import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = path.join(process.env.GIT_HUD_ROOT!, 'data', 'repos.db')

export function getDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  return db
}

// Repository queries
export const repos = {
  create: (db: Database.Database) => db.prepare(`
    INSERT INTO repositories (id, provider, username, name, clone_url, local_path, type, last_synced, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  list: (db: Database.Database) => db.prepare(`
    SELECT * FROM repositories ORDER BY last_synced DESC
  `),

  findById: (db: Database.Database) => db.prepare(`
    SELECT * FROM repositories WHERE id = ?
  `),

  findByPath: (db: Database.Database) => db.prepare(`
    SELECT * FROM repositories WHERE local_path = ?
  `),

  update: (db: Database.Database) => db.prepare(`
    UPDATE repositories
    SET type = ?, last_synced = ?
    WHERE id = ?
  `),

  delete: (db: Database.Database) => db.prepare(`
    DELETE FROM repositories WHERE id = ?
  `)
}

// Worktree queries
export const worktrees = {
  create: (db: Database.Database) => db.prepare(`
    INSERT INTO worktrees (path, repo_id, branch, head, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  listByRepo: (db: Database.Database) => db.prepare(`
    SELECT * FROM worktrees WHERE repo_id = ? ORDER BY path
  `),

  findByPath: (db: Database.Database) => db.prepare(`
    SELECT * FROM worktrees WHERE path = ?
  `),

  updateStatus: (db: Database.Database) => db.prepare(`
    UPDATE worktrees
    SET status = ?, head = ?, commit_message = ?
    WHERE path = ?
  `),

  updateGitStatus: (db: Database.Database) => db.prepare(`
    UPDATE worktrees
    SET dirty = ?, ahead = ?, behind = ?, last_status_check = ?
    WHERE path = ?
  `),

  delete: (db: Database.Database) => db.prepare(`
    DELETE FROM worktrees WHERE path = ?
  `)
}

// Config queries
export const config = {
  get: (db: Database.Database) => db.prepare(`
    SELECT * FROM worktree_config WHERE repo_id = ?
  `),

  upsert: (db: Database.Database) => db.prepare(`
    INSERT INTO worktree_config (repo_id, symlink_patterns, copy_patterns, upstream_remote)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      symlink_patterns = excluded.symlink_patterns,
      copy_patterns = excluded.copy_patterns,
      upstream_remote = excluded.upstream_remote
  `)
}
```

### 2.3 Type Definitions

**src/lib/types.ts**:
```typescript
export interface Repository {
  id: string
  provider: 'github' | 'gitlab' | 'bitbucket'
  username: string
  name: string
  clone_url: string
  local_path: string
  type?: 'turborepo' | 'nx' | 'lerna' | 'workspace' | 'standard'
  last_synced: number
  created_at: number
}

export interface Worktree {
  path: string
  repo_id: string
  branch: string
  head?: string
  status: 'ready' | 'creating' | 'error'
  commit_message?: string
  created_at: number
  dirty: boolean
  ahead: number
  behind: number
  last_status_check?: number
  vscode_pid?: number
  vscode_opened_at?: number
}

export interface WorktreeConfig {
  repo_id: string
  symlink_patterns?: string[]
  copy_patterns?: string[]
  upstream_remote: string
}

export interface Remote {
  repo_id: string
  name: string
  url: string
}
```

### 2.4 Update Hello World Page

**src/app/page.tsx**:
```typescript
import { getDb, repos } from '@/cli/queries'

export default function HomePage() {
  const db = getDb()
  const repositories = repos.list(db).all()
  db.close()

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>git-hud v2</h1>
      <p>Installation root: {process.env.GIT_HUD_ROOT}</p>

      <h2>Repositories ({repositories.length})</h2>
      {repositories.length === 0 ? (
        <p>No repositories yet. Add one to get started.</p>
      ) : (
        <ul>
          {repositories.map((repo: any) => (
            <li key={repo.id}>
              {repo.provider}/{repo.username}/{repo.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

---

## Phase 3: Git Operations Engine

**Goal**: Implement all git operations with progress streaming

### 3.1 Git Operations Module

**cli/git-ops.ts**:
```typescript
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

type ProgressCallback = (message: string) => void

export class GitOps {
  /**
   * Clone repository as bare with __main__ worktree
   */
  async cloneRepository(
    url: string,
    onProgress: ProgressCallback
  ): Promise<{
    provider: string
    username: string
    repoName: string
    localPath: string
  }> {
    // Parse URL to extract provider/username/repo
    const parsed = this.parseGitUrl(url)

    const repoPath = path.join(
      process.env.GIT_HUD_ROOT!,
      'clones',
      parsed.provider,
      parsed.username,
      parsed.repoName
    )

    onProgress(`Cloning ${parsed.provider}/${parsed.username}/${parsed.repoName}...`)

    // Create directory structure
    await execAsync(`mkdir -p "${repoPath}"`)

    // Clone as bare
    onProgress('Cloning bare repository...')
    await execAsync(`git clone --bare "${url}" .bare`, { cwd: repoPath })

    // Create .git file
    await Bun.write(path.join(repoPath, '.git'), 'gitdir: ./.bare\n')

    // Configure fetch
    onProgress('Configuring remotes...')
    await execAsync(
      'git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
      { cwd: repoPath }
    )

    // Create __main__ worktree
    onProgress('Creating __main__ worktree...')
    try {
      await execAsync(`git worktree add __main__ main`, { cwd: repoPath })
    } catch {
      await execAsync(`git worktree add __main__ master`, { cwd: repoPath })
    }

    return {
      ...parsed,
      localPath: repoPath
    }
  }

  /**
   * Create new worktree from branch
   */
  async createWorktree(
    repoPath: string,
    branch: string,
    upstream: string,
    onProgress: ProgressCallback
  ): Promise<string> {
    const worktreeName = branch.replace(/\//g, '-')
    const worktreePath = path.join(path.dirname(repoPath), worktreeName)

    onProgress(`Creating worktree for ${branch}...`)

    await execAsync(
      `git worktree add -B "${branch}" "${worktreePath}" "${upstream}/main"`,
      { cwd: repoPath }
    )

    return worktreePath
  }

  /**
   * Setup file sharing (symlinks/copies)
   */
  async setupFiles(
    repoPath: string,
    worktreePath: string,
    config: { symlink?: string[], copy?: string[] },
    onProgress: ProgressCallback
  ): Promise<void> {
    const mainPath = path.join(repoPath, '__main__')

    if (config.symlink) {
      for (const pattern of config.symlink) {
        const source = path.join(mainPath, pattern)
        const target = path.join(worktreePath, pattern)

        try {
          await execAsync(`ln -s "${source}" "${target}"`)
          onProgress(`  ✓ Linked ${pattern}`)
        } catch {
          onProgress(`  ⊘ Skipped ${pattern} (not found)`)
        }
      }
    }

    if (config.copy) {
      for (const pattern of config.copy) {
        const source = path.join(mainPath, pattern)
        const target = path.join(worktreePath, pattern)

        try {
          await execAsync(`cp -r "${source}" "${target}"`)
          onProgress(`  ✓ Copied ${pattern}`)
        } catch {
          onProgress(`  ⊘ Skipped ${pattern} (not found)`)
        }
      }
    }
  }

  /**
   * Get git status for worktree
   */
  async getStatus(worktreePath: string): Promise<{
    dirty: boolean
    ahead: number
    behind: number
  }> {
    const [porcelain, revList] = await Promise.all([
      execAsync('git status --porcelain', { cwd: worktreePath })
        .then(r => r.stdout),
      execAsync('git rev-list --left-right --count HEAD...@{u}', { cwd: worktreePath })
        .then(r => r.stdout)
        .catch(() => '0\t0')
    ])

    const dirty = porcelain.trim().length > 0
    const [ahead, behind] = revList.trim().split('\t').map(Number)

    return { dirty, ahead: ahead || 0, behind: behind || 0 }
  }

  /**
   * Parse git URL to extract components
   */
  private parseGitUrl(url: string): {
    provider: string
    username: string
    repoName: string
  } {
    // SSH: git@github.com:user/repo.git
    // HTTPS: https://github.com/user/repo.git

    let provider = 'github'
    let match

    if (url.startsWith('git@')) {
      match = url.match(/git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/)
      if (match) {
        provider = match[1].split('.')[0]
        return {
          provider,
          username: match[2],
          repoName: match[3]
        }
      }
    } else {
      match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/)
      if (match) {
        provider = match[1].split('.')[0]
        return {
          provider,
          username: match[2],
          repoName: match[3]
        }
      }
    }

    throw new Error('Invalid git URL')
  }
}

export const git = new GitOps()
```

---

## Phase 4: Event System & SSE

**Goal**: Real-time progress updates via Server-Sent Events

### 4.1 Event Bus

**cli/event-bus.ts**:
```typescript
import { EventEmitter } from 'events'

export type WorktreeEvent = {
  worktreePath: string
  type: 'progress' | 'complete' | 'error'
  message: string
  data?: any
}

class EventBus extends EventEmitter {
  emitWorktreeEvent(event: WorktreeEvent) {
    this.emit(`worktree:${event.worktreePath}`, event)
  }

  onWorktreeEvents(worktreePath: string, handler: (event: WorktreeEvent) => void) {
    this.on(`worktree:${worktreePath}`, handler)
    return () => this.off(`worktree:${worktreePath}`, handler)
  }
}

export const eventBus = new EventBus()
```

### 4.2 Server Actions

**src/app/actions.ts**:
```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { getDb, repos, worktrees, config } from '@/cli/queries'
import { git } from '@/cli/git-ops'
import { eventBus } from '@/cli/event-bus'
import { randomUUID } from 'crypto'

export async function cloneRepository(url: string) {
  const db = getDb()
  const repoId = randomUUID()
  const timestamp = Date.now()

  try {
    const result = await git.cloneRepository(url, (message) => {
      // Log progress (could emit to event bus if needed)
      console.log(message)
    })

    repos.create(db).run(
      repoId,
      result.provider,
      result.username,
      result.repoName,
      url,
      result.localPath,
      null, // type detected later
      timestamp,
      timestamp
    )

    db.close()
    revalidatePath('/')

    return { success: true, id: repoId }
  } catch (error) {
    db.close()
    return { success: false, error: String(error) }
  }
}

export async function createWorktree(repoId: string, branch: string) {
  const db = getDb()

  try {
    const repo = repos.findById(db).get(repoId) as any
    if (!repo) throw new Error('Repository not found')

    const worktreeConfig = config.get(db).get(repoId) as any
    const upstream = worktreeConfig?.upstream_remote || 'origin'

    // Create optimistic record
    const tempPath = `${repo.local_path}/../${branch.replace(/\//g, '-')}`
    worktrees.create(db).run(
      tempPath,
      repoId,
      branch,
      null,
      'creating',
      Date.now()
    )

    db.close()
    revalidatePath('/')

    // Start async operation
    git.createWorktree(repo.local_path, branch, upstream, (message) => {
      eventBus.emitWorktreeEvent({
        worktreePath: tempPath,
        type: 'progress',
        message
      })
    }).then(async (actualPath) => {
      const db2 = getDb()
      worktrees.updateStatus(db2).run('ready', null, null, actualPath)
      db2.close()

      eventBus.emitWorktreeEvent({
        worktreePath: tempPath,
        type: 'complete',
        message: 'Worktree created'
      })

      revalidatePath('/')
    }).catch((error) => {
      eventBus.emitWorktreeEvent({
        worktreePath: tempPath,
        type: 'error',
        message: String(error)
      })
    })

    return { success: true, path: tempPath }
  } catch (error) {
    db.close()
    return { success: false, error: String(error) }
  }
}
```

### 4.3 SSE Endpoint

**src/app/api/worktree/[path]/stream/route.ts**:
```typescript
import { NextRequest } from 'next/server'
import { eventBus } from '@/cli/event-bus'

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string } }
) {
  const worktreePath = decodeURIComponent(params.path)
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = eventBus.onWorktreeEvents(worktreePath, (event) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        )

        if (event.type === 'complete' || event.type === 'error') {
          unsubscribe()
          controller.close()
        }
      })

      request.signal.addEventListener('abort', () => {
        unsubscribe()
        controller.close()
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  })
}
```

---

## Phase 5: UI Components with State Reconciliation

**Goal**: Build UI with robust concurrent operation handling

### 5.1 Worktree Manager Component

**src/components/worktree-manager.tsx**:
```typescript
'use client'

import { useState, useMemo, useTransition } from 'react'
import { createWorktree } from '@/app/actions'
import type { Worktree } from '@/lib/types'

interface WorktreeState {
  server: Worktree[]
  creating: Map<string, {
    worktree: Worktree
    realPath?: string
  }>
  deleting: Set<string>
  progress: Map<string, string>
}

function reconcile(state: WorktreeState): Worktree[] {
  const serverPaths = new Set(state.server.map(w => w.path))

  let result = state.server.filter(w => !state.deleting.has(w.path))

  const pending = Array.from(state.creating.values())
    .filter(({ realPath }) => !realPath || !serverPaths.has(realPath))
    .map(({ worktree }) => worktree)

  return [...result, ...pending].sort((a, b) => a.path.localeCompare(b.path))
}

export function WorktreeManager({
  repoId,
  initial
}: {
  repoId: string
  initial: Worktree[]
}) {
  const [isPending, startTransition] = useTransition()
  const [state, setState] = useState<WorktreeState>({
    server: initial,
    creating: new Map(),
    deleting: new Set(),
    progress: new Map()
  })

  const worktrees = useMemo(() => reconcile(state), [state])

  async function handleCreate(branch: string) {
    const tempId = crypto.randomUUID()
    const tempPath = `pending-${tempId}`

    setState(prev => ({
      ...prev,
      creating: new Map(prev.creating).set(tempId, {
        worktree: {
          path: tempPath,
          repo_id: repoId,
          branch,
          status: 'creating',
          created_at: Date.now(),
          dirty: false,
          ahead: 0,
          behind: 0
        }
      })
    }))

    const result = await createWorktree(repoId, branch)

    if (!result.success) {
      setState(prev => {
        const creating = new Map(prev.creating)
        creating.delete(tempId)
        return { ...prev, creating }
      })
      return
    }

    setState(prev => {
      const creating = new Map(prev.creating)
      const item = creating.get(tempId)
      if (item) {
        item.realPath = result.path
        item.worktree.path = result.path!
      }
      return { ...prev, creating }
    })

    const es = new EventSource(
      `/api/worktree/${encodeURIComponent(result.path!)}/stream`
    )

    es.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'progress') {
        setState(prev => ({
          ...prev,
          progress: new Map(prev.progress).set(result.path!, data.message)
        }))
      }

      if (data.type === 'complete') {
        startTransition(async () => {
          const fresh = await fetch(`/api/worktrees?repo=${repoId}`)
            .then(r => r.json())

          setState(prev => {
            const creating = new Map(prev.creating)
            creating.delete(tempId)

            return {
              ...prev,
              server: fresh,
              creating
            }
          })
        })

        es.close()
      }
    }
  }

  return (
    <div>
      <h2>Worktrees</h2>

      <form onSubmit={(e) => {
        e.preventDefault()
        const input = e.currentTarget.branch as HTMLInputElement
        handleCreate(input.value)
        input.value = ''
      }}>
        <input name="branch" placeholder="feature/new-feature" required />
        <button type="submit">Create Worktree</button>
      </form>

      <ul>
        {worktrees.map(wt => {
          const progressMsg = state.progress.get(wt.path)

          return (
            <li key={wt.path}>
              <strong>{wt.branch}</strong>
              {' '}
              <span style={{ opacity: 0.5 }}>{wt.path}</span>
              {' '}
              <span>{wt.status}</span>
              {progressMsg && (
                <div style={{ fontSize: '0.875rem', opacity: 0.7 }}>
                  {progressMsg}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

---

## Documentation Structure

All documentation lives in `docs/` directory:

```
docs/
├── ARCHITECTURE.md          # System design decisions
├── API.md                   # Server Actions + SSE endpoints
├── DATABASE.md              # Schema + query patterns
├── STATE_MANAGEMENT.md      # Client state reconciliation
├── GIT_OPERATIONS.md        # Git workflows
└── DEPLOYMENT.md            # Build + release process
```

---

## Timeline

| Phase | Days | Description |
|-------|------|-------------|
| 0     | 2    | Architecture + Documentation |
| 1     | 2    | Hello World Installation |
| 2     | 1    | Data Models |
| 3     | 2    | Git Operations |
| 4     | 1    | Event System + SSE |
| 5     | 3    | UI Components |
| **Total** | **11** | |

---

## Next Steps

1. Initialize project structure
2. Write Phase 0 architecture docs
3. Implement Phase 1 hello world
4. Test installation flow
5. Build remaining phases incrementally
