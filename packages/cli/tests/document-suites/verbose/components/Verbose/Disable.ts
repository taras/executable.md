/**
 * `<Verbose.Disable>` — a test fixture that turns verbosity off for its
 * content.
 *
 * The counterpart to `<Verbose.Enable>`: it proves that a nearer false value
 * skips a `<Verbose>` body under a `--verbose` run, and that the enclosing
 * value is what the sibling after it reads. It is not part of any production
 * profile, and the rows that use it select this directory with `--include`.
 */

import { Config, content } from "@executablemd/core";
import type { Operation } from "effection";

export default function* Disable(): Operation<string> {
  yield* Config.around({ verbose: () => false }, { at: "min" });
  return yield* content();
}
