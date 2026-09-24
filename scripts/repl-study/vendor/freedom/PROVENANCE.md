# @bomb.sh/freedom, vendored

`@bomb.sh/freedom` is `private: true`, version `0.0.0`, and unpublished, so it
cannot be installed. Its source is vendored here from the public playground
repository at the commit `MANIFEST.json` pins.

```text
https://github.com/bombshell-dev/playground
8be97e7201cd6effddb2f8b240b4b5166641e7f0   (branch focus-stack)
packages/freedom
```

## It runs on this repository's Effection

Freedom's own manifest asks for `effection@4.1.0-alpha.9`; this repository pins
`4.1.0`. That mattered more than a version number usually does — two Effection
copies would mean two scope trees and two context systems, and Freedom's
central claim, that its node tree and the Effection scope tree correspond,
would have been false against *our* tree.

The sources run on `4.1.0` unmodified. The surface they use is
`createContext`, `createScope`, `createSignal`, `createQueue`, `createApi` from
`effection/experimental`, and `scope.set/get/expect/around/run` — all present
and unchanged. Nothing about the dependency layout moves for this experiment:
no lockfile entry, no second Effection.

## Two patches, and why they are here rather than upstream

Both are recorded in `MANIFEST.json` and reported upstream. They are behaviour
changes to a dependency, taken deliberately.

**`owned-root`.** `createRoot()` parents the root scope to Effection `global`.
A globally-parented root means host context does not reach the tree, a failure
in node work raises into a boundary nobody observes, and the caller owns the
tree only by remembering to destroy it. `useRoot()` acquires the tree as a
resource owned by the acquiring scope, which makes all three structural. This
is the fix this repository's earlier Freedom evaluation identified and settled
on; the pinned branch carries the focus work but not that fix.

**`containment-removal`.** `useFocus()` installs a `remove` middleware that
moves focus to a successor first, but it asked whether the *removed node* was
the focused one. A drawer or a panel is closed by removing the branch above the
focused control, so the common case fell through: focus was left on a node that
had just been destroyed, while a perfectly good sibling survived.

```text
before   removing the focused node   → focus moves to the survivor
before   removing its branch         → focus left on nothing
after    removing its branch         → focus moves to the survivor
```

The predicate now asks whether the branch contains the focused node.

## How it is held still

`MANIFEST.json` records the upstream commit, both patches with their reasons,
and a SHA-256 for every vendored file; `scripts/tests/repl-focus.test.ts`
checks the bytes against it, so an unrecorded edit fails.

The snapshot is excluded from `oxfmt` (`.oxfmtrc.json`) and from `oxlint`
(`.oxlintrc.json`) for the same reason the acpx and Cloudflare DOFS snapshots
are: reformatting upstream's bytes would break the identity the manifest holds
them to. The exclusion is deliberately **not** on the lint task's command line
in `package.json` — editing that manifest invalidates `deno.lock`, and the
build and publication suites that run `deno install --frozen` fail on it.

## What is not vendored

`@bomb.sh/input` pins `@bomb.sh/tty ^0.8.0`, and this repository pins `0.9.0`
exactly under a repository-wide frozen lockfile. The part this experiment needs
is its targeting rule — dispatch a key to the focused node's scope, so the
node's ancestors form the middleware path — which is implemented directly in
`scripts/repl-study/keys.ts`. `packages/input/src/lib/input.ts` at the pinned
commit is the reference it follows.
