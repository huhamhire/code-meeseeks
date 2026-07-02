#!/usr/bin/env bash
#
# One-line installer for the meebox CLI on macOS / Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/huhamhire/code-meeseeks/main/tools/cli/install.sh | bash
#
# Detects OS/arch, downloads the matching release archive from GitHub, verifies its
# SHA-256, and installs the `meebox` binary onto PATH. SKILL.md is NOT installed — it is
# embedded in the binary and printable via `meebox skill` (regenerate on demand if needed).
#
# Options (env vars or flags):
#   MEEBOX_VERSION / --version <v>    install a specific release (e.g. v0.9.0); default: latest
#   MEEBOX_BIN_DIR / --bin-dir <dir>  install target; default: /usr/local/bin if writable, else ~/.local/bin
#
# Windows is not covered by this script — download the .zip from the Releases page.
set -euo pipefail

REPO="huhamhire/code-meeseeks"
BIN_NAME="meebox"

VERSION="${MEEBOX_VERSION:-}"
BIN_DIR="${MEEBOX_BIN_DIR:-}"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

usage() {
  # Print the header comment block (skip the shebang; stop at the first non-comment line).
  awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --bin-dir) BIN_DIR="${2:-}"; shift 2 ;;
    --bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown argument: $1 (see --help)" ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || err "required tool not found: $1"; }
need curl

# --- detect OS / arch ---------------------------------------------------------
os="$(uname -s)"
case "$os" in
  Linux) goos=linux ;;
  Darwin) goos=darwin ;;
  *) err "unsupported OS: $os (this installer supports Linux and macOS; on Windows download the .zip from Releases)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) goarch=amd64 ;;
  aarch64 | arm64) goarch=arm64 ;;
  *) err "unsupported architecture: $arch" ;;
esac

# Only darwin/arm64 (Apple Silicon) is published; Linux ships amd64 + arm64.
if [ "$goos" = darwin ] && [ "$goarch" != arm64 ]; then
  err "no prebuilt macOS binary for $goarch — only Apple Silicon (arm64) is published"
fi

# macOS archives are .zip, Linux archives are .tar.gz (matches the release workflow).
if [ "$goos" = linux ]; then ext="tar.gz"; else ext="zip"; fi
if [ "$ext" = zip ]; then need unzip; else need tar; fi

# --- resolve release tag ------------------------------------------------------
if [ -z "$VERSION" ]; then
  info "Resolving latest release..."
  tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
    grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -n "$tag" ] || err "could not resolve the latest release tag"
else
  case "$VERSION" in v*) tag="$VERSION" ;; *) tag="v$VERSION" ;; esac
fi
version="${tag#v}"

archive="${BIN_NAME}-cli-${version}-${goos}-${goarch}.${ext}"
url="https://github.com/${REPO}/releases/download/${tag}/${archive}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- download + verify --------------------------------------------------------
info "Downloading ${archive} (${tag})..."
curl -fSL --proto '=https' "$url" -o "$tmp/$archive" || err "download failed: $url"

if curl -fsSL --proto '=https' "${url}.sha256" -o "$tmp/$archive.sha256" 2>/dev/null; then
  info "Verifying checksum..."
  want="$(awk '{print $1}' "$tmp/$archive.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
  else
    got=""
    info "warning: no sha256 tool available; skipping verification"
  fi
  [ -z "$got" ] || [ "$want" = "$got" ] || err "checksum mismatch for $archive"
else
  info "warning: checksum file not found; skipping verification"
fi

# --- extract ------------------------------------------------------------------
info "Extracting..."
mkdir -p "$tmp/extract"
if [ "$ext" = zip ]; then
  unzip -q -o "$tmp/$archive" -d "$tmp/extract"
else
  tar -xzf "$tmp/$archive" -C "$tmp/extract"
fi
[ -f "$tmp/extract/$BIN_NAME" ] || err "binary '$BIN_NAME' not found in $archive"

# --- install ------------------------------------------------------------------
if [ -z "$BIN_DIR" ]; then
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    BIN_DIR="/usr/local/bin"
  else
    BIN_DIR="$HOME/.local/bin"
  fi
fi
mkdir -p "$BIN_DIR"
install_path="$BIN_DIR/$BIN_NAME"
mv -f "$tmp/extract/$BIN_NAME" "$install_path"
chmod +x "$install_path"

info "Installed ${BIN_NAME} ${version} to ${install_path}"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) info "note: ${BIN_DIR} is not on your PATH — add it, e.g.: export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac
info ""
info "Next: ${BIN_NAME} login --token <token>    # then e.g. ${BIN_NAME} pr list"
info "Tip:  ${BIN_NAME} skill                     # print the embedded agent usage doc"
