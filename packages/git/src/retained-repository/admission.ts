/**
 * What one entry's retained repository history says, and whether it says it
 * consistently.
 *
 * This is the whole of the decision a later open makes before it touches a
 * checkout: which effects already completed, which one was interrupted, and
 * what state each checkout was left in. It reads the exact frozen snapshot core
 * admitted and answers with detached data. It selects nothing, leases nothing,
 * opens no repository and installs no context, so a wrong answer here cannot
 * reach a mutation — it can only refuse one.
 *
 * Refusal is the point. A history this code cannot read completely is not a
 * history to work around: replaying against it would mean guessing whether a
 * commit, a push or a file write already happened. So every inconsistency fails
 * closed, with the reason named, and nothing is repaired, truncated or skipped
 * to make a replay succeed.
 *
 * What it will not do is refuse honest work. A pending intent's predicted state
 * is offered as an attachment candidate beside the state its predecessors
 * established, because the interrupted operation may have already reached it;
 * rejecting that state against the preceding completion would refuse exactly
 * the case recovery exists for.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import {
  RETAINED_REPOSITORY_COMPLETION,
  RETAINED_REPOSITORY_INTENT,
  RETAINED_REPOSITORY_VERSION,
  establishesCheckout,
  parseRetainedRepositoryCompletion,
  parseRetainedRepositoryIntent,
  retainedRepositoryIntentIdentity,
  sameRetainedFrontier,
} from "./records.ts";
import type {
  RetainedFrontier,
  RetainedRepositoryCompletion,
  RetainedRepositoryIntent,
} from "./records.ts";

/** A word from the fixed vocabulary a continuation refusal is reported under. */
export type RetainedRepositoryRefusal =
  /** A record of this feature's own type that this protocol cannot read. */
  | "malformed-record"
  /** A record written by a version of this protocol that does not exist here. */
  | "unknown-version"
  /** A record belonging to another entry, another execution or a workflow. */
  | "foreign-owner"
  /** A completion whose site is not the site of the intent it names. */
  | "site-substitution"
  /** A completion whose authored request is not the one its intent froze. */
  | "request-substitution"
  /** A completion naming an intent this history does not hold. */
  | "completion-without-intent"
  /** A second completion for one intent. */
  | "duplicate-completion"
  /** A completion standing before the intent it names. */
  | "misordered-completion"
  /** A lane position that does not advance. */
  | "misordered-lane"
  /** A mutation standing before anything selected the checkout it changes. */
  | "missing-baseline"
  /** A pre-state that is not what this checkout's accepted records established. */
  | "broken-frontier-chain"
  /** Two unresolved mutations of one shared Git directory. */
  | "competing-mutation";

/**
 * A retained history this entry cannot continue from.
 *
 * A `StaleInputError`, because it is not a refusal the document asked for: a
 * document that went on running past this would run its later elements as
 * though work had or had not happened. The existing durability boundary owns
 * it, and `<PrintErrors>` cannot print it away.
 */
export class RetainedRepositoryHistoryError extends StaleInputError {
  override name = "RetainedRepositoryHistoryError";

  readonly reason: RetainedRepositoryRefusal;

