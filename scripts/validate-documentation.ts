/**
 * Build the complete first-party documentation index, or refuse.
 *
 * The one entrypoint every distribution passes through before it is produced.
 * Copying the Markdown assets is not the same as validating them: a build that
 * only copied would happily ship a package whose documentation had drifted from
 * the components it documents, and the first person to notice would be an
 * author whose `<Syntax names={…}>` refused at run time.
 *
 * So the check is the real assembly. It selects the first-party Plugin the way
 * an operator does, enters the same declarative bootstraps, collects through the
 * same Api, and builds the same index — which means a missing section, an
 * unknown heading and a component documented twice each fail the build for
 * exactly the reason they would fail a run.
 *
 * XMD bundles one Plugin — `@executablemd/git` — so this assembles the run
 * profile a command gets with no `--plugin`: the bundled value. A distribution
 * carries it, which makes its documentation this gate's business.
 */

import { main, scoped } from "effection";
import type { Operation } from "effection";
import { capturedDocumentation, documentationIndexFor } from "@executablemd/core";
import type { ComponentOrigin, DocumentationIndex } from "@executablemd/core";
import { useCommandComponents } from "../packages/cli/src/syntax.ts";
import { BUNDLED_PLUGIN } from "../packages/cli/src/run-profile.ts";
import { installPlugins } from "../packages/cli/src/plugin-host.ts";

/** Assemble the complete index, throwing whatever it refuses with. */
export function* validateDocumentation(): Operation<number> {
  // Inside the bootstrap scope, because a contribution belongs to the scope
  // that installed it: collecting outside would find core's terminal alone and
  // pass every rule vacuously.
  const index = yield* scoped(function* () {
    // The run profile as a command assembles it, with the bundled Git Plugin
    // installed exactly as a Plugin is. Its registrations and the
    // documentation describing them arrive together, so a build that shipped
    // one without the other fails here.
    yield* installPlugins([BUNDLED_PLUGIN], { command: "run", args: ["run"] });
    yield* useCommandComponents();
    return documentationIndexFor(yield* capturedDocumentation());
  });
  // Read two entries back, one from each side of the terminal, so a build
  // cannot pass by assembling an index that holds nothing: an empty set
  // satisfies every rule above vacuously, and an index holding core's
  // contribution alone would satisfy them for a profile that bootstrapped no
  // package at all.
  read(index, "Syntax", { kind: "protected", origin: "@executablemd/core" });
  read(index, "WebForm", {
    kind: "registered",
    origin: "@executablemd/web",
    reserved: false,
  });
  // And one from the bundled Plugin, so an index assembled without it cannot
  // pass this check either.
  read(index, "Repository", {
    kind: "registered",
    origin: "@executablemd/workflow/composition",
    reserved: false,
  });
  return 1;
}

/** One entry the index must actually hold, read the way a document reads it. */
function read(index: DocumentationIndex, name: string, origin: ComponentOrigin): void {
  const sample = index.documentationFor(name, origin);
  if (sample === undefined || sample.length === 0) {
    throw new Error(
      `the documentation index built without <${name}>'s documentation, so it is not the ` +
        "index this product ships",
    );
  }
}

if (import.meta.main) {
  await main(function* () {
    const boundaries = yield* validateDocumentation();
    console.error(`component documentation: complete across ${boundaries} profile`);
  });
}
