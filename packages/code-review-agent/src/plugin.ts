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

/**
 * Every `xmd workflow` option that takes a separated value.
 *
 * A value is not an action however much it reads like one, so the scan below
 * steps over the token after each of these. The list is every non-boolean field
 * of the command's own grammar (`workflowConfig` in
 * `packages/cli/src/workflow.ts`) plus the two options read out of argv before
 * that grammar exists: `--plugin`, and the aggregate and generated root
 * properties. The boolean switches — `--verbose`/`-V`, `--raw`,
 * `--secret-detection`, `--no-secret-detection`, `--json`, `--forkable` — take
 * no value and are skipped as the options they are.
 *
 * It has to be written out here rather than read from the command, because the
 * CLI depends on this package and not the other way round. What makes the
 * omission of one visible is the rule it breaks: `xmd workflow --output start
 * export run-1` exports a run, and a scan that read `start` as the action would
 * have installed the review graph for a command that executes no document.
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
 * Whether this workflow command line executes a document.
 *
 * The action is the first positional after `workflow`: the first token that is
 * neither an option nor an option's value. Everything after `--` is positional
 * by definition and is not scanned for one, and a token this command defines no
 * action for is not one — a malformed command line executes no document either
 * way, and the command itself is what says so.
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
