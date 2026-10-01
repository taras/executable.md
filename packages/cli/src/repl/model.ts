/**
 * The REPL's view of one execution, projected from its Journal and nothing else.
 *
 * The Journal is the only durable truth this feature has, so the model is a
 * *reading* of it rather than a second copy: `projectRepl` walks the real
 * `Yield | Close` events an ordinary execution appends, recognizes the runtime's
 * existing vocabulary, and returns immutable structural values. No REPL record
 * exists, nothing is cached between processes, and no component ever receives a
 * `DurableEvent` — what leaves here is plain frozen data.
 *
 * Every shape it reads is parsed. A journal is data somebody else may have
 * written, so a payload that will not read, a history this slice's one-entry
 * invariant forbids, or a source position that cannot be attributed to exactly
 * one scope comes back as `Err`. Attaching data to a guessed owner would put a
 * binding in the wrong scope and a wrong answer on the screen; refusing says so.
 *
 * Projection is pure in both directions. Every value the model retains is
 * *detached* from the event that carried it — copied, then frozen — so the model
 * cannot be changed by whoever still holds the events, and the events are
 * neither frozen nor modified by having been read. A projector that froze its
 * input would make a caller's own data immutable as a side effect of being
 * looked at.
 *
 * A marker addresses a prefix rather than a stored sequence number. It is
 * derived from protocol identity — which coroutine, and how many durable yields
 * that coroutine had already settled — so the same event has the same marker in
 * every process that reads the file, with nothing extra written down to make
 * that true.
 *
 * ## Agent conversations
 *
 * A retained `agent_prompt` is one Agent turn, read through Core's own record
 * parser rather than through a second spelling of that shape here. Turns are
 * ordered by the sequence the record states, because a Journal's append order
 * is the order turns *finished* and a chronology built from it would reorder a
 * conversation whenever one turn took longer than the next. Conversations are
 * grouped by the `sessionKey` the provider named and by nothing else — not the
 * agent, the authored name, the native id, or the text — and a turn that never
 * reached a provider has no conversation to join rather than a guessed one.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";
import { validateBindingName } from "@executablemd/core";
import { AGENT_PROMPT, parsePromptRecord, readElicitationSchema } from "@executablemd/core/host";
import type { PromptRecord } from "@executablemd/core/host";
import type { Close, DurableEvent, Json, Yield } from "@executablemd/durable-streams";

import { entryKey, entryMarker, partitionEntrySegments } from "./entries.ts";
import type { EntrySegment } from "./entries.ts";

/** The first entry's key, and the root scope key every existing location names. */
export const ENTRY_SCOPE = entryKey(1);

/**
 * The root namespace each entry's own validated props owns.
 *
 * Named here because two things turn on it: a retained value under this name is
 * not inherited, and Core refuses one supplied as an initial binding.
 */
const ROOT_PROPS_BINDING = "props";

const SOURCE_POSITION_FIELD = "executablemd.source-position";

/** What the REPL could not read, and what it was reading when it stopped. */
export class ReplProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplProjectionError";
  }
}

