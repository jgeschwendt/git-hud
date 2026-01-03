# grove

Git worktree dashboard with bare repository management.

## Features

- **Bare Repository Cloning** - Clone repos as bare with automatic worktree setup
- **Worktree Management** - Create, delete, and manage multiple worktrees per repo
- **Git Status Tracking** - Real-time dirty/clean status, ahead/behind counts
- **File Sharing** - Automatic symlink/copy of shared files (.env, .claude, etc.)
- **Single Binary** - Compiled with Bun, includes Next.js + SQLite
- **Web Dashboard** - Clean UI for managing repos and worktrees

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/grove/main/install.sh | bash
```

Installs to `~/.grove/` and adds to PATH.

## Usage

```bash
grove
```

Visit http://localhost:7777

### Clone a Repository

Enter a Git URL (GitHub, GitLab, Bitbucket) in the sidebar and click Clone.

Repositories are cloned to:
```
~/code/{username}/{repo}/
  ├── .bare/          # Bare git repository
  ├── .git            # File pointing to .bare
  └── .main/          # Primary worktree
```

### Create Worktrees

1. Select a repository
2. Enter a branch name
3. Click "Create Worktree"

New worktrees are created as siblings:
```
~/code/user/repo/
  ├── .main/
  ├── feature--auth/
  └── bugfix--login/
```

Shared files from `.main` (like `.env`, `.claude/`) are automatically symlinked.

## Development

```bash
# Install dependencies
bun install

# Run dev server
bun run dev

# Build binary
bun run build
```

## Documentation

See [docs/README.md](./docs/README.md) for architecture and implementation details.

## Version

**v0.1.1** - Core functionality complete:
- SQLite database with repositories, worktrees, remotes
- Git operations (clone bare, create/delete worktrees, status tracking)
- Server Actions for mutations
- SSE streaming for progress updates
- Dashboard UI for repository management
