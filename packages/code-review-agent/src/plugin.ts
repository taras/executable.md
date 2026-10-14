/**
 * Install the packaged review graph when an operator selects this Plugin.
 *
 * Run, syntax, plan and executing workflow actions reserve its thirty-five
 * Markdown declarations and six reserved registrations, so the repository being
 * reviewed cannot replace the review program. Root `xmd test` reserves none;
 * its isolated `<Execution host="run">` child reinstalls this Plugin with
 * command `run`.
 */

import type { Operation } from "effection";

import { Plugin } from "@executablemd/core/api";
import type { PluginInstallRequest, PluginInstallation } from "@executablemd/core/api";

import { reviewComponentDeclarations, useReviewComponents } from "./review-components.ts";

/** The `xmd workflow` actions that execute a document, and so run a profile. */
const EXECUTING_ACTIONS: ReadonlySet<string> = new Set(["start", "resume", "fork"]);

/**
 * Workflow options whose separated values must not be mistaken for actions.
 * Keep this aligned with `workflowConfig` in `packages/cli/src/workflow.ts` and
 * argv-level Plugin/root-property options; the CLI dependency prevents
 * importing its grammar here. For example, `workflow --output start export
 * run-1` exports and must not install the review graph because the output value
 * reads `start`.
 */
const VALUED_OPTIONS: ReadonlySet<string> = new Set([
  "--plugin",
  "--id",
  "--at",
  "--status",
  "--artifact",
  "--output",
]);

/** The generated root-property options, which take a separated value too. */
const PROPERTY_OPTION = "--props";

/** Whether this token is an option that takes the token after it. */
function takesValue(token: string): boolean {
  return (
    VALUED_OPTIONS.has(token) ||
    token === PROPERTY_OPTION ||
    token.startsWith(`${PROPERTY_OPTION}-`)
  );
}

/**
 * Read the first positional after `workflow`, skipping options and their
 * values. Stop at `--`; unknown actions remain the command's own grammar error
 * and install no review graph.
 */
function executesDocument(args: readonly string[]): boolean {
  const start = args.indexOf("workflow");
  if (start === -1) {
    return false;
  }
  const tokens = args.slice(start + 1);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined || token === "--") {
      return false;
    }
    if (takesValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return EXECUTING_ACTIONS.has(token);
  }
  return false;
}

/** Whether the review graph belongs to this command. */
function claimsGraph(request: PluginInstallRequest): boolean {
  switch (request.command) {
    case "run":
    case "plan":
    case "syntax":
      return true;
    case "workflow":
      return executesDocument(request.args);
    default:
      return false;
  }
}

/**
 * Written as a named, explicitly typed value rather than as a default export
 * expression, because a package publishing to JSR states the type of what it
 * exports rather than leaving it to be inferred.
 */
const reviewPlugin: Plugin = Plugin({
  name: "@executablemd/code-review-agent",
  *install(request: PluginInstallRequest): Operation<PluginInstallation | undefined> {
    if (!claimsGraph(request)) {
      return undefined;
    }
    // The six reserved registrations and the documentation describing them, in
    // the scope the command runs in. Declarative only: nothing here installs a
    // provider, spawns a process, reads a credential or reaches the network.
    yield* useReviewComponents();
    // The thirty-five Markdown declarations travel by value, read from this
    // build's own assets, exactly as they always have.
    return { components: yield* reviewComponentDeclarations() };
  },
});

export default reviewPlugin;