  constructor(reason: RetainedRepositoryRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/** One effect this history proves finished, with the intent it finished. */
export interface RetainedRepositoryCompletedEffect {
  readonly identity: string;
  readonly intent: RetainedRepositoryIntent;
  readonly completion: RetainedRepositoryCompletion;
}

/** One effect this history proves was started and not finished. */
export interface RetainedRepositoryPendingEffect {
  readonly identity: string;
  readonly intent: RetainedRepositoryIntent;
}

/**
 * What one checkout was left in, and what a resuming entry may find.
 *
 * `frontier` is the state this history's accepted records establish. `candidates`
 * is what attachment admits: that state, and — when a mutation of this checkout
 * is unresolved — the state it saved before running and the state it predicted.
 * An interrupted operation may have reached either side of its own transition.
 */
export interface RetainedRepositoryAttachment {
  readonly checkout: string;
  readonly frontier: RetainedFrontier;
  readonly candidates: readonly RetainedFrontier[];
}

/** Everything one entry's admitted history holds about repository work. */
export interface RetainedRepositoryHistory {
  readonly owner: string;
  readonly completed: readonly RetainedRepositoryCompletedEffect[];
  readonly pending: readonly RetainedRepositoryPendingEffect[];
  readonly attachments: readonly RetainedRepositoryAttachment[];
}

interface Held {
  readonly identity: string;
  readonly intent: RetainedRepositoryIntent;
  completion: RetainedRepositoryCompletion | undefined;
}

/** One record as it is read out of the history, before anything names it. */
type ReadRecord =
  | { readonly kind: "intent"; readonly value: RetainedRepositoryIntent }
  | { readonly kind: "completion"; readonly value: RetainedRepositoryCompletion };

/** The same record with an intent's own name on it. */
type RetainedRecord =
  | {
      readonly kind: "intent";
      readonly value: RetainedRepositoryIntent;
      readonly identity: string;
    }
  | { readonly kind: "completion"; readonly value: RetainedRepositoryCompletion };

/**
 * The repository work one entry's history holds, or why it cannot be continued.
 *
 * `retained` is the exact snapshot core admitted and `owner` is this entry's own
 * spelling. Records of other features and of other durable types are not this
 * reader's business and are passed over; a record of *this* feature's type that
 * does not parse is, and refuses.
 */
export function* admitRetainedRepositoryHistory(
  retained: readonly DurableEvent[],
  owner: string,
): Operation<Result<RetainedRepositoryHistory>> {
  const read = readRecords(retained);
  if (!read.ok) {
    return read;
  }
  const records = yield* identified(read.value);

  // Every intent this history holds, named before the walk begins, so a
  // completion that stands before its own intent is a misordering rather than a
  // completion of nothing.
  const names = new Set<string>();
  for (const record of records) {
    if (record.kind === "intent") {
      names.add(record.identity);
    }
  }

  const held: Held[] = [];
  const byIdentity = new Map<string, Held>();
  const established = new Map<string, RetainedFrontier>();
  const lanePosition = new Map<string, number>();
  const laneUnresolved = new Set<string>();

  for (const record of records) {
    if (record.kind === "intent") {
      const intent = record.value;
      if (intent.owner !== owner) {
        return foreign("an intent");
      }
      const lane = intent.lane.common;
      const previous = lanePosition.get(lane);
      if (previous !== undefined && intent.lane.position <= previous) {
        return refuse(
          "misordered-lane",
          `a retained intent at position ${intent.lane.position} stands after position ` +
            `${previous} in the same shared Git directory, so this history does not order the ` +
            "work it holds.",
        );
      }
      if (laneUnresolved.has(lane)) {
        return refuse(
          "competing-mutation",
          "two retained mutations of one shared Git directory are unresolved at the same time, " +
            "and only one of them can be the state this entry resumes from.",
        );
      }
      const checkout = intent.preState.checkout;
      const baseline = established.get(checkout);
      if (baseline === undefined) {
        if (!establishesCheckout(intent.operation)) {
          return refuse(
            "missing-baseline",
            `a retained "${intent.operation}" stands before anything selected the checkout it ` +
              "changes, so the state it says it started from is its own account of it.",
          );
        }
      } else if (!sameRetainedFrontier(baseline, intent.preState)) {
        return refuse(
          "broken-frontier-chain",
          `a retained "${intent.operation}" expected a state this checkout's accepted records ` +
            "did not establish, so the history does not describe one sequence of work.",
        );
      }
      const identity = record.identity;
      const entry: Held = { identity, intent, completion: undefined };
      held.push(entry);
      byIdentity.set(identity, entry);
      lanePosition.set(lane, intent.lane.position);
      laneUnresolved.add(lane);
      if (baseline === undefined) {
        established.set(checkout, intent.preState);
      }
      continue;
    }

    const completion = record.value;
    if (completion.owner !== owner) {
      return foreign("a completion");
    }
    const entry = byIdentity.get(completion.intent);
    if (entry === undefined) {
      if (names.has(completion.intent)) {
        return refuse(
          "misordered-completion",
          "a retained completion stands before the intent it names, so the history does not say " +
            "the work was prepared before it finished.",
        );
      }
      return refuse(
        "completion-without-intent",
        "a retained completion names an intent this history does not hold, so nothing proves " +
          "what it completed.",
      );
    }
    if (entry.completion !== undefined) {
      return refuse(
        "duplicate-completion",
        "one retained intent carries two completions, and one operation completes once.",
      );
    }
    if (entry.intent.site.source !== completion.site.source) {
      return refuse(
        "site-substitution",
        "a retained completion was written in a different source than the intent it names.",
      );
    }
    if (entry.intent.site.occurrence !== completion.site.occurrence) {
      return refuse(
        "site-substitution",
        "a retained completion names an intent from another occurrence, so it answers for work " +
          "somewhere else in the document.",
      );
    }
    if (entry.intent.fingerprint !== completion.fingerprint) {
      return refuse(
        "request-substitution",
        "a retained completion carries a different authored request than the intent it names.",
      );
    }
    entry.completion = completion;
    // The verified resulting state, not the prediction: the prediction is what
    // the operation was held to while it ran, and this is what it left.
    established.set(completion.frontier.checkout, completion.frontier);
    laneUnresolved.delete(entry.intent.lane.common);
  }

  return Ok(history(owner, held, established));
}

/**
 * The same records with every intent named.
 *
 * One digest per intent, taken once: the walk needs an intent's name both when
 * it is admitted and when a later completion asks for it.
 */
function* identified(records: readonly ReadRecord[]): Operation<readonly RetainedRecord[]> {
  const named: RetainedRecord[] = [];
  for (const record of records) {
    if (record.kind === "completion") {
      named.push(record);
      continue;
    }
    named.push({
      kind: "intent",
      value: record.value,
      identity: yield* retainedRepositoryIntentIdentity(record.value),
    });
  }
  return named;
}

function history(
  owner: string,
  held: readonly Held[],
  established: ReadonlyMap<string, RetainedFrontier>,
): RetainedRepositoryHistory {
  const completed: RetainedRepositoryCompletedEffect[] = [];
  const pending: RetainedRepositoryPendingEffect[] = [];
  for (const entry of held) {
    if (entry.completion === undefined) {
      pending.push(Object.freeze({ identity: entry.identity, intent: entry.intent }));
      continue;
    }
    completed.push(
      Object.freeze({
        identity: entry.identity,
        intent: entry.intent,
        completion: entry.completion,
      }),
    );
  }
  const attachments: RetainedRepositoryAttachment[] = [];
  for (const [checkout, frontier] of established) {
    const candidates: RetainedFrontier[] = [frontier];
    for (const effect of pending) {
      if (effect.intent.preState.checkout !== checkout) {
        continue;
      }
      for (const candidate of [effect.intent.preState, effect.intent.postState]) {
        if (!candidates.some((existing) => sameRetainedFrontier(existing, candidate))) {
          candidates.push(candidate);
        }
      }
    }
    attachments.push(Object.freeze({ checkout, frontier, candidates: Object.freeze(candidates) }));
  }
  return Object.freeze({
    owner,
    completed: Object.freeze(completed),
    pending: Object.freeze(pending),
    attachments: Object.freeze(attachments),
  });
}

/**
 * This feature's records, in the order the history holds them.
 *
 * A yield of one of these types whose durable result is not `ok` retained
 * nothing — the operation failed and its outcome is the durable operation's own
 * — so there is no record there to read.
 */
function readRecords(retained: readonly DurableEvent[]): Result<readonly ReadRecord[]> {
  const records: ReadRecord[] = [];
  for (const event of retained) {
    if (event.type !== "yield") {
      continue;
    }
    const type = event.description.type;
    if (type !== RETAINED_REPOSITORY_INTENT && type !== RETAINED_REPOSITORY_COMPLETION) {
      continue;
    }
    if (event.result.status !== "ok") {
      continue;
    }
    const payload = event.result.value;
    const stated = statedVersion(payload);
    if (stated !== undefined && stated !== RETAINED_REPOSITORY_VERSION) {
      return refuse(
        "unknown-version",
        `a retained ${type} record states version ${stated}, and this host implements version ` +
          `${RETAINED_REPOSITORY_VERSION} only. Nothing is assumed about what the rest of it ` +
          "means.",
      );
    }
    if (type === RETAINED_REPOSITORY_INTENT) {
      const intent = parseRetainedRepositoryIntent(payload);
      if (intent === undefined) {
        return malformed(type);
      }
      records.push({ kind: "intent", value: intent });
      continue;
    }
    const completion = parseRetainedRepositoryCompletion(payload);
    if (completion === undefined) {
      return malformed(type);
    }
    records.push({ kind: "completion", value: completion });
  }
  return Ok(Object.freeze(records));
}

/**
 * The version a payload states, read before its membership is decided.
 *
 * A record from a later version is told apart from a broken one, so the person
 * is told which of the two they have.
 */
function statedVersion(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const stated = Reflect.get(payload, "version");
  return typeof stated === "number" ? stated : undefined;
}

function malformed(type: string): Result<never> {
  return refuse(
    "malformed-record",
    `a retained ${type} record does not describe one: continuing would mean guessing whether the ` +
      "work it stands for already happened.",
  );
}

function foreign(record: string): Result<never> {
  return refuse(
    "foreign-owner",
    `${record} in this entry's history belongs to another owner. A record is descriptive data, ` +
      "and this entry works only from its own.",
  );
}

function refuse(reason: RetainedRepositoryRefusal, sentence: string): Result<never> {
  return Err(new RetainedRepositoryHistoryError(reason, sentence));
}
