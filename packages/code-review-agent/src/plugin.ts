/**
 * The review graph as a Plugin.
 *
 * `@executablemd/code-review-agent` is a library, and its default export is the
 * Plugin a distribution bundles. Nothing about the graph changes here: the same
 * thirty-five Markdown declarations, the same six reserved registrations, the
 * same origins, digests and packaged assets, read through the same boundary.
 * What changes is who assembles them — a Plugin the host installs, rather than
 * a package the CLI imports by name at four separate call sites.
 *
 * ## Which commands claim the graph
 *
 * A review is the program that must not be answerable by the repository it is
 * reviewing, so every command that can *run* a review document claims the
 * forty-one names: `xmd run`, `xmd syntax` (which describes what a run may
 * write), `xmd plan` (which validates a candidate against the profile a later
 * run supplies) and a workflow action that executes a document.
 *
 * `xmd test` claims none of them. A test document is a different profile and
 * may still supply its own component of any of these names — while the nested
 * `<Execution host="run">` child a test can launch *is* the run profile, and
 * reinstalls this Plugin with command `run`.
 */

import type { Operation } from "effection";

import { Plugin } from "@executablemd/core/api";
import type { PluginInstallRequest, PluginInstallation } from "@executablemd/core/api";

import { reviewComponentDeclarations, useReviewComponents } from "./review-components.ts";

/** The `xmd workflow` actions that execute a document, and so run a profile. */
const EXECUTING_ACTIONS: ReadonlySet<string> = new Set(["start", "resume", "fork"]);

/** Every action the workflow command defines, so an option is never read as one. */
const WORKFLOW_ACTIONS: ReadonlySet<string> = new Set([
  ...EXECUTING_ACTIONS,
  "answer",
  "status",
  "list",
  "history",
  "cancel",
  "delete",
  "export",
]);

/**
 * Whether this workflow command line executes a document.
 *
 * The action is found by name rather than by position: an option written before
 * it — `--plugin` included — is not an action, and a value that happens to look
 * like one is not either, because only the tokens after `workflow` are read and
 * only the defined action names match. A command line naming none is malformed
 * and refused by the command itself; it executes no document either way.
 */
function executesDocument(args: readonly string[]): boolean {
  const start = args.indexOf("workflow");
  if (start === -1) {
    return false;
  }
  for (const token of args.slice(start + 1)) {
    if (WORKFLOW_ACTIONS.has(token)) {
      return EXECUTING_ACTIONS.has(token);
    }
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
