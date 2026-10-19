/**
 * One retained pull-request read, for every host that retains one.
 *
 * `PullRequest.Reviews`, `.Comments` and `.Checks` are read by a workflow run
 * and by a REPL entry, and until this module existed each of those hosts had
 * its own answer to the same questions: what a sound answer is, when one may be
 * acknowledged, what a saved one has to be before it is restored, and what a
 * failure encodes as. Two answers to one question is one answer too many — the
 * workflow half checked only the collection kind and acknowledged from inside
 * the durable operation, so a checks envelope describing another commit was
 * saved as a success and a cleanup that failed could not take back what had
 * already been published. Those are not two policies. They are one rule and one
 * host that had drifted from it.
 *
 * So this is where the rule lives, and both hosts call it. What a host still
 * owns is exactly what only it can know: the identity a fresh read is asked
 * under, and which recorded owners its own history may inherit. A host does not
 * decide what a valid answer is, when one is settled, how a failure is written
 * down, or which worker performs the read.
 *
 * ## Four places, one validator
 *
 * The same answer is held to the same contract wherever it appears: before a
 * success is appended, when a saved one is restored, when a history is admitted
 * before any of it replays, and after the public chain has composed over it and
 * before items reach a binding. The last of those is why the validator takes
 * the value rather than a parsed record — an outer handler may answer with
 * anything, and what the element binds has to be evidence whatever produced it.
 *
 * Validation runs *through the codec that writes the record* rather than over
 * the object in hand, because what has to be the evidence a read produces is
 * the value the journal would hold, not the shape a provider happened to build.
 *
 * ## The attempt, and what may be acknowledged
 *
 * A read opens things: an authenticated session, a page walk, whatever a
 * provider acquires. The attempt therefore runs in a scope of its own, and that
 * scope is closed before either outcome is published — otherwise a reopen could
 * restore a read whose first run was still unwinding when the journal said it
 * was done.
 *
 * The attempt reports its own refusal rather than raising it, so a scope that
 * returns at all is a scope that closed, and that return is what admits an
 * outcome to publication. Nothing about the exception a failure arrives as
 * takes part in the decision; a body and its cleanup can raise one object, and
 * a teardown error wins over a body error, so no inspection could separate
 * them. A throw reaching the boundary is the boundary failing — a cleanup that
 * threw, or a failure nobody here authored — and it publishes nothing and
 * activates the run's existing fail-stop state. An interruption publishes
 * nothing at all, which leaves the read repeatable: safe, in the way repeating
 * a mutation is not.
 *
 * ## Why the name omits the owner
 *
 * A read is named by its expansion and the question it asks, and deliberately
 * not by who asked. A fork is a different run reaching the same position with
 * the same question, and a name carrying the run would make every inherited
 * read unforkable. Which history a record belongs to is therefore asked
 * separately, by the owner policy a host supplies — strictly, for an entry that
 * must not present another entry's read; permissively, for a run whose journal
 * construction already settled its provenance.
 */

