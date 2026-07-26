---
title: Bootstrap an npm package
---

# Bootstrap an npm package

New npm packages need a package record before npm lets us configure GitHub
Actions as their trusted publisher. This document creates that record when a
package's real implementation cannot yet be built from published siblings.

It publishes an empty `0.0.0-bootstrap.0` package under the `bootstrap`
dist-tag. It never publishes `latest`; the first tagged release publishes the
implementation.

## Run

The code block below is the script source. Until
[#153](https://github.com/taras/executable.md/issues/153) is resolved, `xmd run`
limits a code block to 30 seconds, which is too short for npm's web
authentication. Materialize the block as a temporary script so npm keeps the
terminal it needs for authentication:

```sh
bootstrap_file="$(mktemp)"

awk '
/^```bash exec$/ { run=1; next }
run && /^```$/ { exit }
run { print }
' scripts/bootstrap-npm-package.md > "$bootstrap_file"
```

Publishing requires npm 11.15 or newer for `npm trust`. With Volta, find that
npm and put it on the shell's `PATH`; `volta run --npm … bash` does not pass its
npm selection into `bash`.

```sh
volta install npm@11.18.0
NPM_DIR="$(dirname "$(volta which npm)")"
PATH="$NPM_DIR:$PATH" npm whoami --registry=https://registry.npmjs.org
```

Preview the artifact first:

```sh
PACKAGE_DIR=packages/acp \
PATH="$NPM_DIR:$PATH" \
bash "$bootstrap_file"
```

Publish it and configure trusted publishing:

```sh
PACKAGE_DIR=packages/acp \
PUBLISH=1 \
PATH="$NPM_DIR:$PATH" \
bash "$bootstrap_file"
```

The browser authentication may finish after npm loses its request. Re-run the
same publish command if that happens: an existing, correct bootstrap package
skips publication and continues with trusted-publisher configuration.

Verify the result:

```sh
PATH="$NPM_DIR:$PATH" npm view @executablemd/acp dist-tags \
  --json --registry=https://registry.npmjs.org

PATH="$NPM_DIR:$PATH" npm trust list @executablemd/acp \
  --registry=https://registry.npmjs.org
```

Remove the temporary script when every package is complete:

```sh
rm "$bootstrap_file"
```

Create the matching package on JSR and link it to this repository before the
next tagged release.

## Bootstrap

```bash exec
set -euo pipefail

: "${PACKAGE_DIR:?set PACKAGE_DIR to a workspace package directory}"
registry="https://registry.npmjs.org"
bootstrap_version="0.0.0-bootstrap.0"

if [ ! -f "$PACKAGE_DIR/deno.json" ] || [ ! -f "$PACKAGE_DIR/package.json" ]; then
  echo "PACKAGE_DIR must contain deno.json and package.json: $PACKAGE_DIR" >&2
  exit 1
fi

name="$(node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name)' "$PACKAGE_DIR/package.json")"
description="$(node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).description ?? "")' "$PACKAGE_DIR/package.json")"

case "$name" in
  @executablemd/*) ;;
  *)
    echo "PACKAGE_DIR must name an @executablemd package: $name" >&2
    exit 1
    ;;
esac

if [ "${PUBLISH:-}" = "1" ] && ! node -e '
  const [major, minor] = process.argv[1].split(".").map(Number);
  process.exit(major > 11 || (major === 11 && minor >= 15) ? 0 : 1);
' "$(npm --version)"; then
  echo "PUBLISH=1 requires npm 11.15 or newer for npm trust; found $(npm --version)." >&2
  exit 1
fi

publish=0
if existing="$(npm view "$name" version --json --registry "$registry" 2>&1)"; then
  if ! printf '%s\n' "$existing" | grep -Fq "\"$bootstrap_version\""; then
    echo "$name already exists on npm with a version other than $bootstrap_version:" >&2
    printf '%s\n' "$existing" >&2
    exit 1
  fi

  tags="$(npm view "$name" dist-tags --json --registry "$registry" 2>&1)"
  if ! printf '%s\n' "$tags" | grep -Eq "\"bootstrap\"[[:space:]]*:[[:space:]]*\"$bootstrap_version\""; then
    echo "$name does not have the expected bootstrap dist-tag:" >&2
    printf '%s\n' "$tags" >&2
    exit 1
  fi

  echo "$name@$bootstrap_version already exists; skipping publication."
elif ! printf '%s\n' "$existing" | grep -q 'E404'; then
  echo "could not confirm whether $name exists on npm:" >&2
  printf '%s\n' "$existing" >&2
  exit 1
else
  publish=1
fi

if [ "$publish" = "1" ]; then
  bootstrap_dir="$(mktemp -d -t executablemd-bootstrap.XXXXXX)"
  trap 'rm -rf "$bootstrap_dir"' EXIT

  node -e '
    const fs = require("fs");
    const [file, name, description] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({
      name,
      version: "0.0.0-bootstrap.0",
      description: `Bootstrap reservation for ${description || name}.`,
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/taras/executable.md.git",
      },
      homepage: "https://executable.md",
      files: ["README.md"],
    }, null, 2) + "\n");
  ' "$bootstrap_dir/package.json" "$name" "$description"

  cat >"$bootstrap_dir/README.md" <<EOF
# $name

This is a bootstrap reservation for the package name. It contains no
implementation. Install a stable release from the \`latest\` dist-tag once
available.
EOF

  echo "Bootstrap artifact for $name:"
  (cd "$bootstrap_dir" && npm pack --dry-run --json)

  if [ "${PUBLISH:-}" != "1" ]; then
    echo "Preview complete. Set PUBLISH=1 to publish the bootstrap artifact."
    exit 0
  fi

  (cd "$bootstrap_dir" && npm publish --access public --tag bootstrap --registry "$registry")
elif [ "${PUBLISH:-}" != "1" ]; then
  echo "Preview complete. $name already has the bootstrap artifact."
  exit 0
fi

npm trust github "$name" \
  --file publish-packages.yml \
  --repository taras/executable.md \
  --environment npm-publish \
  --allow-publish \
  --registry "$registry" \
  --yes

echo "npm dist-tags:"
npm view "$name" dist-tags --json --registry "$registry"

echo "trusted publisher:"
npm trust list "$name" --registry "$registry"

echo "Next: create $name on JSR and link it to taras/executable.md before the tagged release."
```
