/**
 * The file mutations an entry retains, and the ones it simply performs.
 *
 * A document writes files in two places: inside a checkout this entry has
 * selected, and everywhere else. Only the first is repository work. A write
 * beside the document, in a temporary directory or anywhere outside a
 * selection, is ordinary filesystem behavior and is journaled by nothing here —
 * giving it a retained record would claim a checkout it is not in.
 *
 * Inside a selection the write goes through the retained protocol: the state is
 * read, the transition is worked out from the inventory alone, the intent is
 * written down, and only then does the file change. Working the transition out
 * needs no Git at all — a write replaces one path's bytes and makes the
 * directories above it, and a deletion removes one path — so this is the one
 * operation that predicts without scratch.
 *
 * The handlers are the ones canonical core was given. Core decides which
 * occurrence is writing and hands it over through its own terminal; nothing
 * here looks an occurrence up, and a public call that arrives without one is
 * not a mutation this entry can retain.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { encodeBase64 } from "@std/encoding/base64";
import { fileWriteSuccess } from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesHandler,
  FileWriteInput,
  FileWriteSuccess,
} from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import type { FileMutationHandlers } from "@executablemd/core/host";
import { inventoryFrontier } from "./frontier.ts";
import { retainedRefusalFilesError } from "../../retained-repository/records.ts";
import { retain } from "./local.ts";
import type {
  PreparedTransition,
  RetainedLanes,
  RetainedOperation,
  RetainedResume,
} from "./local.ts";
import type { GitSession } from "../composition/git.ts";
import type {
  RetainedFrontier,
  RetainedRepositorySite,
  RetainedWorktreeEntry,
} from "../../retained-repository/records.ts";

/** One checkout this entry has selected, as the file handlers see it. */
export interface SelectedCheckout {
  /** The identity it is retained under. */
  readonly checkout: string;
  /** Where it is on this host. */
  readonly directory: string;
  readonly common: string;
  readonly git: GitSession;
}

/** What the entry knows about its own selections and history. */
export interface RetainedFileHost {
  readonly owner: string;
  /**
   * The selected checkout this absolute path is inside, when it is in one.
   *
   * An operation because selection is lazy: the first mutation inside a
   * repository is what looks for one, and an entry that makes none never does.
   */
  covering(path: string): Operation<SelectedCheckout | undefined>;
  /**
   * Authenticate this checkout against what the history accounts for.
   *
   * The entry's own trusted boundary, and the same one for every checkout it
   * works in. A selection calls it before anything is replayed, performed or
   * expanded in the checkout it selected; `covering` calls it for whatever a
   * mutation reaches. Once per checkout, and a checkout nothing has recorded
   * yet needs nothing.
   */
  attach(checkout: SelectedCheckout): Operation<void>;
  /** Where a path outside every selection is performed. */
  readonly ordinary: FilesHandler;
  readonly lanes: RetainedLanes;
  readonly resume: RetainedResume;
  /** The next place in this shared directory's lane. */
  position(common: string): number;
  /** The occurrence's site, derived by the caller from the claimed id. */
  site(occurrence: string): RetainedRepositorySite;
  /**
   * What this entry's accepted history says this checkout may be in.
   *
   * Empty for a checkout nothing has recorded yet. Carried into every
   * operation so the state it starts from is one the history accounts for.
   */
  candidates(checkout: string): readonly RetainedFrontier[];
  /** Record what an acknowledged operation left this checkout in. */
  settled(checkout: string, frontier: RetainedFrontier): void;
}

/** The default mode a file this host creates is left at. */
const CREATED = "0644";

/** The handler set canonical core routes this entry's File mutations through. */
export function retainedFileMutations(host: RetainedFileHost): FileMutationHandlers {
  return {
    *writeTextFile([routing], next) {
      const occurrence = yield* next({ intent: "inspect", routing });
      const answer = yield* write(host, occurrence, routing.input);
      yield* next({ intent: "answer", routing, answer });
    },
    *deleteFile([routing], next) {
      const occurrence = yield* next({ intent: "inspect", routing });
      const answer = yield* remove(host, occurrence, routing.input);
      yield* next({ intent: "answer", routing, answer });
    },
  };
}

/**
 * One authored directory, retained when it is inside a selected checkout.
 *
 * `<Dir>` is a Git-owned component with its own claimed occurrence, so it
 * arrives here already authenticated; what this adds is the same protocol the
 * file mutations use. An ensure that finds the directory already there changes
 * nothing, and its two frozen ends are one state.
 */
