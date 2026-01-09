-- Grove database schema
-- See README.md for documentation

CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    clone_url TEXT NOT NULL,
    local_path TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT 'bare',
    default_branch TEXT NOT NULL DEFAULT 'main',
    last_synced INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    deleted_at INTEGER,
    UNIQUE(provider, username, name)
);

CREATE TABLE IF NOT EXISTS worktrees (
    path TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id),
    branch TEXT NOT NULL,
    head TEXT,
    status TEXT NOT NULL CHECK(status IN ('creating', 'ready', 'error', 'deleting')),
    commit_message TEXT,
    dirty INTEGER DEFAULT 0,
    ahead INTEGER DEFAULT 0,
    behind INTEGER DEFAULT 0,
    last_status_check INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS worktree_config (
    repo_id TEXT PRIMARY KEY REFERENCES repositories(id),
    symlink_patterns TEXT,
    copy_patterns TEXT,
    upstream_remote TEXT DEFAULT 'origin'
);

CREATE INDEX IF NOT EXISTS idx_worktrees_repo_id ON worktrees(repo_id);
CREATE INDEX IF NOT EXISTS idx_repositories_deleted ON repositories(deleted_at);
CREATE INDEX IF NOT EXISTS idx_worktrees_deleted ON worktrees(deleted_at);
