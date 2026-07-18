---
inputs:
  dir:
    type: string
    default: ".reviews/.oxlint"
---

```bash silent exec
# Provisions the pinned oxlint + tsgolint binaries with mandatory sha256
# verification, failing closed — a failed or tampered download must abort the
# review, never silently degrade it. Version pins live next to their hashes so
# neither can change without the other. The workflow guards on the resulting
# binaries (see review.yml).
set -euo pipefail
DIR="{dir}"
OXLINT_TAG="apps_v1.74.0"
TSGOLINT_VERSION="0.25.0"
mkdir -p "$DIR"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) ox_os="apple-darwin"; tg_os="darwin" ;;
  Linux) ox_os="unknown-linux-gnu"; tg_os="linux" ;;
  *) echo "EnsureOxlint: unsupported OS $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) ox_arch="aarch64"; tg_arch="arm64" ;;
  x86_64 | amd64) ox_arch="x86_64"; tg_arch="x64" ;;
  *) echo "EnsureOxlint: unsupported arch $arch" >&2; exit 1 ;;
esac

case "${ox_arch}-${ox_os}" in
  aarch64-apple-darwin) ox_sha="768a2d00e7e0a95cbf89837086f475d25dc1a1ba605b8831fb5a1db6d590a643" ;;
  x86_64-apple-darwin) ox_sha="04ae38d56ae4990ac96320c03f05f38cf1103b5fe64b08cd7203b87e767b45b4" ;;
  aarch64-unknown-linux-gnu) ox_sha="ced0d2433bda2b4295e1ab93b40c3f24224713c32a44e13abcda656590dba1cb" ;;
  x86_64-unknown-linux-gnu) ox_sha="fd3ed5d2dc55ab6f7a243583c69dd5da4ac97cd1f6e10321225ca6343c9451a9" ;;
esac
case "${tg_os}-${tg_arch}" in
  darwin-arm64) tg_sha="3ad51d1b88070b491b81a4f5c6169148914127b9da65f8087823b25568431e1e" ;;
  darwin-x64) tg_sha="6b78caa20db383c055cead96724aeafab3cd277b00b1f95c6f56b4bfcf22fd60" ;;
  linux-arm64) tg_sha="20bcbab4bb37dd396102566740ee39e67d1e3d16d06096802180426c022bc414" ;;
  linux-x64) tg_sha="f6ea083842395d7439eadbbbf380f23793a1fa890fbda92013ee0f6033e75630" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum"; else sha_cmd="shasum -a 256"; fi

verify() {
  actual="$($sha_cmd "$1" | awk '{print $1}')"
  if [ "$actual" != "$2" ]; then
    echo "EnsureOxlint: checksum mismatch for $1 (expected $2, got $actual)" >&2
    exit 1
  fi
}

# oxlint: standalone binary from the oxc release (no Node/npm needed).
if [ ! -x "$DIR/oxlint" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/oxlint.tar.gz" "https://github.com/oxc-project/oxc/releases/download/${OXLINT_TAG}/oxlint-${ox_arch}-${ox_os}.tar.gz"
  verify "$tmp/oxlint.tar.gz" "$ox_sha"
  tar xz -C "$tmp" -f "$tmp/oxlint.tar.gz"
  mv "$tmp/oxlint-${ox_arch}-${ox_os}" "$DIR/oxlint"
  chmod +x "$DIR/oxlint"
  rm -rf "$tmp"
fi

# tsgolint (type-aware engine): npm-only, so pull the platform tarball directly.
if [ ! -x "$DIR/tsgolint" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tsgolint.tgz" "https://registry.npmjs.org/@oxlint-tsgolint/${tg_os}-${tg_arch}/-/${tg_os}-${tg_arch}-${TSGOLINT_VERSION}.tgz"
  verify "$tmp/tsgolint.tgz" "$tg_sha"
  tar xz -C "$tmp" -f "$tmp/tsgolint.tgz"
  mv "$tmp/package/tsgolint" "$DIR/tsgolint"
  chmod +x "$DIR/tsgolint"
  rm -rf "$tmp"
fi
```