export function* retainedDirectoryEnsure(
  host: RetainedFileHost,
  occurrence: string,
  input: FilePathInput,
): Operation<Result<void>> {
  const target = yield* targetOf(input);
  const selected = yield* host.covering(target);
  const at = selected === undefined ? undefined : inside(selected, target);
  if (selected === undefined || at === undefined) {
    return yield* host.ordinary.ensureDirectory(input);
  }
  const produced = yield* retain(
    {
      owner: host.owner,
      site: host.site(occurrence),
      operation: "dir-ensure",
      checkout: selected.checkout,
      common: selected.common,
      position: host.position(selected.common),
      candidates: () => host.candidates(selected.checkout),
      settled: (frontier) => host.settled(selected.checkout, frontier),
      selection: { checkout: selected.checkout },
      request: { cwd: input.cwd, path: input.path },
      inventory: () =>
        inventoryFrontier({
          git: selected.git,
          checkout: selected.checkout,
          directory: selected.directory,
        }),
      *prepare(preState: RetainedFrontier | null): Operation<Result<PreparedTransition>> {
        if (preState === null) {
          return Err(
            new Error(
              "a file operation has no absent state: the checkout it writes in was selected, " +
                "not created.",
            ),
          );
        }
        const postState = ensured(preState, at);
        if (postState === undefined) {
          return Err(
            new Error(
              `"${input.path}" names something other than a directory inside ` +
                `${selected.checkout}.`,
            ),
          );
        }
        return Ok({
          postState,
          prepared: { target: at },
          evidence: { type: "dir-ensure" },
        });
      },
      refusal: (result) => retainedRefusalFilesError("dir-ensure", result),
      *perform(): Operation<Result<Json>> {
        const made = yield* host.ordinary.ensureDirectory(input);
        if (!made.ok) {
          return made;
        }
        return Ok({ type: "dir-ensure" });
      },
    },
    host.resume,
    host.lanes,
  );
  if (!produced.ok) {
    return produced;
  }
  return Ok(undefined);
}

function* write(
  host: RetainedFileHost,
  occurrence: string,
  input: FileWriteInput,
): Operation<Result<FileWriteSuccess>> {
  const target = yield* targetOf(input);
  const selected = yield* host.covering(target);
  if (selected === undefined) {
    return yield* host.ordinary.writeTextFile(input);
  }
  const at = inside(selected, target);
  if (at === undefined) {
    return yield* host.ordinary.writeTextFile(input);
  }
  const produced = yield* retain(
    fileOperation(host, selected, occurrence, "file-write", input, {
      at,
      content: input.content,
      perform: () => host.ordinary.writeTextFile(input),
    }),
    host.resume,
    host.lanes,
  );
  if (!produced.ok) {
    return produced;
  }
  return Ok(fileWriteSuccess("host-committed"));
}

function* remove(
  host: RetainedFileHost,
  occurrence: string,
  input: FilePathInput,
): Operation<Result<void>> {
  const target = yield* targetOf(input);
  const selected = yield* host.covering(target);
  if (selected === undefined) {
    return yield* host.ordinary.deleteFile(input);
  }
  const at = inside(selected, target);
  if (at === undefined) {
    return yield* host.ordinary.deleteFile(input);
  }
  const produced = yield* retain(
    fileOperation(host, selected, occurrence, "file-delete", input, {
      at,
      perform: () => host.ordinary.deleteFile(input),
    }),
    host.resume,
    host.lanes,
  );
  if (!produced.ok) {
    return produced;
  }
  return Ok(undefined);
}

/** One file mutation, as the retained protocol wants it described. */
function fileOperation(
  host: RetainedFileHost,
  selected: SelectedCheckout,
  occurrence: string,
  operation: "file-write" | "file-delete",
  input: FilePathInput,
  work: {
    readonly at: string;
    readonly content?: string;
    perform(): Operation<Result<unknown>>;
  },
): RetainedOperation {
  return {
    owner: host.owner,
    site: host.site(occurrence),
    operation,
    checkout: selected.checkout,
    common: selected.common,
    position: host.position(selected.common),
    candidates: () => host.candidates(selected.checkout),
    settled: (frontier) => host.settled(selected.checkout, frontier),
    selection: { checkout: selected.checkout },
    request:
      work.content === undefined
        ? { cwd: input.cwd, path: input.path }
        : { cwd: input.cwd, path: input.path, content: work.content },
    inventory: () =>
      inventoryFrontier({
        git: selected.git,
        checkout: selected.checkout,
        directory: selected.directory,
      }),
    *prepare(preState: RetainedFrontier | null): Operation<Result<PreparedTransition>> {
      if (preState === null) {
        return Err(
          new Error(
            "a file operation has no absent state: the checkout it writes in was selected, " +
              "not created.",
          ),
        );
      }
      const postState =
        work.content === undefined
          ? removed(preState, work.at)
          : written(preState, work.at, work.content);
      if (postState === undefined) {
        return Err(
          new Error(
            `"${input.path}" is not a path this entry can predict a transition for inside ` +
              `${selected.checkout}.`,
          ),
        );
      }
      return Ok({
        postState,
        prepared: { target: work.at },
        evidence: evidenceFor(operation),
      });
    },
    refusal: (result) => retainedRefusalFilesError(operation, result),
    *perform(): Operation<Result<Json>> {
      const produced = yield* work.perform();
      if (!produced.ok) {
        return produced;
      }
      return Ok(evidenceFor(operation));
    },
  };
}

