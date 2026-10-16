/**
 * One local file operation, performed once and answered from its result.
 *
 * The file half of the REPL's local durability, and the substrate the local Git
 * half beside it reuses: an ordinary durable operation whose name is this
 * entry's own, whose value is what the ordinary Files call produced, and whose
 * replay is the durable engine's own positional matching. A completed operation answers with its saved result and touches no
 * file, however the file has changed since. The first operation with no saved
 * result runs live, against whatever the environment actually holds.
 *
 * Nothing is inventoried, predicted or compared. The window that honesty buys
 * is explicit: native work can happen and its result can fail to be appended.
 * The journal then holds no completion, so a continuation takes the ordinary
 * live path and may attempt it again. That is normal durable-stream behavior
 * rather than an exactly-once local effect, and it is what the REPL trades for
 * not snapshotting anybody's working tree.
 *
 * ## Why this reads the cursor before it looks at the filesystem
 *
 * Deciding whether a path is inside the checkout means resolving it, and
 * resolving it means touching a filesystem the saved result is not about — a
 * continuation whose checkout has since been deleted would fail at the question
 * rather than answer from what it already knows. So the retained cursor is read
 * first, without consuming anything: a position holding this operation's own
 * record is answered from the record, and only an operation with nothing saved
 * resolves, routes, leases and performs.
 *
 * The read is a hint and never an authority. `createDurableOperation` remains
 * the only consumer of the cursor and the only judge of position, type and name,
 * so a peek that guessed wrong costs a wasted comparison and changes no outcome.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { createDurableOperation, DurableContext } from "@executablemd/durable-streams";
import type {
  ActivateDurabilityFailure,
  Json,
  LiveDurableOperationCoordinator,
  Result as ProtocolResult,
} from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import { asFilesFatal, FilesInvariantError } from "@executablemd/runtime";
import {
  parseReplLocalRecord,
  parseReplSelectionRecord,
  replLocalFingerprint,
  replLocalRecordJson,
  replLocalRecordName,
  replSelectionFingerprint,
  replSelectionRecordJson,
  replSelectionRecordName,
  REPL_REPOSITORY_LOCAL,
  REPL_REPOSITORY_SELECTION,
  retainableRefusal,
} from "../../retained-repository/records.ts";
import type {
  ReplAmbientCheckout,
  ReplLocalOperation,
  ReplLocalRequest,
  ReplLocalValue,
} from "../../retained-repository/records.ts";

/**
 * A saved record standing where this operation belongs that it cannot read.
 *
 * Fatal: a value that does not describe this operation is not an outcome of it,
 * so it does not belong in the result channel. A refusal there is the
 * operation's own sentence, which `<PrintErrors>` may print and carry on past.
 */
export class ReplLocalRecordError extends StaleInputError {
  override name = "ReplLocalRecordError";
}

/** One local mutation, as this durable boundary needs it described. */
export interface LocalOperation {
  readonly operation: ReplLocalOperation;
  /** What the document asked for. Names the record; never live state. */
  readonly request: ReplLocalRequest;
  /** The ordinary composed call, run only when no result is saved. */
  perform(): Operation<Result<ReplLocalValue>>;
}

/** Where this entry's ambient routing comes from when none is saved. */
export interface AmbientSelectionSource {
  /** The directory discovery starts from. */
  readonly cwd: string;
  /** The live discovery, run only when no routing is saved. */
  discover(): Operation<ReplAmbientCheckout | undefined>;
}

/** The name this operation's record is journaled under. */
export function* localRecordName(operation: {
  readonly operation: ReplLocalOperation;
  readonly request: ReplLocalRequest;
}): Operation<string> {
  return replLocalRecordName({
    operation: operation.operation,
    fingerprint: yield* replLocalFingerprint(operation),
  });
}

/**
 * Whether the next retained position in this coroutine holds this record.
 *
 * Reads the description alone and consumes nothing. A `true` says a saved
 * result is probably standing here, which is reason enough to answer from the
 * journal instead of resolving a path; the matcher below decides whether it
 * really is.
 */
export function* retainedRecordAhead(type: string, name?: string): Operation<boolean> {
  const context = yield* DurableContext.expect();
  const entry = context.replayIndex.peekYield(context.coroutineId);
  if (entry === undefined || entry.description.type !== type) {
    return false;
  }
  return name === undefined || entry.description.name === name;
}

/**
 * Which durable coroutine is asking.
 *
 * A record belongs to a position in one coroutine, so anything this host
 * remembers *about* records has to be remembered per coroutine too. An entry is
 * one journal with several coroutines in it, and `<All>` is how a document gets
 * more than one.
 */
export function* currentCoroutine(): Operation<string> {
  const context = yield* DurableContext.expect();
  return context.coroutineId;
}

/** Whether this entry's saved ambient routing stands at the cursor. */
export function retainedSelectionAhead(): Operation<boolean> {
  return retainedRecordAhead(REPL_REPOSITORY_SELECTION);
}

