#!/usr/bin/env bash
set -euo pipefail

echo "==> Copying standalone assets..."
cp -r public .next/standalone/public 2>/dev/null || true
cp -r .next/static .next/standalone/.next/static

echo "==> Detecting platform..."

# Use BUILD_TARGET from environment if set (for CI), otherwise detect
if [ -n "${BUILD_TARGET:-}" ]; then
  TARGET="$BUILD_TARGET"
  PLATFORM="${TARGET#bun-}"
  # Parse OS and ARCH from PLATFORM (e.g., "darwin-arm64" -> OS=darwin, ARCH=arm64)
  OS="${PLATFORM%-*}"
  ARCH="${PLATFORM#*-}"
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  if [ "$ARCH" = "x86_64" ]; then
    ARCH="x64"
  fi

  TARGET="bun-${OS}-${ARCH}"
  PLATFORM="${OS}-${ARCH}"
fi

PACKAGE="${PLATFORM}"
echo "    OS=$OS, ARCH=$ARCH, TARGET=$TARGET"

echo "==> Compiling binary for $TARGET..."
mkdir -p "dist/$PACKAGE"

# Get git commit hash
COMMIT=$(git rev-parse --short HEAD)

bun build --compile \
  --target="$TARGET" \
  --define "process.env.NODE_ENV=\"production\"" \
  --define "process.env.BUILD_COMMIT=\"$COMMIT\"" \
  --jsx-runtime automatic \
  --jsx-import-source react \
  --outfile="dist/$PACKAGE/grove" \
  ./cli/index.tsx

echo "==> Downloading bun runtime..."
BUN_VERSION="1.1.42"

# Map arch to bun's naming (arm64 -> aarch64)
BUN_ARCH="$ARCH"
if [ "$ARCH" = "arm64" ]; then
  BUN_ARCH="aarch64"
fi

BUN_PLATFORM="${OS}-${BUN_ARCH}"
BUN_ARCHIVE="bun-${BUN_PLATFORM}.zip"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARCHIVE}"

echo "    Downloading from: $BUN_URL"
curl -fsSL -o "dist/$PACKAGE/${BUN_ARCHIVE}" "$BUN_URL"
unzip -q "dist/$PACKAGE/${BUN_ARCHIVE}" -d "dist/$PACKAGE/"
mv "dist/$PACKAGE/bun-${BUN_PLATFORM}/bun" "dist/$PACKAGE/bun"
rm -rf "dist/$PACKAGE/bun-${BUN_PLATFORM}" "dist/$PACKAGE/${BUN_ARCHIVE}"
chmod +x "dist/$PACKAGE/bun"

echo "==> Packaging standalone assets..."
cp -r .next/standalone/* "dist/$PACKAGE/"
cp -r .next/standalone/.next "dist/$PACKAGE/"

echo "==> Pruning unnecessary files..."
# Keep only required node_modules
KEEP_MODULES="next @next @swc styled-jsx react react-dom client-only execa"
for dir in "dist/$PACKAGE/node_modules"/*; do
  name=$(basename "$dir")
  if ! echo "$KEEP_MODULES" | grep -qw "$name"; then
    rm -rf "$dir"
  fi
done
# Remove sourcemaps and type definitions
find "dist/$PACKAGE" -name "*.map" -delete 2>/dev/null || true
find "dist/$PACKAGE" -name "*.d.ts" -delete 2>/dev/null || true

echo "==> Creating tarball..."
cd dist
tar -czf "${PACKAGE}.tar.gz" "$PACKAGE"
cd ..

echo ""
echo "✓ Package created at: dist/${PACKAGE}.tar.gz"
du -h "dist/${PACKAGE}.tar.gz"
