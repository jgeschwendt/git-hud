# Database Schema & Patterns

git-hud uses SQLite for all persistent data storage.

> **Implementation:** Schema and queries are in `src/lib/db.ts` using `bun:sqlite`.
> Some code samples below show alternative patterns from planning docs.

---

## Schema

**Location**: `~/.git-hud/data/repos.db`

**Configuration**:
```sql
PRAGMA journal_mode = WAL;  -- Write-Ahead Logging for concurrent reads
PRAGMA foreign_keys = ON;   -- Enforce referential integrity
```

### Core Tables

#### repositories

Tracks all cloned repositories.

```sql
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
```

**Indexes**:
```sql
CREATE INDEX idx_repos_path ON repositories(local_path);
```

#### worktrees

Tracks all worktrees across all repositories.

```sql
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
```

**Indexes**:
```sql
CREATE INDEX idx_worktrees_repo ON worktrees(repo_id);
CREATE INDEX idx_worktrees_status ON worktrees(status);
```

#### worktree_config

Per-repository configuration for file sharing and upstream remote.

```sql
CREATE TABLE worktree_config (
  repo_id TEXT PRIMARY KEY,           -- One config per repository
  symlink_patterns TEXT,              -- JSON array: [".env", ".claude"]
  copy_patterns TEXT,                 -- JSON array: [".env.example"]
  upstream_remote TEXT DEFAULT 'origin',
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
```

**JSON Column Format**:
```json
{
  "symlink_patterns": [".env", ".claude"],
  "copy_patterns": [".env.example"],
  "upstream_remote": "upstream"
}
```

#### remotes

Git remotes for each repository.

```sql
CREATE TABLE remotes (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
```

---

## Query Patterns

### Prepared Statements

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

### Usage Pattern

```typescript
// Always close database after use
const db = getDb()
try {
  const repositories = repos.list(db).all()
  // ... use data
} finally {
  db.close()
}

// Transaction pattern for multiple operations
const db = getDb()
try {
  db.exec('BEGIN TRANSACTION')

  repos.create(db).run(id, provider, username, name, url, path, type, now, now)
  worktrees.create(db).run(wtPath, id, branch, null, 'creating', now)

  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
} finally {
  db.close()
}
```

---

## Type Definitions

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

---

## Migrations

**Initial Setup**:
```typescript
// cli/database.ts
export async function initializeDatabase() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Check current version
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }

  if (version.user_version === 0) {
    // Initial schema
    db.exec(INITIAL_SCHEMA)
    db.prepare('PRAGMA user_version = 1').run()
  }

  // Future migrations
  if (version.user_version === 1) {
    // db.exec(MIGRATION_V2)
    // db.prepare('PRAGMA user_version = 2').run()
  }

  db.close()
}
```

---

## Best Practices

1. **Always use prepared statements** - Prevent SQL injection and improve performance
2. **Always close database connections** - Use try/finally blocks
3. **Use transactions for multi-step operations** - Ensure atomicity
4. **Store JSON as TEXT** - Use `JSON.stringify()` and `JSON.parse()`
5. **Use Unix timestamps** - `Date.now()` for all timestamps
6. **Rely on foreign keys** - CASCADE deletes maintain integrity
7. **Index frequently queried columns** - Improve query performance
8. **Use WAL mode** - Enable concurrent reads while writing
