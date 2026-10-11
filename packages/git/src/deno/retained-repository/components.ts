/**
 * Every Git-owned component this entry records the work of.
 *
 * Each one is the ordinary component's shape with this entry's own durable
 * boundary around the live work: claim the occurrence, find the selection the
 * element is standing in, then record one ordinary operation. The operations
 * themselves are the ordinary live performers — `liveSwitch`, `liveAdd`,
 * `liveCommit` — because a REPL entry does the same Git work an ordinary run
 * does. What it adds is that a completed one replays its result instead of
 * running again.
 *
 * Nothing here predicts. A commit's identity, time and object id are whatever
 * the commit that happens produces; a staged index is whatever staging leaves.
 * That is what makes the recorded result a report rather than a promise.
 */

import { Ok } from "effection";
import type { Operation, Result } from "effection";
import { findDurabilityFailure } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { API, cwd } from "@executablemd/runtime";
import { content } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { parseFilesFailure } from "@executablemd/runtime";
import { DirInvocationError, props as dirProps, reason } from "../../composition/components/Dir.ts";
import { canonicalPaths, props as addProps } from "../../composition/components/GitAdd.ts";
import {
  admitCommitMessage,
  composeCommitMessage,
  props as commitProps,
  returns as commitReturns,
} from "../../composition/components/GitCommit.ts";
import { props as switchProps } from "../../composition/components/GitSwitch.ts";
import { GitOperationError } from "../../composition/errors.ts";
import { captureCommitIdentity, denoIdentityReader } from "../run-composition/identity.ts";
import { liveAdd, liveCheckout, liveCommit, liveSwitch } from "../run-composition/operations.ts";
import { detachedJson } from "../../retained-repository/records.ts";
import { recorded } from "./local.ts";
import { retainedDirectoryEnsure } from "./files.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";
import { routeDirectory } from "./terminal.ts";

/** Where these components report themselves as coming from. */
export const RETAINED_ORIGIN = "@executablemd/git/retained";

/** Every Git-owned component this entry records the work of. */
export function retainedGitComponents(host: RetainedFileHost): readonly IdentityComponent[] {
  return Object.freeze([
    retainedDir(host),
    retainedAdd(host),
    retainedCommit(host),
    retainedSwitch(host),
  ]);
}

/**
 * `<Dir>`, with the directory it makes retained.
 *
 * The order is the one the ordinary component keeps, with authentication where
 * the contract puts it: the occurrence is claimed in this invocation's own
 * frame, before the ensure and before anything subordinate runs. The directory
 * exists before its content expands, because content that ran in a directory
 * the ensure was going to refuse would be content run somewhere nobody chose.
 */
function retainedDir(host: RetainedFileHost): IdentityComponent {
  return {
    name: "Dir",
    origin: RETAINED_ORIGIN,
    props: dirProps,
    forms: ["paired"],
    description:
      "Create or use a directory. `<Dir path={worktree}>…</Dir>` changes the working " +
      "directory for its content.",
    factory: (claim: IdentityClaimant) =>
      function* Dir(props, invocation): Operation<string> {
        const path = props.path;
        if (typeof path !== "string" || path === "") {
          throw new DirInvocationError("<Dir> needs a non-empty path.");
        }
        const enclosing = yield* cwd();
        const target = path.startsWith("/")
          ? path
          : `${enclosing.endsWith("/") ? enclosing.slice(0, -1) : enclosing}/${path}`;

        const occurrence = yield* claim(invocation);
        const made = yield* routeDirectory({ cwd: enclosing, path }, (final) =>
          retainedDirectoryEnsure(host, occurrence, final),
        );
        if (!made.ok) {
          // A durability failure keeps its own class. Describing it as a
          // directory this document could not use would be describing it as
          // something the document may be shown and carry on past, and what it
          // reports is that this entry's history no longer matches the disk.
          const fatal = findDurabilityFailure(made.error);
          if (fatal !== undefined) {
            throw fatal;
          }
          const failure = parseFilesFailure(made.error);
          throw new DirInvocationError(
            `<Dir path=${JSON.stringify(path)}> could not be used: ${
              failure === undefined ? "the directory operation failed" : reason(failure.reason)
            }`,
          );
        }

        yield* API.Env.around(
          {
            // deno-lint-ignore require-yield
            *cwd(): Operation<string> {
              return target;
            },
          },
          { at: "min" },
        );
        // A nested `<File>` authenticates its own occurrence. This one lends it
        // nothing: the directory is made, and what runs inside is its own work.
        return yield* content();
      },
  };
}

/**
 * `Git.Add`, with what staging produced recorded.
 *
 * The live add is the ordinary one, and what it returns is the ordinary
 * result: which paths were named, and the branch, commit and trees the checkout
 * was on either side of it. A completed add replays that and stages nothing,
 * however the working tree has changed since.
 */