/** Whether this operation's own saved result stands at the cursor. */
export function retainedResultAhead(name: string): Operation<boolean> {
  return retainedRecordAhead(REPL_REPOSITORY_LOCAL, name);
}

/**
 * This entry's ambient routing, restored from the journal or discovered live.
 *
 * Routing facts only: the request, the checkout root and the common Git
 * directory, or their absence. Restoring them authenticates no checkout and
 * acquires no lease — a continuation that reads them has learned where this
 * entry was working, which is not permission to work there.
 */
export function selectedCheckout(
  source: AmbientSelectionSource,
): Operation<ReplAmbientCheckout | undefined> {
  return selecting(source);
}

function* selecting(source: AmbientSelectionSource): Operation<ReplAmbientCheckout | undefined> {
  const fingerprint = yield* replSelectionFingerprint({ cwd: source.cwd });
  const name = replSelectionRecordName({ fingerprint });

  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_SELECTION, name },
    function* () {
      return replSelectionRecordJson({ cwd: source.cwd, checkout: yield* source.discover() });
    },
  );

  const parsed = parseReplSelectionRecord(stored);
  if (parsed === undefined || parsed.cwd !== source.cwd) {
    throw new ReplLocalRecordError(
      "the saved routing for this entry is not one this host can read, so where it was working " +
        "is unknown.",
    );
  }
  return parsed.checkout ?? undefined;
}

/**
 * Perform this operation, or answer with what performing it produced before.
 *
 * The result is the operation's own — the same value a live call produces and a
 * replay restores — so a caller cannot tell from it which of the two happened,
 * which is the point.
 */
export function recordedLocalOperation(
  operation: LocalOperation,
): Operation<Result<ReplLocalValue>> {
  return recording(operation);
}

function* recording(operation: LocalOperation): Operation<Result<ReplLocalValue>> {
  const fingerprint = yield* replLocalFingerprint({
    operation: operation.operation,
    request: operation.request,
  });
  const name = replLocalRecordName({ operation: operation.operation, fingerprint });

  // Whatever comes back is journal data on a replay, so it is handed on as the
  // unknown it is and parsed below rather than trusted as this code's own.
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_LOCAL, name },
    function* () {
      const outcome = yield* operation.perform();
      if (!outcome.ok && !retainableRefusal(outcome.error)) {
        // Not a refusal in the ordinary Files vocabulary, so not an outcome
        // this host may write down as one. The coordinator below classifies it.
        throw outcome.error;
      }
      return replLocalRecordJson({
        operation: operation.operation,
        fingerprint,
        request: operation.request,
        outcome,
      });
    },
    { coordinator: localOperationCoordinator },
  );

  const parsed = parseReplLocalRecord(stored);
  if (parsed === undefined) {
    throw new ReplLocalRecordError(
      `the saved result for "${operation.operation}" is not one this host can read, so what it ` +
        "says about work already done is unknown.",
    );
  }
  if (parsed.operation !== operation.operation || parsed.fingerprint !== fingerprint) {
    throw new ReplLocalRecordError(
      `the saved result standing where "${operation.operation}" belongs describes another ` +
        "operation, so this history does not say what happened here.",
    );
  }
  return parsed.outcome.ok ? Ok(parsed.outcome.value) : Err(parsed.outcome.error);
}

/**
 * The live boundary one local operation publishes through.
 *
 * The default coordinator serializes whatever was thrown and publishes it as
 * this operation's outcome, which is the one thing that must not happen here: a
 * provider that broke its contract may or may not have changed the file, so
 * recording a completion for it would let a continuation skip work that never
 * happened — and serializing it would lose the Files classification the engine
 * and `<PrintErrors>` both read.
 *
 * So a throw is classified, activates the durability fence and is rethrown with
 * its identity intact, publishing nothing. An already active failure wins over
 * the new one: the first failure is the one that describes what went wrong.
 *
 * A valid outcome — success or an ordinary refusal — is published once and
 * returned. A failing append is the engine's own persistence fence and is not
 * caught here.
 */
const localOperationCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: ProtocolResult) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
  ): Operation<ProtocolResult> {
    let value: T;
    try {
      value = yield* execute();
    } catch (error) {
      throw activateFailure(classify(error));
    }
    const result: ProtocolResult = { status: "ok", value };
    yield* publish(result);
    return result;
  },
};

/**
 * What this throw is, in the vocabulary the engine already fences on.
 *
 * The search order is core's own at the Files boundary: a durability failure
 * keeps its identity, then an infrastructure failure keeps its data, and only
 * something that is neither becomes a fresh `protocol` invariant carrying no
 * cause, message or host value. A handler that threw an arbitrary object is
 * precisely the case where nothing it produced can be trusted.
 */
function classify(error: unknown): Error {
  if (error instanceof StaleInputError) {
    return error;
  }
  if (error instanceof Error && asFilesFatal(error) !== undefined) {
    return error;
  }
  return new FilesInvariantError("protocol");
}
