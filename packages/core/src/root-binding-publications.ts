/**
 * Retaining the root values one entry captured, so the next one inherits them
 * (spec §4.5, `specs/repl-spec.md`).
 *
 * `<Let>` and an ordinary component capture bind into the environment they were
 * written in and record nothing, which is right for a document that runs once.
 * A REPL entry is one execution of several over one journal, and what a later
 * entry may start from is what the file says an earlier one published — so a
 * capture nothing retained is a value the next entry cannot have.
 *
 * This is the retention, and it is opt-in at the trusted-host boundary: a host
 * that states `rootBindingPublications` on its `ExecutionInitialization` asks
 * for it, and every other execution behaves exactly as it did. The owner is
 * built beside the canonical root environment and handed to expansion as an
 * argument, so the only thing that can publish is a capture whose actual
 * assignment target is that exact environment. A component body, an `<Each>`
 * iteration, a `<Spawn>` and a generated fragment each write a different
 * environment, and none of them acquires root ownership from the file it was
 * written in or the coroutine it ran on.
 *
 * ## What a publication holds, and what it deliberately does not
 *
 * A value inside the strict JSON domain is retained as a detached snapshot,
 * taken before the publication suspends. Everything else — a function, a live
 * handle, a class instance, a cycle, `undefined`, a non-finite number, a sparse
 * hole — is **entry-local**: the capture binds the exact value the producer
 * returned and stays usable for the rest of that entry, and the record says
 * only that the capture happened. It carries no value, names no class, removes
 * nothing and warns about nothing. A later entry therefore keeps the last value
 * that was durably published under that name, which may be one an earlier entry
 * published; a name only ever bound to a live value is absent from inheritance.
 *
 * One record per successful root capture, whichever outcome it is. That is what
 * keeps the retained effect sequence a fact about the document rather than about
 * what happened to be serializable on the day it ran, so a partial continuation
 * replays the same positions it recorded.
 */

import { Err, Ok, useScope } from "effection";
import type { Operation, Result } from "effection";
import {
  createDurableOperation,
  DurableContext,
  StaleInputError,
} from "@executablemd/durable-streams";
import type {
  DurableEvent,
  EffectDescription,
  Json,
  Workflow,
} from "@executablemd/durable-streams";

import { isJsonObject, parseJson } from "./json.ts";
import { validateBindingName } from "./live-env.ts";
import { sourceDescription } from "./source-position.ts";
import type { EvalEnv, SourcePosition } from "./types.ts";

/**
 * The durable effect type one retained root capture is recorded under.
 *
 * Distinct from the private `root_binding` *member* a pre-root terminal in
 * `execute.ts` carries: that one says which document a run that failed before
 * importing anything was about, and its meaning and its bytes are unchanged.
 */
export const ROOT_BINDING_PUBLICATION = "root_binding";

/**
 * The only retention mode there is, and the only spelling a host may state.
 *
 * Versioned in the value rather than in the member name, so the member a host
 * writes stays one member and an unrecognized version is a refusal rather than
 * a second field nothing reads.
 */
export const ROOT_BINDING_PUBLICATIONS_JSON_V1 = "json-v1";

/** Which retention an execution publishes root captures under. */
export type RootBindingPublicationMode = typeof ROOT_BINDING_PUBLICATIONS_JSON_V1;

/**
 * Where the mode is retained on the root admission this execution recorded.
 *
 * Namespaced, and on the description rather than in the result: the result is
 * the closed root *selection*, and a reader that had to understand a new shape
 * there would stop reading every root admission written before this existed.
 */
export const ROOT_BINDING_PUBLICATIONS_FIELD = "executablemd.root-binding-publications";

/** What a retained publication says, once it has been read. */
export interface RootBindingPublication {
  readonly binding: string;
  readonly publication: RootBindingOutcome;
}

/**
 * What one successful root capture retained: a detached JSON snapshot, or the
 * statement that the value stays in the entry that produced it.
 */
export type RootBindingOutcome =
  | { readonly kind: "json"; readonly value: Json }
  | { readonly kind: "entry-local" };

/** This execution's own publisher for the root environment it was built beside. */
export interface RootBindingPublications {
  /** Whether this environment is the exact canonical root this publishes for. */
  owns(target: EvalEnv): boolean;
  /** Retain one successful root capture, and wait for the journal to hold it. */
  publish(
    binding: string,
    value: unknown,
    position: Readonly<SourcePosition> | undefined,
  ): Operation<void>;
}

/**
 * Build the publisher for one execution's canonical root environment.
 *
 * The environment is captured in the closure rather than looked up, which is
 * what makes ownership an identity rather than a heuristic. The sequence is this
 * execution's own count of successful root captures, so the name each record
 * carries is the same live and on replay.
 */
