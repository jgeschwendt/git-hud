#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.grove"
REPO="jgeschwendt/grove"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
fi

# Fetch latest version from GitHub
echo "Fetching latest release..."
if command -v curl &> /dev/null; then
  LATEST_JSON=$(curl -fsSL --tlsv1.2 "https://api.github.com/repos/${REPO}/releases/latest")
elif command -v wget &> /dev/null; then
  LATEST_JSON=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest")
else
  echo "Error: curl or wget required"
  exit 1
fi

VERSION=$(echo "$LATEST_JSON" | grep '"tag_name"' | grep -o 'v[0-9.]*' | tr -d 'v')

if [ -z "$VERSION" ]; then
  echo "Error: Failed to fetch latest version"
  exit 1
fi

PACKAGE_NAME="${OS}-${ARCH}.tar.gz"
RELEASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${PACKAGE_NAME}"

echo "Installing grove v${VERSION} for ${OS}-${ARCH}..."

# Create directory structure
mkdir -p "${INSTALL_DIR}/data"
mkdir -p "${INSTALL_DIR}/clones"
mkdir -p "${INSTALL_DIR}/logs"

# Download package
TEMP_DIR=$(mktemp -d)
echo "Downloading from $RELEASE_URL..."
if command -v curl &> /dev/null; then
  curl -fL# --tlsv1.2 "$RELEASE_URL" -o "${TEMP_DIR}/${PACKAGE_NAME}"
elif command -v wget &> /dev/null; then
  wget --progress=bar:force -O "${TEMP_DIR}/${PACKAGE_NAME}" "$RELEASE_URL"
else
  echo "Error: curl or wget required"
  exit 1
fi

# Extract to install directory
echo "Extracting..."
tar -xzf "${TEMP_DIR}/${PACKAGE_NAME}" -C "$TEMP_DIR"
rm -rf "${INSTALL_DIR}/app" 2>/dev/null || true
mv "${TEMP_DIR}/${OS}-${ARCH}" "${INSTALL_DIR}/app"
rm -rf "$TEMP_DIR"

# Create symlink in bin
mkdir -p "${INSTALL_DIR}/bin"
ln -sf "${INSTALL_DIR}/app/grove" "${INSTALL_DIR}/bin/grove"

# Add to PATH - detect shell config file
if [ -n "${SHELL:-}" ] && [[ "$SHELL" == *"zsh"* ]]; then
  # Prefer .zshenv for zsh (sourced for all shells)
  if [ -f "${HOME}/.zshenv" ]; then
    SHELL_RC="${HOME}/.zshenv"
  else
    SHELL_RC="${HOME}/.zshrc"
  fi
elif [ -f "${HOME}/.bash_profile" ]; then
  SHELL_RC="${HOME}/.bash_profile"
elif [ -f "${HOME}/.bashrc" ]; then
  SHELL_RC="${HOME}/.bashrc"
else
  # Fallback to .zshrc
  SHELL_RC="${HOME}/.zshrc"
fi

if ! grep -q ".grove/bin" "$SHELL_RC" 2>/dev/null; then
  echo '' >> "$SHELL_RC"
  echo '# grove' >> "$SHELL_RC"
  echo 'export PATH="$HOME/.grove/bin:$PATH"' >> "$SHELL_RC"
  echo "Added to PATH in $SHELL_RC"
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Installed version: $VERSION"
"${INSTALL_DIR}/bin/grove" version
echo ""
echo "Start grove:"
echo "  ${INSTALL_DIR}/bin/grove"
echo ""
echo "Or reload your shell and run:"
echo "  grove"
