/**
 * One REPL entry's local Add, Switch and Commit: performed once, answered from
 * what performing them produced.
 *
 * These are the ordinary performers an `xmd run` uses, wrapped in this entry's
 * durable boundary. `<Git.Add>` stages exactly the pathspecs a document wrote,
 * `<Git.Switch>` follows the ordinary branch rules, and `<Git.Commit>` records
 * the current index under the invoking person's own author and committer. What
 * is added is memory: a completed operation answers with its saved result and
 * runs no `git`, however the checkout has changed since.
 *
 * ## A saved commit id is history, not a prediction
 *
 * The honesty the REPL trades for not snapshotting anybody's repository is
 * explicit here. A completed Commit's object id names the commit that was made
 * then; it says nothing about where HEAD is now, and nothing re-resolves it.
 * Work that physically finished and whose result was never acknowledged leaves
 * no completion, so a continuation runs it again and may get another answer —
 * including the ordinary empty-index refusal, because the earlier attempt
 * already consumed the index. Nothing rolls back, adopts, repairs or predicts.
 *
 * ## Why this reads the cursor before it resolves anything
 *
 * Routing a call means canonicalizing its working directory and choosing among
 * this entry's registered checkouts, and acquiring ownership means opening lock
 * descriptors. None of that is anything a saved result is about: a continuation
 * whose managed worktree has since been removed answers from what it already
 * recorded rather than failing at a question nobody asked. So the retained
 * cursor is read first, without consuming anything, and only a call with
 * nothing saved resolves, routes, acquires and performs.
 *
 * The read is a hint and never an authority. `createDurableOperation` remains
 * the only judge of position, type and name, so the recording callback asks for
 * the same routing and the same holds again — idempotently — around work that
 * really does run live.
 *
 * ## Two holds and one turn
 *
 * A live operation takes the selected placement's managed slot and then the
 * mutation lease on the shared Git directory, in that order, and keeps both for
 * the rest of the entry. Both are the entry's existing single-flight
 * acquisitions, so an operation inside a checkout File work already owns takes
 * nothing new. A no-op Add, a same-branch Switch and a Commit that will refuse
 * take them too: whether native work will change state is not something to
 * predict.
 *
 * Beside them, one turn per shared Git directory serializes this entry's own
 * native Git attempts with each other. It is not a transaction over anything
 * else: concurrent File work, Worktree selection and middleware keep their
 * existing scheduling, and the entry-wide locks are about other entries and
 * other processes rather than about a person's editor.
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
import type {
  GitAddInvocation,
  GitApi,
  GitCommitInvocation,
  GitSwitchInvocation,
} from "@executablemd/git/api";
import { GitOperationAdmissionError } from "@executablemd/git";
import type { GitAddResult, GitCommitResult, GitSwitchResult } from "@executablemd/git";
import { ADD, admitPathspecs } from "@executablemd/git";
import { admitCommitMessage, admitMessageSource, COMMIT } from "@executablemd/git";
import { SWITCH } from "@executablemd/git";
import { sameRepositoryIdentity } from "@executablemd/git";
import type { RepositorySelection } from "@executablemd/git/api";
import {
  parseReplGitRecord,
  replGitFingerprint,
  replGitRecordJson,
  replGitRecordName,
  replGitRefusal,
  ReplGitRefusal,
  REPL_REPOSITORY_GIT,
} from "../git-records.ts";
import type {
  ReplGitAddRequest,
  ReplGitCommitRequest,
  ReplGitRecord,
  ReplGitOperation,
  ReplGitPlace,
  ReplGitRefusalData,
  ReplGitRequest,
  ReplGitSwitchRequest,
  ReplGitValue,
} from "../git-records.ts";
import { gitCommitMessageEvidence } from "@executablemd/git/deno";
import type { DenoRepositoryOperations } from "@executablemd/git/deno";
import { GitRefusal } from "@executablemd/git/deno";
import { CompositionRefusal, refusalReason, restoredGitRefusal } from "@executablemd/git/deno";
import type { GitCommitIdentity } from "@executablemd/git/deno";
import { UnresolvedGitIdentityError } from "@executablemd/git/deno";
import { selectCheckout, type RegisteredCheckout } from "@executablemd/git/deno";
import type { SlotKind } from "@executablemd/git/deno";
import type { SelectionRegistry } from "@executablemd/git/deno";
import { holdManagedPlacement } from "./leases.ts";
import { retainedRecordAhead } from "./local.ts";
import { nativeGitTurn, placementSubject } from "./selections.ts";
import type { ReplPlacementRegistration } from "./selections.ts";

/**
 * A saved local Git result standing where this operation belongs that it cannot
 * read.
 *
 * Fatal: a value that does not describe this operation is not an outcome of it,
 * so it does not belong in the result channel. A refusal there is the
 * operation's own sentence, which `<PrintErrors>` may print and carry on past.
 */
