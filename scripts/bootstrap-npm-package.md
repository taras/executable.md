---
title: Bootstrap an npm package
required: [package]
props:
  package:
    type: string
    pattern: "^packages/[a-z0-9][a-z0-9._-]*$"
    description: Workspace package directory, e.g. packages/web
---

# Bootstrap an npm package

A new `@executablemd` package needs a registry record before its first tagged
release. This document creates one: it publishes an empty `0.0.0-bootstrap.0`
artifact under the `bootstrap` dist-tag and configures GitHub Actions as the
package's trusted publisher. It never publishes `latest` — the first tagged
release publishes the implementation.

The publish and the trust configuration both need a one-time code, and the
document asks for it at the point of use. Everything before that point is a
preview: guards, the generated artifact, and `npm pack --dry-run`. Nothing
reaches the registry until the code is entered, and a preview that fails ends
the run without asking for one.

## Run

```sh
deno task xmd run scripts/bootstrap-npm-package.md --props-package packages/web
```

> [!WARNING]
> Run this document **without `-j`/`--journal` and without `--verbose`**. The
> code you enter is interpolated into the publish command, and the durable entry
> for a code block records that command: `--journal` persists the code to a file
> on disk, and `--verbose` reports it to stderr. Neither is needed here.

Two things this document cannot do for you, both because they are browser flows
that the code prompt cannot carry:

- **Be logged in.** Check with
  `npm whoami --registry=https://registry.npmjs.org`, and log in if it fails.
- **Have a recent enough npm.** `npm trust` needs npm 11.15 or newer. The
  document checks this before anything else and refuses rather than publishing
  an artifact it cannot then configure — but installing a newer npm is yours.
  With Volta, `volta install npm@11.18.0` and put that npm first on `PATH`.

Re-running is safe. A package already sitting at `0.0.0-bootstrap.0` under the
`bootstrap` dist-tag skips the publish and re-runs the trust configuration, so
a run that lost its code partway through resumes by starting over.

## Preview

<TempDir as="artifact" />

The verdict file is written before the work, not after, so a block that dies
anywhere — including under `set -euo pipefail`, before it could report — leaves
a failure behind rather than nothing.

```bash silent exec
printf 'fail: preview did not complete' > "{artifact}/verdict"
```

```bash exec
set -euo pipefail

pkg_dir="{package}"
artifact_dir="{artifact}"
registry="https://registry.npmjs.org"
bootstrap_version="0.0.0-bootstrap.0"

# First, before the registry is contacted at all. An npm too old for `npm trust`
# can still publish, and would leave exactly the half-configured package this
# document exists to avoid.
if ! node -e '
  const [major, minor] = process.argv[1].split(".").map(Number);
  process.exit(major > 11 || (major === 11 && minor >= 15) ? 0 : 1);
' "$(npm --version)"; then
  echo "npm trust requires npm 11.15 or newer; found $(npm --version)." >&2
  exit 1
fi

if [ ! -f "$pkg_dir/deno.json" ] || [ ! -f "$pkg_dir/package.json" ]; then
  echo "package must name a workspace member with deno.json and package.json: $pkg_dir" >&2
  exit 1
fi

pkg_name="$(node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name)' "$pkg_dir/package.json")"
pkg_description="$(node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).description ?? "")' "$pkg_dir/package.json")"

case "$pkg_name" in
  @executablemd/*) ;;
  *)
    echo "package must name an @executablemd package: $pkg_name" >&2
    exit 1
    ;;
esac

if existing="$(npm view "$pkg_name" version --json --registry "$registry" 2>&1)"; then
  if ! printf '%s\n' "$existing" | grep -Fq "\"$bootstrap_version\""; then
    echo "$pkg_name already exists on npm with a version other than $bootstrap_version:" >&2
    printf '%s\n' "$existing" >&2
    exit 1
  fi

  tags="$(npm view "$pkg_name" dist-tags --json --registry "$registry" 2>&1)"
  if ! printf '%s\n' "$tags" | grep -Eq "\"bootstrap\"[[:space:]]*:[[:space:]]*\"$bootstrap_version\""; then
    echo "$pkg_name does not have the expected bootstrap dist-tag:" >&2
    printf '%s\n' "$tags" >&2
    exit 1
  fi

  echo "$pkg_name@$bootstrap_version already exists; the publish will be skipped."
elif ! printf '%s\n' "$existing" | grep -q 'E404'; then
  echo "could not confirm whether $pkg_name exists on npm:" >&2
  printf '%s\n' "$existing" >&2
  exit 1
else
  echo "$pkg_name is absent from npm; it will be published at $bootstrap_version."
fi

# Generated here and published from here: the artifact previewed below is the
# artifact that goes to the registry, not a second one built to match it.
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
' "$artifact_dir/package.json" "$pkg_name" "$pkg_description"

cat >"$artifact_dir/README.md" <<EOF
# $pkg_name

This is a bootstrap reservation for the package name. It contains no
implementation. Install a stable release from the \`latest\` dist-tag once
available.
EOF

echo "Bootstrap artifact for $pkg_name:"
(cd "$artifact_dir" && npm pack --dry-run --json)

printf 'ok' > "$artifact_dir/verdict"
```

