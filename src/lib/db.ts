import { Database } from 'bun:sqlite'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import type { Repository, Worktree, Remote, WorktreeConfig } from './types'

const DB_PATH = process.env.GROVE_ROOT
  ? join(process.env.GROVE_ROOT, 'data', 'repos.db')
  : join(process.env.HOME!, '.grove', 'data', 'repos.db')

let db: Database | null = null

export function getDb(): Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    db = new Database(DB_PATH, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    initSchema(db)
  }
  return db
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      local_path TEXT NOT NULL UNIQUE,
      type TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      last_synced INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, username, name)
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      path TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT,
      status TEXT NOT NULL CHECK(status IN ('creating', 'ready', 'error', 'deleting')),
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

    CREATE TABLE IF NOT EXISTS remotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(repo_id, name),
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worktree_config (
      repo_id TEXT PRIMARY KEY,
      symlink_patterns TEXT NOT NULL,
      copy_patterns TEXT NOT NULL,
      upstream_remote TEXT NOT NULL DEFAULT 'origin',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id);
    CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
    CREATE INDEX IF NOT EXISTS idx_remotes_repo ON remotes(repo_id);
  `)

  // Migration: add default_branch column if it doesn't exist
  try {
    db.exec(`ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'`)
  } catch {
    // Column already exists
  }

  // Migration: update worktree status constraint to include 'deleting'
  try {
    db.exec(`
      -- Create new table with updated constraint
      CREATE TABLE IF NOT EXISTS worktrees_new (
        path TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        head TEXT,
        status TEXT NOT NULL CHECK(status IN ('creating', 'ready', 'error', 'deleting')),
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

      -- Copy data from old table (only if old table exists and has different constraint)
      INSERT OR IGNORE INTO worktrees_new
      SELECT * FROM worktrees;

      -- Drop old table
      DROP TABLE IF EXISTS worktrees;

      -- Rename new table
      ALTER TABLE worktrees_new RENAME TO worktrees;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id);
      CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
    `)
  } catch (err) {
    // Migration already applied or table already has correct constraint
    console.log('[DB Migration] Worktree status constraint update:', err)
  }
}

// Repository queries

export function insertRepository(repo: Omit<Repository, 'id' | 'created_at'>): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const now = Date.now()

  db.prepare(`
    INSERT INTO repositories (id, provider, username, name, clone_url, local_path, type, default_branch, last_synced, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, repo.provider, repo.username, repo.name, repo.clone_url, repo.local_path, repo.type, repo.default_branch, repo.last_synced, now)

  return id
}

export function getRepository(id: string): Repository | null {
  const db = getDb()
  return db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Repository | null
}

export function getRepositoryByPath(path: string): Repository | null {
  const db = getDb()
  return db.prepare('SELECT * FROM repositories WHERE local_path = ?').get(path) as Repository | null
}

export function listRepositories(): Repository[] {
  const db = getDb()
  return db.prepare('SELECT * FROM repositories ORDER BY created_at DESC').all() as Repository[]
}

export function updateRepositorySynced(id: string): void {
  const db = getDb()
  db.prepare('UPDATE repositories SET last_synced = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteRepository(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM repositories WHERE id = ?').run(id)
}

// Worktree queries

export function insertWorktree(worktree: Omit<Worktree, 'created_at'>): void {
  const db = getDb()
  const now = Date.now()

  db.prepare(`
    INSERT INTO worktrees (
      path, repo_id, branch, head, status, commit_message, created_at,
      dirty, ahead, behind, last_status_check, vscode_pid, vscode_opened_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    worktree.path,
    worktree.repo_id,
    worktree.branch,
    worktree.head,
    worktree.status,
    worktree.commit_message,
    now,
    worktree.dirty ? 1 : 0,
    worktree.ahead,
    worktree.behind,
    worktree.last_status_check,
    worktree.vscode_pid,
    worktree.vscode_opened_at
  )
}

export function getWorktree(path: string): Worktree | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM worktrees WHERE path = ?').get(path) as any
  if (!row) return null
  return { ...row, dirty: Boolean(row.dirty) }
}

export function listWorktrees(repoId: string): Worktree[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM worktrees WHERE repo_id = ? ORDER BY created_at ASC').all(repoId) as any[]
  return rows.map(row => ({ ...row, dirty: Boolean(row.dirty) }))
}

export function updateWorktreeStatus(
  path: string,
  status: Worktree['status'],
  head?: string,
  commitMessage?: string
): void {
  const db = getDb()
  db.prepare(`
    UPDATE worktrees
    SET status = ?, head = COALESCE(?, head), commit_message = COALESCE(?, commit_message)
    WHERE path = ?
  `).run(status, head ?? null, commitMessage ?? null, path)
}

export function updateWorktreeGitStatus(
  path: string,
  dirty: boolean,
  ahead: number,
  behind: number
): void {
  const db = getDb()
  db.prepare(`
    UPDATE worktrees
    SET dirty = ?, ahead = ?, behind = ?, last_status_check = ?
    WHERE path = ?
  `).run(dirty ? 1 : 0, ahead, behind, Date.now(), path)
}

export function deleteWorktree(path: string): void {
  const db = getDb()
  db.prepare('DELETE FROM worktrees WHERE path = ?').run(path)
}

// Remote queries

export function insertRemote(remote: Omit<Remote, 'id' | 'created_at'>): number {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO remotes (repo_id, name, url, created_at)
    VALUES (?, ?, ?, ?)
  `).run(remote.repo_id, remote.name, remote.url, Date.now())

  return result.lastInsertRowid as number
}

export function listRemotes(repoId: string): Remote[] {
  const db = getDb()
  return db.prepare('SELECT * FROM remotes WHERE repo_id = ? ORDER BY name').all(repoId) as Remote[]
}

export function deleteRemote(repoId: string, name: string): void {
  const db = getDb()
  db.prepare('DELETE FROM remotes WHERE repo_id = ? AND name = ?').run(repoId, name)
}

// Worktree config queries

export function upsertWorktreeConfig(config: Omit<WorktreeConfig, 'created_at' | 'updated_at'>): void {
  const db = getDb()
  const now = Date.now()

  db.prepare(`
    INSERT INTO worktree_config (repo_id, symlink_patterns, copy_patterns, upstream_remote, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      symlink_patterns = excluded.symlink_patterns,
      copy_patterns = excluded.copy_patterns,
      upstream_remote = excluded.upstream_remote,
      updated_at = excluded.updated_at
  `).run(config.repo_id, config.symlink_patterns, config.copy_patterns, config.upstream_remote, now, now)
}

export function getWorktreeConfig(repoId: string): WorktreeConfig | null {
  const db = getDb()
  return db.prepare('SELECT * FROM worktree_config WHERE repo_id = ?').get(repoId) as WorktreeConfig | null
}