export class ReplGitRecordError extends StaleInputError {
  override name = "ReplGitRecordError";
}

/**
 * One checkout this entry may run native Git in.
 *
 * The ordinary routing fact the shared selector reads, beside the placement
 * registration whose managed slot and recorded root a live operation
 * reacquires. An ambient owner is registered too and carries no slot: it is the
 * checkout the person was already standing in.
 */
export interface ReplGitCheckout {
  readonly checkout: RegisteredCheckout;
  readonly registration: ReplPlacementRegistration;
}

/** What recorded local Git needs from the entry that owns it. */
export interface ReplGitEntry {
  /** The native repository work this entry asks for, credential-free. */
  readonly operations: DenoRepositoryOperations;
  /**
   * Who an ordinary commit in this entry is by, or `undefined` when this host
   * cannot say.
   *
   * Acquired at most once per entry and reached only by a genuinely live
   * Commit. Add, Switch, installation, passive history and a completed Commit's
   * replay ask it nothing.
   */
  identity(): Operation<GitCommitIdentity | undefined>;
  /** Hold a managed slot for the entry, single-flight per root and slot. */
  holdSlot(root: string, kind: SlotKind, path: string, subject: string): Operation<void>;
  /** Hold the shared Git directory this operation is about to mutate in. */
  holdCommon(commonDirectory: string): Operation<void>;
  /** Run live native Git for one shared Git directory in order within this entry. */
  serialize<T>(key: string, work: () => Operation<T>): Operation<T>;
  /** This entry's private map from the selections it minted to what it holds. */
  readonly selections: SelectionRegistry<ReplPlacementRegistration>;
  /**
   * The checkouts this entry has registered, as they stand now.
   *
   * Not an operation: membership is rebuilt by selections that already
   * happened, so reading it acquires nothing.
   */
  checkouts(): readonly ReplGitCheckout[];
}

/**
 * The recorded Add, Switch and Commit this entry installs.
 *
 * Installed at the implementation slot, exactly where the ordinary provider
 * installs its own, so this is ordinary Git dispatch rather than a protected
 * channel: middleware above may answer without reaching here, refuse, or
 * transform and delegate — and when it delegates, the request that arrives is
 * the request recorded. A call answered wholly by a replacement never reaches
 * this provider and acquires none of its retention.
 *
 * Push is not one of these. Publication has its own protocol and its own
 * evidence, and a local result authorizes none of it, so it is recorded by
 * `push.ts` beside this: one request written down before a remote is contacted,
 * and the Git host's own answer reconciled afterwards.
 */
export function replGitMiddleware(entry: ReplGitEntry): Partial<Around<GitApi>> {
  return {
    switch: ([invocation]: [GitSwitchInvocation]): Operation<GitSwitchResult> =>
      recordedSwitch(entry, invocation),
    add: ([invocation]: [GitAddInvocation]): Operation<GitAddResult> =>
      recordedAdd(entry, invocation),
    commit: ([invocation]: [GitCommitInvocation]): Operation<GitCommitResult> =>
      recordedCommit(entry, invocation),
  };
}

function* recordedAdd(entry: ReplGitEntry, invocation: GitAddInvocation): Operation<GitAddResult> {
  // Admitted where the request enters, exactly as the ordinary provider admits
  // it, and copied: the Api is public, and the array a caller still holds is
  // not what this operation is named by.
  const paths = admitPathspecs(invocation.paths);
  const request: ReplGitAddRequest = Object.freeze({
    operation: "add" as const,
    ...place(entry, ADD, invocation),
    paths,
  });
  const value = yield* recorded(entry, ADD, request, (checkout, workingDirectory) =>
    entry.operations.add(checkout, workingDirectory, paths),
  );
  if (!("paths" in value)) {
    throw mismatch(ADD);
  }
  return value;
}

