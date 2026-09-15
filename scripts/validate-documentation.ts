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
 * XMD bundles no Plugin, so the selection is explicit here too. This script is
 * a build tool rather than the product, which is why it may name the package
 * that ships the graph; nothing in the CLI does.
 */

import { main, scoped } from "effection";
import type { Operation } from "effection";
import { capturedDocumentation, documentationIndexFor } from "@executablemd/core";
import type { ComponentOrigin, DocumentationIndex } from "@executablemd/core";
import { useCommandComponents } from "../packages/cli/src/syntax.ts";
import { installPlugins } from "../packages/cli/src/plugin-host.ts";
import reviewPlugin from "../packages/code-review-agent/mod.ts";

/** Assemble the complete index, throwing whatever it refuses with. */
export function* validateDocumentation(): Operation<number> {
  // Inside the bootstrap scope, because a contribution belongs to the scope
  // that installed it: collecting outside would find core's terminal alone and
  // pass every rule vacuously.
  const index = yield* scoped(function* () {
    // The first-party Plugin, installed exactly as `--plugin` installs one: a
    // Plugin's registrations and the documentation describing them arrive
    // together, so a build that shipped one without the other fails here.
    yield* installPlugins([reviewPlugin], { command: "run", args: [] });
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
  // And one from the selected Plugin, so an index assembled without it cannot
  // pass this check either.
  read(index, "ReviewContext", {
    kind: "registered",
    origin: "@executablemd/code-review-agent",
    reserved: true,
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
