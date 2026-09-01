/**
 * `<Verbose.Enable>` — a test fixture that turns verbosity on for its content.
 *
 * It exists so a Markdown row can establish a lexical verbosity boundary the
 * way any authorized component may, and prove that `<Verbose>` reads the
 * nearest value rather than the flag the command line resolved. It is not part
 * of any production profile, and the rows that use it select this directory
 * with `--include`.
 *
 * The installation is made in this frame rather than inside a nested scope,
 * because `content()` anchors to the invocation: a handler installed further in
 * would be invisible to the very body it is here to configure.
 */

import { Config, content } from "@executablemd/core";
import type { Operation } from "effection";

export default function* Enable(): Operation<string> {
  yield* Config.around({ verbose: () => true }, { at: "min" });
  return yield* content();
}