function* recordedSwitch(
  entry: ReplGitEntry,
  invocation: GitSwitchInvocation,
): Operation<GitSwitchResult> {
  // Read once, here, and used by both the request and the performer. The
  // invocation is the caller's own object and this operation suspends several
  // times before Git runs — hashing the request, routing, taking the turn and
  // taking two holds — so reading it again later would let the record name one
  // branch while the checkout moved to another.
  const branch = invocation.branch;
  const base = invocation.base;
  const request: ReplGitSwitchRequest = Object.freeze({
    operation: "switch" as const,
    ...place(entry, SWITCH, invocation),
    branch,
    base: base ?? null,
  });
  const value = yield* recorded(entry, SWITCH, request, (checkout, workingDirectory) =>
    entry.operations.switch(checkout, workingDirectory, branch, base),
  );
  if (!("requestedBranch" in value)) {
    throw mismatch(SWITCH);
  }
  return value;
}

function* recordedCommit(
  entry: ReplGitEntry,
  invocation: GitCommitInvocation,
): Operation<GitCommitResult> {
  const message = admitCommitMessage(invocation.message);
  const messageSource = admitMessageSource(invocation.messageSource);
  const evidence = gitCommitMessageEvidence(message);
  const request: ReplGitCommitRequest = Object.freeze({
    operation: "commit" as const,
    ...place(entry, COMMIT, invocation),
    messageSource,
    messageDigest: evidence.digest,
    messageLength: evidence.length,
  });
  const value = yield* recorded(entry, COMMIT, request, function* (checkout, workingDirectory) {
    // Read here, because this is the operation that needs it: an entry that
    // commits nothing asks the host nothing about who it is, and a completed
    // Commit never reaches this callback at all.
    return yield* entry.operations.commit(
      checkout,
      workingDirectory,
      message,
      messageSource,
      yield* entry.identity(),
    );
  });
  if (!("commit" in value)) {
    throw mismatch(COMMIT);
  }
  return value;
}

/**
 * Where this invocation runs, as this entry's own registry describes it.
 *
 * The received selection is authenticated before anything else and its *parsed*
 * facts are what the request carries. The fresh opaque identifier the provider
 * minted for this entry never appears: it names nothing once the entry ends, so
 * a durable name built from one would differ on every reopen of the same
 * question.
 */
function place(
  entry: ReplGitEntry,
  element: string,
  invocation: { readonly repository: RepositorySelection; readonly workingDirectory: string },
): ReplGitPlace {
  const placement = entry.selections.authenticate(
    invocation.repository,
    () =>
      new GitOperationAdmissionError(
        element,
        "the Repository in scope is not one this entry selected, so it names no checkout",
      ),
  ).placement;
  return {
    repository: placement.identity,
    selectionCheckout: placement.checkoutRoot,
    commonDirectory: placement.commonDirectory,
    // Exactly as received. Resolving it is live routing, which a completed
    // operation does not do, so the name cannot depend on it.
    workingDirectory: invocation.workingDirectory,
  };
}

/**
 * Perform this operation, or answer with what performing it produced before.
 *
 * The result is the operation's own — the same value a live call produces and a
 * replay restores — so a caller cannot tell from it which of the two happened,
 * which is the point. An ordinary refusal is raised from the saved
 * classification on both paths, by this one route, so a live refusal and a
 * replayed one are the same error for the same element.
 */
function* recorded(
  entry: ReplGitEntry,
  element: string,
  request: ReplGitRequest,
  perform: (checkout: RegisteredCheckout, workingDirectory: string) => Operation<ReplGitValue>,
): Operation<ReplGitValue> {
  const fingerprint = yield* replGitFingerprint(request);
  const name = replGitRecordName({ operation: request.operation, fingerprint });

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
      { type: REPL_REPOSITORY_GIT, name },
      function* () {
        const target = yield* routing();
        yield* own(entry, target);
        const outcome = yield* attempted(request.operation, function* () {
          return yield* perform(target.checkout, request.workingDirectory);
        });
        const payload = replGitRecordJson({ fingerprint, request, outcome });
        // Read back before the coordinator publishes it. A payload this build
        // cannot parse, or one describing another request or a checkout this
        // entry holds no placement for, is not an outcome to acknowledge: it
        // takes the fatal path here, so nothing is appended and a continuation
        // meets today's checkout instead of a record it could never read.
        readback(entry, element, request, fingerprint, payload);
        return payload;
      },
      { coordinator: gitCoordinator },
    );
  }

  // Journal data on a replay, so it arrives as the unknown it is and is parsed
  // below rather than trusted as this code's own.
  const stored: unknown = (yield* retainedRecordAhead(REPL_REPOSITORY_GIT, name))
    ? yield* once()
    : yield* live(entry, routing, once);

  const parsed = readback(entry, element, request, fingerprint, stored);
  if (!parsed.outcome.ok) {
    throw failure(element, refusalOf(parsed.outcome.error));
  }
  return parsed.outcome.value;
}

