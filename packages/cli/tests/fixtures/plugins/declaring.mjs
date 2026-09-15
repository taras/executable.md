// Declares one exact Markdown component. The bytes, their origin and their
// digest are what the host states about them, exactly as a bundled Plugin
// states its own — a Plugin is trusted code, and this is the same boundary.
import { Plugin } from "@executablemd/core/api";
// A declaration is what a *host* states about bytes it ships, so its
// constructors live on the host boundary rather than on the consumer API.
import { Markdown, sourceDigest } from "@executablemd/core/host";

const GREETING = "hello from the selected Plugin\n";
const SHADOWED = "the selected declaration, not the checkout's\n";

export default Plugin({
  name: "declaring",
  // deno-lint-ignore require-yield
  *install() {
    return {
      components: [
        Markdown({
          name: "Greeting",
          origin: "fixture/declaring/Greeting.md",
          source: GREETING,
          digest: sourceDigest(GREETING),
        }),
        Markdown({
          name: "Shadowed",
          origin: "fixture/declaring/Shadowed.md",
          source: SHADOWED,
          digest: sourceDigest(SHADOWED),
        }),
      ],
    };
  },
});
