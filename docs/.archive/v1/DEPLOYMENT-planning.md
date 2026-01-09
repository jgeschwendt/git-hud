# Deployment & Distribution

This document covers building, releasing, and installing git-hud.

---

## Build System

### Prerequisites

- Bun 1.0+ installed
- Git repository cloned
- Dependencies installed: `bun install`

### Build Process

**Command**:
```bash
bun run build
```

**What it does**:
```bash
# 1. Build Next.js in standalone mode
bun run next build

# 2. Copy static assets into standalone output
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static

# 3. Compile to binary
bun build --compile \
  --minify \
  --target=bun-{os}-{arch} \
  --outfile=dist/git-hud-{os}-{arch} \
  ./cli/index.ts
```

**Output**:
- Single binary: `dist/git-hud-{os}-{arch}`
- Size: ~50-80MB (includes Bun runtime + Next.js + SQLite)
- No external dependencies required

### Build Script

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

### Multi-Platform Build

**scripts/build-all.sh**:
```bash
#!/usr/bin/env bash
set -euo pipefail

PLATFORMS=(
  "bun-linux-x64"
  "bun-linux-arm64"
  "bun-darwin-x64"
  "bun-darwin-arm64"
)

bun run next build
cp -r public .next/standalone/public 2>/dev/null || true
cp -r .next/static .next/standalone/.next/static

mkdir -p dist

for platform in "${PLATFORMS[@]}"; do
  echo "Building for $platform..."

  PLATFORM_NAME="${platform#bun-}"

  bun build --compile \
    --minify \
    --target="$platform" \
    --outfile="dist/git-hud-$PLATFORM_NAME" \
    ./cli/index.ts
done

echo "==> Build complete"
ls -lh dist/
```

---

## GitHub Actions Release

### Workflow

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

### Triggering a Release

```bash
# Create and push a tag
git tag v0.1.0
git push origin v0.1.0

# GitHub Actions will:
# 1. Build binaries for all platforms
# 2. Create GitHub release
# 3. Upload binaries as release assets
# 4. Generate release notes
```

---

## Installation

### Install Script

**install.sh** (hosted on GitHub):
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

# Create directory structure
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

# Add to PATH
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

### Usage

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/jgeschwendt/git-hud/main/install.sh | bash

# Reload shell
source ~/.zshrc  # or source ~/.bashrc

# Start git-hud
git-hud start

# Visit http://localhost:3000
```

---

## Auto-Update

### Update Check

**cli/updater.ts**:
```typescript
import { version } from '../package.json'

export async function checkForUpdates(): Promise<void> {
  const response = await fetch(
    'https://api.github.com/repos/jgeschwendt/git-hud/releases/latest'
  )

  const release = await response.json()
  const latestVersion = release.tag_name.replace('v', '')

  if (latestVersion === version) {
    console.log('✓ Up to date')
    return
  }

  console.log(`Update available: ${version} → ${latestVersion}`)

  const platform = process.platform
  const arch = process.arch === 'x64' ? 'x64' : 'arm64'
  const assetName = `git-hud-${platform}-${arch}`

  const asset = release.assets.find((a: any) => a.name === assetName)
  if (!asset) {
    console.log('No binary found for platform')
    return
  }

  console.log('Downloading update...')
  const binaryData = await fetch(asset.browser_download_url)
    .then(r => r.arrayBuffer())

  await Bun.write(process.execPath, binaryData)
  await chmod(process.execPath, 0o755)

  console.log('✓ Updated! Restart to use new version')
}
```

### Integration

**cli/index.ts**:
```typescript
import { checkForUpdates } from './updater'

async function main() {
  const command = process.argv[2] || 'start'

  switch (command) {
    case 'start':
      // Check for updates in background (don't block startup)
      checkForUpdates().catch(() => {})

      await startServer()
      break

    case 'update':
      // Manual update check
      await checkForUpdates()
      break

    case 'version':
      console.log(require('../package.json').version)
      break
  }
}
```

**Behavior**:
- Check GitHub releases API on startup
- Non-blocking (doesn't delay server start)
- Download in background if update available
- Replace binary atomically
- User restarts to use new version

---

## Manual Installation

### From Source

```bash
# Clone repository
git clone https://github.com/jgeschwendt/git-hud.git
cd git-hud

# Install dependencies
bun install

# Build binary
bun run build

# Move to installation directory
mkdir -p ~/.git-hud/bin
cp dist/git-hud-* ~/.git-hud/bin/git-hud
chmod +x ~/.git-hud/bin/git-hud

# Add to PATH
echo 'export PATH="$HOME/.git-hud/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Development Mode

```bash
# Run without building
bun run dev

# Visit http://localhost:3000
```

---

## Uninstallation

```bash
# Remove binary and data
rm -rf ~/.git-hud

# Remove from PATH
# Edit ~/.zshrc or ~/.bashrc and remove:
# export PATH="$HOME/.git-hud/bin:$PATH"

# Reload shell
source ~/.zshrc
```

**Note**: Repositories cloned to `~/.git-hud/clones/` will be deleted. Back up any work before uninstalling.

---

## Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS    | x64 (Intel) | ✅ Supported |
| macOS    | arm64 (M1+) | ✅ Supported |
| Linux    | x64         | ✅ Supported |
| Linux    | arm64       | ✅ Supported |
| Windows  | x64         | ❌ Not supported (future) |

---

## Troubleshooting

### Binary won't run

```bash
# Check if executable
ls -l ~/.git-hud/bin/git-hud

# Fix permissions
chmod +x ~/.git-hud/bin/git-hud
```

### Port already in use

```bash
# Use different port
PORT=4000 git-hud start
```

### Database locked error

```bash
# Stop any running instances
pkill git-hud

# Remove lock file
rm ~/.git-hud/data/repos.db-shm
rm ~/.git-hud/data/repos.db-wal
```

### Update fails

```bash
# Manual update
git-hud update

# Or download latest binary manually
curl -fsSL https://github.com/jgeschwendt/git-hud/releases/latest/download/git-hud-darwin-arm64 \
  -o ~/.git-hud/bin/git-hud
chmod +x ~/.git-hud/bin/git-hud
```