/**
 * The record this value is for this operation, or the fatal failure it is not.
 *
 * The same three questions on both paths, which is the point: a live outcome is
 * held to them before it is published, and a restored one before it is
 * returned. The payload parses, it describes this request, and the checkout a
 * success names is one this entry registered under the repository it
 * authenticated — with parsed facts alone, so a result path never authorizes a
 * native call and a new call chooses its checkout independently.
 */
function readback(
  entry: ReplGitEntry,
  element: string,
  request: ReplGitRequest,
  fingerprint: string,
  stored: unknown,
): ReplGitRecord {
  const parsed = parseReplGitRecord(stored);
  if (parsed === undefined) {
    throw new ReplGitRecordError(
      `the saved result for ${element} is not one this host can read, so what it says about work ` +
        "already done is unknown.",
    );
  }
  if (parsed.operation !== request.operation || parsed.fingerprint !== fingerprint) {
    throw mismatch(element);
  }
  if (parsed.outcome.ok) {
    authorized(entry, element, request, parsed.outcome.value);
  }
  return parsed;
}

/**
 * Route, take the turn, take ownership, and perform.
 *
 * Acquisition happens outside the recorded operation, which is what keeps a
 * slot another entry holds a fatal diagnostic the person can act on rather than
 * a durable outcome — and keeps temporary contention out of the journal
 * entirely.
 */
