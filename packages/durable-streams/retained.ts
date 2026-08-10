/**
 * Retained events — what a run reads a journal as.
 *
 * A journal is data supplied by a backend, and every phase of a replay reads
 * the same events: a private authority gate, the replay index, public guard
 * policy, and the replay path itself. If those are separate reads of the
 * backend's own objects, a source that answers differently between them decides
 * one thing for validation and another for execution, and nothing downstream
 * can detect the substitution.
 *
 * A retained event is therefore read once and detached. **Every** event that
 * participates in admission, indexing, or terminal reuse is retained, Close as
 * well as Yield: a Close decides whether a coroutine has a terminal result to
 * reuse, so leaving it as the backend's own object lets it belong to a child
 * coroutine while one phase asks and to the root while the next does.
 *
 * The discriminator is settled once, by the classification that chooses a
 * retained event's kind, and never read from the source again. Identity — the
 * coroutine an event belongs to, and a Yield's complete effect description — is
 * settled once too, so no phase can be shown a different event than the phase
 * before it.
 *
 * A Yield's *settlement* stays lazy and separate: the index is built before
 * guards run, and a guard that would refuse an event has to get that chance
 * before the stream is asked to produce its result. A Close keeps its own cell,
 * memoized the same way, so every later read receives the same detached answer.
 */

import type {
  Close,
  CoroutineId,
  DurableEvent,
  EffectDescription,
  Json,
  Result,
  SerializedError,
  Yield,
} from "./types.ts";

/** What one retained value's single read of the stream produced. */
type Settled<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "refusal"; readonly refusal: unknown };

function settle<T>(read: () => T): Settled<T> {
  try {
    return { kind: "value", value: read() };
  } catch (refusal) {
    return { kind: "refusal", refusal };
  }
}

function resolve<T>(settled: Settled<T>): T {
  if (settled.kind === "refusal") {
    throw settled.refusal;
  }
  return settled.value;
}

/**
 * A detached copy of one retained JSON value.
 *
 * Every property is read once and rebuilt, so nothing the stream still owns
 * remains reachable: a nested accessor cannot answer one thing to one phase and
 * another to the next, and no later mutation of the source changes what replay
 * used.
 *
 * The copy is ordinary JSON. Detaching is the claim against the *stream*;
 * making the copy immutable would be a claim against the *consumer*, and
 * replayed values are legitimately mutable — an eval binding restored from a
 * journal is pushed to by the iteration that resumes on it. Members are
 * therefore writable and configurable like any other JSON.
 *
 * Keys are defined rather than assigned all the same, because `__proto__`
 * reaches an inherited setter on some runtimes and would rewrite the copy's
 * prototype instead of becoming a member of it.
 *
 * A cycle is refused. `Json` has none, and a value that does is not something
 * this can detach — refusing is remembered like any other refusal.
 */
export function detachJson(value: Json, seen: Set<object> = new Set()): Json {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError("a retained value cannot contain a cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: Json[] = [];
      for (let index = 0; index < value.length; index++) {
        items.push(detachJson(value[index]!, seen));
      }
      return items;
    }
    const detached: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(detached, key, {
        value: detachJson(member, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return detached;
  } finally {
    seen.delete(value);
  }
}

/**
 * A detached copy, frozen through.
 *
 * The authoritative retained graph is what admission validated and what replay
 * consumes, so nothing that reaches a caller may write to it. Freezing is the
 * claim against *policy*, not against a workflow: what a document finally
 * receives is a fresh mutable copy taken from this, never this.
 */
function sealJson(value: Json): Json {
  const detached = detachJson(value);
  freezeDeep(detached);
  return detached;
}

function freezeDeep(value: Json): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  Object.freeze(value);
  for (const member of Array.isArray(value) ? value : Object.values(value)) {
    freezeDeep(member);
  }
}

/** A detached copy of a retained failure's description. */
function detachError(error: SerializedError): SerializedError {
  const name = error.name;
  const stack = error.stack;
  return Object.freeze({
    message: error.message,
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack }),
  });
}

/**
 * A retained result detached from everything the stream still owns.
 *
 * Each member is read exactly once, here, and the tree beneath it is rebuilt.
 * Copying only the outer object would leave a `value` the journal can still
 * rewrite, which is the substitution this exists to prevent.
 */
function detachResult(result: Result): Result {
  const status = result.status;
  if (status === "ok") {
    if (!("value" in result)) {
      return { status };
    }
    const value = result.value;
    return Object.freeze(value === undefined ? { status } : { status, value: sealJson(value) });
  }
  if (status === "err") {
    if (!("error" in result)) {
      throw new TypeError("a retained failure carries the error it failed with");
    }
    return Object.freeze({ status, error: detachError(result.error) });
  }
  return Object.freeze({ status });
}

