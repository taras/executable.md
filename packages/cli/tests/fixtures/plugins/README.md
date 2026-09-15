# Plugin fixtures

Selected Plugins, written as portable ESM JavaScript.

`.mjs` rather than `.ts` because these modules are loaded by a running `xmd` —
from source under Deno, from the emitted npm package under Node, and from a
compiled binary with no checkout at all. Arbitrary TypeScript modules are not
something all three can import, and the point of these fixtures is what every
product can load.

`external.mjs` imports nothing, so it is the one every product loads without
resolving anything. The rest import `@executablemd/core/api` — or, for the
declarations a *host* states, `@executablemd/core/host` — and therefore resolve
through this checkout's own workspace. A compiled binary loading one of those is
the loaded-copy case on purpose: the binary carries its own copy of core and the
fixture resolves the checkout's, and they compose because the Api key is stable.

`impostor.mjs` is the other half of that claim. It builds an Api under the bare
public name `Document` rather than the key canonical core publishes, and proves
it addresses a different context: the document it would have replaced comes out
unwrapped.

`structural.mjs` declares structural syntax and no Markdown component at all. It
is what proves the retained catalog carries both arms: its construct has to be
describable by `xmd syntax` and acceptable to Plan validation, not only
expandable by a run.