/**
 * The result each of these two operations produces.
 *
 * Fixed rather than read back from the provider: what a document learns from a
 * write is that it happened, and the retained evidence says the same thing the
 * live one does so a replay is indistinguishable from a first run.
 */
function evidenceFor(operation: "file-write" | "file-delete"): Json {
  return operation === "file-write"
    ? { type: "file-write", publication: "host-committed" }
    : { type: "file-delete" };
}

/**
 * Where this request points, with the directory it is relative to resolved.
 *
 * The working directory is resolved through the filesystem rather than used as
 * written, because a host's temporary root is commonly reached through a link
 * — `/var` for `/private/var` on macOS — and a checkout discovered by its real
 * path would not appear to contain a file addressed through the link. The file
 * itself need not exist; its directory does.
 */
function* targetOf(input: FilePathInput): Operation<string> {
  const directory = yield* canonical(input.cwd);
  return resolve(join(directory, input.path));
}

/** This directory's real path, or the one given when it cannot be resolved. */
function* canonical(directory: string): Operation<string> {
  try {
    return yield* until(realpath(directory));
  } catch {
    return resolve(directory);
  }
}

/** Where this absolute path sits inside the checkout, or nothing. */
function inside(selected: SelectedCheckout, target: string): string | undefined {
  const at = relative(selected.directory, target);
  if (at === "" || at.startsWith("..") || isAbsolute(at)) {
    return undefined;
  }
  return at.split(/[\\/]/).join("/");
}

/**
 * The checkout this write leaves behind.
 *
 * The parents it would create are entries of their own, because an empty
 * directory is state and a resume has to find the same ones. An existing
 * file keeps the mode it already had: a write replaces content, not
 * permissions.
 */
function written(
  preState: RetainedFrontier,
  at: string,
  content: string,
): RetainedFrontier | undefined {
  const bytes = encodeBase64(new TextEncoder().encode(content));
  const entries = new Map(preState.worktree.map((entry) => [entry.path, entry]));
  for (const parent of parentsOf(at)) {
    const held = entries.get(parent);
    if (held === undefined) {
      entries.set(parent, Object.freeze({ kind: "directory", path: parent, mode: "0755" }));
      continue;
    }
    if (held.kind !== "directory") {
      return undefined;
    }
  }
  const existing = entries.get(at);
  if (existing !== undefined && existing.kind !== "file") {
    return undefined;
  }
  entries.set(
    at,
    Object.freeze({
      kind: "file",
      path: at,
      mode: existing === undefined ? CREATED : existing.mode,
      bytes,
    }),
  );
  return withWorktree(preState, entries);
}

/**
 * The checkout this ensure leaves behind.
 *
 * The target and every directory above it, because a recursive ensure makes
 * all of them and an empty directory is state a resume has to find again. A
 * directory that is already there is a no-op, so the two ends of that
 * transition are one state.
 */
function ensured(preState: RetainedFrontier, at: string): RetainedFrontier | undefined {
  const entries = new Map(preState.worktree.map((entry) => [entry.path, entry]));
  for (const path of [...parentsOf(at), at]) {
    const held = entries.get(path);
    if (held === undefined) {
      entries.set(path, Object.freeze({ kind: "directory", path, mode: "0755" }));
      continue;
    }
    if (held.kind !== "directory") {
      return undefined;
    }
  }
  return withWorktree(preState, entries);
}

/**
 * The checkout this deletion leaves behind.
 *
 * Removing a path that was not there is the same answer as removing one that
 * was, on the Files contract's own terms, so an absent entry predicts an
 * unchanged worktree rather than a refusal.
 */
function removed(preState: RetainedFrontier, at: string): RetainedFrontier | undefined {
  const entries = new Map(preState.worktree.map((entry) => [entry.path, entry]));
  const held = entries.get(at);
  if (held !== undefined && held.kind === "directory") {
    return undefined;
  }
  entries.delete(at);
  return withWorktree(preState, entries);
}

function withWorktree(
  preState: RetainedFrontier,
  entries: ReadonlyMap<string, RetainedWorktreeEntry>,
): RetainedFrontier {
  const worktree = [...entries.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return Object.freeze({
    checkout: preState.checkout,
    administration: preState.administration,
    objectFormat: preState.objectFormat,
    head: preState.head,
    refs: preState.refs,
    index: preState.index,
    worktree: Object.freeze(worktree),
  });
}

/** Every directory above this path, outermost first. */
function parentsOf(at: string): readonly string[] {
  const parents: string[] = [];
  let parent = dirname(at);
  while (parent !== "." && parent !== "" && parent !== "/") {
    parents.unshift(parent.split(/[\\/]/).join("/"));
    parent = dirname(parent);
  }
  return parents;
}
