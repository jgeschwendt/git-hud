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

echo "==> Packaging standalone assets..."
cp -r .next/standalone/* "dist/$PACKAGE/"
cp -r .next/standalone/.next "dist/$PACKAGE/"

echo "==> Creating tarball..."
cd dist
tar -czf "${PACKAGE}.tar.gz" "$PACKAGE"
cd ..

echo ""
echo "✓ Package created at: dist/${PACKAGE}.tar.gz"
du -h "dist/${PACKAGE}.tar.gz"
