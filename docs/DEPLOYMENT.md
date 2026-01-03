# Deployment & Distribution

Build, release, and installation process for git-hud v0.1.1.

> **Default Port:** 7777 (configurable via `PORT` env var)

---

## Build System

### Prerequisites

- Bun 1.0+ installed
- Git repository cloned
- Dependencies installed: `bun install`

### Local Build

```bash
bun run build
```

**Process:**
1. Next.js standalone build: `bun --bun next build`
2. Copy static assets to standalone output
3. Compile binary with Bun
4. Package as tarball

**Output:**
- `dist/{platform}.tar.gz` (~36-37MB compressed)
- Contains: binary + Next.js standalone + static assets

**Platforms:**
- `darwin-arm64` (macOS M1+)
- `darwin-x64` (macOS Intel)
- `linux-arm64`
- `linux-x64`

### Build Script

**scripts/build.sh:**
- Detects platform or uses `BUILD_TARGET` env var
- Injects git commit hash via `--define process.env.BUILD_COMMIT`
- Sets `NODE_ENV=production` via `--define`
- Uses automatic JSX runtime: `--jsx-runtime automatic --jsx-import-source react`
- Creates tarball: `{platform}.tar.gz`

**Key flags:**
```bash
bun build --compile \
  --target="$TARGET" \
  --define "process.env.NODE_ENV=\"production\"" \
  --define "process.env.BUILD_COMMIT=\"$COMMIT\"" \
  --jsx-runtime automatic \
  --jsx-import-source react \
  --outfile="dist/$PACKAGE/git-hud" \
  ./cli/index.tsx
```

---

## GitHub Actions Release

### Workflow

**.github/workflows/release.yml:**
- Triggers on version tags: `v*.*.*`
- Matrix builds for 4 platforms
- Concurrent builds with auto-cancel on re-push
- Artifacts merged automatically
- Release created with auto-generated notes

**Trigger:**
```bash
git tag v0.1.1
git push origin v0.1.1
```

**Process:**
1. Checkout + setup Bun
2. Install dependencies (`--frozen-lockfile`)
3. Build via `bun run build`
4. Extract platform name from matrix target
5. Upload artifact as `{platform}.tar.gz`
6. Merge all artifacts to `binaries/`
7. Create GitHub release with all tarballs

**Concurrency:**
- Group: `release-${{ github.ref }}`
- Auto-cancels in-progress builds for same tag

---

## Installation

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/git-hud/main/install.sh | bash
```

**Process:**
1. Detect platform (OS + architecture)
2. Fetch latest version from GitHub API
3. Download `{platform}.tar.gz`
4. Extract to `~/.git-hud/app/`
5. Create symlink: `~/.git-hud/bin/git-hud`
6. Add to PATH in shell RC file
7. Display installed version with commit hash

**Directory structure:**
```
~/.git-hud/
├── app/              # Current installation
│   ├── git-hud       # Compiled binary
│   ├── server.js     # Next.js entry
│   ├── public/       # Static assets
│   └── .next/        # Standalone build
├── app.backup/       # Previous version (after update)
├── bin/
│   └── git-hud       # Symlink to app/git-hud
├── clones/           # Git repositories
├── data/             # SQLite database
└── logs/             # Application logs
```

### Usage

```bash
# Run git-hud (no 'start' command needed)
git-hud

# Check version
git-hud version  # Shows: 0.1.1 (commit-hash)

# Visit browser
open http://localhost:7777
```

---

## Auto-Update

### How It Works

**On startup:**
1. Non-blocking check to GitHub releases API
2. Compare local version with latest tag
3. If newer version found:
   - Download tarball in background
   - Extract to temp directory
   - Backup current `app/` to `app.backup/`
   - Move new version to `app/`
   - Cleanup temp files
4. Notify user to restart

**Implementation:**
- See `cli/index.tsx` → `checkAndUpdate()`
- No manual update command required
- Atomic replacement with rollback capability

**User experience:**
```bash
$ git-hud
git-hud v0.1.0 (abc1234)
Server running on http://localhost:7777
Checking for updates...
Update available: 0.1.0 → 0.1.1
Downloading in background...
✓ Updated to 0.1.1! Restart to use new version.
```

---

## CLI Interface

### ink UI

React-based terminal interface showing:
- Version with commit hash (green)
- Server URL (cyan)
- Update status (gray/yellow/green)

**Output suppression:**
- Next.js logs hidden via `stdio: "ignore"`
- Clean, minimal interface

**Commands:**
- `git-hud` - Start server (default)
- `git-hud version` - Show version + commit hash

---

## Troubleshooting

### Binary won't run

```bash
# Check permissions
ls -l ~/.git-hud/bin/git-hud

# Fix if needed
chmod +x ~/.git-hud/bin/git-hud
```

### Port already in use

```bash
PORT=4000 git-hud
```

### Update failed

```bash
# Check backup exists
ls -la ~/.git-hud/app.backup/

# Restore if needed
rm -rf ~/.git-hud/app
mv ~/.git-hud/app.backup ~/.git-hud/app
```

### Clean reinstall

```bash
# Remove installation
rm -rf ~/.git-hud

# Run install script again
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/git-hud/main/install.sh | bash
```

---

## Uninstallation

```bash
# Remove all files
rm -rf ~/.git-hud

# Remove from PATH (edit ~/.zshrc or ~/.bashrc)
# Delete line: export PATH="$HOME/.git-hud/bin:$PATH"

# Reload shell
source ~/.zshrc
```

**Warning:** All cloned repositories in `~/.git-hud/clones/` will be deleted.

---

## Developer Notes

### Dependencies

- `react-devtools-core`: Required by ink, bundled but not used in production
- No external dependencies at runtime (everything bundled)

### Build Quirks

- No minification (breaks JSX runtime)
- Automatic JSX runtime required for production
- `NODE_ENV` and `BUILD_COMMIT` injected at compile time
- Explicit `React` import not needed with automatic runtime

### Tarball Contents

```bash
# View contents
tar -tzf dist/darwin-arm64.tar.gz

# Extract
tar -xzf dist/darwin-arm64.tar.gz
```