function retainedAdd(host: RetainedFileHost): IdentityComponent {
  return {
    name: "Git.Add",
    origin: RETAINED_ORIGIN,
    props: addProps,
    forms: ["self-closing"],
    description: 'Stage changes. `<Git.Add paths="notes.md" />` stages what the pathspec matches.',
    factory: (claim: IdentityClaimant) =>
      function* GitAdd(props, invocation): Operation<string> {
        const paths = canonicalPaths(props.paths);
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* selection(host, directory, "Git.Add", "stage anything in");
        const produced = yield* recorded({
          owner: host.owner,
          site: host.site(occurrence),
          operation: "add",
          request: { cwd: directory, paths: [...paths] },
          *perform(): Operation<Result<Json>> {
            return Ok(yield* journaled(yield* liveAdd(checkoutIn(selected, directory), paths)));
          },
        });
        if (!produced.ok) {
          throw produced.error;
        }
        return "";
      },
  };
}

/**
 * `Git.Switch`, with the branch it left the checkout on recorded.
 *
 * The ordinary live switch, which creates a missing branch at the base the
 * document named and reports which branch and base it resolved to.
 */
function retainedSwitch(host: RetainedFileHost): IdentityComponent {
  return {
    name: "Git.Switch",
    origin: RETAINED_ORIGIN,
    props: switchProps,
    forms: ["self-closing"],
    description:
      'Switch or create a branch. `<Git.Switch branch="release/1.4" base="main" />` starts a ' +
      "missing branch at the specified base.",
    factory: (claim: IdentityClaimant) =>
      function* GitSwitch(props, invocation): Operation<string> {
        const branch = props.branch;
        if (typeof branch !== "string" || branch === "") {
          throw new GitOperationError(
            "Git.Switch",
            "invalid-branch",
            "<Git.Switch> needs a non-empty branch.",
          );
        }
        const base = typeof props.base === "string" && props.base !== "" ? props.base : undefined;
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* selection(host, directory, "Git.Switch", "switch a branch in");
        const produced = yield* recorded({
          owner: host.owner,
          site: host.site(occurrence),
          operation: "switch",
          request:
            base === undefined ? { cwd: directory, branch } : { cwd: directory, branch, base },
          *perform(): Operation<Result<Json>> {
            return Ok(
              yield* journaled(yield* liveSwitch(checkoutIn(selected, directory), branch, base)),
            );
          },
        });
        if (!produced.ok) {
          throw produced.error;
        }
        return "";
      },
  };
}

/**
 * `Git.Commit`, with the commit it wrote recorded.
 *
 * The message is composed once, from what the document wrote, and is the
 * authored request this operation is named by. Everything else — the parent,
 * the tree, the commit id, the time — is whatever the ordinary live commit
 * produced. A completed commit replays that result and writes no object.
 */
function retainedCommit(host: RetainedFileHost): IdentityComponent {
  return {
    name: "Git.Commit",
    origin: RETAINED_ORIGIN,
    props: commitProps,
    returns: commitReturns,
    description:
      "Commit what is staged. `<Git.Commit message={summary} />` writes one commit in the " +
      "selected checkout.",
    factory: (claim: IdentityClaimant) =>
      function* GitCommit(props, invocation): Operation<string> {
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* selection(host, directory, "Git.Commit", "commit in");
        const composed = composeCommitMessage(
          typeof props.message === "string" ? props.message : undefined,
          invocation.hasContent() ? yield* content() : "",
        );
        const message = admitCommitMessage(composed.message);

        const produced = yield* recorded({
          owner: host.owner,
          site: host.site(occurrence),
          operation: "commit",
          request: { cwd: directory, message },
          *perform(): Operation<Result<Json>> {
            // Read here, because this is the operation that needs it: an entry
            // that commits nothing asks the host nothing about who it is.
            // Whatever the commit records is what this result reports.
            const identity = yield* captureCommitIdentity(denoIdentityReader(selected.directory));
            return Ok(
              yield* journaled(
                yield* liveCommit(
                  checkoutIn(selected, directory),
                  message,
                  composed.source,
                  identity,
                ),
              ),
            );
          },
        });
        if (!produced.ok) {
          throw produced.error;
        }
        const commit = produced.value;
        return typeof commit === "object" && commit !== null && !Array.isArray(commit)
          ? String(Reflect.get(commit, "commit") ?? "")
          : "";
      },
  };
}

/**
 * The selection this element is standing in, or its own refusal.
 *
 * One sentence per component, because what a person needs to know is which
 * element was written outside a selection — not which internal lookup answered
 * nothing.
 */
function* selection(
  host: RetainedFileHost,
  directory: string,
  element: string,
  doing: string,
): Operation<SelectedCheckout> {
  const selected = yield* host.covering(directory);
  if (selected === undefined) {
    throw new GitOperationError(
      element,
      "invalid-invocation",
      `<${element}> is written outside a repository this entry has selected, so there is ` +
        `nothing in scope to ${doing}.`,
    );
  }
  return selected;
}

/** The ordinary live checkout these performers act on. */
function checkoutIn(selected: SelectedCheckout, workingDirectory: string) {
  return liveCheckout(selected.git, selected.registered, workingDirectory);
}

/**
 * One ordinary result, as journal data.
 *
 * Detached rather than cast: what goes into a record has to be plain JSON this
 * host built, so a performer that one day answered with something richer is
 * caught here rather than written down as whatever it happened to be.
 */
// deno-lint-ignore require-yield
function* journaled(result: unknown): Operation<Json> {
  const detached = detachedJson(result);
  if (detached === undefined) {
    throw new Error("a live Git operation answered with something this host cannot journal.");
  }
  return detached;
}