import { scoped, until } from "effection";
import type { Operation } from "effection";
import { getExpansion, isJsonObject, sourceDescription } from "@executablemd/core";
import type { JournalAdmission } from "@executablemd/core/api";
import {
  createDurableOperation,
  serializeError,
  StaleInputError,
} from "@executablemd/durable-streams";
import type {
  AbandonedRetainedHistory,
  ActivateDurabilityFailure,
  DurableEvent,
  EffectDescription,
  Json,
  JournalProvenance,
  LiveDurableOperationCoordinator,
  Result as DurableResult,
} from "@executablemd/durable-streams";
import { PullRequestReadError } from "./errors.ts";
import {
  parsePullRequestReadRequest,
  parsePullRequestReadResult,
  PULL_REQUEST_READ,
  pullRequestReadEnvelopeJson,
  pullRequestReadHeadsAgree,
  pullRequestReadRequestJson,
} from "./pull-request-read-records.ts";
import type {
  PullRequestReadKind,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "./pull-request-read-records.ts";

/** Which element a refusal names, by the collection it was reading. */
const ELEMENT: Readonly<Record<PullRequestReadKind, string>> = Object.freeze({
  reviews: "<PullRequest.Reviews>",
  comments: "<PullRequest.Comments>",
  checks: "<PullRequest.Checks>",
});

/** Which element a pull-request read refusal names, by its collection. */
export function pullRequestReadElement(kind: PullRequestReadKind): string {
  return ELEMENT[kind];
}

/**
 * Which recorded owners a host's own history may inherit.
 *
 * A predicate and nothing more: it answers about an owner this module has
 * already parsed out of a record, and it never reads a record, replaces a
 * value, reaches another execution's state or decides anything else.
 */
export type ReadOwnerPolicy = (recordedOwner: string) => boolean;

/** Why a retained evidence-read history cannot be continued. */
export type PullRequestReadHistoryRefusal =
  /** A retained read whose description this host cannot read. */
  | "malformed-record"
  /** A retained read naming a history that is not this one's. */
  | "foreign-owner"
  /** A retained read journaled under a name or configuration its own question does not produce. */
  | "request-fingerprint"
  /** A settled read holding a value that is not the evidence a read produces. */
  | "malformed-result";

/**
 * A retained evidence-read history that cannot be continued from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past.
 */
export class PullRequestReadHistoryError extends StaleInputError {
  override name = "PullRequestReadHistoryError";

  readonly reason: PullRequestReadHistoryRefusal;

  constructor(reason: PullRequestReadHistoryRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * The evidence this value is, or the refusal that it is none.
 *
 * One validator, four callers. The value is parsed, written through the record
 * codec and parsed again, because the contract is about what this position
 * would append rather than about the object a provider built. A collection
 * other than the one asked for, an item shape no reader can parse, and a checks
 * envelope holding an item about a commit other than the head it recorded are
 * each answers whose meaning is unknown, and an unknown answer is not one to
 * acknowledge, restore or bind.
 */
export function validatePullRequestReadResult(
  answered: unknown,
  kind: PullRequestReadKind,
): PullRequestReadResult {
  const offered = readValue(answered);
  if (offered === undefined || offered.kind !== kind) {
    throw new PullRequestReadError(
      "protocol",
      ELEMENT[kind],
      "the answer it received is not the evidence that read produces, so nothing was retained " +
        "for it.",
    );
  }
  const written = parsePullRequestReadResult(pullRequestReadEnvelopeJson(offered));
  if (written === undefined || written.kind !== kind) {
    throw new PullRequestReadError(
      "protocol",
      ELEMENT[kind],
      "the answer it received is not a value this read can record, so nothing was retained " +
        "for it.",
    );
  }
  if (!pullRequestReadHeadsAgree(written)) {
    throw new PullRequestReadError(
      "protocol",
      ELEMENT[kind],
      "the checks it received include one about a commit other than the head they were read " +
        "at, so what they say about that commit is unknown and nothing was retained for it.",
    );
  }
  return written;
}

/**
 * This value as the codec can read it, or nothing.
 *
 * The final boundary is handed whatever an outer handler answered with, so the
 * value arrives as `unknown` and the parse below is what decides. Narrowing it
 * here keeps that one question in one place.
 */
function readValue(answered: unknown): PullRequestReadResult | undefined {
  return isJsonObject(answered as Json) ? parsePullRequestReadResult(answered as Json) : undefined;
}

/**
 * The durable name and configuration one read's question produces.
 *
 * The platform's `crypto`, adapted with `until`: this is shared code and it
 * names no host, so the digest cannot be the synchronous native one. The bytes
 * are the ones every existing record was named under — each value as its
 * JavaScript UTF-16 length, a colon and the value, `null` as `-`, concatenated,
 * encoded as big-endian UTF-16 code units, SHA-256, first sixteen hex
 * characters — because a name that moved would make every saved read a
 * different read.
 */
export function* pullRequestReadName(request: PullRequestReadRequest): Operation<{
  readonly name: string;
  readonly configuration: string;
}> {
  const canonical = [request.operation, request.url, request.provider, request.kind]
    .map((value) => (value === null ? "-" : `${value.length}:${value}`))
    .join("");
  const digest = yield* until(crypto.subtle.digest("SHA-256", codeUnits(canonical)));
  const configuration = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
  return { name: `${request.expansionId}:${configuration}`, configuration };
}

/** One string's UTF-16 code units, big-endian, two bytes each. */
function codeUnits(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length * 2));
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    bytes[index * 2] = unit >> 8;
    bytes[index * 2 + 1] = unit & 0xff;
  }
  return bytes;
}

/** How this read is described where it is journaled. */
export function* describePullRequestRead(
  request: PullRequestReadRequest,
): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const { name, configuration } = yield* pullRequestReadName(request);
  return {
    type: PULL_REQUEST_READ,
    name,
    input: pullRequestReadRequestJson(request),
    configuration,
    ...sourceDescription(expansion.position),
  };
}

/**
 * Retain this read, or restore what is already retained.
 *
 * Reached only after a transport has matched the request, admitted it against
 * the host's current ceiling and validated the target — so the effect this
 * creates always describes a question the execution was permitted to ask, and a
 * refusal before this point saves nothing and opens no credential. Everything
 * from here is durable: an expected failure is retained as this read's own
 * answer and binds no partial collection, and a completed read restores its
 * snapshot without opening a session or reaching the network.
 */
export function* retainPullRequestRead(
  request: PullRequestReadRequest,
  transport: () => Operation<PullRequestReadResult>,
): Operation<PullRequestReadResult> {
  const description = yield* describePullRequestRead(request);
  // One attempt per read, reachable only from the two halves of this operation.
  // Nothing a provider, a handler or a document holds can put an answer in it.
  const attempt: ReadAttempt = {};
  const stored: unknown = yield createDurableOperation<Json>(
    description,
    function* (): Operation<Json> {
      try {
        const answered = yield* transport();
        return pullRequestReadEnvelopeJson(validatePullRequestReadResult(answered, request.kind));
      } catch (error) {
        // Reported rather than raised. An expected read failure is this read's
        // own answer, and raising it would carry it out through the same
        // channel that reports a scope which failed to close — where no
        // inspection of the error could tell one of those from the other. A
        // refusal has no envelope, and the value it returns is never read.
        attempt.refusal = { error: readFailure(error) };
        return null;
      }
    },
    { coordinator: readCoordinator(attempt) },
  );
  return validatePullRequestReadResult(stored, request.kind);
}

