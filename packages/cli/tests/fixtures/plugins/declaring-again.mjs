// A second Plugin claiming one of the same component names. Two declarations
// of one name are refused at admission, by the engine, rather than settled by
// which Plugin was selected first.
import { Plugin } from "@executablemd/core/api";
import { Markdown, sourceDigest } from "@executablemd/core/host";

const GREETING = "a second claim on the same name\n";

export default Plugin({
  name: "declaring-again",
  // deno-lint-ignore require-yield
  *install() {
    return {
      components: [
        Markdown({
          name: "Greeting",
          origin: "fixture/declaring-again/Greeting.md",
          source: GREETING,
          digest: sourceDigest(GREETING),
        }),
      ],
    };
  },
});
