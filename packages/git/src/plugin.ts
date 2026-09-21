/**
 * The Git Plugin: what writing `<Repository>` in a document means.
 *
 * Installing it declares vocabulary and admits history, and does nothing else.
 * The Repository, Worktree, Dir, Git, PullRequest, IssueTracker and Issue
 * components become ordinary defaults for the command, exactly as they were
 * when this package was part of `@executablemd/workflow` — same names, same
 * order, same props, same documentation and the same durable origins. A
 * repository-local component of one of those names is still chosen ahead of
 * them.
 *
 * What installing does *not* do is reach a repository. No ambient checkout is
 * discovered, no managed directory is created, no `git` runs, no credential is
 * read and no request is made. Those belong to the first operation that
 * actually needs repository state, which is why `xmd syntax` and `<Plan>` can
 * describe this vocabulary without touching a machine's repositories at all.
 *
 * ## One Plugin value, one execution's identities
 *
 * The admissions this returns are what let a replay recognize the Git-host and
 * Issue records it inherited. They are admissions rather than anything
 * installed alongside them because canonical core applies an admission inside
 * each execution's own journal read: a host that installs this Plugin once and
 * runs two documents gets two journal reads, so each execution derives its
 * identities from its own retained history and neither can read the other's.
 */

import type { Operation } from "effection";
import { Plugin } from "@executablemd/core/api";
import type { PluginInstallRequest, PluginInstallation } from "@executablemd/core/api";
import { useCompositionComponents } from "./composition/installation.ts";
import { gitHostIdentityAdmission, issueIdentityAdmission } from "./identities.ts";

/**
 * The commands that execute a document, or describe what one could write.
 *
 * `workflow` is not one of them on its own: most of that command reads and
 * manages runs without executing anything, and declaring a vocabulary into
 * `xmd workflow list` would advertise components nothing there can expand.
 * Which workflow *action* was asked for decides it, and
 * {@link executesDocument} is what reads that off the argv.
 */
const DOCUMENT_COMMANDS: ReadonlySet<string> = new Set(["run", "plan", "syntax"]);

/** The workflow actions that execute a document. */
const EXECUTING_ACTIONS: ReadonlySet<string> = new Set(["start", "resume", "fork"]);

/**
 * The workflow options whose value is the token after them.
 *
 * The same list the review Plugin's own scan carries, for the same reason and
 * written out for the same reason: it is every non-boolean field of the
 * command's grammar (`workflowConfig` in `packages/cli/src/workflow.ts`) plus
 * the aggregate and generated root properties, which are read out of argv
 * before that grammar exists. The boolean switches take no value and are
 * skipped as the options they are. `--plugin` is not here: the host has already
 * taken it out of the argv this scans.
 *
 * It is written out here rather than read from the command because the CLI
 * depends on this package and not the other way round. What makes the omission
 * of one visible is the rule it breaks: `xmd workflow --output start export
 * run-1` exports a run, and a scan that read `start` as the action would have
 * declared this vocabulary for a command that executes no document.
 */
const VALUED_OPTIONS: ReadonlySet<string> = new Set([
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
  // An assigned spelling carries its own value and is one token. Checked first
  // because `--props-name=alice` matches the generated-property prefix, and
  // stepping over the word after it would skip the action.
  if (token.includes("=")) {
    return false;
  }
  return (
    VALUED_OPTIONS.has(token) ||
    token === PROPERTY_OPTION ||
    token.startsWith(`${PROPERTY_OPTION}-`)
  );
}

/** The pre-command grammar, which is read before any other scanner. */
const PLUGIN_OPTION = "--plugin";
const PLUGIN_ASSIGNMENT = `${PLUGIN_OPTION}=`;

/**
 * The argv with the Plugin selection removed, as the host reads it.
 *
 * `--plugin` is answered before every other scanner, so the command token is
 * the first token *left* once those are gone — not the first token that happens
 * to spell a command. `xmd --plugin workflow workflow start flow.md` selects a
 * module named `workflow` and then runs `workflow start`, and searching the raw
 * argv for the word would find the specifier and read the command as the
 * action.
 *
 * The same scan the host performs (`selectPlugins` in
 * `packages/cli/src/plugin-selection.ts`), written out here rather than
 * imported because the CLI depends on this package and not the other way round.
 * It stops at `--` for the same reason: every token after the separator keeps
 * the meaning the caller gave it.
 */
function withoutPluginSelection(args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (arg === PLUGIN_OPTION) {
      const value = args[index + 1];
      // A missing value, and a value that reads as another option, are what the
      // host refuses the whole command line for. Nothing is selected, nothing
      // is installed, and there is no command here to declare for.
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        return [];
      }
      index += 1;
      continue;
    }
    if (arg.startsWith(PLUGIN_ASSIGNMENT)) {
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

/**
 * Whether this workflow command line executes a document.
 *
 * The action is the first positional after the command: the first token that is
 * neither an option nor an option's value. Everything after `--` is positional
 * by definition and is not scanned for one, and a token this command defines no
 * action for is not one — a malformed command line executes no document either
 * way, and the command itself is what says so.
 */
function executesDocument(args: readonly string[]): boolean {
  const [command, ...tokens] = withoutPluginSelection(args);
  if (command !== "workflow") {
    return false;
  }
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

/** Whether this command's profile is one this vocabulary belongs to. */
export function declaresFor(request: PluginInstallRequest): boolean {
  if (DOCUMENT_COMMANDS.has(request.command)) {
    return true;
  }
  return request.command === "workflow" && executesDocument(request.args);
}

export const gitPlugin: Plugin = Plugin({
  name: "@executablemd/git",
  *install(request: PluginInstallRequest): Operation<PluginInstallation | undefined> {
    if (!declaresFor(request)) {
      return undefined;
    }
    // Declarations only. Every one of these is a name and a description; the
    // provider that performs what they name is attached by the host, lazily,
    // when a run actually has a Workspace to perform it in.
    yield* useCompositionComponents();
    return { admissions: [gitHostIdentityAdmission(), issueIdentityAdmission()] };
  },
});

export default gitPlugin;
