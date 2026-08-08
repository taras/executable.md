---
props:
  type: object
  properties:
    dir:
      type: string
      default: ".reviews/.oxlint"
  additionalProperties: false
---

```ts eval
import { platform } from "@executablemd/runtime";

const OXLINT_TAG = "apps_v1.74.0";
const TSGOLINT_VERSION = "0.25.0";
const host = yield* platform();
const target = {
  oxlintOs: host.os === "darwin" ? "apple-darwin" : host.os === "linux" ? "unknown-linux-gnu" : "",
  tsgolintOs: host.os === "darwin" ? "darwin" : host.os === "linux" ? "linux" : "",
  oxlintArch: host.arch === "arm64" || host.arch === "aarch64"
    ? "aarch64"
    : host.arch === "x86_64" || host.arch === "amd64" || host.arch === "x64"
    ? "x86_64"
    : "",
  tsgolintArch: host.arch === "arm64" || host.arch === "aarch64"
    ? "arm64"
    : host.arch === "x86_64" || host.arch === "amd64" || host.arch === "x64"
    ? "x64"
    : "",
};
if (!target.oxlintOs || !target.oxlintArch) {
  throw new Error(`EnsureOxlint: unsupported platform ${host.os}/${host.arch}`);
}

const oxlintHashes = {
  "aarch64-apple-darwin": "768a2d00e7e0a95cbf89837086f475d25dc1a1ba605b8831fb5a1db6d590a643",
  "x86_64-apple-darwin": "04ae38d56ae4990ac96320c03f05f38cf1103b5fe64b08cd7203b87e767b45b4",
  "aarch64-unknown-linux-gnu": "ced0d2433bda2b4295e1ab93b40c3f24224713c32a44e13abcda656590dba1cb",
  "x86_64-unknown-linux-gnu": "fd3ed5d2dc55ab6f7a243583c69dd5da4ac97cd1f6e10321225ca6343c9451a9",
};
const tsgolintHashes = {
  "darwin-arm64": "3ad51d1b88070b491b81a4f5c6169148914127b9da65f8087823b25568431e1e",
  "darwin-x64": "6b78caa20db383c055cead96724aeafab3cd277b00b1f95c6f56b4bfcf22fd60",
  "linux-arm64": "20bcbab4bb37dd396102566740ee39e67d1e3d16d06096802180426c022bc414",
  "linux-x64": "f6ea083842395d7439eadbbbf380f23793a1fa890fbda92013ee0f6033e75630",
};
const oxlintKey = `${target.oxlintArch}-${target.oxlintOs}`;
const tsgolintKey = `${target.tsgolintOs}-${target.tsgolintArch}`;
const oxlintUrl = `https://github.com/oxc-project/oxc/releases/download/${OXLINT_TAG}/oxlint-${target.oxlintArch}-${target.oxlintOs}.tar.gz`;
const tsgolintUrl = `https://registry.npmjs.org/@oxlint-tsgolint/${target.tsgolintOs}-${target.tsgolintArch}/-/${target.tsgolintOs}-${target.tsgolintArch}-${TSGOLINT_VERSION}.tgz`;
const oxlintSha = oxlintHashes[oxlintKey];
const tsgolintSha = tsgolintHashes[tsgolintKey];
if (!oxlintSha || !tsgolintSha) {
  throw new Error(`EnsureOxlint: no checksum for ${oxlintKey}/${tsgolintKey}`);
}
```

```bash silent exec
set -euo pipefail
DIR="{dir}"
mkdir -p "$DIR"

verify() {
  expected="$2"
  actual="$(sha256sum "$1" 2>/dev/null || shasum -a 256 "$1")"
  actual="${actual%% *}"
  if [ "$actual" != "$expected" ]; then
    echo "EnsureOxlint: checksum mismatch for $1" >&2
    exit 1
  fi
}

if [ ! -x "$DIR/oxlint" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/oxlint.tar.gz" "{oxlintUrl}"
  verify "$tmp/oxlint.tar.gz" "{oxlintSha}"
  tar xz -C "$tmp" -f "$tmp/oxlint.tar.gz"
  mv "$tmp/oxlint-{target.oxlintArch}-{target.oxlintOs}" "$DIR/oxlint"
  chmod +x "$DIR/oxlint"
  rm -rf "$tmp"
fi

if [ ! -x "$DIR/tsgolint" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/tsgolint.tgz" "{tsgolintUrl}"
  verify "$tmp/tsgolint.tgz" "{tsgolintSha}"
  tar xz -C "$tmp" -f "$tmp/tsgolint.tgz"
  mv "$tmp/package/tsgolint" "$DIR/tsgolint"
  chmod +x "$DIR/tsgolint"
  rm -rf "$tmp"
fi
```
