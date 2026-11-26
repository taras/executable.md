# Install xmd-dev

Run this example from the root of a checkout you prepared with
`deno task setup`. Use an existing `xmd` to run the installer.

```sh
xmd run examples/install-xmd-dev.md
```

The installer writes a small launcher into `~/.local/xmd-dev/bin` and
records this checkout as its default. The dedicated directory lets you put
the launcher first on `PATH`, the list your shell searches for commands.

```sh exec as="source"
test -f packages/cli/src/deno.ts
```

<If condition={source.exitCode !== 0}>
  <Fail message="Go to the root of your prepared checkout and run xmd run examples/install-xmd-dev.md again." />
</If>

```sh exec as="destination"
test -n "${HOME:-}" && printf '%s/.local/xmd-dev/bin/xmd-dev\n' "$HOME"
```

<If condition={!destination.stdout.startsWith("/")}>
  <Fail message="Set HOME to the absolute path of your home directory, then run xmd run examples/install-xmd-dev.md again." />
</If>

<Let as="installedPath" value={destination.stdout.trimEnd()} />

The installer stages a complete executable before publishing it. If the name
already holds the same generated launcher, a repeat run leaves it in place.
If it holds a different command, including a symlink from a previous install,
move that command aside before running the installer again.

```bash exec as="install"
set -eu
checkout=$(pwd -P)
bin="$HOME/.local/xmd-dev/bin"
mkdir -p "$bin"
staging=$(mktemp -d "$bin/.install.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT

{
  printf '%s\n' '#!/usr/bin/env bash' 'set -eu'
  printf 'checkout=%q\n' "$checkout"
  cat <<'LAUNCHER'
launcher=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
root=${XMD_DEV_ROOT:-$checkout}
root=$(cd "$root" && pwd -P)
entry=$root/packages/cli/src/deno.ts

if [ ! -f "$entry" ]; then
  printf 'xmd-dev: no CLI entrypoint at %s\n' "$entry" >&2
  exit 1
fi

XMD_REPL_LAUNCHER=$launcher XMD_REPL_DENO_PROFILE=allow-all exec "${XMD_DEV_DENO:-deno}" run --allow-all "$entry" "$@"
LAUNCHER
} > "$staging/xmd-dev"
chmod 755 "$staging/xmd-dev"

destination="$bin/xmd-dev"
if ln "$staging/xmd-dev" "$bin/"; then
  printf 'installed\n'
elif [ ! -L "$destination" ] && [ -f "$destination" ] &&
  [ -x "$destination" ] && cmp -s "$staging/xmd-dev" "$destination"; then
  printf 'already installed\n'
else
  exit 1
fi
```

<If condition={install.exitCode !== 0}>
  <Let as="refusal">

    Could not install {installedPath}. Move a conflicting command aside before
    retrying.

  </Let>
  <Fail message={refusal.trim() + " " + install.stderr.trim()} />
</If>

```sh exec as="selected"
command -v xmd-dev
```

<Output>

  <If condition={install.stdout.trim() === "installed"}>

    Installed the launcher at {installedPath}.

    <Else>

      The launcher at {installedPath} already points to this checkout.

    </Else>
  </If>

  <If condition={selected.stdout !== destination.stdout}>

    Run this in your current shell to select this launcher.

    ```sh
    export PATH="$HOME/.local/xmd-dev/bin:$PATH"
    ```

  </If>

  Confirm which launcher your shell selects and check its version.

  ```sh
  command -v xmd-dev
  xmd-dev --version
  ```

</Output>
