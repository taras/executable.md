/**
 * One local repository operation, performed once and replayed from its result.
 *
 * This is the whole of the REPL's local durability: an ordinary durable
 * operation whose name is this entry's own, whose value is what the operation
 * produced, and whose replay is the durable engine's own positional matching.
 * A completed operation returns its saved result and performs nothing. The first
 * operation with no saved result runs live, against whatever the environment
 * actually holds, and its outcome is appended before any later work runs.
 *
 * What is deliberately absent is the experimental protocol that preceded it. No
 * intent is written before the effect, no checkout is inventoried, no transition
 * is predicted in a scratch clone and no saved state is compared with the live
 * one. The REPL's execution model accepts that recorded values and the
 * environment can disagree; a person reading the screen is what resolves it.
 *
 * The window that honesty buys is explicit: native work can happen and its
 * result can fail to be appended. The journal then holds no completion, so a
 * continuation takes the ordinary live path and may attempt it again. That is
 * normal durable-stream behaviour rather than an exactly-once local effect, and
 * it is what the REPL trades for not snapshotting anybody's working tree.
 */

import { createContext, Err, ensure, Ok } from "effection";
import type { Context, Operation, Result } from "effection";
import { createDurableOperation, StaleInputError } from "@executablemd/durable-streams";
import { ManagedCheckoutError } from "../run-composition/errors.ts";
import type { Json } from "@executablemd/durable-streams";
import {
  parseReplRepositoryResult,
  replRepositoryRecordName,
  replRepositoryRequestJson,
  replRepositoryResultJson,
  REPL_REPOSITORY_REQUEST,
  REPL_REPOSITORY_RESULT,
  REPL_REPOSITORY_VERSION,
  retainedRefusalFilesError,
  retainedRefusalResult,
  retainedRepositoryOutcome,
  retainedRepositoryRefusal,
  retainedRepositoryRequestFingerprint,
} from "../../retained-repository/records.ts";
import type {
  ReplRepositoryRequest,
  RetainedRepositoryOperation,
  RetainedRepositorySite,
} from "../../retained-repository/records.ts";
import { parseReplRepositoryRequest } from "../../retained-repository/records.ts";

/**
 * A checkout this entry cannot work in, or a saved record it cannot read.
 *
 * Kept as this feature's own class because two different readers report it: a
 * selection that found no repository where the entry was started, and a record
 * that does not describe the operation standing where it is. Both are fatal and
 * neither is something a document may print away and carry on past.
 */
export class FrontierError extends StaleInputError {
  override name = "FrontierError";
}

/**
 * A saved record this host cannot read as its own.
 *
 * Fatal: a value where this operation's result belongs, which does not describe
 * this operation, is not something to continue past. `<PrintErrors>` cannot turn
 * it into authorization for later work.
 */
export class RetainedOperationError extends StaleInputError {
  override name = "RetainedOperationError";
}

/**
 * The shared Git directories entries of this process are working in.
 *
 * The advisory lease beside this one answers for other processes: it is a
 * kernel-released lock on a file, and a second process asking for it is told
 * no. Within one process it says nothing useful — POSIX record locks are held
 * per process, so a second entry asking for a directory this process already
 * holds is granted it — and two entries moving the refs of one repository is
 * exactly what the lease exists to prevent.
 *
 * So this is the other half of the same exclusion, and it is the only mutual
 * exclusion this feature keeps: one entry at a time per shared Git directory,
 * released when that entry's scope ends however it ends. It orders nothing and
 * remembers nothing about state — there are no lanes, no positions and no
 * expected states here, only who is working where.
 *
 * Kept as a context's default rather than a module binding, which is what makes
 * the process-wide answer the ordinary one while leaving a caller able to bind a
 * table of its own. Nothing durable depends on what it holds: it answers one
 * question, for the length of one entry, and an entry that is told no is told so
 * in a sentence.
 */
const Working: Context<Map<string, string>> = createContext<Map<string, string>>(
  "executablemd.git.repl-repository.working-directories",
  new Map(),
);

/**
 * Take this shared Git directory for the entry asking, or refuse.
 *
 * Refuses rather than waits, like the lease it stands beside: an entry that
 * cannot have the directory it needs is told so before it reads a byte of it,
 * and a person with two entries in one process gets a sentence rather than a
 * stall.
 */
export function* holdCommonDirectory(common: string, owner: string): Operation<void> {
  const working = yield* Working.expect();
  const held = working.get(common);
  if (held !== undefined && held !== owner) {
    throw new ManagedCheckoutError(
      "in-use",
      `another entry of this process is working in ${common}. Nothing was read and nothing was ` +
        "changed; it releases the directory when it ends.",
    );
  }
  if (held === undefined) {
    working.set(common, owner);
    yield* ensure(() => {
      if (working.get(common) === owner) {
        working.delete(common);
      }
    });
  }
}

/** What one local operation is, as this boundary needs to know it. */
export interface RecordedOperation {
  /** The entry this operation belongs to. */
  readonly owner: string;
  /** The canonical occurrence that asked for it. */
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  /** What the document asked for. Names the record; never live state. */
  readonly request: Json;
  /** The ordinary live work, run only when no result is saved. */
  perform(): Operation<Result<Json>>;
}

/**
 * Perform this operation, or answer with what performing it produced before.
 *
 * The result is the operation's own — the same value a live run produces and a
 * replay restores — so a caller cannot tell from it which of the two happened,
 * which is the point.
 */
