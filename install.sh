#!/bin/bash
set -euo pipefail

# grove installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jgeschwendt/grove/main/install.sh | bash
#
# Installs to ~/.grove/bin by default (no sudo required)
# Set GROVE_INSTALL_DIR to override

REPO="jgeschwendt/grove"
GROVE_HOME="${GROVE_HOME:-$HOME/.grove}"
INSTALL_DIR="${GROVE_INSTALL_DIR:-$GROVE_HOME/bin}"
VERSION="${1:-latest}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${GREEN}info${NC}: $1"; }
warn() { echo -e "${YELLOW}warn${NC}: $1"; }
error() { echo -e "${RED}error${NC}: $1"; exit 1; }

# Detect OS
case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)      error "Unsupported OS: $(uname -s)" ;;
esac

# Detect architecture (normalize to Rust target naming)
case "$(uname -m)" in
    x86_64)         ARCH="x86_64" ;;
    arm64|aarch64)  ARCH="aarch64" ;;
    *)              error "Unsupported architecture: $(uname -m)" ;;
esac

NAME="${OS}-${ARCH}"
info "Detected platform: ${NAME}"

# Get version
if [[ "$VERSION" == "latest" ]]; then
    info "Fetching latest version..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    if [[ -z "$VERSION" ]]; then
        error "Failed to fetch latest version"
    fi
fi

info "Installing grove ${VERSION}..."

# Download
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${NAME}.tar.gz"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

info "Downloading from ${DOWNLOAD_URL}"
if ! curl -fsSL "$DOWNLOAD_URL" -o "${TMP_DIR}/grove.tar.gz"; then
    error "Download failed. Check that version ${VERSION} exists and has binaries for ${NAME}."
fi

# Extract
tar -xzf "${TMP_DIR}/grove.tar.gz" -C "$TMP_DIR"

# Install
mkdir -p "$INSTALL_DIR"
mv "${TMP_DIR}/grove" "${INSTALL_DIR}/grove"
chmod +x "${INSTALL_DIR}/grove"

info "Installed grove to ${INSTALL_DIR}/grove"
echo ""

# Check if in PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    warn "$INSTALL_DIR is not in your PATH"
    echo ""
    echo "Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo ""
    echo "  export PATH=\"\$HOME/.grove/bin:\$PATH\""
    echo ""
fi

echo "Run 'grove --help' to get started"
