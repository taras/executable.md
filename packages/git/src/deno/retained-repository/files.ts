/**
 * The file mutations an entry records, and the ones it simply performs.
 *
 * A document writes files in two places: inside a checkout this entry has
 * selected, and everywhere else. Only the first is repository work. A write
 * beside the document, in a temporary directory or anywhere outside a
 * selection, is ordinary filesystem behavior and is journaled by nothing here —
 * giving it a record would claim a checkout it is not in.
 *
 * Inside a selection the write goes through this entry's own durable boundary:
 * the ordinary Files operation performs it, and what it produced is recorded
 * once. A completed write replays its result and touches no file, however the
 * file has changed since. Nothing is inventoried, predicted or compared.
 *
 * The handlers are the ones canonical core was given. Core decides which
 * occurrence is writing and hands it over through its own terminal; nothing
 * here looks an occurrence up, and a public call that arrives without one is
 * not a mutation this entry can record.
 */

import { Ok, until } from "effection";
import type { Operation, Result } from "effection";
import { isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileWriteSuccess } from "@executablemd/runtime";
import type {
  FilePathInput,
  FilesHandler,
  FileWriteInput,
  FileWriteSuccess,
} from "@executablemd/runtime";
import type { Json } from "@executablemd/durable-streams";
import type { FileMutationHandlers } from "@executablemd/core/host";
import { recorded } from "./local.ts";
import type { RecordedOperation } from "./local.ts";
import type { GitSession } from "../composition/git.ts";
import type { RegisteredCheckout } from "../run-composition/operations.ts";
import type { RepositoryIdentity } from "../../composition/selection.ts";
import { retainedFileResult } from "../../retained-repository/records.ts";
import type { RetainedRepositorySite } from "../../retained-repository/records.ts";

/**
 * What one selected checkout publishes as, resolved when something asks.
 *
 * Pinned by the selection rather than read when a push happens: the identity
 * carries the commit the repository was selected at, and re-deriving it after
 * the entry has committed would name a different repository and so a different
 * external effect. A managed checkout takes it from the metadata its creation
 * wrote; an ambient one from what its own recorded selection kept.
 */
export interface CheckoutPublication {
  readonly identity: RepositoryIdentity;
  /** The credential-free locator it publishes to, or `null` when it has none. */
  readonly origin: string | null;
  /**
   * The checkout of the repository this one belongs to.
   *
   * Its own, for a repository; the owner's, for a linked worktree — which is
   * the checkout whose administration holds the object database both of them
   * publish from.
   */
  readonly repositoryDirectory: string;
}

/** One checkout this entry has selected, as the file handlers see it. */
export interface SelectedCheckout {
  /** The identity it is recorded under. */
  readonly checkout: string;
  /** Where it is on this host. */
  readonly directory: string;
  readonly common: string;
  readonly git: GitSession;
  /**
   * The same checkout as the ordinary live performers take it.
   *
   * Carried rather than rebuilt, because the live Add, Switch, Commit and Push
   * are the ordinary ones: this entry records what they produced instead of
   * implementing its own.
   */
  readonly registered: RegisteredCheckout;
  /**
   * What this checkout publishes as, asked for at most once.
   *
   * An operation rather than a member because nothing but a push or a pull
   * request needs it: an entry that selects a checkout and writes a file in it
   * reads no metadata and resolves no identity. A `Result`, because a
   * placement whose metadata this host cannot read is an answer the asking
   * element refuses with its own words.
   */
  publication(): Operation<Result<CheckoutPublication>>;
}

/** What the entry knows about its own selections. */
export interface RetainedFileHost {
  readonly owner: string;
  /**
   * The selected checkout this absolute path is inside, when it is in one.
   *
   * An operation because selection is lazy: the first mutation inside a
   * repository is what looks for one, and an entry that makes none never does.
   */
  covering(path: string): Operation<SelectedCheckout | undefined>;
  /** Where a path outside every selection is performed. */
  readonly ordinary: FilesHandler;
  /** The occurrence's site, derived by the caller from the claimed id. */
  site(occurrence: string): RetainedRepositorySite;
}

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
 * One authored directory, recorded when it is inside a selected checkout.
 *
 * `<Dir>` is a Git-owned component with its own claimed occurrence, so it
 * arrives here already authenticated; what this adds is the same boundary the
 * file mutations use. An ensure that finds the directory already there is the
 * ordinary success it always was.
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
  const produced = yield* recorded({
    owner: host.owner,
    site: host.site(occurrence),
    operation: "dir-ensure",
    request: { cwd: input.cwd, path: input.path },
    *perform(): Operation<Result<Json>> {
      const made = yield* host.ordinary.ensureDirectory(input);
      return made.ok ? Ok(retainedFileResult("dir-ensure")) : made;
    },
  });
  return produced.ok ? Ok(undefined) : produced;
}

function* write(
  host: RetainedFileHost,
  occurrence: string,
  input: FileWriteInput,
): Operation<Result<FileWriteSuccess>> {
  const target = yield* targetOf(input);
  const selected = yield* host.covering(target);
  if (selected === undefined || inside(selected, target) === undefined) {
    return yield* host.ordinary.writeTextFile(input);
  }
  const produced = yield* recorded(
    fileOperation(host, occurrence, "file-write", input, {
      content: input.content,
      perform: () => host.ordinary.writeTextFile(input),
    }),
  );
  // The same answer a live write gives, which is what makes a replay
  // indistinguishable from a first run: what a document learns from a write is
  // that this host committed it.
  return produced.ok ? Ok(fileWriteSuccess("host-committed")) : produced;
}

function* remove(
  host: RetainedFileHost,
  occurrence: string,
  input: FilePathInput,
): Operation<Result<void>> {
  const target = yield* targetOf(input);
  const selected = yield* host.covering(target);
  if (selected === undefined || inside(selected, target) === undefined) {
    return yield* host.ordinary.deleteFile(input);
  }
  const produced = yield* recorded(
    fileOperation(host, occurrence, "file-delete", input, {
      perform: () => host.ordinary.deleteFile(input),
    }),
  );
  return produced.ok ? Ok(undefined) : produced;
}

/** One file mutation, as this entry's durable boundary wants it described. */
function fileOperation(
  host: RetainedFileHost,
  occurrence: string,
  operation: "file-write" | "file-delete",
  input: FilePathInput,
  work: {
    readonly content?: string;
    perform(): Operation<Result<unknown>>;
  },
): RecordedOperation {
  return {
    owner: host.owner,
    site: host.site(occurrence),
    operation,
    // The authored request and nothing else. The content is here because the
    // document wrote it; no other file's bytes belong in a record of this one.
    request:
      work.content === undefined
        ? { cwd: input.cwd, path: input.path }
        : { cwd: input.cwd, path: input.path, content: work.content },
    *perform(): Operation<Result<Json>> {
      const produced = yield* work.perform();
      return produced.ok ? Ok(retainedFileResult(operation)) : produced;
    },
  };
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