function* live(
  entry: ReplGitEntry,
  routing: () => Operation<ReplGitCheckout>,
  once: () => Operation<unknown>,
): Operation<unknown> {
  const target = yield* routing();
  return yield* entry.serialize(
    nativeGitTurn(target.registration.placement.commonDirectory),
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
  entry: ReplGitEntry,
  element: string,
  request: ReplGitRequest,
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
 * Take ownership of the checkout this operation is about to change.
 *
 * The managed slot first and the shared Git directory second, because the slot
 * says which entry owns a managed checkout and the lease says which entry is
 * changing a repository — and a restored placement took neither when it
 * replayed. An ambient target has no slot: it is the checkout the person was
 * already in.
 */
function* own(entry: ReplGitEntry, target: ReplGitCheckout): Operation<void> {
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
  yield* entry.holdCommon(registration.placement.commonDirectory);
}

/**
 * Run the live performer, or classify its refusal as one this record may carry.
 *
 * Joined, so every per-call native child has finished and closed before the
 * outcome exists — the entry's own Git session, its isolation directory, the
 * identity acquisition and both holds stay outside, where the entry owns them.
 *
 * A classified refusal is an answer the document asked for and is written down.
 * Anything else is infrastructure: it publishes no completion, so a continuation
 * reaches the ordinary live path rather than replaying a verdict this host has
 * no word for.
 */
function* attempted(
  operation: ReplGitOperation,
  perform: () => Operation<ReplGitValue>,
): Operation<Result<ReplGitValue>> {
  try {
    return Ok(yield* scoped(perform));
  } catch (error) {
    const refusal = classified(operation, error);
    if (refusal === undefined) {
      throw error;
    }
    return Err(new ReplGitRefusal(refusal));
  }
}

/**
 * The closed classification this failure refuses under, or `undefined`.
 *
 * Three routes, and each keeps its own. A native `GitRefusal` is what `git`
 * itself reported; a `CompositionRefusal` carries a word from the Git
 * vocabulary this provider owns; and an absent ordinary identity is the host
 * saying it cannot name a committer. Keeping them apart is what stops a native
 * Add's ignored-path refusal from being rebuilt with the Workflow formatter's
 * sentence, which says the staging was discarded — nothing here discards
 * anything.
 *
 * Lock contention, admission and infrastructure failures are none of these.
 * Each is decided before an operation exists or describes a condition this host
 * has no word for, and writing one down would make it the permanent answer
 * every later continuation replays.
 */
function classified(operation: ReplGitOperation, error: unknown): ReplGitRefusalData | undefined {
  if (error instanceof GitRefusal) {
    return replGitRefusal(operation, "native-git", error.reason);
  }
  if (error instanceof UnresolvedGitIdentityError) {
    return replGitRefusal(operation, "ordinary-identity", error.reason);
  }
  if (!(error instanceof CompositionRefusal)) {
    return undefined;
  }
  const word = refusalReason(error, "git");
  return word === undefined ? undefined : replGitRefusal(operation, "composition-git", word);
}

/**
 * The failure a refused operation reaches the document as.
 *
 * Built here on a live refusal and on a replayed one alike, so the two cannot
 * diverge: what the record carries is a vocabulary and a word, and this is the
 * one place either of them becomes an error a component shows.
 */
function failure(element: string, data: ReplGitRefusalData): Error {
  if (data.vocabulary === "native-git") {
    return new GitRefusal(data.reason);
  }
  if (data.vocabulary === "ordinary-identity") {
    return new UnresolvedGitIdentityError();
  }
  const refusal = restoredGitRefusal(element, data.reason);
  if (refusal === undefined) {
    return new ReplGitRecordError(
      `the saved refusal for ${element} names a condition this build has no word for, so what it ` +
        "refused is unknown.",
    );
  }
  return refusal;
}

/**
 * The refusal data a parsed failure carries.
 *
 * The codec's failure side is `ReplGitRefusal` by construction, so anything
 * else here is this host's own invariant rather than something a record did.
 */
function refusalOf(error: Error): ReplGitRefusalData {
  if (!(error instanceof ReplGitRefusal)) {
    throw new ReplGitRecordError(
      "a saved local Git refusal carries no closed classification, so what it refused is unknown.",
    );
  }
  return error.refusal;
}

/**
 * That the checkout a saved result names is one this entry registered.
 *
 * Pure arithmetic over parsed facts. The identity has to be the one this call
 * authenticated, and the path and the worktree name have to be a placement this
 * entry holds. What it deliberately does not require is that the result name the
 * selection's own checkout: a lexical `<Repository>` can own several worktrees,
 * and a `<Dir>` into one of them selects that one.
 *
 * Effective-cwd selection is checked on the live path, where a directory is
 * resolved. A replay does not resolve an old alias again to re-prove routing
 * that already happened.
 */
function authorized(
  entry: ReplGitEntry,
  element: string,
  request: ReplGitRequest,
  value: ReplGitValue,
): void {
  const identity = value.checkout;
  for (const candidate of entry.checkouts()) {
    if (
      candidate.checkout.root === identity.checkoutPath &&
      candidate.checkout.repositoryName === identity.repositoryName &&
      candidate.checkout.worktreeName === identity.worktreeName &&
      sameRepositoryIdentity(candidate.checkout.identity, request.repository)
    ) {
      return;
    }
  }
  throw new ReplGitRecordError(
    `the saved result for ${element} names a checkout this entry holds no placement for, so this ` +
      "history does not say where the operation ran.",
  );
}

function mismatch(element: string): ReplGitRecordError {
  return new ReplGitRecordError(
    `the saved result standing where ${element} belongs describes another operation, so this ` +
      "history does not say what happened here.",
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
 * The live boundary one recorded local Git operation publishes through.
 *
 * The same contract this feature's file work and its selections publish under.
 * The default coordinator would serialize whatever was thrown and publish it as
 * this operation's outcome, which is the one thing that must not happen: a
 * performer that broke its contract may or may not have moved a branch, so
 * recording a completion for it would let a continuation skip work that never
 * happened.
 *
 * A throw therefore activates the durability fence and is re-raised with its
 * identity intact, publishing nothing — and a continuation takes the ordinary
 * live path, where today's checkout decides what happens next. A valid outcome,
 * success or classified refusal, is published once and returned only after the
 * append is acknowledged. A failing append is the engine's own persistence fence
 * and is not caught here.
 */
const gitCoordinator: LiveDurableOperationCoordinator = {
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