/** Where an authored element was written, as the journal recorded it. */
export interface ReplPosition {
  readonly path: string | undefined;
  /**
   * The generated fragment this position belongs to, when it belongs to one.
   *
   * Closed against `path`: an effect inside admitted generated source names the
   * admission that decided that source, because generated text has no file for
   * it to name. A record carrying both is malformed.
   */
  readonly generatedSource: string | undefined;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** One name a durable eval published into its scope. */
export interface ReplBinding {
  readonly name: string;
  readonly value: Json;
}

/** One answered question, as history can still show it. */
export interface ReplElicitation {
  readonly marker: string;
  readonly location: string;
  readonly schema: Json;
  readonly answer: Json;
  readonly position: ReplPosition | undefined;
}

/** One admitted generated fragment. */
export interface ReplGenerated {
  readonly marker: string;
  readonly source: string | undefined;
  readonly decision: "admitted" | "refused";
  readonly construct: string | undefined;
}

/**
 * One source region the entry admitted, and what that region holds.
 *
 * `kind` says where the source came from: the submitted entry, a nested
 * component occurrence the run retained, or a generated fragment an authored
 * invocation produced. A scope exists in a model only where the projected prefix
 * admitted it, so a selection earlier than an admission has no scope to show and
 * needs no separate flag saying so.
 */
export interface ReplScope {
  readonly key: string;
  readonly kind: "entry" | "component" | "generated";
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly position: ReplPosition | undefined;
  readonly marker: string;
  readonly bindings: readonly ReplBinding[];
  readonly elicitations: readonly ReplElicitation[];
  readonly generated: readonly ReplGenerated[];
  readonly scopes: readonly ReplScope[];
}

/** One provider choice a retained permission request offered. */
export interface ReplAgentOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/**
 * One permission request a retained turn answered.
 *
 * A fact about a decision already made. It has no action and no authority: the
 * request it describes was answered while that turn ran, by a process that may
 * no longer exist.
 */
export interface ReplAgentPermission {
  readonly toolCallId: string;
  readonly title: string | undefined;
  readonly kind: string | undefined;
  readonly options: readonly ReplAgentOption[];
  readonly outcome: "selected" | "cancelled";
  /** The choice that answered it, or none where it was cancelled. */
  readonly selected: string | undefined;
}

/** What one conversation was running under, where it said. */
export interface ReplAgentConfiguration {
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/**
 * One retained Agent turn, at the position its record was appended.
 *
 * Everything a reader can be shown about a Prompt that has settled, and nothing
 * about the process that ran it. A provider checkpoint a host retained beside
 * the record is not here: it names a turn something could be *continued* from,
 * which is durable identity rather than something to read.
 */
export interface ReplAgentTurn {
  readonly marker: string;
  /**
   * The admission-order key of the entry whose execution recorded this turn.
   *
   * Carried rather than inferred. A sequence counts the Prompts of one entry and
   * restarts for the next, so the pair of entry and sequence is what names a
   * turn across the whole history — and the entry a turn belongs to is the one
   * whose range its record landed in, never the latest one, the one a reader has
   * selected or the one that happened to finish first.
   */
  readonly entry: string;
  /** The order this turn ran in, as its record states it. */
  readonly sequence: number;
  /** The durable name the Prompt was journaled under. */
  readonly name: string;
  /** The text the Prompt was asked. */
  readonly input: string;
  /** The key of the one scope whose source this Prompt was written in. */
  readonly scope: string;
  readonly position: ReplPosition;
  readonly agent: string;
  /** The provider's name for the conversation, empty where none was reached. */
  readonly sessionKey: string;
  readonly agentSessionId: string | undefined;
  readonly status: "completed" | "failed" | "cancelled";
  readonly stopReason: string | undefined;
  /** Whatever the turn produced, including partial text on a failure. */
  readonly text: string;
  /**
   * What went wrong, as one line a reader can act on.
   *
   * The message alone, for the reason the entry's own outcome keeps only the
   * message: a serialized failure names host paths and engine frames, and a
   * transcript is a reader's view of their own entry.
   */
  readonly failure: string | undefined;
  readonly configuration: ReplAgentConfiguration | undefined;
  readonly permissions: readonly ReplAgentPermission[];
}

/** One retained conversation: a non-empty session key and the turns it held. */
export interface ReplAgentSession {
  readonly sessionKey: string;
  readonly turns: readonly ReplAgentTurn[];
}

/** One offered history position, in append order. */
export interface ReplCheckpoint {
  readonly marker: string;
  readonly kind: "entry" | "scope" | "binding" | "generated" | "elicit" | "agent" | "terminal";
  readonly label: string;
}

/**
 * What the root coroutine settled to.
 *
 * Three outcomes, because the protocol has three. A document that produced a
 * result closes `ok` carrying it, and the result says whether the document
 * succeeded. A run that failed before there was a result to produce closes
 * `err`, and there is no rendered output to restore. A cancelled run closes
 * with neither.
 */
export interface ReplTerminal {
  readonly status: "ok" | "err" | "cancelled";
  readonly output: string;
  readonly message: string | undefined;
}

/** One semantic transcript row. Never a record dump. */
export type ReplRow =
  | {
      readonly kind: "entry";
      readonly marker: string;
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly kind: "scope";
      readonly marker: string;
      readonly scope: string;
      readonly name: string;
      readonly path: string;
    }
  | {
      readonly kind: "binding";
      readonly marker: string;
      readonly scope: string;
      readonly names: readonly string[];
    }
  | {
      readonly kind: "output";
      readonly marker: string;
      readonly scope: string;
      readonly text: string;
    }
  | {
      readonly kind: "generated";
      readonly marker: string;
      readonly scope: string;
      readonly source: string | undefined;
      readonly decision: "admitted" | "refused";
    }
  | {
      readonly kind: "elicit";
      readonly marker: string;
      readonly scope: string;
      readonly location: string;
      readonly answer: Json;
    }
  | {
      readonly kind: "agent";
      readonly marker: string;
      readonly scope: string;
      /** The exact turn the chronology and its conversation also hold. */
      readonly turn: ReplAgentTurn;
    }
  | {
      readonly kind: "effect";
      readonly marker: string;
      readonly type: string;
      readonly status: string;
    }
  | {
      readonly kind: "terminal";
      readonly marker: string;
      readonly status: "ok" | "err" | "cancelled";
      readonly output: string;
    };

/**
 * One entry this execution admitted, and everything that entry holds.
 *
 * One frozen object per semantic reading. The catalog, the transcript and the
 * binding inheritance all read this same value, because two objects describing
 * one entry are two answers to what that entry did.
 *
 * `bindings` is what the root environment holds *after* this entry: the values
 * earlier entries durably published, with this entry's own published values over
 * them. It is what the next entry starts from, which is why it is a reading of
 * the Journal and never of a process's memory — a value a run computed and never
 * retained is a value a cold reopen would not have.
 */
export interface ReplEntry {
  /** Its admission-order key: `entry-1`, `entry-2`, and so on. */
  readonly key: string;
  /** Its admission order, counting from one, which is also its display order. */
  readonly order: number;
  /** The exact source admitted, which nothing afterwards can change. */
  readonly source: string;
  /** The path that source was admitted under. */
  readonly path: string;
  /** This entry's root scope, holding its nested scopes and published values. */
  readonly scope: ReplScope;
  readonly transcript: readonly ReplRow[];
  readonly checkpoints: readonly ReplCheckpoint[];
  /** What this entry's root settled to, or none while it is unfinished. */
  readonly terminal: ReplTerminal | undefined;
  readonly settled: boolean;
  /**
   * The root bindings in effect after this entry, in the order they appeared.
   *
   * `props` is never among them: each entry's props namespace belongs to its own
   * validated root, so a value published under that name stays in `scope` where
   * it happened rather than appearing here as something a successor receives.
   */
  readonly bindings: readonly ReplBinding[];
  /** This entry's retained turns, in its own Prompt sequence order. */
  readonly turns: readonly ReplAgentTurn[];
}

/** One frozen reading of one validated Journal prefix. */
export interface ReplModel {
  /** The marker this model was projected at, or none for the Journal head. */
  readonly selection: string | undefined;
  /** Whether the projected prefix is the whole file. */
  readonly head: boolean;
  /** Every entry this prefix admitted, in admission order. */
  readonly entries: readonly ReplEntry[];
  /** Whether the last entry this prefix admitted has settled. */
  readonly settled: boolean;
  /** What the last entry settled to, or none while it is unfinished. */
  readonly terminal: ReplTerminal | undefined;
  readonly checkpoints: readonly ReplCheckpoint[];
  readonly transcript: readonly ReplRow[];
  /**
   * Every retained turn, in entry admission order and then Prompt sequence.
   *
   * Two orders rather than one, because a sequence is local to the entry that
   * recorded it: both entries of a two-entry history may hold sequence `0`, and
   * a single global sort would interleave them.
   */
  readonly turns: readonly ReplAgentTurn[];
  /**
   * The conversations those turns belong to.
   *
   * One per non-empty `sessionKey`, in the order each group's earliest turn
   * appears in the chronology. A turn whose key is empty reached no provider,
   * so it belongs to no conversation and appears only in `turns`.
   */
  readonly sessions: readonly ReplAgentSession[];
}

/**
 * The marker for one event, given how many yields its coroutine had settled.
 *
 * Both spellings are total over the protocol's two events, which is what lets a
 * selection name any position in the file without a sequence number being
 * stored anywhere.
 */
function markerFor(event: DurableEvent, ordinal: number): string {
  return event.type === "yield"
    ? `yield:${event.coroutineId}:${ordinal}`
    : `close:${event.coroutineId}`;
}

/**
 * Project one Journal prefix.
 *
 * `selection` names the last event the model may see. Absent, the model is the
 * whole file. A marker that names no event in this file, or names one twice,
 * is refused rather than rounded to the head: a reader looking at history must
 * never be shown the present instead.
 *
 * Whatever the selection, the complete file is read first — boundaries and the
 * contents of every segment — and a file this version cannot read refuses
 * whichever prefix was asked for. What a selection chooses is which part of a
 * readable history to show, not how much of it has to be readable.
 */
export function projectRepl(
  events: readonly DurableEvent[],
  selection?: string,
): Result<ReplModel> {
  // The whole file's boundaries first, before any part of it is read as an
  // entry. A prefix whose ranges are not ranges comes back as one refusal with
  // no entries at all: a catalog missing whichever entry stopped parsing looks
  // exactly like a history that never held it.
  const partitioned = partitionEntrySegments(events);
  if (!partitioned.ok) {
    return partitioned;
  }
  const markers = globalMarkers(partitioned.value, events.length);

  const duplicated = firstDuplicate(markers);
  if (duplicated !== undefined) {
    return Err(
      new ReplProjectionError(
        `this journal records ${duplicated} twice, so one position in its history names two ` +
          "events. A coroutine closes once.",
      ),
    );
  }

  // Every segment in the complete prefix is read before any view escapes —
  // including a view a selection shortens. Boundaries alone are not enough:
  // a later entry whose retained payload this version cannot read is damage to
  // the file, and an earlier position is not a place to stand and be shown a
  // catalog in front of it. A reader inspecting history would see a model that
  // looks whole, go back to the head, and only then be told the file is broken.
  const whole = build(partitioned.value, markers, selection, true);
  if (!whole.ok) {
    return whole;
  }
  if (selection === undefined) {
    return whole;
  }
  const at = markers.indexOf(selection);
  if (at === -1) {
    return Err(
      new ReplProjectionError(
        "the selected history position is not in this journal. Return to the live head and " +
          "choose a checkpoint the history offers.",
      ),
    );
  }
  const end = at + 1;
  if (end === events.length) {
    // The selection names the last event, so the reading above is already it.
    return whole;
  }
  // Partitioned again rather than sliced by hand. Every boundary rule is about a
  // prefix, so a prefix of a valid partition is a valid partition — and reading
  // it that way keeps one description of what a segment is.
  const selected = partitionEntrySegments(events.slice(0, end));
  if (!selected.ok) {
    return selected;
  }
  return build(selected.value, markers.slice(0, end), selection, false);
}

/**
 * The root bindings one entry starts from.
 *
 * The last durably published value for each root name across every entry
 * admitted *before* that one, in the record shape the trusted-host entrypoint
 * takes. Named `entry` is the entry about to start or resume; absent, it is the
 * entry that would follow the last one this prefix holds. An entry never seeds
 * itself, so a history reopened at an unfinished final segment hands its
 * execution exactly what its first run was handed.
 *
 * Read off the projection and off nothing a process remembers: the same Journal
 * prefix produces the same record in a cold command, which is what makes an
 * inherited value a fact about the history rather than about whoever happened to
 * run it.
 *
 * Every name here is one an eval block could bind, because the projection
 * refused the record otherwise, and `props` is not here at all — the entries it
 * reads already exclude it. Core refuses both independently, so neither rule
 * rests on this function having applied it.
 *
 * `__proto__` is defined rather than assigned, for the reason the projection
 * defines it: assignment reaches `Object.prototype`'s inherited setter and would
 * drop the name while replacing the prototype.
 */
export function entryInitialBindings(
  model: ReplModel,
  entry?: ReplEntry,
): Readonly<Record<string, Json>> {
  const record: { [key: string]: Json } = {};
  // The entry itself rather than its key, so there is no spelling that names no
  // entry and quietly inherits nothing. Admission order counts from one, so the
  // entry before `order` is at `order - 2`, and the first entry has none.
  const before =
    entry === undefined ? model.entries[model.entries.length - 1] : model.entries[entry.order - 2];
  for (const binding of before?.bindings ?? []) {
    Object.defineProperty(record, binding.name, {
      value: binding.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(record);
}

/**
 * Every event's marker, in append order, spelled as the whole history spells it.
 *
 * Ordinals are counted inside the segment that holds the event, because that is
 * the history its own execution replayed: a second entry's root yield is its
 * coroutine's first, not the file's second. The entry key then namespaces every
 * marker after the first entry's, so one spelling names one position in the file
 * while every location an earlier build wrote still resolves to the event it
 * named.
 */
function globalMarkers(segments: readonly EntrySegment[], length: number): readonly string[] {
  const markers: string[] = Array.from({ length }, () => "");
  for (const segment of segments) {
    const ordinals = new Map<string, number>();
    for (let index = 0; index < segment.events.length; index++) {
      const event = segment.events[index];
      let ordinal = 0;
      if (event.type === "yield") {
        ordinal = ordinals.get(event.coroutineId) ?? 0;
        ordinals.set(event.coroutineId, ordinal + 1);
      }
      markers[segment.start + index] = entryMarker(segment.order, markerFor(event, ordinal));
    }
  }
  return markers;
}

/** The first marker that appears twice, if any. */
function firstDuplicate(markers: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const marker of markers) {
    if (seen.has(marker)) {
      return marker;
    }
    seen.add(marker);
  }
  return undefined;
}

/** A scope under construction, before the model is frozen. */
interface ScopeDraft {
  key: string;
  kind: "entry" | "component" | "generated";
  name: string;
  path: string;
  source: string;
  position: ReplPosition | undefined;
  marker: string;
  bindings: ReplBinding[];
  elicitations: ReplElicitation[];
  generated: ReplGenerated[];
  scopes: ScopeDraft[];
}

/**
 * Assemble one reading of a partitioned prefix.
 *
 * Each range is read by the one-entry reader below, exactly as a one-entry
 * history has always been read, and only a complete set of readings becomes a
 * model: an unreadable range refuses the whole projection rather than publishing
 * the entries before it. The global chronology is the entries' own turns
 * concatenated in admission order, so two entries that each recorded Prompt
 * sequence `0` stay in the order they ran rather than colliding.
 */
function build(
  segments: readonly EntrySegment[],
  markers: readonly string[],
  selection: string | undefined,
  head: boolean,
): Result<ReplModel> {
  const entries: ReplEntry[] = [];
  const transcript: ReplRow[] = [];
  const checkpoints: ReplCheckpoint[] = [];
  const chronology: ReplAgentTurn[] = [];
  /** What the root environment holds after the entries read so far. */
  let inherited: readonly ReplBinding[] = Object.freeze([]);

  for (const segment of segments) {
    const read = buildEntry(segment, markers.slice(segment.start, segment.end));
    if (!read.ok) {
      return read;
    }
    const reading = read.value;
    const bindings = inEffectAfter(inherited, reading.scope.bindings);
    inherited = bindings;
    entries.push(
      freeze({
        key: segment.key,
        order: segment.order,
        source: reading.scope.source,
        path: reading.scope.path,
        scope: reading.scope,
        transcript: reading.transcript,
        checkpoints: reading.checkpoints,
        terminal: reading.terminal,
        settled: reading.terminal !== undefined,
        bindings,
        turns: reading.turns,
      }),
    );
    transcript.push(...reading.transcript);
    checkpoints.push(...reading.checkpoints);
    chronology.push(...reading.turns);
  }

  const last = entries[entries.length - 1];
  const ordered = Object.freeze(chronology);
  return Ok(
    freeze({
      selection,
      head,
      entries: Object.freeze(entries),
      settled: last?.terminal !== undefined,
      terminal: last?.terminal,
      checkpoints: Object.freeze(checkpoints),
      transcript: Object.freeze(transcript),
      turns: ordered,
      sessions: conversationsOf(ordered),
    }),
  );
}

/**
 * The root bindings in effect after one entry: what it inherited, with what it
 * published over the top.
 *
 * A name keeps the position it first appeared in, so a reader watching a value
 * change across entries watches it change in place rather than move. Only values
 * an entry durably published are here — a value a run computed and never
 * retained is not something a cold reopen could find, so it is not something an
 * entry may inherit either.
 *
 * `props` is the one name that does not cross. Every entry's props namespace is
 * the one its own root validated, so a document that published a root value
 * under that name published it for itself. It stays visible in that entry's own
 * scope, where it happened, and is absent from here rather than listed as though
 * a later entry would receive it.
 */
function inEffectAfter(
  inherited: readonly ReplBinding[],
  own: readonly ReplBinding[],
): readonly ReplBinding[] {
  const effective = inherited.map((binding) => binding);
  for (const binding of own) {
    if (binding.name === ROOT_PROPS_BINDING) {
      continue;
    }
    const at = effective.findIndex((candidate) => candidate.name === binding.name);
    if (at === -1) {
      effective.push(binding);
      continue;
    }
    effective[at] = binding;
  }
  return Object.freeze(effective);
}

/** One entry's reading, before it is placed in the collection. */
interface EntryReading {
  readonly scope: ReplScope;
  readonly transcript: readonly ReplRow[];
  readonly checkpoints: readonly ReplCheckpoint[];
  readonly turns: readonly ReplAgentTurn[];
  readonly terminal: ReplTerminal | undefined;
}

/**
 * Read one entry's range: the same reading a one-entry history has always had.
 *
 * The range's shape is already settled — it begins with this entry's root
 * admission and holds at most one terminal close, because that is what made it a
 * range — so nothing here decides a boundary. The markers arrive spelled the way
 * the whole history spells them, so every position this reading retains is one a
 * location can name.
 */
function buildEntry(segment: EntrySegment, markers: readonly string[]): Result<EntryReading> {
  const events = segment.events;
  const transcript: ReplRow[] = [];
  const checkpoints: ReplCheckpoint[] = [];
  /** Every retained turn, in append order, before the chronology is ordered. */
  const turns: ReplAgentTurn[] = [];
  let terminal: ReplTerminal | undefined;
  /** Every scope by the source path it was admitted from, for owner lookup. */
  const byPath = new Map<string, ScopeDraft[]>();
  /** Every generated fragment this prefix admitted, by the identity it carries. */
  const fragments: GeneratedOwner[] = [];
  /**
   * Every identity the whole prefix admits, read before anything is projected.
   *
   * Only so that a history recording work *before* the admission that names it
   * can be told from one that never admitted it at all: both refuse, and a
   * reader repairing a history needs to know which of the two they have.
   */
  const announced = admittedIdentities(events);
  const occurrences = new Map<string, number>();

  // The range's first event is this entry's root admission, because that is what
  // began the range. Read here rather than recognized inside the loop, so the
  // reading below has an entry from its first iteration and the one thing a
  // segment cannot hold — a second root admission — needs no check it could
  // never reach.
  const rootSource = readRetainedSource(segment.admission);
  if (rootSource === undefined) {
    return Err(
      new ReplProjectionError(
        "the entry's recorded source cannot be read by this version of the REPL.",
      ),
    );
  }
  const entry: ScopeDraft = {
    key: segment.key,
    kind: "entry",
    name: segment.key,
    path: rootSource.path,
    source: rootSource.content,
    position: undefined,
    marker: markers[0],
    bindings: [],
    elicitations: [],
    generated: [],
    scopes: [],
  };
  register(byPath, entry);
  transcript.push({
    kind: "entry",
    marker: markers[0],
    path: rootSource.path,
    source: rootSource.content,
  });
  checkpoints.push({
    marker: markers[0],
    kind: "entry",
    label: `Entry ${segment.order} admitted`,
  });

  for (let index = 1; index < events.length; index++) {
    const event = events[index];
    const marker = markers[index];

    if (event.type === "close") {
      if (event.coroutineId !== "root") {
        transcript.push({ kind: "effect", marker, type: "close", status: event.result.status });
        continue;
      }
      const settled = readTerminal(event);
      if (settled === undefined) {
        return Err(
          new ReplProjectionError(
            "the recorded outcome of this entry cannot be read by this version of the REPL.",
          ),
        );
      }
      terminal = settled;
      transcript.push({ kind: "terminal", marker, status: settled.status, output: settled.output });
      checkpoints.push({ marker, kind: "terminal", label: "Settled" });
      continue;
    }

    const description = event.description;

    const position = readPosition(event);
    if (position === MALFORMED) {
      return Err(
        new ReplProjectionError(
          "a recorded effect carries a source position this version cannot read, so nothing can " +
            "say which part of the entry it belongs to.",
        ),
      );
    }

    if (description.type === "import_component") {
      const retained = readRetainedSource(event);
      if (retained === undefined) {
        transcript.push({
          kind: "effect",
          marker,
          type: description.type,
          status: event.result.status,
        });
        continue;
      }
      const owner = ownerOf(
        byPath,
        fragments,
        announced,
        position,
        site(event, index),
        `<${description.name} />`,
      );
      if (!owner.ok) {
        return owner;
      }
      const ordinalKey = `${owner.value.scope.key}/${description.name}`;
      const ordinal = (occurrences.get(ordinalKey) ?? 0) + 1;
      occurrences.set(ordinalKey, ordinal);
      const scope: ScopeDraft = {
        key: `${description.name}-${ordinal}`,
        kind: "component",
        name: description.name,
        path: retained.path,
        source: retained.content,
        position,
        marker,
        bindings: [],
        elicitations: [],
        generated: [],
        scopes: [],
      };
      owner.value.scope.scopes.push(scope);
      register(byPath, scope);
      transcript.push({
        kind: "scope",
        marker,
        scope: scope.key,
        name: scope.name,
        path: scope.path,
      });
      checkpoints.push({ marker, kind: "scope", label: `<${description.name} /> admitted` });
      continue;
    }

    if (description.type === "eval") {
      if (event.result.status !== "ok") {
        transcript.push({ kind: "effect", marker, type: "eval", status: event.result.status });
        continue;
      }
      const read = readExports(event);
      if (!read.ok) {
        return read;
      }
      const published = read.value;
      const owner = ownerOf(
        byPath,
        fragments,
        announced,
        position,
        site(event, index),
        "an evaluated block",
      );
      if (!owner.ok) {
        return owner;
      }
      for (const [name, value] of published.bindings) {
        bind(owner.value.scope, name, value);
      }
      if (published.bindings.length > 0) {
        transcript.push({
          kind: "binding",
          marker,
          scope: owner.value.scope.key,
          names: Object.freeze(published.bindings.map(([name]) => name)),
        });
        checkpoints.push({
          marker,
          kind: "binding",
          label: published.bindings.map(([name]) => name).join(", "),
        });
      }
      if (published.output !== undefined) {
        transcript.push({
          kind: "output",
          marker,
          scope: owner.value.scope.key,
          text: published.output,
        });
      }
      continue;
    }

    if (description.type === "generated_xmd") {
      if (event.result.status !== "ok") {
        transcript.push({
          kind: "effect",
          marker,
          type: "generated_xmd",
          status: event.result.status,
        });
        continue;
      }
      const admission = readAdmission(event);
      if (admission === undefined) {
        return Err(
          new ReplProjectionError(
            "a recorded generated fragment cannot be read by this version of the REPL.",
          ),
        );
      }
      const owner = ownerOf(
        byPath,
        fragments,
        announced,
        position,
        site(event, index),
        "a generated fragment",
      );
      if (!owner.ok) {
        return owner;
      }
      owner.value.scope.generated.push({ marker, ...admission });
      if (admission.decision === "admitted" && admission.source !== undefined) {
        const ordinalKey = `${owner.value.scope.key}/generated`;
        const ordinal = (occurrences.get(ordinalKey) ?? 0) + 1;
        occurrences.set(ordinalKey, ordinal);
        const fragment: ScopeDraft = {
          key: `generated-${ordinal}`,
          kind: "generated",
          name: "generated",
          path: owner.value.scope.path,
          source: admission.source,
          position,
          marker,
          bindings: [],
          elicitations: [],
          generated: [],
          scopes: [],
        };
        owner.value.scope.scopes.push(fragment);
        // Retained by the identity the admission carries rather than indexed by
        // a path it does not have: what belongs to this scope is the work the
        // fragment itself performed, and every one of those effects names this
        // exact admission.
        const admitted = generatedIdentity(description.name);
        if (admitted === undefined) {
          return Err(
            new ReplProjectionError(
              "a recorded generated fragment does not name the admission it is, so the work " +
                "inside it cannot be owned.",
            ),
          );
        }
        fragments.push({
          id: admitted,
          entry: entry.key,
          coroutine: event.coroutineId,
          order: index,
          scope: fragment,
        });
      }
      transcript.push({
        kind: "generated",
        marker,
        scope: owner.value.scope.key,
        source: admission.source,
        decision: admission.decision,
      });
      checkpoints.push({ marker, kind: "generated", label: "Generated XMD admitted" });
      continue;
    }

    if (description.type === "elicit") {
      if (event.result.status !== "ok") {
        transcript.push({ kind: "effect", marker, type: "elicit", status: event.result.status });
        continue;
      }
      const schema = readElicitationSchema(description);
      if (schema === undefined) {
        return Err(
          new ReplProjectionError(
            "a recorded question does not retain the schema it asked, so its answer cannot be " +
              "shown as the question it answered.",
          ),
        );
      }
      const answer = event.result.value;
      if (answer === undefined) {
        return Err(new ReplProjectionError("a recorded question records no answer at all."));
      }
      const owner = ownerOf(
        byPath,
        fragments,
        announced,
        position,
        site(event, index),
        "an answered question",
      );
      if (!owner.ok) {
        return owner;
      }
      const location = description.name.startsWith("elicit:")
        ? description.name.slice("elicit:".length)
        : description.name;
      const asked = detach(schema);
      const given = detach(answer);
      owner.value.scope.elicitations.push({
        marker,
        location,
        schema: asked,
        answer: given,
        position,
      });
      transcript.push({
        kind: "elicit",
        marker,
        scope: owner.value.scope.key,
        location,
        answer: given,
      });
      checkpoints.push({ marker, kind: "elicit", label: `Answered ${location}` });
      continue;
    }

    if (description.type === AGENT_PROMPT) {
      if (event.result.status !== "ok") {
        transcript.push({
          kind: "effect",
          marker,
          type: AGENT_PROMPT,
          status: event.result.status,
        });
        continue;
      }
      // Core's own parser, because the record is core's. Restating its shape
      // here would be a second reader that could disagree with the one the
      // runtime writes through, and the audits are the half of it that must not
      // be read loosely.
      const record = parsePromptRecord(event.result.value);
      if (record === undefined) {
        return Err(
          new ReplProjectionError(
            "a recorded Agent prompt cannot be read by this version of the REPL.",
          ),
        );
      }
      const input = description["input"];
      if (typeof input !== "string") {
        return Err(
          new ReplProjectionError("a recorded Agent prompt does not retain the text it asked."),
        );
      }
      const owner = ownerOf(
        byPath,
        fragments,
        announced,
        position,
        site(event, index),
        "an Agent prompt",
      );
      if (!owner.ok) {
        return owner;
      }
      const turn = agentTurn(
        marker,
        segment.key,
        owner.value.scope.key,
        owner.value.position,
        description.name,
        input,
        record,
      );
      turns.push(turn);
      transcript.push({ kind: "agent", marker, scope: owner.value.scope.key, turn });
      checkpoints.push({ marker, kind: "agent", label: `Agent prompt ${record.status}` });
      continue;
    }

    transcript.push({
      kind: "effect",
      marker,
      type: description.type,
      status: event.result.status,
    });
  }

  // Inside this entry and nowhere else. A sequence counts the Prompts of one
  // execution, and every entry is its own execution — so two entries each
  // recording `0` is what the protocol writes, while one entry recording it
  // twice is a history whose conversation cannot be ordered.
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (sequences.has(turn.sequence)) {
      return Err(
        new ReplProjectionError(`two recorded Agent prompts claim sequence ${turn.sequence}.`),
      );
    }
    sequences.add(turn.sequence);
  }

  // By the sequence each record states, not by where its event landed: a
  // Journal appends a turn when it finished, and two conversations running
  // beside each other finish in whatever order their providers answered.
  const chronology = [...turns].sort((left, right) => left.sequence - right.sequence);

  return Ok(
    freeze({
      scope: freezeScope(entry),
      transcript: Object.freeze(transcript.map((row) => freeze({ ...row }))),
      checkpoints: Object.freeze(checkpoints.map((checkpoint) => freeze({ ...checkpoint }))),
      turns: Object.freeze(chronology),
      terminal: terminal === undefined ? undefined : freeze({ ...terminal }),
    }),
  );
}

/**
 * One retained turn, copied out of the parsed record and frozen all the way
 * down.
 *
 * Copied again rather than kept: the parser's record is a reading of the event,
 * and what a component is handed has to be this model's own object — frozen, so
 * one reader cannot change what every other reader sees, and unshared, so
 * nothing the model holds is reachable from the events.
 */
function agentTurn(
  marker: string,
  entry: string,
  scope: string,
  position: ReplPosition,
  name: string,
  input: string,
  record: PromptRecord,
): ReplAgentTurn {
  return freeze({
    marker,
    entry,
    sequence: record.sequence,
    name,
    input,
    scope,
    position: freeze({ ...position }),
    agent: record.agent,
    sessionKey: record.sessionKey,
    agentSessionId: record.agentSessionId,
    status: record.status,
    stopReason: record.stopReason,
    text: record.text,
    failure: record.error?.message,
    configuration:
      record.configuration === undefined
        ? undefined
        : freeze({ model: record.configuration.model, effort: record.configuration.effort }),
    permissions: Object.freeze((record.permissions ?? []).map(agentPermission)),
  });
}

function agentPermission(permission: NonNullable<PromptRecord["permissions"]>[number]) {
  return freeze({
    toolCallId: permission.toolCallId,
    title: permission.title,
    kind: permission.kind,
    options: Object.freeze(
      permission.options.map((option) =>
        freeze({ optionId: option.optionId, name: option.name, kind: option.kind }),
      ),
    ),
    outcome: permission.outcome.outcome,
    selected: permission.outcome.outcome === "selected" ? permission.outcome.optionId : undefined,
  });
}

/**
 * The conversations one chronology holds.
 *
 * Grouped by the session key the provider named, and by nothing else: an agent
 * name, an authored Prompt name and a native session id all describe something
 * other than which conversation this was, and grouping by one of them would
 * merge two conversations or split one. A turn that reached no provider has an
 * empty key and joins nothing — inventing a conversation for it would put a
 * failure in a history it was never part of.
 */
function conversationsOf(chronology: readonly ReplAgentTurn[]): readonly ReplAgentSession[] {
  const grouped = new Map<string, ReplAgentTurn[]>();
  for (const turn of chronology) {
    if (turn.sessionKey.length === 0) {
      continue;
    }
    const held = grouped.get(turn.sessionKey);
    if (held === undefined) {
      grouped.set(turn.sessionKey, [turn]);
      continue;
    }
    held.push(turn);
  }
  // Insertion order, so a conversation appears where its earliest turn does.
  return Object.freeze(
    [...grouped].map(([sessionKey, held]) => freeze({ sessionKey, turns: Object.freeze(held) })),
  );
}

/** Publish one name into a scope, replacing an earlier value for that name. */
function bind(scope: ScopeDraft, name: string, value: Json): void {
  const at = scope.bindings.findIndex((binding) => binding.name === name);
  const binding = { name, value };
  if (at === -1) {
    scope.bindings.push(binding);
    return;
  }
  scope.bindings[at] = binding;
}

function register(index: Map<string, ScopeDraft[]>, scope: ScopeDraft): void {
  const held = index.get(scope.path);
  if (held === undefined) {
    index.set(scope.path, [scope]);
    return;
  }
  held.push(scope);
}

/**
 * One generated fragment this prefix admitted, as its own effects name it.
 *
 * Generated source is not a file, so the engine records the work inside it at a
 * position carrying the fragment's identity instead of a path — the id the
 * admission was decided under. This is that identity, with the two facts that
 * say whether a candidate effect could have come from it: which coroutine
 * admitted it, and how far into the history that was.
 */
interface GeneratedOwner {
  readonly id: string;
  /** The entry that admitted it. One execution holds one, and this states it. */
  readonly entry: string;
  readonly coroutine: string;
  /** Where the admission sits in this prefix, so only earlier work can be its. */
  readonly order: number;
  readonly scope: ScopeDraft;
}

/** Where one recorded effect sits: on which coroutine, and how far in. */
interface EffectSite {
  readonly coroutine: string;
  readonly order: number;
}

function site(event: Yield, order: number): EffectSite {
  return { coroutine: event.coroutineId, order };
}

/**
 * Every generated identity this prefix admits, wherever it admits it.
 *
 * Read from the same records the projection will read, and used for one thing:
 * telling "this history records work before the fragment that owns it" from
 * "this history admits no such fragment". Ownership itself is decided in order,
 * from the admissions already projected.
 */
function admittedIdentities(events: readonly DurableEvent[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const event of events) {
    if (event.type !== "yield" || event.description.type !== "generated_xmd") {
      continue;
    }
    // An admitted one alone. A refused fragment performed nothing and has no
    // scope, so a record naming its id is naming something that never ran.
    if (event.result.status !== "ok" || !isJsonObject(event.result.value)) {
      continue;
    }
    if (event.result.value["decision"] !== "admitted") {
      continue;
    }
    const identity = generatedIdentity(String(event.description.name));
    if (identity !== undefined) {
      found.add(identity);
    }
  }
  return found;
}

/** The id a generated admission's durable name carries, or none. */
function generatedIdentity(name: string): string | undefined {
  if (!name.startsWith("generated:")) {
    return undefined;
  }
  const id = name.slice("generated:".length);
  return id.length === 0 ? undefined : id;
}

/**
 * Whether one coroutine is the other, or an ancestor of it.
 *
 * Segment-aware on purpose: a child's id is its parent's with a further segment,
 * so `root.1` encloses `root.1.0` and has nothing to do with `root.10`.
 */
function descendsFrom(ancestor: string, coroutine: string): boolean {
  return coroutine === ancestor || coroutine.startsWith(`${ancestor}.`);
}

/**
 * The one scope an effect's source position belongs to.
 *
 * Two attributions, and a position states which one it is. A position naming a
 * path belongs to the scope admitted from that path. A position naming a
 * generated fragment belongs to the scope that fragment's admission created —
 * chosen by the identity the effect itself carries, with journal order and
 * coroutine ancestry deciding only whether that candidate could be its owner: an
 * admission that happened afterwards, or on work this effect is not part of, is
 * not an owner however recently it ran. Nothing is chosen by the latest
 * admission, the current scope, an effect's name or its line and column: a
 * binding attached to a guessed owner is a value shown in the wrong place, and
 * there is no spelling of "probably this one" that a reader could check.
 */
function ownerOf(
  index: Map<string, ScopeDraft[]>,
  fragments: readonly GeneratedOwner[],
  announced: ReadonlySet<string>,
  position: ReplPosition | undefined,
  where: EffectSite,
  subject: string,
): Result<{ scope: ScopeDraft; position: ReplPosition }> {
  if (position === undefined) {
    return Err(
      new ReplProjectionError(
        `${subject} was recorded without the source position that says which part of the entry ` +
          "it belongs to.",
      ),
    );
  }
  if (position.path === undefined) {
    return generatedOwnerOf(fragments, announced, position, where, subject);
  }
  const held = index.get(position.path) ?? [];
  if (held.length === 0) {
    return Err(
      new ReplProjectionError(
        `${subject} names a source this entry never admitted, so nothing owns it.`,
      ),
    );
  }
  if (held.length > 1) {
    return Err(
      new ReplProjectionError(
        `${subject} names a source this entry admitted more than once, so which occurrence owns ` +
          "it cannot be decided.",
      ),
    );
  }
  // The position travels back with the scope: an effect that has an owner has a
  // readable position by construction, and saying so here is what lets a caller
  // retain it without asking again whether it was there.
  return Ok({ scope: held[0], position });
}

/**
 * The generated fragment one pathless effect belongs to.
 *
 * The identity chooses the candidate; order and ancestry only say whether it
 * could be its owner. Each way that fails is its own refusal, because "nothing
 * owns this" and "two things might" are different damage and a reader acting on
 * either needs to know which they have.
 */
function generatedOwnerOf(
  fragments: readonly GeneratedOwner[],
  announced: ReadonlySet<string>,
  position: ReplPosition,
  where: EffectSite,
  subject: string,
): Result<{ scope: ScopeDraft; position: ReplPosition }> {
  const identity = position.generatedSource;
  if (identity === undefined) {
    return Err(
      new ReplProjectionError(
        `${subject} was recorded with neither a source path nor the generated fragment it ` +
          "belongs to, so nothing owns it.",
      ),
    );
  }
  const named = fragments.filter((fragment) => fragment.id === identity);
  if (named.length === 0) {
    return Err(
      new ReplProjectionError(
        announced.has(identity)
          ? `${subject} names a generated fragment this entry admitted only afterwards, so ` +
              "nothing had admitted it when it ran."
          : `${subject} names a generated fragment this entry never admitted, so nothing owns it.`,
      ),
    );
  }
  // Only an admission this effect could have come from: one that had already
  // happened, on this coroutine or on an ancestor of it.
  const earlier = named.filter((fragment) => fragment.order < where.order);
  const owning = earlier.filter((fragment) => descendsFrom(fragment.coroutine, where.coroutine));
  if (owning.length === 0) {
    return Err(
      new ReplProjectionError(
        `${subject} names a generated fragment admitted on work it is not part of, so nothing ` +
          "owns it.",
      ),
    );
  }
  if (owning.length > 1) {
    return Err(
      new ReplProjectionError(
        `${subject} names a generated fragment this entry admitted more than once, so which ` +
          "admission owns it cannot be decided.",
      ),
    );
  }
  return Ok({ scope: owning[0]!.scope, position });
}

/** What a position that will not read is, as distinct from one that is absent. */
const MALFORMED = Symbol("malformed source position");

function readPosition(event: Yield): ReplPosition | undefined | typeof MALFORMED {
  const field = event.description[SOURCE_POSITION_FIELD];
  if (field === undefined) {
    return undefined;
  }
  if (!isJsonObject(field)) {
    return MALFORMED;
  }
  const path = field["path"];
  const generatedSource = field["generatedSource"];
  const offset = field["offset"];
  const line = field["line"];
  const column = field["column"];
  if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
    return MALFORMED;
  }
  if (
    generatedSource !== undefined &&
    (typeof generatedSource !== "string" || generatedSource.length === 0)
  ) {
    return MALFORMED;
  }
  // One source, or neither. A position naming a file *and* a generated fragment
  // says two different things about where its effect was written, and there is
  // no reading of it that is not a choice between them.
  if (path !== undefined && generatedSource !== undefined) {
    return MALFORMED;
  }
  if (!isIndex(offset) || !isOrdinal(line) || !isOrdinal(column)) {
    return MALFORMED;
  }
  return { path, generatedSource, offset, line, column };
}

/**
 * The exact source a recorded import retained, or none when it retained none.
 *
 * Two shapes, because an import resolves two kinds of thing. A component read
 * from somewhere states the `path` it was read from; a component the host
 * *declared* states the `origin` it is known by, its digest and its bytes — and
 * that origin is the path every effect inside its body is recorded at, so it is
 * the path this model owns the scope under.
 *
 * Each is read as the closed record it is. A declared selection carries exactly
 * four members, or five when the optional `exact` disposition is present, and
 * `exact` is present only as `true`: a record with a member this version does
 * not know, or one it knows written as something else, is a record this version
 * cannot read rather than one to guess the rest of. What comes back for an
 * unreadable record is nothing, and an effect that then names its path has no
 * owner — which is the refusal, not a scope assembled from a guess.
 */
function readRetainedSource(event: Yield): { path: string; content: string } | undefined {
  if (event.result.status !== "ok" || !isJsonObject(event.result.value)) {
    return undefined;
  }
  const record = event.result.value;
  const content = record["content"];
  if (typeof content !== "string") {
    return undefined;
  }
  if (record["kind"] === "declared-markdown") {
    const origin = record["origin"];
    const digest = record["digest"];
    const exact = record["exact"];
    const withExact = Object.hasOwn(record, "exact");
    const members = Object.keys(record).length;
    if (
      members !== (withExact ? 5 : 4) ||
      typeof origin !== "string" ||
      typeof digest !== "string" ||
      (withExact && exact !== true)
    ) {
      return undefined;
    }
    return { path: origin, content };
  }
  const path = record["path"];
  if (typeof path !== "string") {
    return undefined;
  }
  return { path, content };
}

/**
 * The names a recorded evaluation published, and the output it rendered.
 *
 * Each published value is detached as it is read, so what the model goes on to
 * hold is never the object the event holds.
 */
function readExports(
  event: Yield,
): Result<{ bindings: [string, Json][]; output: string | undefined }> {
  if (event.result.status !== "ok" || !isJsonObject(event.result.value)) {
    return Err(new ReplProjectionError(UNREADABLE_EXPORTS));
  }
  const published = event.result.value["value"];
  if (!isJsonObject(published)) {
    return Err(new ReplProjectionError(UNREADABLE_EXPORTS));
  }
  const bindings: [string, Json][] = [];
  let output: string | undefined;
  for (const [name, value] of Object.entries(published)) {
    if (name === "__output") {
      if (typeof value !== "string") {
        return Err(new ReplProjectionError(UNREADABLE_EXPORTS));
      }
      output = value;
      continue;
    }
    // Checked against the parser an authored binding is checked against, here
    // and not when something tries to use it. A retained name no eval block
    // could have bound is a record this version cannot read — and reading it
    // anyway puts the name into a later entry's environment, where it reaches
    // the generated preamble and fails as a syntax error about a document that
    // never wrote it.
    const binding = validateBindingName(name);
    if (!binding.ok) {
      return Err(
        new ReplProjectionError(
          `a recorded evaluation published a value under a name no binding can have: ` +
            `${binding.error.message}`,
        ),
      );
    }
    bindings.push([name, detach(value)]);
  }
  return Ok({ bindings, output });
}

const UNREADABLE_EXPORTS =
  "a recorded evaluation's published values cannot be read by this version of the REPL.";

/** What a recorded generated fragment decided. */
function readAdmission(event: Yield): Omit<ReplGenerated, "marker"> | undefined {
  if (event.result.status !== "ok" || !isJsonObject(event.result.value)) {
    return undefined;
  }
  const record = event.result.value;
  const decision = record["decision"];
  if (decision === "admitted") {
    const source = record["source"];
    if (typeof source !== "string") {
      return undefined;
    }
    return { source, decision, construct: undefined };
  }
  if (decision === "refused") {
    const construct = record["construct"];
    if (typeof construct !== "string") {
      return undefined;
    }
    return { source: undefined, decision, construct };
  }
  return undefined;
}

/** What the root coroutine's close records, read as the document outcome. */
function readTerminal(event: Close): ReplTerminal | undefined {
  if (event.result.status === "cancelled") {
    return { status: "cancelled", output: "", message: undefined };
  }
  if (event.result.status === "err") {
    // The message alone. A serialized stack names host paths and the engine's
    // own frames, and the transcript is a reader's view of their entry.
    return { status: "err", output: "", message: event.result.error.message };
  }
  if (!isJsonObject(event.result.value)) {
    return undefined;
  }
  const record = event.result.value;
  const output = record["output"];
  const status = record["status"];
  if (typeof output !== "string") {
    return undefined;
  }
  if (status === "ok") {
    return { status, output, message: undefined };
  }
  if (status !== "err") {
    return undefined;
  }
  const failure = record["error"];
  if (!isJsonObject(failure) || typeof failure["message"] !== "string") {
    return undefined;
  }
  return { status, output, message: failure["message"] };
}

function isJsonObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIndex(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOrdinal(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Freeze a scope and everything reachable from it.
 *
 * Everything reachable is already this projection's own: a retained value was
 * detached the moment it was read, so freezing here cannot reach an object the
 * caller still holds. What the router hands a component is the exact object the
 * model holds, which is what makes two readings of one prefix one reading.
 */
function freezeScope(draft: ScopeDraft): ReplScope {
  return freeze({
    key: draft.key,
    kind: draft.kind,
    name: draft.name,
    path: draft.path,
    source: draft.source,
    position: draft.position === undefined ? undefined : freeze({ ...draft.position }),
    marker: draft.marker,
    bindings: Object.freeze(
      draft.bindings.map((binding) => freeze({ name: binding.name, value: binding.value })),
    ),
    elicitations: Object.freeze(
      draft.elicitations.map((elicitation) =>
        freeze({
          marker: elicitation.marker,
          location: elicitation.location,
          schema: elicitation.schema,
          answer: elicitation.answer,
          position:
            elicitation.position === undefined ? undefined : freeze({ ...elicitation.position }),
        }),
      ),
    ),
    generated: Object.freeze(draft.generated.map((generated) => freeze({ ...generated }))),
    scopes: Object.freeze(draft.scopes.map(freezeScope)),
  });
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/**
 * One retained value, copied out of the event graph and frozen.
 *
 * Copied rather than frozen in place, because the events belong to whoever
 * handed them over. Freezing a value inside them would reach back out of this
 * function and silently make the caller's own data immutable — a projection
 * that changed its input, which is the one thing a projection must not do. The
 * copy is what the model retains, so nothing the caller does to its events
 * afterwards can change what a reader is looking at either.
 *
 * `__proto__` is defined rather than assigned, for the same reason
 * `parseDurableEvent` defines it: assignment reaches `Object.prototype`'s
 * inherited setter and would drop the member while replacing the prototype.
 */
function detach(value: Json): Json {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const members = value.map(detach);
    Object.freeze(members);
    return members;
  }
  const copy: { [key: string]: Json } = {};
  for (const [key, member] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: detach(member),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}