export function createRootBindingPublications(root: EvalEnv): RootBindingPublications {
  let published = 0;
  return {
    owns: (target: EvalEnv) => target === root,
    *publish(
      binding: string,
      value: unknown,
      position: Readonly<SourcePosition> | undefined,
    ): Operation<void> {
      // Expansion driven without a journal — no durable context on the scope —
      // retains nothing and binds exactly as it would have. There is no history
      // for a position in, so there is no sequence to keep either.
      const scope = yield* useScope();
      const durable = scope.get(DurableContext);
      if (durable === undefined) {
        return;
      }
      const sequence = published;
      published += 1;
      // Taken here, before the append suspends, and from the operand itself: a
      // snapshot is what the journal keeps, and reading it later would read
      // whatever the entry had done to the value in between.
      const outcome = snapshot(value);
      const name = publicationName(sequence, binding);
      const stored = yield* retain(name, position, { binding, publication: outcome });
      // Read back and parsed, which is the only way a replay can be told from a
      // live run here: `createDurableOperation` answers with the value the
      // journal already held, so this is where a retained publication this
      // version cannot read is discovered. Live it parses the record just
      // written, and the check costs nothing.
      //
      // Before the caller binds and before any later authored work: a history
      // whose publication cannot be read is not one this run may continue, so
      // it must not reach the binding, the suffix no record describes, or a
      // completion appended on top of it.
      const held = parseRootBindingRecord(stored, name);
      if (!held.ok) {
        throw new StaleInputError(UNREADABLE_PUBLICATION, {
          coroutineId: durable.coroutineId,
          description: { type: ROOT_BINDING_PUBLICATION, name },
        });
      }
    },
  };
}

/**
 * Publish and bind one successful root capture.
 *
 * The one thing every capture site calls, so where the retention sits relative
 * to the assignment is decided once: the journal holds the publication before
 * the name exists in the environment, and a cancellation between them leaves a
 * publication the next entry inherits and a binding this entry never got.
 *
 * A target this execution does not own as its root is bound exactly as it has
 * always been bound, with the assignment the site used before — including the
 * ordinary expansion that publishes nothing at all.
 */
