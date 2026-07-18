---
inputs:
  dir:
    type: string
    default: ".reviews/.oxlint"
  oxlintTag:
    type: string
    default: "apps_v1.74.0"
  tsgolintVersion:
    type: string
    default: "0.25.0"
---

```bash silent exec
set -eu
DIR="{dir}"
OXLINT_TAG="{oxlintTag}"
TSGOLINT_VERSION="{tsgolintVersion}"
mkdir -p "$DIR"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) ox_os="apple-darwin"; tg_os="darwin" ;;
  Linux) ox_os="unknown-linux-gnu"; tg_os="linux" ;;
  *) echo "EnsureOxlint: unsupported OS $os"; exit 0 ;;
esac
case "$arch" in
  arm64 | aarch64) ox_arch="aarch64"; tg_arch="arm64" ;;
  x86_64 | amd64) ox_arch="x86_64"; tg_arch="x64" ;;
  *) echo "EnsureOxlint: unsupported arch $arch"; exit 0 ;;
esac

# oxlint: standalone binary from the oxc release (no Node/npm needed).
if [ ! -x "$DIR/oxlint" ]; then
  tmp="$(mktemp -d)"
  if curl -fsSL "https://github.com/oxc-project/oxc/releases/download/${OXLINT_TAG}/oxlint-${ox_arch}-${ox_os}.tar.gz" | tar xz -C "$tmp"; then
    mv "$tmp/oxlint-${ox_arch}-${ox_os}" "$DIR/oxlint"
    chmod +x "$DIR/oxlint"
  fi
  rm -rf "$tmp"
fi

# tsgolint (type-aware engine): npm-only, so pull the platform tarball directly.
if [ ! -x "$DIR/tsgolint" ]; then
  tmp="$(mktemp -d)"
  if curl -fsSL "https://registry.npmjs.org/@oxlint-tsgolint/${tg_os}-${tg_arch}/-/${tg_os}-${tg_arch}-${TSGOLINT_VERSION}.tgz" | tar xz -C "$tmp"; then
    mv "$tmp/package/tsgolint" "$DIR/tsgolint"
    chmod +x "$DIR/tsgolint"
  fi
  rm -rf "$tmp"
fi

echo "oxlint: $("$DIR/oxlint" --version 2>/dev/null || echo missing)"
echo "tsgolint: $([ -x "$DIR/tsgolint" ] && echo installed || echo missing)"
```