<Capture as="previewVerdict">

```bash exec
cat "{artifact}/verdict"
```

</Capture>

The pattern is anchored at both ends, so it accepts the sentinel and nothing
else: `not ok`, a `fail: …` reason, and an empty verdict all fail it. Only the
surrounding whitespace a rendered code block carries is tolerated.

<AssertMatch actual={previewVerdict} expected={/^\s*ok$/} msg="preview failed — see the output above. Nothing was published and no code was requested." />

## Publish

The code is asked for here, after the preview and before anything reaches the
registry. Enter a **fresh** one: both the publish and the trust configuration
ride the same code, and a code entered early may expire between them.

<Capture as="otpSchema" select="code[lang=json]">

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": ["code"],
  "additionalProperties": false
}
```

</Capture>

<Elicit schema={otpSchema} as="otp">
Enter a fresh six-digit npm one-time code. It authorizes both the bootstrap
publish and the trusted-publisher configuration, so generate it now rather than
reusing one from a moment ago.
</Elicit>

```bash silent exec
printf 'fail: publish did not complete' > "{artifact}/verdict"
```

```bash exec
set -euo pipefail

pkg_dir="{package}"
artifact_dir="{artifact}"
registry="https://registry.npmjs.org"
bootstrap_version="0.0.0-bootstrap.0"

pkg_name="$(node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name)' "$pkg_dir/package.json")"

# Checked again, not carried over from the preview: the operator has been away
# entering a code, and the registry may have gained the package in the meantime.
# Publishing on the preview's answer would publish over whatever arrived.
publish=0
if existing="$(npm view "$pkg_name" version --json --registry "$registry" 2>&1)"; then
  if ! printf '%s\n' "$existing" | grep -Fq "\"$bootstrap_version\""; then
    echo "$pkg_name gained a version other than $bootstrap_version since the preview:" >&2
    printf '%s\n' "$existing" >&2
    exit 1
  fi
  echo "$pkg_name@$bootstrap_version is already published; skipping the publish."
elif ! printf '%s\n' "$existing" | grep -q 'E404'; then
  echo "could not confirm whether $pkg_name exists on npm:" >&2
  printf '%s\n' "$existing" >&2
  exit 1
else
  publish=1
fi

if [ "$publish" = "1" ]; then
  (cd "$artifact_dir" && npm_config_otp={otp.code} npm publish --access public --tag bootstrap --registry "$registry")
fi

npm_config_otp={otp.code} npm trust github "$pkg_name" \
  --file publish-packages.yml \
  --repository taras/executable.md \
  --environment npm-publish \
  --allow-publish \
  --registry "$registry" \
  --yes

echo "npm dist-tags:"
npm view "$pkg_name" dist-tags --json --registry "$registry"

echo "trusted publisher:"
npm trust list "$pkg_name" --registry "$registry"

printf 'ok' > "$artifact_dir/verdict"
```

<Capture as="publishVerdict">

```bash exec
cat "{artifact}/verdict"
```

</Capture>

<AssertMatch actual={publishVerdict} expected={/^\s*ok$/} msg="publish or trust configuration failed — see the output above. Re-run to resume: an existing bootstrap artifact is skipped and the trust configuration is re-applied." />

## Afterwards

Create the matching package on JSR under the `@executablemd` scope and link it
to this repository before the next tagged release. `deno publish` fails for a
package that does not exist on JSR, and the JSR job publishes the workspace as a
unit — so one uncreated package fails the release for every package.
