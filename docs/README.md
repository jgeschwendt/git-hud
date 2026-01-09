# Grove Documentation

Grove is a git worktree management tool written in Rust.

## Overview

Grove provides:

- **CLI** for managing repositories and worktrees
- **HTTP API** with SSE real-time updates
- **TUI** (terminal UI) for interactive management
- **MCP server** for AI tool integration

## Quick Start

```bash
# Clone a repository
grove clone git@github.com:user/repo.git

# Create a worktree
grove worktree <repo-name> feature-branch

# Open in editor
grove open /path/to/worktree

# Start server only (no TUI)
grove server

# Launch interactive TUI
grove
```

## Architecture

Grove is organized as a Rust workspace with four crates:

```
crates/
  grove-core/    # Database, git operations, types
  grove-api/     # HTTP server, SSE, MCP
  grove-tui/     # Terminal UI (ratatui)
  grove-cli/     # Binary entry point
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## API Reference

Grove exposes a REST API with SSE streaming:

| Endpoint                 | Method | Description              |
| ------------------------ | ------ | ------------------------ |
| `/api/state`             | GET    | SSE stream of full state |
| `/api/state/snapshot`    | GET    | Current state (JSON)     |
| `/api/repositories`      | GET    | List repositories        |
| `/api/clone`             | POST   | Clone repository         |
| `/api/repositories/{id}` | DELETE | Delete repository        |
| `/api/worktree`          | POST   | Create worktree          |
| `/api/worktree/{path}`   | DELETE | Delete worktree          |
| `/api/open`              | POST   | Open path in editor      |
| `/api/refresh/{id}`      | POST   | Refresh repository       |
| `/mcp`                   | ANY    | MCP endpoint             |

See [API.md](./API.md) for details.

## CLI Reference

```
grove [OPTIONS] [COMMAND]

Commands:
  clone      Clone a repository
  worktree   Create a new worktree
  delete     Delete a worktree
  open       Open worktree in editor
  list       List repositories
  server     Start server only (no TUI)
  status     Show server status
  harvest    Export repositories to seed.jsonl
  grow       Import repositories from seed.jsonl

Options:
  -p, --port <PORT>  Server port [default: 3000]
```

See [CLI.md](./CLI.md) for details.

## Configuration

Grove uses environment variables and XDG conventions:

| Variable         | Default          | Description                   |
| ---------------- | ---------------- | ----------------------------- |
| `GROVE_PORT`     | `3000`           | Server port                   |
| `GROVE_CODE_DIR` | `~/code`         | Where repositories are cloned |
| `XDG_DATA_HOME`  | `~/.local/share` | Database location             |

## Documentation Index

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design and crate structure
- [API.md](./API.md) - HTTP and SSE endpoint reference
- [CLI.md](./CLI.md) - Command line reference
- [.archive/v1/](./.archive/v1/) - Previous TypeScript implementation docs
