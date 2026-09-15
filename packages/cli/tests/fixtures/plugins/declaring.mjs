// Declares one exact Markdown component. The bytes, their origin and their
// digest are what the host states about them, exactly as a bundled Plugin
// states its own — a Plugin is trusted code, and this is the same boundary.
import { Markdown, Plugin, sourceDigest } from "@executablemd/core/api";

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
