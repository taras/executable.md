#!/bin/sh
# install.sh — install the `xmd` (executable.md) binary.
#
#   curl -fsSL https://executable.md/install.sh | sh
#
# Environment overrides:
#   XMD_VERSION      release tag to install (default: latest)
#   XMD_INSTALL_DIR  install directory (default: $HOME/.local/bin)
set -eu

REPO="taras/executable.md"
BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"

info() { printf '%s\n' "${DIM}$*${RESET}"; }
ok() { printf '%s\n' "${GREEN}$*${RESET}"; }
err() { printf '%s\n' "${RED}error:${RESET} $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || err "curl is required"

# --- detect platform -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os_part="apple-darwin" ;;
  Linux)  os_part="unknown-linux-gnu" ;;
  *) err "unsupported OS: $os (Windows: download xmd-x86_64-pc-windows-msvc.exe from the releases page)" ;;
esac

case "$arch" in
  arm64|aarch64) arch_part="aarch64" ;;
  x86_64|amd64)  arch_part="x86_64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

target="${arch_part}-${os_part}"
asset="xmd-${target}"

# --- resolve version -------------------------------------------------------
version="${XMD_VERSION:-}"
if [ -z "$version" ]; then
  info "Resolving latest release…"
  version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//; s/".*//')"
  [ -n "$version" ] || err "could not resolve latest release; set XMD_VERSION explicitly"
fi

base="https://github.com/${REPO}/releases/download/${version}"
info "Installing ${BOLD}xmd ${version}${RESET}${DIM} (${target})"

# --- download + verify -----------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "${tmp}/${asset}" "${base}/${asset}" \
  || err "failed to download ${asset} for ${version}"

if curl -fsSL -o "${tmp}/checksums.txt" "${base}/checksums.txt" 2>/dev/null; then
  info "Verifying checksum…"
  expected="$(grep " ${asset}\$" "${tmp}/checksums.txt" | awk '{print $1}')"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${tmp}/${asset}" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')"
    fi
    [ "$expected" = "$actual" ] || err "checksum mismatch for ${asset}"
  fi
fi

# --- install ---------------------------------------------------------------
install_dir="${XMD_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir" 2>/dev/null || true
if [ ! -w "$install_dir" ]; then
  if [ -w /usr/local/bin ]; then install_dir="/usr/local/bin"; else
    err "cannot write to ${install_dir}; set XMD_INSTALL_DIR to a writable directory"
  fi
fi

chmod +x "${tmp}/${asset}"
# clear macOS quarantine so the unsigned binary runs without Gatekeeper prompts
[ "$os" = "Darwin" ] && xattr -d com.apple.quarantine "${tmp}/${asset}" 2>/dev/null || true
mv "${tmp}/${asset}" "${install_dir}/xmd"

ok "Installed xmd to ${install_dir}/xmd"

# --- PATH hint -------------------------------------------------------------
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) printf '%s\n' "${BOLD}Note:${RESET} ${install_dir} is not on your PATH. Add it, e.g.:"
     printf '  export PATH="%s:$PATH"\n' "$install_dir" ;;
esac

printf '\nRun %sxmd run <document.md>%s to get started.\n' "$BOLD" "$RESET"
