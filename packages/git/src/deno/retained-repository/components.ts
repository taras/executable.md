/**
 * The Git-owned components a retained entry answers with.
 *
 * Each one is declared to the execution as an identity component, so canonical
 * core mints it a domain and hands the implementation a claimant that answers
 * only for invocations of that component in this execution. The body
 * authenticates its own invocation once, in its own frame, and keeps the
 * occurrence in the closure that routes the operation — never in a context,
 * never on a request, and never anywhere a second invocation could reach it.
 *
 * What a document writes does not change. The names, props, forms and results
 * are the ordinary ones; what is different is that the operation behind them is
 * retained, so an entry that is interrupted knows what it had already done.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { API, cwd } from "@executablemd/runtime";
import { content } from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import { parseFilesFailure } from "@executablemd/runtime";
import {
  DirInvocationError,
  props as dirProps,
  reason,
} from "../../composition/components/Dir.ts";
import { canonicalPaths, props as addProps } from "../../composition/components/GitAdd.ts";
import { GitOperationError } from "../../composition/errors.ts";
import { inventoryFrontier } from "./frontier.ts";
import { retain } from "./local.ts";
import { retainedDirectoryEnsure } from "./files.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";
import type { RetainedFrontier } from "../../retained-repository/records.ts";
import { routeDirectory } from "./terminal.ts";
import { retainedCommit } from "./commit.ts";
import type { RepositoryHost } from "../composition/host.ts";

/** Where these components report themselves as coming from. */
export const RETAINED_ORIGIN = "@executablemd/git/retained";

