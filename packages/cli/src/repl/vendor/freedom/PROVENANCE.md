# `@bomb.sh/freedom`, vendored

This directory holds a pinned copy of Freedom, the keyed-node library the REPL's
component tree is built on. Two copies of every source file are kept:
`upstream/` is byte-identical to the commit named below, and `patched/` is what
production imports. Nothing outside this directory imports `upstream/`; it
exists so the drift test can say exactly which bytes this repository changed and
prove that every other file did not change at all.

## Where it comes from

- Repository: <https://github.com/bombshell-dev/playground>, directory
  `packages/freedom`
- Commit: `8be97e7201cd6effddb2f8b240b4b5166641e7f0` (branch `focus-stack`)
- Files: the nine sources under `src/`, 617 lines, plus the repository `LICENSE`

`MANIFEST.json` records a SHA-256 for every file, both copies of every source,
and which named patch accounts for each difference.

## Why it is vendored rather than depended on

The package is `private: true` at version `0.0.0` and has never been published.
There is no registry release to depend on, so the only way to consume it is to
copy it — and the only honest way to copy it is to pin the exact revision and
prove, continuously, that the copy has not drifted.

## Licensing

Two facts, recorded and not reconciled:

- the upstream repository carries an MIT notice, reproduced here unchanged as
  `LICENSE`, and its root manifest declares MIT; and
- `packages/freedom`'s own `package.json` declares `"license": "ISC"`.

This repository makes no determination about which declaration controls the
copy in this directory. Nothing here should be read as choosing one, and anyone
who needs that question answered should raise it upstream.

## Effection

The package's manifest asks for `effection@4.1.0-alpha.9`. This repository is on
stable `4.1.0` and stays there: two Effection copies would mean two scope trees
and two context systems, and Freedom's central claim — that its node tree and
the Effection scope tree correspond — would be false against the host's tree.
The sources use `createContext`, `createScope`, `createSignal`, `createQueue`,
`createApi` from `effection/experimental`, and `scope.set/get/expect/around/run`,
all of which stable 4.1.0 provides. The composition suite re-proves that against
the patched copy rather than inheriting the claim.

## The two local patches

### `executablemd/caller-owned-root` — `lib/mod.ts`, `lib/node.ts`, `lib/root.ts`

Upstream offers only `createRoot()`, whose root node is
`new NodeImpl(id, "", undefined)` and whose scope is therefore parented to
Effection's `global`. Three consequences follow: the host's context never
reaches the tree, a failure in node work raises into a boundary nobody observes,
and the tree outlives whoever created it unless that caller remembers to call
`destroy()`.

The patch adds an optional owner to `NodeImpl`, threads it through
`createRoot({ scope })`, and adds `useRoot()` — an ordinary Effection operation
that parents the root to the calling scope, inherits its contexts and destroys
the tree when that scope ends. `createRoot()` remains as the explicitly unowned
escape hatch for an integration with no Effection scope to belong to.

### `executablemd/containment-aware-removal` — `lib/focus.ts`

`useFocus()`'s `remove` middleware tests identity: it moves focus to a successor
only when the *removed node* is the focused one. A drawer or a panel closes by
removing the branch **above** the focused control, so the common case left focus
on a node that was about to be destroyed while a valid sibling survived.

The patch decides by subtree containment instead. Removing either the focused
node or any ancestor of it moves focus to the first focusable node outside the
departing subtree, or clears focus when no survivor exists.

## Refreshing or removing this copy

To move to another upstream revision: replace `upstream/` from that exact
commit, re-apply both patches to `patched/`, regenerate every hash in
`MANIFEST.json`, and update the commit recorded above. The drift test fails
until all three agree.

To remove it: delete this directory, drop its entry from the repository lint and
format exclusions, and replace the imports in `packages/cli/src/repl/`. Nothing
else in the repository depends on it.
