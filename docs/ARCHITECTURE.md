# Architecture

Grove is a Rust workspace with four crates that work together.

## Crate Structure

```
crates/
  grove-core/     # Shared functionality
    src/
      lib.rs      # Re-exports
      config.rs   # Configuration from env
      db.rs       # SQLite database
      git.rs      # Git operations (gix + shell)
      types.rs    # Shared types
      state.rs    # State manager + broadcast
      install.rs  # Package manager detection

  grove-api/      # HTTP server
    src/
      lib.rs      # Server::new(), Server::run()
      routes.rs   # API route handlers
      mcp.rs      # MCP tool definitions
      static_files.rs  # Embedded UI assets

  grove-tui/      # Terminal UI
    src/
      lib.rs      # ChatApp export
      app.rs      # Event loop, state
      ui.rs       # Rendering

  grove-cli/      # Entry point
    src/
      main.rs     # CLI parsing, command dispatch
```

## Data Flow

```
┌────────────────────────────────────────────────────────────┐
│                       grove-cli                            │
│                                                            │
│  CLI Commands → ensure_server_running() → API Calls        │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│                       grove-api                            │
│                                                            │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────┐       │
│  │  Routes  │──▶│ StateManager │──▶│  Broadcast   │       │
│  │  (axum)  │   │              │   │   Channel    │       │
│  └────┬─────┘   └──────┬───────┘   └──────┬───────┘       │
│       │                │                   │               │
│       │                ▼                   ▼               │
│       │         ┌──────────────┐    ┌──────────────┐      │
│       │         │   Database   │    │  SSE Stream  │      │
│       │         │              │    │  (/api/state)│      │
│       │         └──────────────┘    └──────────────┘      │
│       │                │                                   │
│       ▼                ▼                                   │
│  ┌──────────────────────────────────┐                     │
│  │          grove-core              │                     │
│  │  Config | Database | Git | State │                     │
│  └──────────────────────────────────┘                     │
└────────────────────────────────────────────────────────────┘
```

## State Management

State is managed server-side and pushed to clients via SSE.

### FullState

```rust
pub struct FullState {
    pub repositories: Vec<RepoWithWorktrees>,
    pub progress: HashMap<String, String>,
}
```

### StateManager

```rust
impl StateManager {
    /// Subscribe to state changes (SSE clients)
    pub fn subscribe(&self) -> broadcast::Receiver<FullState>

    /// Set progress message (None to clear)
    pub fn set_progress(&self, path: &str, message: Option<&str>)

    /// Notify of database change (triggers push)
    pub fn on_db_change(&self)
}
```

### Flow

1. Client connects to `/api/state` SSE endpoint
2. Server sends initial `FullState`
3. On mutations:
   - Route handler calls `set_progress()` for progress updates
   - Route handler modifies database
   - Route handler calls `on_db_change()`
   - StateManager broadcasts new `FullState` to all subscribers

## Database Schema

SQLite database at `~/.grove/data/repos.db`:

```sql
-- Repositories
CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    clone_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    type TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    last_synced INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);

-- Worktrees
CREATE TABLE worktrees (
    path TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    head TEXT,
    status TEXT NOT NULL DEFAULT 'creating',
    commit_message TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    ahead INTEGER NOT NULL DEFAULT 0,
    behind INTEGER NOT NULL DEFAULT 0,
    last_status_check INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
);

-- Worktree config per repo
CREATE TABLE worktree_config (
    repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    symlink_patterns TEXT,
    copy_patterns TEXT,
    upstream_remote TEXT NOT NULL DEFAULT 'origin'
);
```

## Git Operations

Grove uses a hybrid approach:

- **gix** for clone, fetch, status queries
- **shell commands** for worktree mutations (more reliable)

### Repository Structure

```
~/code/{username}/{repo}/
  .bare/          # Bare git repository
  .git            # File: "gitdir: ./.bare"
  .main/          # Main worktree (default branch)
  feature--foo/   # Feature worktree (/ → --)
```

### Worktree Lifecycle

```
1. Clone repo      → .bare/ + .main/ worktree
2. Create worktree → Sync .main, create new worktree, share files, install
3. Delete worktree → git worktree remove, cleanup directory
```

## Configuration

```rust
pub struct Config {
    /// Where repos are cloned (default: ~/code)
    pub code_dir: PathBuf,

    /// Grove data directory (default: ~/.grove)
    pub data_dir: PathBuf,

    /// Database path (default: ~/.grove/data/repos.db)
    pub db_path: PathBuf,
}
```

Environment variables:

- `GROVE_ROOT` - Override ~/.grove
- `GROVE_CODE_DIR` - Override ~/code
- `GROVE_PORT` - Server port (default: 3000)

## MCP Integration

Grove exposes an MCP server at `/mcp` with tools:

| Tool                 | Description                   |
| -------------------- | ----------------------------- |
| `list_repositories`  | List all tracked repositories |
| `clone_repository`   | Clone a git repository        |
| `delete_repository`  | Delete a repository           |
| `create_worktree`    | Create a new worktree         |
| `delete_worktree`    | Delete a worktree             |
| `refresh_repository` | Fetch and update status       |
| `get_state`          | Get current full state        |

Uses `rmcp` crate with streamable HTTP transport.

## Dependencies

Key workspace dependencies:

| Crate          | Purpose           |
| -------------- | ----------------- |
| `tokio`        | Async runtime     |
| `axum`         | HTTP framework    |
| `gix`          | Git operations    |
| `rusqlite`     | SQLite database   |
| `ratatui`      | Terminal UI       |
| `clap`         | CLI parsing       |
| `rmcp`         | MCP server        |
| `tokio-stream` | Async streams     |
| `async-stream` | Stream generators |
