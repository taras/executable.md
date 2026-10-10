/**
 * One REPL entry's retained repository host.
 *
 * Everything an entry needs to do repository work and be able to resume it
 * lives in the closure this builds: the owner it retains under, the checkouts
 * it has selected, the lane that serializes each shared Git directory, and the
 * history its own admission read. None of it is installed in a context, none of
 * it is reachable from a document, and all of it ends with the entry.
 *
 * The admission is where a resume is decided. It runs inside canonical core's
 * own journal read, on the exact snapshot every later phase consumes, before
 * any document code exists — so by the time the first element expands, this
 * host already knows which effects completed and which one was interrupted. A
 * history it cannot read completely refuses there, with nothing yet attached
 * and nothing yet touched.
 *
 * Selection is lazy and never implicit. Installing this host opens no
 * repository, takes no lease and reads no checkout; an entry that writes no
 * file inside a repository has done no repository work, and its history says
 * so by being empty.
 */

import { Ok } from "effection";
import type { Operation } from "effection";
import { isAbsolute, relative, resolve } from "node:path";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import type { FragmentFileAccess } from "@executablemd/core/host";
import type { FilePathInput, FilesHandler, FileWriteInput, GlobInput } from "@executablemd/runtime";
import { admitRetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import { retainedRepositoryOwner } from "../../retained-repository/records.ts";
import type { RetainedRepositorySite } from "../../retained-repository/records.ts";
import { gitSession } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { discoverAmbientRepository } from "../run-composition/ambient.ts";
import { retainedGitComponents } from "./components.ts";
import { retainedFileMutations } from "./files.ts";
import type { RetainedFileHost, SelectedCheckout } from "./files.ts";
import { retain, retainedLanes, retainedResume } from "./local.ts";
import { inventoryFrontier } from "./frontier.ts";
import type { RetainedResume } from "./local.ts";

/** What the command tells this entry about itself. */
export interface RetainedEntryRequest {
  /** The execution this entry belongs to, as the host established it. */
  readonly executionId: string;
  /** This entry's own key, in the order the entries were admitted. */
  readonly entryKey: string;
  /** The canonical identity of the source this entry is running. */
  readonly source: string;
  /** Where the entry started, which is where an ambient checkout is looked for. */
  readonly cwd: string;
  readonly host: RepositoryHost;
  /** Ordinary file behavior, for everything outside a selected checkout. */
  readonly files: FilesHandler;
}

/** What one entry's host offers the command that built it. */
export interface RetainedEntryHost {
  /** The owner every record this entry writes is retained under. */
  readonly owner: string;
  readonly installation: ExecutionInstallation;
  /** The one captured file access this entry's evaluation profile is bound to. */
  readonly files: FragmentFileAccess;
  /** What its admitted history holds, once the admission has run. */
  history(): RetainedRepositoryHistory | undefined;
  /** The checkouts it has selected so far. */
  selections(): readonly SelectedCheckout[];
}

/**
 * Build one entry's host.
 *
 * Nothing here reaches the filesystem. The lanes, the selection table and the
 * handler set are closures, and the first thing that touches a checkout is a
 * mutation an admitted element asked for.
 */
export function* useRetainedRepositoryEntry(
  request: RetainedEntryRequest,
): Operation<RetainedEntryHost> {
  const owner = retainedRepositoryOwner({
    executionId: request.executionId,
    entryKey: request.entryKey,
  });
  const lanes = retainedLanes();
  // One counter per shared Git directory, advanced as this entry attempts
  // operations. A resume attempts the same ones in the same order, so the
  // numbers line up and a replayed intent carries the identity it was written
  // under.
  const positions = new Map<string, number>();
  const position = (common: string) => {
    const next = positions.get(common) ?? 0;
    positions.set(common, next + 1);
    return next;
  };
  const selected = new Map<string, SelectedCheckout>();
  const git = gitSession(request.host, request.cwd);
  let admitted: RetainedRepositoryHistory | undefined;
  let resume: RetainedResume = retainedResume([]);
  let ambient: SelectedCheckout | undefined;
  let discovered = false;

  /**
   * The checkout covering this path, discovering the ambient one on first ask.
   *
   * Lazy on purpose, and asked once: an entry that never writes inside a
   * repository never looks for one, and one that does looks exactly where it
   * started rather than wherever the document has since moved.
   */
  function* covering(path: string): Operation<SelectedCheckout | undefined> {
    for (const checkout of selected.values()) {
      if (within(checkout.directory, path)) {
        return checkout;
      }
    }
    if (discovered) {
      return undefined;
    }
    discovered = true;
    ambient = yield* selectAmbient();
    if (ambient === undefined) {
      return undefined;
    }
    selected.set(ambient.checkout, ambient);
    return within(ambient.directory, path) ? ambient : undefined;
  }

  /**
   * The ambient checkout this entry works in, selected once.
   *
   * A resume takes the root its own history recorded rather than looking
   * again: an entry reopened from somewhere else on the disk is still the
   * entry that selected that checkout, and rediscovering would quietly make it
   * a different one.
   *
   * A first selection is itself retained. It changes nothing, so the state it
   * starts from and the state it leaves are the same — but it is the record
   * that says this entry works here, and every mutation after it is held to
   * following it.
   */
  function* selectAmbient(): Operation<SelectedCheckout | undefined> {
    const retainedRoot = admitted?.completed.find((effect) => effect.intent.operation === "ambient")
      ?.completion.frontier;
    const checkout =
      retainedRoot === undefined
        ? yield* discoveredCheckout()
        : Object.freeze({
            checkout: retainedRoot.checkout,
            directory: retainedRoot.checkout,
            common: retainedRoot.administration.common,
            git,
          });
    if (checkout === undefined) {
      return undefined;
    }
    const selection = yield* retain(
      {
        owner,
        site: Object.freeze({
          source: request.source,
          occurrence: `ambient:${checkout.checkout}`,
        }),
        operation: "ambient",
        checkout: checkout.checkout,
        common: checkout.common,
        position: position(checkout.common),
        selection: { checkout: checkout.checkout },
        request: { ambient: checkout.checkout },
        inventory: () =>
          inventoryFrontier({
            git,
            checkout: checkout.checkout,
            directory: checkout.directory,
          }),
        // deno-lint-ignore require-yield
        *prepare(preState) {
          // Selecting changes nothing: the two ends of this transition are one
          // state, and what the record is for is saying which checkout.
          return Ok({
            postState: preState,
            prepared: { root: checkout.checkout },
            evidence: { type: "ambient", checkout: checkout.checkout },
          });
        },
        // deno-lint-ignore require-yield
        *perform() {
          return Ok({ type: "ambient", checkout: checkout.checkout });
        },
      },
      resume,
      lanes,
    );
    if (!selection.ok) {
      throw selection.error;
    }
    return checkout;
  }

  /** The checkout this entry started in, when it started in one. */
  function* discoveredCheckout(): Operation<SelectedCheckout | undefined> {
    const found = yield* discoverAmbientRepository(git, request.cwd);
    if (found === undefined) {
      return undefined;
    }
    return Object.freeze({
      checkout: found.checkoutRoot,
      directory: found.checkoutRoot,
      common: found.commonDirectory,
      git,
    });
  }

  const fileHost: RetainedFileHost = {
    owner,
    covering: (path) => covering(path),
    ordinary: request.files,
    lanes,
    resume: {
      pending: (fingerprint) => resume.pending(fingerprint),
      completed: (fingerprint) => resume.completed(fingerprint),
    },
    position,
    site: (occurrence): RetainedRepositorySite =>
      Object.freeze({ source: request.source, occurrence }),
  };

  const admission: JournalAdmission = function* (retained: readonly DurableEvent[]) {
    const read = yield* admitRetainedRepositoryHistory(retained, owner);
    if (!read.ok) {
      // Fails the continuation where it is read, with nothing attached and
      // nothing touched.
      throw read.error;
    }
    admitted = read.value;
    resume = retainedResume(read.value.pending, read.value.completed);
  };

  return {
    owner,
    installation: {
      admissions: [admission],
      fileMutations: retainedFileMutations(fileHost),
      // Declared, not registered: each one is minted a domain so its body can
      // authenticate its own invocation before it routes anything.
      components: retainedGitComponents(fileHost, request.host),
    },
    files: capturedFiles(request.files, request.cwd),
    history: () => admitted,
    selections: () => [...selected.values()],
  };
}

/**
 * The one captured file access this entry's fragments run on.
 *
 * Its mutations are the ones canonical core routes past it, straight to the
 * handler set above, so what remains here is everything a fragment may do that
 * is not a mutation — and the ordinary mutation behavior for a host that was
 * given no handlers at all.
 */
function capturedFiles(files: FilesHandler, cwd: string): FragmentFileAccess {
  return {
    checkFilePath: (input: FilePathInput) => files.checkFilePath(input),
    readTextFile: (input: FilePathInput) => files.readTextFile(input),
    globFiles: (input: GlobInput) => files.globFiles(input),
    writeTextFile: (input: FileWriteInput) => files.writeTextFile(input),
    deleteFile: (input: FilePathInput) => files.deleteFile(input),
    ensureDirectory: (input: FilePathInput) => files.ensureDirectory(input),
    // deno-lint-ignore require-yield
    *workingDirectory(): Operation<string> {
      return cwd;
    },
  };
}

/**
 * Whether this absolute path is this checkout, or somewhere in it.
 *
 * The checkout's own root counts. A `<Git.Add>` written at the top of a
 * checkout is working in that checkout, and asking whether the root is
 * *strictly inside* itself is a different question — the one a file target is
 * held to, where the root is not a file anybody can write.
 */
function within(directory: string, path: string): boolean {
  const at = relative(resolve(directory), resolve(path));
  return !at.startsWith("..") && !isAbsolute(at);
}

/** Another entry's checkout is not this one's, whatever the path says. */
export function selectedCheckoutFor(
  selections: readonly SelectedCheckout[],
  path: string,
): SelectedCheckout | undefined {
  return selections.find((checkout) => within(checkout.directory, path));
}