/** Every Git-owned component this entry retains the work of. */
export function retainedGitComponents(
  host: RetainedFileHost,
  repository: RepositoryHost,
): readonly IdentityComponent[] {
  return Object.freeze([retainedDir(host), retainedAdd(host), retainedCommit(host, repository)]);
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
 * `Git.Add`, with the staging it does retained.
 *
 * The prediction needs Git but changes nothing: `--dry-run` says exactly which
 * paths this pathspec would stage, and `hash-object` without `-w` computes the
 * object each one would become without writing it. So the semantic index is
 * predicted from read-only commands, and the real add is then checked against
 * it. Partial staging followed by a refusal is therefore not an unchanged
 * state — it is a state the prediction did not describe.
 */
function retainedAdd(host: RetainedFileHost): IdentityComponent {
  return {
    name: "Git.Add",
    origin: RETAINED_ORIGIN,
    props: addProps,
    forms: ["self-closing"],
    description:
      "Stage changes. `<Git.Add paths=\"notes.md\" />` stages what the pathspec matches.",
    factory: (claim: IdentityClaimant) =>
      function* GitAdd(props, invocation): Operation<string> {
        const paths = canonicalPaths(props.paths);
        const directory = yield* cwd();
        const occurrence = yield* claim(invocation);
        const selected = yield* host.covering(directory);
        if (selected === undefined) {
          throw new GitOperationError(
            "Git.Add",
            "invalid-invocation",
            "<Git.Add> is written outside a repository this entry has selected, so there is " +
              "nothing in scope to stage anything in.",
          );
        }
        const produced = yield* retain(
          {
            owner: host.owner,
            site: host.site(occurrence),
            operation: "add",
            checkout: selected.checkout,
            common: selected.common,
            position: host.position(selected.common),
            selection: { checkout: selected.checkout },
            request: { cwd: directory, paths: [...paths] },
            inventory: () => inventory(selected),
            *prepare(preState) {
              const staged = yield* stagedBy(selected, directory, paths);
              if (!staged.ok) {
                return staged;
              }
              return Ok({
                postState: withIndex(preState, staged.value),
                prepared: { paths: [...paths], entries: staged.value.map(indexJson) },
                evidence: { type: "add", paths: [...paths] },
              });
            },
            *perform() {
              const outcome = yield* selected.git.run(["add", "--", ...paths], directory);
              if (outcome.code !== 0) {
                return Err(
                  new GitOperationError(
                    "Git.Add",
                    "unmatched-pathspec",
                    "<Git.Add> could not stage what its pathspec named.",
                  ),
                );
              }
              return Ok({ type: "add", paths: [...paths] });
            },
          },
          host.resume,
          host.lanes,
        );
        if (!produced.ok) {
          throw produced.error;
        }
        return "";
      },
  };
}

/**
 * The index entries this pathspec would produce, read without writing.
 *
 * `--dry-run` names the paths and `hash-object` names the objects, and neither
 * writes: the prediction leaves the object store exactly as it found it, which
 * is what lets the intent be appended before anything has happened.
 */
function* stagedBy(
  selected: SelectedCheckout,
  directory: string,
  paths: readonly string[],
): Operation<Result<readonly StagedEntry[]>> {
  const listed = yield* selected.git.read(
    ["add", "--dry-run", "--verbose", "--", ...paths],
    directory,
  );
  const entries: StagedEntry[] = [];
  for (const line of (listed ?? "").split("\n")) {
    const match = /^(add|remove) '(.*)'$/.exec(line.trim());
    if (match === null) {
      if (line.trim() !== "") {
        return Err(
          new GitOperationError(
            "Git.Add",
            "invalid-invocation",
            "<Git.Add> could not be predicted: this host does not recognize what Git said it " +
              "would stage.",
          ),
        );
      }
      continue;
    }
    const [, verb, at] = match;
    if (at === undefined) {
      continue;
    }
    if (verb === "remove") {
      entries.push({ path: at, removed: true });
      continue;
    }
    const oid = yield* selected.git.read(["hash-object", at], selected.directory);
    const mode = yield* selected.git.read(
      ["ls-files", "--stage", "--", at],
      selected.directory,
    );
    if (oid === undefined) {
      return Err(
        new GitOperationError(
          "Git.Add",
          "unmatched-pathspec",
          "<Git.Add> could not read one of the files its pathspec named.",
        ),
      );
    }
    entries.push({
      path: at,
      oid,
      // A file already in the index keeps the mode Git recorded for it;
      // anything new is the ordinary non-executable blob unless the file says
      // otherwise, which `hash-object` does not tell us — so it is read back
      // from the worktree after the add and compared there.
      mode: mode === undefined ? "100644" : (mode.split(/\s+/)[0] ?? "100644"),
      removed: false,
    });
  }
  return Ok(Object.freeze(entries));
}

interface StagedEntry {
  readonly path: string;
  readonly oid?: string;
  readonly mode?: string;
  readonly removed: boolean;
}

function indexJson(entry: StagedEntry): Json {
  return entry.removed
    ? { path: entry.path, removed: true }
    : { path: entry.path, oid: entry.oid ?? null, mode: entry.mode ?? null };
}

/** The index this add would leave, with everything else where it was. */
function withIndex(preState: RetainedFrontier, staged: readonly StagedEntry[]): RetainedFrontier {
  const entries = new Map(preState.index.map((entry) => [`${entry.path}:${entry.stage}`, entry]));
  for (const entry of staged) {
    const key = `${entry.path}:0`;
    if (entry.removed) {
      entries.delete(key);
      continue;
    }
    const held = entries.get(key);
    entries.set(key, {
      path: entry.path,
      stage: 0,
      oid: entry.oid ?? "",
      mode: entry.mode ?? "100644",
      flags: held?.flags ?? Object.freeze([]),
    });
  }
  const index = [...entries.values()].sort((left, right) =>
    left.path === right.path ? left.stage - right.stage : left.path < right.path ? -1 : 1
  );
  return Object.freeze({
    checkout: preState.checkout,
    administration: preState.administration,
    objectFormat: preState.objectFormat,
    head: preState.head,
    refs: preState.refs,
    index: Object.freeze(index),
    worktree: preState.worktree,
  });
}

function inventory(selected: SelectedCheckout) {
  return inventoryFrontier({
    git: selected.git,
    checkout: selected.checkout,
    directory: selected.directory,
  });
}
