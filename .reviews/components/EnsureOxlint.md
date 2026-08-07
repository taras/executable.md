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
import { platform, stat } from "@executablemd/runtime";

const target = yield* platform();
const targets = {
  "arm64-darwin": {
    oxlintArch: "aarch64",
    oxlintOs: "apple-darwin",
    tsgolintOs: "darwin",
    tsgolintArch: "arm64",
    oxlintSha: "768a2d00e7e0a95cbf89837086f475d25dc1a1ba605b8831fb5a1db6d590a643",
    tsgolintSha: "3ad51d1b88070b491b81a4f5c6169148914127b9da65f8087823b25568431e1e",
  },
  "x64-darwin": {
    oxlintArch: "x86_64",
    oxlintOs: "apple-darwin",
    tsgolintOs: "darwin",
    tsgolintArch: "x64",
    oxlintSha: "04ae38d56ae4990ac96320c03f05f38cf1103b5fe64b08cd7203b87e767b45b4",
    tsgolintSha: "6b78caa20db383c055cead96724aeafab3cd277b00b1f95c6f56b4bfcf22fd60",
  },
  "arm64-linux": {
    oxlintArch: "aarch64",
    oxlintOs: "unknown-linux-gnu",
    tsgolintOs: "linux",
    tsgolintArch: "arm64",
    oxlintSha: "ced0d2433bda2b4295e1ab93b40c3f24224713c32a44e13abcda656590dba1cb",
    tsgolintSha: "20bcbab4bb37dd396102566740ee39e67d1e3d16d06096802180426c022bc414",
  },
  "x64-linux": {
    oxlintArch: "x86_64",
    oxlintOs: "unknown-linux-gnu",
    tsgolintOs: "linux",
    tsgolintArch: "x64",
    oxlintSha: "fd3ed5d2dc55ab6f7a243583c69dd5da4ac97cd1f6e10321225ca6343c9451a9",
    tsgolintSha: "f6ea083842395d7439eadbbbf380f23793a1fa890fbda92013ee0f6033e75630",
  },
};
const targetKey = `${target.arch}-${target.os}`;
const selected = targets[targetKey];
if (!selected) {
  throw new Error(`EnsureOxlint does not support ${target.os}/${target.arch}`);
}

const oxlintPath = `${dir}/oxlint`;
const tsgolintPath = `${dir}/tsgolint`;
const oxlintInstalled = (yield* stat(oxlintPath)).exists;
const tsgolintInstalled = (yield* stat(tsgolintPath)).exists;
const oxlintTag = "apps_v1.74.0";
const tsgolintVersion = "0.25.0";
const oxlintArchive = `oxlint-${selected.oxlintArch}-${selected.oxlintOs}.tar.gz`;
const tsgolintArchive = `${selected.tsgolintOs}-${selected.tsgolintArch}-${tsgolintVersion}.tgz`;
const oxlintUrl = `https://github.com/oxc-project/oxc/releases/download/${oxlintTag}/${oxlintArchive}`;
const tsgolintUrl = `https://registry.npmjs.org/@oxlint-tsgolint/${selected.tsgolintOs}-${selected.tsgolintArch}/-/${tsgolintArchive}`;
```

<Show when={!oxlintInstalled}>

```bash silent exec
set -euo pipefail
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL -o "$tmp_dir/oxlint.tar.gz" "{oxlintUrl}"
checksum=$(sha256sum "$tmp_dir/oxlint.tar.gz" 2>/dev/null || shasum -a 256 "$tmp_dir/oxlint.tar.gz")
case "$checksum" in
  "{selected.oxlintSha}"*) ;;
  *) echo "EnsureOxlint: checksum mismatch for oxlint" >&2; exit 1 ;;
esac
tar xzf "$tmp_dir/oxlint.tar.gz" -C "$tmp_dir"
mkdir -p "{dir}"
mv "$tmp_dir/oxlint-{selected.oxlintArch}-{selected.oxlintOs}" "{oxlintPath}"
chmod +x "{oxlintPath}"
```

</Show>

<Show when={!tsgolintInstalled}>

```bash silent exec
set -euo pipefail
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL -o "$tmp_dir/tsgolint.tgz" "{tsgolintUrl}"
checksum=$(sha256sum "$tmp_dir/tsgolint.tgz" 2>/dev/null || shasum -a 256 "$tmp_dir/tsgolint.tgz")
case "$checksum" in
  "{selected.tsgolintSha}"*) ;;
  *) echo "EnsureOxlint: checksum mismatch for tsgolint" >&2; exit 1 ;;
esac
tar xzf "$tmp_dir/tsgolint.tgz" -C "$tmp_dir"
mkdir -p "{dir}"
mv "$tmp_dir/package/tsgolint" "{tsgolintPath}"
chmod +x "{tsgolintPath}"
```

</Show>
