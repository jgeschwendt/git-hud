//! SQLite database operations
//!
//! See README.md for schema and pseudocode.

use crate::types::*;
use crate::Config;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;

/// Database wrapper with connection pooling
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open database at configured path
    pub fn open(config: &Config) -> Result<Self> {
        config.ensure_dirs()?;

        let conn = Connection::open(&config.db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_schema()?;
        Ok(db)
    }

    /// Initialize database schema
    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(include_str!("schema.sql"))?;
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Repositories
    // ─────────────────────────────────────────────────────────────

    /// List all non-deleted repositories
    pub fn list_repositories(&self) -> Result<Vec<Repository>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, username, name, clone_url, local_path,
                    type, default_branch, last_synced, created_at, deleted_at
             FROM repositories
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC",
        )?;

        let repos = stmt
            .query_map([], |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    username: row.get(2)?,
                    name: row.get(3)?,
                    clone_url: row.get(4)?,
                    local_path: row.get(5)?,
                    repo_type: row.get(6)?,
                    default_branch: row.get(7)?,
                    last_synced: row.get(8)?,
                    created_at: row.get(9)?,
                    deleted_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(repos)
    }

    /// Get repository by ID
    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, username, name, clone_url, local_path,
                    type, default_branch, last_synced, created_at, deleted_at
             FROM repositories
             WHERE id = ? AND deleted_at IS NULL",
        )?;

        let repo = stmt
            .query_row([id], |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    username: row.get(2)?,
                    name: row.get(3)?,
                    clone_url: row.get(4)?,
                    local_path: row.get(5)?,
                    repo_type: row.get(6)?,
                    default_branch: row.get(7)?,
                    last_synced: row.get(8)?,
                    created_at: row.get(9)?,
                    deleted_at: row.get(10)?,
                })
            })
            .optional()?;

        Ok(repo)
    }

    /// Get repository by provider/username/name
    pub fn get_repository_by_name(
        &self,
        provider: &str,
        username: &str,
        name: &str,
    ) -> Result<Option<Repository>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, username, name, clone_url, local_path,
                    type, default_branch, last_synced, created_at, deleted_at
             FROM repositories
             WHERE provider = ? AND username = ? AND name = ? AND deleted_at IS NULL",
        )?;

        let repo = stmt
            .query_row([provider, username, name], |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    username: row.get(2)?,
                    name: row.get(3)?,
                    clone_url: row.get(4)?,
                    local_path: row.get(5)?,
                    repo_type: row.get(6)?,
                    default_branch: row.get(7)?,
                    last_synced: row.get(8)?,
                    created_at: row.get(9)?,
                    deleted_at: row.get(10)?,
                })
            })
            .optional()?;

        Ok(repo)
    }

    /// Get repository by local path
    pub fn get_repository_by_path(&self, path: &str) -> Result<Option<Repository>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, username, name, clone_url, local_path,
                    type, default_branch, last_synced, created_at, deleted_at
             FROM repositories
             WHERE local_path = ? AND deleted_at IS NULL",
        )?;

        let repo = stmt
            .query_row([path], |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    username: row.get(2)?,
                    name: row.get(3)?,
                    clone_url: row.get(4)?,
                    local_path: row.get(5)?,
                    repo_type: row.get(6)?,
                    default_branch: row.get(7)?,
                    last_synced: row.get(8)?,
                    created_at: row.get(9)?,
                    deleted_at: row.get(10)?,
                })
            })
            .optional()?;

        Ok(repo)
    }

    /// Insert new repository, returns ID
    pub fn insert_repository(&self, repo: &NewRepository) -> Result<String> {
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "INSERT INTO repositories
             (id, provider, username, name, clone_url, local_path, type, default_branch, last_synced, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                repo.provider,
                repo.username,
                repo.name,
                repo.clone_url,
                repo.local_path,
                repo.repo_type,
                repo.default_branch,
                repo.last_synced,
                now,
            ],
        )?;

        Ok(id)
    }

    /// Hard delete repository and its worktrees
    pub fn delete_repository(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // Delete worktrees first (foreign key)
        conn.execute("DELETE FROM worktrees WHERE repo_id = ?", params![id])?;
        // Delete worktree config
        conn.execute("DELETE FROM worktree_config WHERE repo_id = ?", params![id])?;
        // Delete repository
        conn.execute("DELETE FROM repositories WHERE id = ?", params![id])?;

        Ok(())
    }

    /// Update last_synced timestamp
    pub fn update_repository_synced(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "UPDATE repositories SET last_synced = ? WHERE id = ?",
            params![now, id],
        )?;

        Ok(())
    }

    /// Update default branch
    pub fn update_repository_default_branch(&self, id: &str, default_branch: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE repositories SET default_branch = ? WHERE id = ?",
            params![default_branch, id],
        )?;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Worktrees
    // ─────────────────────────────────────────────────────────────

    /// List worktrees for a repository
    pub fn list_worktrees(&self, repo_id: &str) -> Result<Vec<Worktree>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, repo_id, branch, head, status, commit_message,
                    dirty, ahead, behind, last_status_check, created_at, deleted_at
             FROM worktrees
             WHERE repo_id = ? AND deleted_at IS NULL
             ORDER BY created_at ASC",
        )?;

        let worktrees = stmt
            .query_map([repo_id], |row| {
                let status_str: String = row.get(4)?;
                Ok(Worktree {
                    path: row.get(0)?,
                    repo_id: row.get(1)?,
                    branch: row.get(2)?,
                    head: row.get(3)?,
                    status: status_str.parse().unwrap_or(WorktreeStatus::Error),
                    commit_message: row.get(5)?,
                    dirty: row.get(6)?,
                    ahead: row.get(7)?,
                    behind: row.get(8)?,
                    last_status_check: row.get(9)?,
                    created_at: row.get(10)?,
                    deleted_at: row.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(worktrees)
    }

    /// Get worktree by path
    pub fn get_worktree(&self, path: &str) -> Result<Option<Worktree>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, repo_id, branch, head, status, commit_message,
                    dirty, ahead, behind, last_status_check, created_at, deleted_at
             FROM worktrees
             WHERE path = ? AND deleted_at IS NULL",
        )?;

        let worktree = stmt
            .query_row([path], |row| {
                let status_str: String = row.get(4)?;
                Ok(Worktree {
                    path: row.get(0)?,
                    repo_id: row.get(1)?,
                    branch: row.get(2)?,
                    head: row.get(3)?,
                    status: status_str.parse().unwrap_or(WorktreeStatus::Error),
                    commit_message: row.get(5)?,
                    dirty: row.get(6)?,
                    ahead: row.get(7)?,
                    behind: row.get(8)?,
                    last_status_check: row.get(9)?,
                    created_at: row.get(10)?,
                    deleted_at: row.get(11)?,
                })
            })
            .optional()?;

        Ok(worktree)
    }

    /// Insert new worktree
    pub fn insert_worktree(&self, worktree: &NewWorktree) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "INSERT INTO worktrees (path, repo_id, branch, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                worktree.path,
                worktree.repo_id,
                worktree.branch,
                worktree.status.as_str(),
                now,
            ],
        )?;

        Ok(())
    }

    /// Update worktree status
    pub fn update_worktree_status(
        &self,
        path: &str,
        status: WorktreeStatus,
        head: Option<&str>,
        commit_message: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE worktrees SET status = ?, head = ?, commit_message = ? WHERE path = ?",
            params![status.as_str(), head, commit_message, path],
        )?;

        Ok(())
    }

    /// Update worktree git status (dirty, ahead, behind)
    pub fn update_worktree_git_status(
        &self,
        path: &str,
        dirty: bool,
        ahead: i32,
        behind: i32,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "UPDATE worktrees SET dirty = ?, ahead = ?, behind = ?, last_status_check = ? WHERE path = ?",
            params![dirty, ahead, behind, now, path],
        )?;

        Ok(())
    }

    /// Hard delete worktree
    pub fn delete_worktree(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM worktrees WHERE path = ?", params![path])?;

        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    // Worktree Config
    // ─────────────────────────────────────────────────────────────

    /// Get worktree config for a repository
    pub fn get_worktree_config(&self, repo_id: &str) -> Result<Option<WorktreeConfig>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT repo_id, symlink_patterns, copy_patterns, upstream_remote
             FROM worktree_config WHERE repo_id = ?",
        )?;

        let config = stmt
            .query_row([repo_id], |row| {
                Ok(WorktreeConfig {
                    repo_id: row.get(0)?,
                    symlink_patterns: row.get(1)?,
                    copy_patterns: row.get(2)?,
                    upstream_remote: row.get(3)?,
                })
            })
            .optional()?;

        Ok(config)
    }

    /// Upsert worktree config
    pub fn upsert_worktree_config(&self, config: &WorktreeConfig) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO worktree_config (repo_id, symlink_patterns, copy_patterns, upstream_remote)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(repo_id) DO UPDATE SET
                symlink_patterns = excluded.symlink_patterns,
                copy_patterns = excluded.copy_patterns,
                upstream_remote = excluded.upstream_remote",
            params![
                config.repo_id,
                config.symlink_patterns,
                config.copy_patterns,
                config.upstream_remote,
            ],
        )?;

        Ok(())
    }
}