/**
 * What one read's own attempt reported, as only this operation can see it.
 *
 * Present and holding the failure when the read raised instead of answering,
 * and absent otherwise — boxed, so a read that raised something undefined still
 * reports a refusal. It is written before the attempt's scope begins to close
 * and read only after that scope has closed, which is what keeps it an account
 * of the read rather than of the unwinding.
 */
interface ReadAttempt {
  refusal?: { readonly error: Error };
}

/**
 * This read's attempt boundary: finish, tear down, join, then acknowledge.
 *
 * A live operation that appended nothing would leave the next one to append at
 * this one's position, so a boundary failure activates the run's existing
 * first-failure fence rather than quietly continuing.
 */
function readCoordinator(attempt: ReadAttempt): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: DurableResult) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      _journalProvenance: JournalProvenance | undefined,
      _abandoned: AbandonedRetainedHistory,
    ): Operation<DurableResult> {
      let answered: T;
      try {
        answered = yield* scoped(execute);
      } catch (error) {
        throw activateFailure(
          error instanceof Error ? error : new Error("the evidence read boundary failed"),
        );
      }
      // The scope returned, so the attempt and everything it opened are closed,
      // and what the attempt reported is now this read's outcome.
      const refusal = attempt.refusal;
      const result: DurableResult =
        refusal === undefined
          ? { status: "ok", value: answered }
          : { status: "err", error: serializeError(refusal.error) };
      yield* publish(result);
      return result;
    },
  };
}

/**
 * The failure a new attempt records.
 *
 * An actual Error keeps its own name, message and stack, because that is what
 * the reader of a failed read needs. Anything else carries no diagnosis worth
 * encoding, and one fixed sentence is better than a host-specific rendering of
 * a value nobody can interpret.
 */
function readFailure(raised: unknown): Error {
  return raised instanceof Error ? raised : new Error("the pull-request evidence read failed");
}

/**
 * What a host requires of the evidence reads its history holds.
 *
 * Integrity, ownership and result, asked of every retained read before any of
 * it replays. The description is held to the name and configuration its own
 * question produces — the two are not redundant, because the name a position
 * publishes under is the invocation plus the fingerprint, so a record moved to
 * another position keeps a fingerprint its name no longer exposes.
 *
 * Ownership is the host's policy and nothing else here is. It is asked of a
 * failed read's description too: a failure retains no result to check, but its
 * description still says who asked. Nothing here contacts a URL, opens a
 * session or hands a result out, and whether the ceiling still authorizes a
 * saved read is a different question the adapter asks on every execution.
 */
export function pullRequestReadAdmission(acceptOwner: ReadOwnerPolicy): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    for (const event of retained) {
      if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
        continue;
      }
      const request = parsePullRequestReadRequest(event.description["input"]);
      if (request === undefined) {
        throw historyRefusal(
          "malformed-record",
          "a retained evidence read in this history is not one this host can read, so what it " +
            "says was read is unknown.",
        );
      }
      if (!acceptOwner(request.runId)) {
        throw historyRefusal(
          "foreign-owner",
          "a retained evidence read in this history was written under another owner, so the " +
            "collection it describes was not read here and its record is not one this history " +
            "can present again.",
        );
      }
      // The name and the configuration, but not the whole description: this
      // runs over a retained history before any element is expanding, and the
      // source position a description also carries is only available there.
      const named = yield* pullRequestReadName(request);
      if (event.description.name !== named.name) {
        throw historyRefusal(
          "request-fingerprint",
          "a retained evidence read is journaled under a name that is not the name its own " +
            "question produces, so the record and the read it names do not match.",
        );
      }
      if (event.description.configuration !== named.configuration) {
        throw historyRefusal(
          "request-fingerprint",
          "a retained evidence read is journaled with a configuration that is not the one its " +
            "own question produces, so the record and the read it describes do not match.",
        );
      }
      if (event.result.status !== "ok") {
        // A refused read retains no result of its own: its outcome is the
        // durable operation's failed result, and there is nothing in it to hold
        // to a collection. Its description was still held to this history above.
        continue;
      }
      try {
        validatePullRequestReadResult(event.result.value, request.kind);
      } catch {
        throw historyRefusal(
          "malformed-result",
          "a retained evidence read holds a value that is not the collection its own question " +
            "asked for, or a checks item for a different head than the one it recorded, so " +
            "what it says was read is unknown.",
        );
      }
    }
  };
}

function historyRefusal(
  reason: PullRequestReadHistoryRefusal,
  sentence: string,
): PullRequestReadHistoryError {
  return new PullRequestReadHistoryError(reason, sentence);
}
