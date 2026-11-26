# Install xmd-dev

Run this example from the root of a checkout you prepared with
`deno task setup`. Use an existing `xmd` to run the installer.

```sh
xmd run examples/install-xmd-dev.md
```

The installer links the checkout's launcher into `~/.local/xmd-dev/bin`. A
symbolic link points to the launcher in the checkout, so later edits there take
effect without reinstalling. The dedicated directory lets you put this launcher
first on `PATH`, the list your shell searches for commands.

```sh exec as="source"
test -f scripts/xmd-dev && test -x scripts/xmd-dev &&
  printf '%s/scripts/xmd-dev\n' "$(pwd -P)"
```

<If condition={source.exitCode !== 0}>
<Fail message="No executable scripts/xmd-dev was found here. Go to the root of your prepared checkout and run xmd run examples/install-xmd-dev.md again." />
</If>

```sh exec as="destination"
test -n "${HOME:-}" && printf '%s/.local/xmd-dev/bin/xmd-dev\n' "$HOME"
```

<If condition={!destination.stdout.startsWith("/")}>
<Fail message="Set HOME to the absolute path of your home directory, then run xmd run examples/install-xmd-dev.md again." />
</If>

<Let as="installedPath" value={destination.stdout.trimEnd()} />

The link is created without replacement. If the name is occupied, the installer
reads the existing link to tell a repeat install from a conflict. Move a
conflicting command elsewhere before running the installer again.

```sh exec as="install"
mkdir -p "$HOME/.local/xmd-dev/bin" &&
  ln -s "$(pwd -P)/scripts/xmd-dev" "$HOME/.local/xmd-dev/bin/"
```

<If condition={install.exitCode !== 0}>

```sh exec as="existing"
readlink "$HOME/.local/xmd-dev/bin/xmd-dev"
```

<If condition={existing.exitCode !== 0 || existing.stdout !== source.stdout}>
<Let as="refusal">

Could not install {installedPath}. Move a conflicting command aside before
retrying.

</Let>
<Fail message={refusal.trim() + " " + install.stderr.trim()} />
</If>

</If>

```sh exec as="selected"
command -v xmd-dev
```

<Output>

<If condition={install.exitCode === 0}>

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