/**
 * A detached copy of an effect description.
 *
 * `type` and `name` are the identity divergence detection compares; every other
 * member is extra data a guard may read. All of it is rebuilt, so a description
 * cannot name one effect while one phase looks and another while the next does.
 */
function detachDescription(description: EffectDescription): EffectDescription {
  // One enumeration, so every member — `type` and `name` included — is read
  // exactly once. Reading them directly and then enumerating would read each of
  // them twice, which is the second read this exists to remove.
  const members = Object.entries(description);
  let type: Json | undefined;
  let name: Json | undefined;
  const extra: [string, Json][] = [];
  for (const [key, member] of members) {
    if (key === "type") {
      type = member;
      continue;
    }
    if (key === "name") {
      name = member;
      continue;
    }
    extra.push([key, member]);
  }
  if (typeof type !== "string" || typeof name !== "string") {
    throw new TypeError("a retained effect description carries a type and a name");
  }
  const detached: EffectDescription = { type, name };
  for (const [key, member] of extra) {
    Object.defineProperty(detached, key, {
      value: sealJson(member),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(detached);
}

/** Everything about a retained Yield except what it settled to. */
interface RetainedIdentity {
  readonly coroutineId: CoroutineId;
  readonly description: EffectDescription;
}

function readCoroutineId(source: { coroutineId: CoroutineId }): CoroutineId {
  const coroutineId = source.coroutineId;
  if (typeof coroutineId !== "string") {
    throw new TypeError("a retained event belongs to a coroutine");
  }
  return coroutineId;
}

function readIdentity(source: Yield): RetainedIdentity {
  return {
    coroutineId: readCoroutineId(source),
    description: detachDescription(source.description),
  };
}

/**
 * One retained Yield: one identity, and one cell for what it settled to.
 *
 * Identity is read together and once. Reading `type` here and `coroutineId`
 * there would let a source present an unrelated event to one phase and the root
 * import to the next, which is the whole reason identity is a single settled
 * fact rather than three accessors.
 *
 * The settlement is separate and lazy on purpose: the index is built before
 * guards run, so a guard that would refuse an event must get that chance before
 * the stream is asked for its result. Both outcomes of both reads are kept — a
 * refusal is remembered and re-raised rather than retried, so a source cannot
 * refuse one phase and then answer the next.
 */
/**
 * Present a retained member the way the event it stands for presents it.
 *
 * Own and enumerable, so a retained event spreads, serializes, and compares
 * like the plain event a backend would have supplied. The settled cells stay
 * genuinely private, which is what keeps them out of all of that.
 */
function present<T>(target: object, name: string, read: () => T): void {
  Object.defineProperty(target, name, { enumerable: true, get: read });
}

class RetainedYield implements Yield {
  /**
   * Settled by the classification that chose this wrapper, never re-read. A
   * second read of the source's own discriminator is a second chance for it to
   * answer differently, and an event that classifies as a Yield here and a
   * Close there is the same substitution one level further out.
   */
  declare readonly type: "yield";
  declare readonly coroutineId: CoroutineId;
  declare readonly description: EffectDescription;
  declare readonly result: Result;
  #source: Yield;
  #identity: Settled<RetainedIdentity> | undefined;
  #settled: Settled<Result> | undefined;

  constructor(source: Yield) {
    this.#source = source;
    present(this, "type", () => "yield" as const);
    present(this, "coroutineId", () => this.#stable().coroutineId);
    present(this, "description", () => this.#stable().description);
    present(this, "result", () => {
      this.#settled ??= settle(() => detachResult(this.#source.result));
      return resolve(this.#settled);
    });
  }

  #stable(): RetainedIdentity {
    this.#identity ??= settle(() => readIdentity(this.#source));
    return resolve(this.#identity);
  }
}

/**
 * One retained Close: settled identity, and one cell for its terminal result.
 *
 * A Close decides whether a coroutine has a terminal result to reuse, so it
 * participates in admission exactly as a Yield does. Left as the backend's own
 * object it could belong to a child coroutine while one phase asks and to the
 * root while the next does — a history nobody could admit, reused as a result
 * nobody asked for.
 */
class RetainedClose implements Close {
  declare readonly type: "close";
  declare readonly coroutineId: CoroutineId;
  declare readonly result: Result;
  #identity: Settled<CoroutineId>;
  #settled: Settled<Result>;

  constructor(source: Close) {
    // Settled here, while the history is being retained, rather than at a first
    // later read. A Close carries the result a completed run hands back, and
    // deferring that read leaves an interval — between the moment a consumer's
    // private admission accepts the history and the moment terminal reuse
    // consumes it — in which the backend still owns the answer and can replace
    // it. Reading once at a later getter closes repeated reads and leaves that
    // window open.
    //
    // Settling cannot throw: a refusal is captured and re-raised from the
    // getter, so retaining a history is never the thing that fails.
    this.#identity = settle(() => readCoroutineId(source));
    this.#settled = settle(() => detachResult(source.result));
    present(this, "type", () => "close" as const);
    present(this, "coroutineId", () => resolve(this.#identity));
    present(this, "result", () => resolve(this.#settled));
  }
}

/**
 * An event that would not say what it is.
 *
 * Classification is the one thing every later phase depends on, so an event
 * that refuses it is not an event this history can describe. The refusal is
 * remembered and re-raised from every member, rather than retried — a source
 * that refuses one phase must not answer the next.
 */
class RetainedRefusal implements Yield {
  declare readonly type: "yield";
  declare readonly coroutineId: CoroutineId;
  declare readonly description: EffectDescription;
  declare readonly result: Result;
  #refusal: unknown;

  constructor(refusal: unknown) {
    this.#refusal = refusal;
    for (const name of ["type", "coroutineId", "description", "result"]) {
      present(this, name, (): never => {
        throw this.#refusal;
      });
    }
  }
}

/**
 * The retained form of a journal's events.
 *
 * Idempotent: retaining an already-retained event returns it, so a caller that
 * has produced the stable history hands the same objects onward rather than a
 * second wrapping of them. That is what lets one snapshot serve every phase.
 *
 * Only the event type is read here, which is the least a caller can read and
 * still tell a Yield from a Close. Everything else is the retained event's own.
 */
export function retainEvents(events: readonly DurableEvent[]): DurableEvent[] {
  return events.map((event) => {
    if (isRetained(event)) {
      return event;
    }
    // The one read of the source's discriminator. Whatever it says here is what
    // the retained event reports from now on, to every phase.
    const classified = settle(() => event.type);
    if (classified.kind === "refusal") {
      return new RetainedRefusal(classified.refusal);
    }
    if (classified.value === "yield") {
      return new RetainedYield(event as Yield);
    }
    if (classified.value === "close") {
      return new RetainedClose(event as Close);
    }
    return new RetainedRefusal(new TypeError("a retained event is a yield or a close"));
  });
}

function isRetained(event: DurableEvent): boolean {
  return (
    event instanceof RetainedYield ||
    event instanceof RetainedClose ||
    event instanceof RetainedRefusal
  );
}

/**
 * An isolated observation of a retained event, for public policy to read.
 *
 * A replay guard is composable policy, and composition means handlers read,
 * annotate, and pass along. What it must never mean is that a handler edits the
 * history the execution already validated: the authoritative graph is what
 * admission accepted and what replay consumes, and a guard that could rewrite a
 * root selection or an effect description after admission would hold exactly
 * the authority the private gate exists to keep out of public hands.
 *
 * So policy reads a copy. It is deep and mutable, so middleware may compose over
 * it as freely as it likes, and nothing it does reaches replay.
 */
export function observeEvent(event: DurableEvent): DurableEvent {
  if (event.type === "close") {
    return { type: "close", coroutineId: event.coroutineId, result: consumable(event.result) };
  }
  return {
    type: "yield",
    coroutineId: event.coroutineId,
    description: observeDescription(event.description),
    result: consumable(event.result),
  };
}

function observeDescription(description: EffectDescription): EffectDescription {
  const copy: EffectDescription = { type: description.type, name: description.name };
  for (const [key, member] of Object.entries(description)) {
    if (key === "type" || key === "name") {
      continue;
    }
    Object.defineProperty(copy, key, {
      value: detachJson(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * A retained result as a consumer may hold it: ordinary mutable JSON.
 *
 * The authoritative copy is frozen so policy cannot rewrite it. A document
 * that resumes on a restored binding writes to it, so what a workflow receives
 * is a fresh copy taken from that authority rather than the authority itself.
 */
export function consumable(result: Result): Result {
  if (result.status === "ok") {
    return "value" in result && result.value !== undefined
      ? { status: "ok", value: detachJson(result.value) }
      : { status: "ok" };
  }
  if (result.status === "err") {
    return { status: "err", error: { ...result.error } };
  }
  return { status: "cancelled" };
}
