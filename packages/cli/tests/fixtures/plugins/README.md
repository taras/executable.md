# Plugin fixtures

Selected Plugins, written as portable ESM JavaScript.

`.mjs` rather than `.ts` because these modules are loaded by a running `xmd` —
from source under Deno, from the emitted npm package under Node, and from a
compiled binary with no checkout at all. Arbitrary TypeScript modules are not
something all three can import, and the point of these fixtures is what every
product can load.

`external.mjs` imports nothing, so it is the one every product loads. The rest
import `@executablemd/core/api` and therefore resolve through this checkout's
own workspace, which is what makes them source-suite fixtures.
