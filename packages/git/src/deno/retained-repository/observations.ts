/**
 * One REPL entry's four local Git reads: performed once, answered from what
 * performing them produced.
 *
 * These are the ordinary performers an `xmd run` uses, wrapped in this entry's
 * durable boundary. What is added is memory: a completed read answers with its
 * saved page and runs no `git`, however the checkout has changed since — and a
 * read whose checkout has been deleted still answers, because answering it
 * consults nothing.
 *
 * ## A saved page is history, not a prediction
 *
 * The honesty the REPL trades for not snapshotting anybody's repository is
 * explicit here. A completed listing names the paths the index held then; a
 * completed patch window is the text that comparison produced then. Reopening
 * the page performs no check against today's repository. Using the `next` it
 * carries in a *new* read does, which is where a changed observation refuses —
 * that is a live continuation check rather than something replay decides.
 *
 * ## Why this reads the cursor before it resolves anything
 *
 * Routing a read means canonicalizing its working directory and choosing among
 * this entry's registered checkouts; performing one means creating a scratch
 * directory, proving an object database contained and copying an index. None of
 * that is anything a saved page is about. So the retained cursor is read first,
 * without consuming anything, and only a read with nothing saved routes,
 * acquires and performs.
 *
 * The read is a hint and never an authority. `createDurableOperation` remains
 * the only judge of position, type and name, so the recording callback asks for
 * the same routing and the same hold again — idempotently — around work that
 * really does run live.
 *
 * ## One slot, no lease, one turn
 *
 * A live read takes the selected placement's managed slot where it has one, and
 * nothing else: it changes no byte of the repository, so there is nothing for a
 * mutation lease to protect. It does take this entry's existing per-common-
 * directory turn, so the entry's own native Git attempts do not interleave each
 * other's command sequences.
 */

import { Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { realpath } from "node:fs/promises";
import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import type { Around } from "@effectionx/context-api";
import { GitObservationError, GitOperationAdmissionError } from "../../composition/errors.ts";
import type { GitQueryApi } from "../../git.ts";
import {
  admitChangesInvocation,
  admitDiffInvocation,
  admitFileInvocation,
  admitFilesInvocation,
} from "../../composition/observation-api.ts";
import type {
  GitChangesInvocation,
  GitChangesResult,
  GitDiffInvocation,
  GitDiffResult,
  GitFileInvocation,
  GitFileResult,
  GitFilesInvocation,
  GitFilesResult,
  GitObservationRequest,
  GitObservationValue,
} from "../../composition/observation-api.ts";
import {
  CHANGES_ELEMENT,
  DIFF_ELEMENT,
  FILE_ELEMENT,
  FILES_ELEMENT,
} from "../../composition/components/GitReads.ts";
import { sameRepositoryIdentity } from "../../composition/selection.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import {
  elementOf,
  parseReplObservationRecord,
  replObservationFingerprint,
  replObservationRecordJson,
  replObservationRecordName,
  replObservationRefusalOf,
  ReplObservationRefusal,
  REPL_REPOSITORY_OBSERVATION,
} from "../../retained-repository/observation-records.ts";
import type {
  ReplObservationCheckout,
  ReplObservationRecord,
  ReplObservationRequest,
} from "../../retained-repository/observation-records.ts";
import { performGitObservation } from "../composition/observations.ts";
import type { ObservationPlace } from "../composition/observations.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { selectCheckout } from "../run-composition/operations.ts";
import type { SlotKind } from "../run-composition/leases.ts";
import type { SelectionRegistry } from "../selections.ts";
import { holdManagedPlacement } from "./leases.ts";
import { retainedRecordAhead } from "./local.ts";
import { placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";
import type { ReplGitCheckout } from "./git.ts";

/**
 * A saved page standing where this read belongs that it cannot read.
 *
 * Fatal: a value that does not describe this read is not an outcome of it, so
 * it does not belong in the result channel. A refusal there is the read's own
 * sentence, which `<PrintErrors>` may print and carry on past.
 */
export class ReplObservationRecordError extends StaleInputError {
  override name = "ReplObservationRecordError";
}

/** What recorded local Git reads need from the entry that owns them. */
export interface ReplObservationEntry {
  /** The native Git host one contained observation performs through. */
  readonly host: RepositoryHost;
  /** Hold a managed slot for the entry, single-flight per root and slot. */
  holdSlot(root: string, kind: SlotKind, path: string, subject: string): Operation<void>;
  /** Run live native Git for one shared Git directory in order within this entry. */
  serialize<T>(key: string, work: () => Operation<T>): Operation<T>;
  /** This entry's private map from the selections it minted to what it holds. */
  readonly selections: SelectionRegistry<ReplPlacementRegistration>;
  /** The checkouts this entry has registered, as they stand now. */
  checkouts(): readonly ReplGitCheckout[];
}

/**
 * The recorded four reads this entry installs.
 *
 * Installed at the implementation slot, exactly where the ordinary provider
 * installs its own, so this is ordinary dispatch rather than a protected
 * channel: middleware above may answer without reaching here, refuse, or
 * transform and delegate — and when it delegates, the request that arrives is
 * the request recorded. A read answered wholly by a replacement never reaches
 * this provider and creates no observation record.
 */
export function replObservationMiddleware(
  entry: ReplObservationEntry,
): Partial<Around<GitQueryApi>> {
  return {
    *files([invocation]: [GitFilesInvocation]): Operation<GitFilesResult> {
      const request = admitFilesInvocation(FILES_ELEMENT, invocation.request);
      const value = yield* recorded(entry, { ...invocation, request });
      if (!("paths" in value)) {
        throw mismatch(FILES_ELEMENT);
      }
      return value;
    },

    *changes([invocation]: [GitChangesInvocation]): Operation<GitChangesResult> {
      const request = admitChangesInvocation(CHANGES_ELEMENT, invocation.request);
      const value = yield* recorded(entry, { ...invocation, request });
      if (!("changes" in value)) {
        throw mismatch(CHANGES_ELEMENT);
      }
      return value;
    },

    *diff([invocation]: [GitDiffInvocation]): Operation<GitDiffResult> {
      const request = admitDiffInvocation(DIFF_ELEMENT, invocation.request);
      const value = yield* recorded(entry, { ...invocation, request });
      if (!("text" in value) || "commit" in value) {
        throw mismatch(DIFF_ELEMENT);
      }
      return value;
    },

    *file([invocation]: [GitFileInvocation]): Operation<GitFileResult> {
      const request = admitFileInvocation(FILE_ELEMENT, invocation.request);
      const value = yield* recorded(entry, { ...invocation, request });
      if (!("commit" in value)) {
        throw mismatch(FILE_ELEMENT);
      }
      return value;
    },
  };
}

/**
 * Where this read runs, as this entry's own registry describes it.
 *
 * The received selection is authenticated before anything else and its *parsed*
 * facts are what the request carries. The fresh opaque identifier the provider
 * minted for this entry never appears: it names nothing once the entry ends, so
 * a durable name built from one would differ on every reopen of the same
 * question.
 */
function place(
  entry: ReplObservationEntry,
  element: string,
  invocation: { readonly repository: RepositorySelection; readonly workingDirectory: string },
  query: GitObservationRequest,
): ReplObservationRequest {
  const placement = entry.selections.authenticate(
    invocation.repository,
    () =>
      new GitOperationAdmissionError(
        element,
        "the Repository in scope is not one this entry selected, so it names no checkout",
      ),
  ).placement;
  return Object.freeze({
    repository: placement.identity,
    selectionCheckout: placement.checkoutRoot,
    commonDirectory: placement.commonDirectory,
    // Exactly as received. Resolving it is live routing, which a completed read
    // does not do, so the name cannot depend on it.
    workingDirectory: invocation.workingDirectory,
    query,
  });
}

/**
 * Perform this read, or answer with what performing it produced before.
 *
 * The page is the read's own — the same value a live call produces and a replay
 * restores — so a caller cannot tell from it which of the two happened, which
 * is the point. An ordinary refusal is raised from the saved classification on
 * both paths, by this one route, so a live refusal and a replayed one are the
 * same error for the same element.
 */
function* recorded(
  entry: ReplObservationEntry,
  invocation: {
    readonly repository: RepositorySelection;
    readonly workingDirectory: string;
    readonly request: GitObservationRequest;
  },
): Operation<GitObservationValue> {
  const element = elementOf(invocation.request.kind);
  const request = place(entry, element, invocation, invocation.request);
  const fingerprint = yield* replObservationFingerprint(request);
  const name = replObservationRecordName({
    operation: invocation.request.kind,
    fingerprint,
  });

  // Resolved at most once for this call, because the live path routes before it
  // takes the turn and the recording callback asks again inside it.
  let routed: ReplGitCheckout | undefined;
  function* routing(): Operation<ReplGitCheckout> {
    if (routed === undefined) {
      routed = yield* route(entry, element, request);
    }
    return routed;
  }

  function* once(): Operation<unknown> {
    return yield createDurableOperation<Json>(
      { type: REPL_REPOSITORY_OBSERVATION, name },
      function* () {
        const target = yield* routing();
        yield* own(entry, target);
        const checkout = describing(target);
        const outcome = yield* attempted(element, function* () {
          return yield* performGitObservation(
            entry.host,
            element,
            invocation.request,
            placeOf(request, target),
          );
        });
        const payload = replObservationRecordJson({
          fingerprint,
          request,
          checkout,
          outcome,
        });
        // Read back before the coordinator publishes it. A payload this build
        // cannot parse, or one describing another request or a checkout this
        // entry holds no placement for, is not an outcome to acknowledge: it
        // takes the fatal path here, so nothing is appended and a continuation
        // meets today's checkout instead of a record it could never read.
        readback(entry, element, request, fingerprint, payload);
        return payload;
      },
      { coordinator: observationCoordinator },
    );
  }

  // Journal data on a replay, so it arrives as the unknown it is and is parsed
  // below rather than trusted as this code's own.
  const stored: unknown = (yield* retainedRecordAhead(REPL_REPOSITORY_OBSERVATION, name))
    ? yield* once()
    : yield* live(entry, routing, once);

  const parsed = readback(entry, element, request, fingerprint, stored);
  if (!parsed.outcome.ok) {
    throw failure(element, parsed.outcome.error);
  }
  return parsed.outcome.value;
}

/** Where the contained native read runs, once this entry has routed it. */
function placeOf(
  request: ReplObservationRequest,
  target: ReplGitCheckout,
): ObservationPlace {
  return {
    repository: request.repository,
    root: target.checkout.root,
    commonDirectory: target.registration.placement.commonDirectory,
  };
}

/** The checkout a record names, derived from the route rather than the journal. */
function describing(target: ReplGitCheckout): ReplObservationCheckout {
  return Object.freeze({
    root: target.checkout.root,
    commonDirectory: target.registration.placement.commonDirectory,
    repositoryName: target.checkout.repositoryName,
    worktreeName: target.checkout.worktreeName,
  });
}

/**
 * The record this value is for this read, or the fatal failure it is not.
 *
 * The same three questions on both paths, which is the point: a live outcome is
 * held to them before it is published, and a restored one before it is
 * returned. The payload parses, it describes this request, and the checkout it
 * names is one this entry registered under the repository it authenticated —
 * with parsed facts alone, so a result path never authorizes a native call and
 * a new read chooses its checkout independently.
 */
function readback(
  entry: ReplObservationEntry,
  element: string,
  request: ReplObservationRequest,
  fingerprint: string,
  stored: unknown,
): ReplObservationRecord {
  const parsed = parseReplObservationRecord(stored);
  if (parsed === undefined) {
    throw new ReplObservationRecordError(
      `the saved page for ${element} is not one this host can read, so what it says about work ` +
        "already done is unknown.",
    );
  }
  if (parsed.operation !== request.query.kind || parsed.fingerprint !== fingerprint) {
    throw mismatch(element);
  }
  authorized(entry, element, request, parsed.checkout);
  return parsed;
}

/**
 * Route, take the turn, take the slot, and perform.
 *
 * Acquisition happens outside the recorded operation, which is what keeps a
 * slot another entry holds a fatal diagnostic the person can act on rather than
 * a durable outcome — and keeps temporary contention out of the journal
 * entirely.
 */
function* live(
  entry: ReplObservationEntry,
  routing: () => Operation<ReplGitCheckout>,
  once: () => Operation<unknown>,
): Operation<unknown> {
  const target = yield* routing();
  return yield* entry.serialize(
    `observation ${target.registration.placement.commonDirectory}`,
    function* () {
      yield* own(entry, target);
      return yield* once();
    },
  );
}

/**
 * Which registered checkout this repository and working directory select.
 *
 * The ordinary selector over this entry's own registrations, restricted by the
 * whole authenticated Repository identity and resolving the received directory
 * first — a checkout root is the path Git resolved, and a working directory
 * reached through a link is the same place under another name. The longest
 * covering checkout wins, so a subdirectory, a linked worktree and a captured
 * path entered through `<Dir>` each select the checkout their own paths belong
 * to.
 */
function* route(
  entry: ReplObservationEntry,
  element: string,
  request: ReplObservationRequest,
): Operation<ReplGitCheckout> {
  const registered = entry.checkouts();
  const selected = selectCheckout(
    registered.map((held) => held.checkout),
    request.repository,
    yield* canonicalPath(request.workingDirectory),
    element,
  );
  const found = registered.find((held) => held.checkout.root === selected.root);
  if (found === undefined) {
    throw new GitOperationAdmissionError(
      element,
      "the checkout it selected is not one this entry holds a placement for",
    );
  }
  return found;
}

/**
 * Take the hold a read needs, which is the managed slot and nothing else.
 *
 * The slot says which entry owns a managed checkout, and a restored placement
 * took none when it replayed. No mutation lease: a read changes nothing in the
 * repository, so there is nothing for one to protect — and taking one would
 * make reading a checkout block an editor committing in it.
 */
function* own(entry: ReplObservationEntry, target: ReplGitCheckout): Operation<void> {
  const registration = target.registration;
  const slot = registration.slot;
  // The root this placement recorded, not the one configured now: a restored
  // placement's slot belongs to the root it was selected under.
  const root = registration.placement.managedRoot;
  if (slot !== undefined && root !== undefined) {
    yield* holdManagedPlacement(() =>
      entry.holdSlot(root, slot.kind, slot.path, placementSubject(registration.placement)),
    );
  }
}

/**
 * Run the live read, or classify its refusal as one this record may carry.
 *
 * Joined, so every per-call native child has finished and closed and the
 * scratch it worked in has been removed before the outcome exists. A classified
 * refusal is an answer the document asked for and is written down. Anything
 * else is infrastructure: it publishes no completion, so a continuation reaches
 * the ordinary live path rather than replaying a verdict this host has no word
 * for.
 */
function* attempted(
  element: string,
  perform: () => Operation<GitObservationValue>,
): Operation<Result<GitObservationValue>> {
  try {
    return Ok(yield* scoped(perform));
  } catch (error) {
    const refusal = replObservationRefusalOf(error);
    if (refusal === undefined) {
      throw error;
    }
    return Err(new ReplObservationRefusal(element, refusal.reason, refusal.sentence));
  }
}

/**
 * The failure a refused read reaches the document as.
 *
 * Built here on a live refusal and on a replayed one alike, so the two cannot
 * diverge: what the record carries is a word and this host's own sentence, and
 * this is the one place either of them becomes an error a component shows.
 */
function failure(element: string, error: Error): Error {
  if (!(error instanceof ReplObservationRefusal)) {
    return new ReplObservationRecordError(
      `the saved refusal for ${element} carries no closed classification, so what it refused is ` +
        "unknown.",
    );
  }
  return new GitObservationError(element, error.reason, error.message);
}

/**
 * That the checkout a saved page names is one this entry registered.
 *
 * Pure arithmetic over parsed facts. The identity has to be the one this call
 * authenticated, and the root, the common directory and the worktree name have
 * to be a placement this entry holds. What it deliberately does not require is
 * that the page name the selection's own checkout: a lexical `<Repository>` can
 * own several worktrees, and a `<Dir>` into one of them selects that one.
 *
 * Effective-cwd selection is checked on the live path, where a directory is
 * resolved. A replay does not resolve an old alias again to re-prove routing
 * that already happened.
 */
function authorized(
  entry: ReplObservationEntry,
  element: string,
  request: ReplObservationRequest,
  checkout: ReplObservationCheckout,
): void {
  for (const candidate of entry.checkouts()) {
    if (
      candidate.checkout.root === checkout.root &&
      candidate.registration.placement.commonDirectory === checkout.commonDirectory &&
      candidate.checkout.repositoryName === checkout.repositoryName &&
      candidate.checkout.worktreeName === checkout.worktreeName &&
      sameRepositoryIdentity(candidate.checkout.identity, request.repository)
    ) {
      return;
    }
  }
  throw new ReplObservationRecordError(
    `the saved page for ${element} names a checkout this entry holds no placement for, so this ` +
      "history does not say where the read ran.",
  );
}

function mismatch(element: string): ReplObservationRecordError {
  return new ReplObservationRecordError(
    `the saved page standing where ${element} belongs describes another read, so this history ` +
      "does not say what happened here.",
  );
}

/** The canonical directory this path resolves to, or the path as written. */
function* canonicalPath(path: string): Operation<string> {
  try {
    return yield* until(realpath(path));
  } catch {
    return path;
  }
}

/**
 * The live boundary one recorded read publishes through.
 *
 * The same contract this feature's file work, its selections and its local Git
 * publish under. The default coordinator would serialize whatever was thrown
 * and publish it as this read's outcome, which is the one thing that must not
 * happen: a performer that broke its contract may or may not have finished, so
 * recording a completion for it would let a continuation skip a read that never
 * answered.
 *
 * A throw therefore activates the durability fence and is re-raised with its
 * identity intact, publishing nothing — and a continuation takes the ordinary
 * live path, where today's repository decides what happens next. A valid
 * outcome, page or classified refusal, is published once and returned only
 * after the append is acknowledged. A failing append is the engine's own
 * persistence fence and is not caught here.
 */
const observationCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: ProtocolResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<ProtocolResult> {
    let value: T;
    try {
      value = yield* execute();
    } catch (error) {
      throw activateFailure(error);
    }
    const result: ProtocolResult = { status: "ok", value };
    yield* publish(result);
    return result;
  },
};
