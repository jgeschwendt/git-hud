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
  PACKAGE="git-hud-${PLATFORM}"
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  if [ "$ARCH" = "x86_64" ]; then
    ARCH="x64"
  fi

  TARGET="bun-${OS}-${ARCH}"
  PLATFORM="${OS}-${ARCH}"
  PACKAGE="git-hud-${PLATFORM}"
fi

echo "==> Compiling binary for $TARGET..."
mkdir -p "dist/$PACKAGE"

bun build --compile \
  --minify \
  --target="$TARGET" \
  --outfile="dist/$PACKAGE/git-hud" \
  ./cli/index.ts

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
