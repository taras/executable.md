// Declares exact Markdown components and reserves one registration. The bytes,
// their origin and their digest are what the host states about them, exactly as
// any selected Plugin states its own — a Plugin is trusted code, and this is the
// same boundary.
import { registerComponents } from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
// A declaration is what a *host* states about bytes it ships, so its
// constructors live on the host boundary rather than on the consumer API.
import { Markdown, sourceDigest } from "@executablemd/core/host";

const GREETING = "hello from the selected Plugin\n";
const SHADOWED = "the selected declaration, not the checkout's\n";

export default Plugin({
  name: "declaring",
  *install() {
    // The registered tier beside the declared one: a reserved name a
    // checkout's same-named file cannot replace either.
    yield* registerComponents([
      {
        name: "Stamp",
        origin: "fixture/declaring",
        reserved: true,
        props: { type: "object", properties: {}, additionalProperties: false },
        description: "Mark the output as the selected Plugin's.",
        // deno-lint-ignore require-yield
        *fn() {
          return "stamped by the selected Plugin";
        },
      },
    ]);
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
