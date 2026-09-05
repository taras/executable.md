/**
 * Build the complete first-party documentation index, or refuse.
 *
 * The one entrypoint every distribution passes through before it is produced.
 * Copying the Markdown assets is not the same as validating them: a build that
 * only copied would happily ship a package whose documentation had drifted from
 * the components it documents, and the first person to notice would be an
 * author whose `<Syntax names={…}>` refused at run time.
 *
 * So the check is the real assembly. It reads the same contributions the `run`
 * profile installs, through the same loader, and builds the same index — which
 * means a missing section, an unknown heading and a component documented twice
 * each fail the build for exactly the reason they would fail a run.
 */

import { main } from "effection";
import type { Operation } from "effection";
import { documentationIndexFor } from "@executablemd/core";
import { runProfileDocumentation } from "../packages/cli/src/syntax.ts";

/** Assemble the complete index, throwing whatever it refuses with. */
export function* validateDocumentation(): Operation<number> {
  const index = yield* documentationIndexFor(yield* runProfileDocumentation());
  // Read one entry back, so a build cannot pass by assembling an index that
  // holds nothing: an empty set satisfies every rule above vacuously.
  const sample = index.documentationFor("Syntax", {
    kind: "protected",
    origin: "@executablemd/core",
  });
  if (sample === undefined || sample.length === 0) {
    throw new Error(
      "the documentation index built without <Syntax>'s own documentation, so it is not the " +
        "index this product ships",
    );
  }
  return 1;
}

if (import.meta.main) {
  await main(function* () {
    const boundaries = yield* validateDocumentation();
    console.error(`component documentation: complete across ${boundaries} profile`);
  });
}