export function recorded(operation: RecordedOperation): Operation<Result<Json>> {
  return recording(operation);
}

function* recording(operation: RecordedOperation): Operation<Result<Json>> {
  const fingerprint = yield* retainedRepositoryRequestFingerprint({
    owner: operation.owner,
    site: operation.site,
    operation: operation.operation,
    selection: null,
    request: operation.request,
  });
  const name = replRepositoryRecordName({
    phase: "result",
    owner: operation.owner,
    fingerprint,
    operation: operation.operation,
  });

  // Whatever comes back is journal data on a replay, so it is handed on as the
  // unknown it is and parsed below rather than trusted as this code's own.
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_RESULT, name },
    function* () {
      const outcome = yield* operation.perform();
      if (outcome.ok) {
        return replRepositoryResultJson({
          version: REPL_REPOSITORY_VERSION,
          owner: operation.owner,
          site: operation.site,
          operation: operation.operation,
          fingerprint,
          request: operation.request,
          result: outcome.value,
        });
      }
      // A refusal in this operation's own closed vocabulary is an outcome worth
      // keeping: a replay answers the same sentence rather than performing the
      // operation again. Anything else is raised, which is the ordinary failure
      // path — the engine records the error and later work does not run.
      const refusal = retainedRefusalResult(operation.operation, outcome.error);
      if (refusal === undefined) {
        throw outcome.error;
      }
      return replRepositoryResultJson({
        version: REPL_REPOSITORY_VERSION,
        owner: operation.owner,
        site: operation.site,
        operation: operation.operation,
        fingerprint,
        request: operation.request,
        result: refusal,
      });
    },
  );

  const parsed = parseReplRepositoryResult(stored);
  if (parsed === undefined) {
    // Raised rather than answered. A history this host cannot read is not an
    // outcome of the operation standing here, so it does not belong in the
    // result channel: a refusal there is the operation's own sentence, which
    // `<PrintErrors>` may print and carry on past.
    throw new RetainedOperationError(
      `the saved result for "${operation.operation}" is not one this host can read, so what ` +
        "it says about work already done is unknown.",
    );
  }
  if (
    parsed.owner !== operation.owner ||
    parsed.fingerprint !== fingerprint ||
    parsed.operation !== operation.operation ||
    parsed.site.source !== operation.site.source ||
    parsed.site.occurrence !== operation.site.occurrence
  ) {
    throw new RetainedOperationError(
      `the saved result standing where "${operation.operation}" belongs describes another ` +
        "operation, so this history does not say what happened here.",
    );
  }

  // Both branches a saved outcome has are read positively. A value that is
  // neither this operation's success nor its own refusal is journal data this
  // host cannot act on: the operation may have happened or may not, and letting
  // it answer as success is what would authorize the work standing after it.
  if (!retainedRepositoryOutcome(parsed.operation, parsed.result)) {
    throw new RetainedOperationError(
      `the saved outcome for "${operation.operation}" is neither a result it produces nor a ` +
        "refusal it reports, so what became of it is unknown.",
    );
  }

  // A retained refusal answers as the refusal it was. Read positively from the
  // operation's own vocabulary, never inferred from a result's shape.
  if (retainedRepositoryRefusal(parsed.operation, parsed.result)) {
    const error = retainedRefusalFilesError(parsed.operation, parsed.result);
    if (error === undefined) {
      throw new RetainedOperationError(
        `the saved refusal for "${operation.operation}" is one this host cannot report again.`,
      );
    }
    return Err(error);
  }
  return Ok(parsed.result);
}

/** What one external call needs resolved before a service is contacted. */
export interface ResolvedRequest {
  readonly owner: string;
  readonly site: RetainedRepositorySite;
  readonly operation: RetainedRepositoryOperation;
  /** What the document asked for. Names the record. */
  readonly request: Json;
  /** Reading the live facts that call will name, run only once. */
  resolve(): Operation<Json>;
}

/**
 * Freeze the inputs one external call resolves to, and answer with them.
 *
 * Written before the service is contacted and read back on a continuation, so
 * the same branch, commit and destination are named the second time. It says
 * nothing about what the service did: `git_host_effect` and `issue_effect`
 * remain the only authority on that.
 */
export function resolvedRequest(input: ResolvedRequest): Operation<Result<ReplRepositoryRequest>> {
  return resolving(input);
}

function* resolving(input: ResolvedRequest): Operation<Result<ReplRepositoryRequest>> {
  const fingerprint = yield* retainedRepositoryRequestFingerprint({
    owner: input.owner,
    site: input.site,
    operation: input.operation,
    selection: null,
    request: input.request,
  });
  const name = replRepositoryRecordName({
    phase: "request",
    owner: input.owner,
    fingerprint,
    operation: input.operation,
  });
  const stored: unknown = yield createDurableOperation<Json>(
    { type: REPL_REPOSITORY_REQUEST, name },
    function* () {
      return replRepositoryRequestJson({
        version: REPL_REPOSITORY_VERSION,
        owner: input.owner,
        site: input.site,
        operation: input.operation,
        fingerprint,
        request: input.request,
        resolved: yield* input.resolve(),
      });
    },
  );
  const parsed = parseReplRepositoryRequest(stored);
  if (parsed === undefined || parsed.owner !== input.owner || parsed.fingerprint !== fingerprint) {
    return Err(
      new RetainedOperationError(
        `the saved request for "${input.operation}" is not one this host can read, so what this ` +
          "entry already asked a service for is unknown.",
      ),
    );
  }
  return Ok(parsed);
}