export function* bindRootCapture(
  publications: RootBindingPublications | undefined,
  target: EvalEnv,
  binding: string,
  value: unknown,
  position: Readonly<SourcePosition> | undefined,
): Operation<void> {
  if (publications === undefined || !publications.owns(target)) {
    target.values[binding] = value;
    return;
  }
  yield* publications.publish(binding, value, position);
  // Defined rather than assigned, for the reason the root's initial bindings are
  // defined: `values["__proto__"] = …` reaches `Object.prototype`'s inherited
  // setter, and what that does depends on the engine. This is the environment a
  // retained name is read back into, so a capture of that name has to be the
  // same own data property every runtime.
  Object.defineProperty(target.values, binding, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * What a host stated as its retention mode, or nothing.
 *
 * Refusing is a throw rather than a `Result` because this is read at the
 * earliest point of an invocation, beside the initial bindings: nothing is
 * installed, no document exists, and there is no handle to carry an outcome on.
 */
export function readRootBindingPublicationMode(
  stated: unknown,
): RootBindingPublicationMode | undefined {
  if (stated === undefined) {
    return undefined;
  }
  if (stated !== ROOT_BINDING_PUBLICATIONS_JSON_V1) {
    throw new Error(
      "an execution retains root binding publications under " +
        `"${ROOT_BINDING_PUBLICATIONS_JSON_V1}" or under nothing at all.`,
    );
  }
  return stated;
}

/** The description one root admission carries when its execution retains captures. */
export function rootBindingPublicationsDescription(
  mode: RootBindingPublicationMode | undefined,
): Record<string, Json> {
  return mode === undefined ? {} : { [ROOT_BINDING_PUBLICATIONS_FIELD]: mode };
}

/**
 * The mode a recorded root admission states.
 *
 * Three answers, and they are deliberately three. An absent member is a
 * readable history written before this existed, and it continues in its own
 * mode. A recognized one is this mode. Anything else — a spelling this version
 * does not know, a member that is not text, a description that refuses to be
 * read — is a refusal, because guessing would run an entry under a retention
 * its own records disagree with.
 */
export function recordedRootBindingPublicationMode(
  description: EffectDescription,
): Result<RootBindingPublicationMode | undefined> {
  let stated: unknown;
  try {
    stated = description[ROOT_BINDING_PUBLICATIONS_FIELD];
  } catch {
    return Err(new Error(UNREADABLE_MODE));
  }
  if (stated === undefined) {
    return Ok(undefined);
  }
  if (stated !== ROOT_BINDING_PUBLICATIONS_JSON_V1) {
    return Err(new Error(UNREADABLE_MODE));
  }
  return Ok(stated);
}

/**
 * What a run says when a recorded root admission states a retention it cannot
 * run under, and all it says.
 *
 * Cause-free and quoting nothing: what the record holds is journal data, and
 * repeating it would put whatever it holds into a diagnostic.
 */
export const UNREADABLE_MODE =
  "the recorded entry states a root binding retention this version cannot read.";

/**
 * What a run says when a recorded entry's retention is not the one it is
 * running under.
 *
 * Readable, and still refused: the record says what the entry published and the
 * invocation says what it is about to publish, and continuing across that
 * disagreement would insert or omit a durable position in a sequence the entry
 * has already recorded.
 */
export const MISMATCHED_MODE =
  "the recorded entry retains its root bindings differently from this run. Re-run the " +
  "document from the start rather than continuing a journal written under another retention.";

/** What a reader says when a retained publication is not one this version can read. */
export const UNREADABLE_PUBLICATION =
  "a retained root binding publication cannot be read by this version.";

/**
 * One retained publication, parsed whole and detached.
 *
 * Parsed rather than asserted, and parsed before any member is believed: the
 * event is journal data, so a property that throws, a value that is not JSON
 * and a member this version does not know are each "not this record" rather
 * than an error of their own. The name the effect was recorded under has to
 * agree with the binding inside it, because the name is what replay matches
 * positions by — a record whose two halves disagree is one this version did not
 * write.
 */
export function parseRootBindingPublication(event: DurableEvent): Result<RootBindingPublication> {
  let carried: unknown;
  let name: unknown;
  try {
    if (event.type !== "yield" || event.description.type !== ROOT_BINDING_PUBLICATION) {
      return Err(new Error(UNREADABLE_PUBLICATION));
    }
    if (event.result.status !== "ok") {
      return Err(new Error(UNREADABLE_PUBLICATION));
    }
    name = event.description.name;
    carried = event.result.value;
  } catch {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  if (typeof name !== "string") {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  return parseRootBindingRecord(carried, name);
}

/**
 * One retained publication record, parsed against the effect name it was
 * recorded under.
 *
 * The one contract both readers are held to: the projection reads a journal
 * somebody else wrote, and the publisher reads what its own durable operation
 * handed back — which on a continuation is the retained record rather than the
 * one just built. Two readings of this shape would be two contracts, and the
 * day they disagreed is the day a history one of them refused continued
 * through the other.
 *
 * The name is part of it. Replay matches a position by description, so a record
 * naming a different binding from the effect it came back for is a record this
 * version did not write there.
 */
export function parseRootBindingRecord(
  carried: unknown,
  name: string,
): Result<RootBindingPublication> {
  let record: Json;
  try {
    record = parseJson(carried);
  } catch {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  if (!isJsonObject(record) || Object.keys(record).length !== 3) {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  if (record["version"] !== 1) {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  const binding = record["binding"];
  if (typeof binding !== "string") {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  const validated = validateBindingName(binding);
  if (!validated.ok || validated.value !== binding) {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  if (!namesBinding(name, binding)) {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  const outcome = readOutcome(record["publication"]);
  if (outcome === undefined) {
    return Err(new Error(UNREADABLE_PUBLICATION));
  }
  return Ok({ binding, publication: outcome });
}

/** The closed outcome a retained record carries, or nothing because it is not one. */
function readOutcome(carried: Json | undefined): RootBindingOutcome | undefined {
  if (!isJsonObject(carried)) {
    return undefined;
  }
  const kind = carried["kind"];
  const members = Object.keys(carried).length;
  if (kind === "entry-local") {
    return members === 1 ? { kind } : undefined;
  }
  if (kind !== "json" || members !== 2 || !Object.hasOwn(carried, "value")) {
    return undefined;
  }
  const value = carried["value"];
  return value === undefined ? undefined : { kind, value };
}

/** Append one publication and wait for the journal to hold it. */
function* retain(
  name: string,
  position: Readonly<SourcePosition> | undefined,
  record: { readonly binding: string; readonly publication: RootBindingOutcome },
): Workflow<unknown> {
  return yield createDurableOperation<Json>(
    {
      type: ROOT_BINDING_PUBLICATION,
      name,
      ...sourceDescription(position),
    },
    // deno-lint-ignore require-yield
    function* (): Operation<Json> {
      return { version: 1, binding: record.binding, publication: { ...record.publication } };
    },
  );
}

/**
 * The strict snapshot of one captured value, or the statement that it stays
 * here.
 *
 * `parseJson` is the one JSON domain this repository has — the same walk the
 * root's initial bindings are copied through — so what crosses between entries
 * and what a host may supply are the same values. It rebuilds the graph, which
 * is what makes the snapshot detached: a later mutation of the operand changes
 * nothing the journal or a reader holds.
 */
function snapshot(value: unknown): RootBindingOutcome {
  try {
    return { kind: "json", value: parseJson(value) };
  } catch {
    return { kind: "entry-local" };
  }
}

/**
 * The deterministic name one publication is recorded under.
 *
 * The sequence rather than a block id: a block counter is what every authored
 * element's identity is derived from, and consuming one here would move the
 * identity of every element after it in documents whose journals already name
 * them.
 */
function publicationName(sequence: number, binding: string): string {
  return `root-binding:v1:${sequence}:${binding}`;
}

/** Whether a recorded effect name is a publication name for this binding. */
function namesBinding(name: string, binding: string): boolean {
  const prefix = "root-binding:v1:";
  if (!name.startsWith(prefix)) {
    return false;
  }
  const rest = name.slice(prefix.length);
  const divider = rest.indexOf(":");
  if (divider <= 0) {
    return false;
  }
  return /^(0|[1-9][0-9]*)$/.test(rest.slice(0, divider)) && rest.slice(divider + 1) === binding;
}
