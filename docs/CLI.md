# CLI Reference

Grove provides a command-line interface for managing git worktrees.

## Usage

```
grove [OPTIONS] [COMMAND]
```

**Global Options**:
- `-p, --port <PORT>` - Server port [default: 3000, env: GROVE_PORT]
- `-h, --help` - Print help
- `-V, --version` - Print version

**No Command** (default): Launch interactive TUI

## Commands

### grove (no args)

Launch the interactive terminal UI.

Starts the server if not running, then opens the TUI.

```bash
grove
grove --port 3001
```

### grove clone

Clone a git repository.

```bash
grove clone <URL>
```

**Arguments**:
- `<URL>` - Git clone URL (SSH or HTTPS)

**Examples**:
```bash
grove clone git@github.com:user/repo.git
grove clone https://github.com/user/repo.git
```

The repository is cloned to `~/code/{username}/{repo}/` with:
- `.bare/` - Bare git repository
- `.main/` - Main worktree

### grove worktree

Create a new worktree.

```bash
grove worktree <REPO> <BRANCH>
```

**Arguments**:
- `<REPO>` - Repository ID or name
- `<BRANCH>` - Branch name (created if doesn't exist)

**Examples**:
```bash
grove worktree my-repo feature/new-feature
grove worktree abc123 bugfix-login
```

Worktree is created at `~/code/{username}/{repo}/{branch}/`

### grove delete

Delete a worktree.

```bash
grove delete <PATH>
```

**Arguments**:
- `<PATH>` - Worktree path

**Examples**:
```bash
grove delete /Users/me/code/user/repo/feature--new
```

### grove open

Open a path in VS Code.

```bash
grove open <PATH>
```

**Arguments**:
- `<PATH>` - Path to open

**Examples**:
```bash
grove open /Users/me/code/user/repo/.main
grove open ~/code/user/repo/feature--new
```

### grove list

List all tracked repositories.

```bash
grove list
```

**Output**:
```
my-repo - git@github.com:user/my-repo.git
  ● main (/Users/me/code/user/my-repo/.main)
  ○ feature/new (/Users/me/code/user/my-repo/feature--new)

other-repo - git@github.com:user/other.git
  ● main (/Users/me/code/user/other/.main)
```

### grove server

Start the HTTP server in foreground (no TUI).

```bash
grove server
grove server --port 3001
```

Runs until interrupted (Ctrl+C).

### grove status

Check if server is running.

```bash
grove status
```

**Output**:
```
Server running on http://localhost:3000
```
or
```
Server not running
```

### grove harvest

Export repositories to a seed file.

```bash
grove harvest <FILE>
```

**Arguments**:
- `<FILE>` - Output file path

**Output Format** (JSONL):
```jsonl
{"url":"git@github.com:user/repo.git","worktrees":["feature-a"]}
{"url":"git@github.com:user/other.git"}
```

The `.main` worktree is excluded (automatically created on clone).

### grove grow

Import repositories from a seed file.

```bash
grove grow <FILE>
```

**Arguments**:
- `<FILE>` - Input file path (JSONL)

**Input Format**:
```jsonl
{"url":"git@github.com:user/repo.git","worktrees":["feature-a","feature-b"]}
{"url":"git@github.com:user/other.git"}
```

**Behavior**:
1. Starts server if not running
2. For each entry:
   - Clones repository via API
   - Waits for clone to complete (SSE streaming)
   - Creates specified worktrees

**Example**:
```bash
# Export from one machine
grove harvest ~/seed.jsonl

# Import on another machine
grove grow ~/seed.jsonl
```

## Server Auto-Start

Commands that need the server (`clone`, `worktree`, `delete`, `grow`) automatically:
1. Check if server is running (TCP connect test)
2. Spawn server as background daemon if not running
3. Wait up to 5 seconds for server to be ready

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROVE_PORT` | `3000` | Server port |
| `GROVE_ROOT` | `~/.grove` | Data directory |
| `GROVE_CODE_DIR` | `~/code` | Clone directory |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (see stderr) |

## Examples

**Typical Workflow**:
```bash
# Clone a repo
grove clone git@github.com:user/project.git

# Create feature worktree
grove worktree project feature/new-thing

# Open in editor
grove open ~/code/user/project/feature--new-thing

# List status
grove list

# Clean up
grove delete ~/code/user/project/feature--new-thing
```

**Migration**:
```bash
# On old machine
grove harvest ~/my-repos.jsonl

# On new machine
grove grow ~/my-repos.jsonl
```

**Headless Server**:
```bash
# Start server only (for API/MCP access)
grove server &

# Use via API
curl http://localhost:3000/api/repositories
```
