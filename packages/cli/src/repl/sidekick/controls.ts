/**
 * The words a reply may use, and what each of them asks the root to do.
 *
 * A reply is generated XMD evaluated as a root, so everything it can reach is a
 * component the host pinned into its ceiling. These are those components. Each
 * one is thin on purpose: it validates nothing about the REPL, decides nothing
 * about admission, and performs no work of its own. It turns an element into a
 * **semantic request** and waits for the root's answer.
 *
 * ## Why the request rather than the work
 *
 * The root owns the draft, the entry slot, the route and the liveness checks,
 * and it owns them because they are one decision made in one place — a control
 * that admitted an entry itself would be a second submitter racing the person's
 * own Run. So `<REPL.Submit />` does not admit anything. It asks, and the root
 * answers with what happened, which is also what makes the whole set revocable:
 * Stop revokes pending requests and the controls simply stop being answered.
 *
 * ## Why every invocation writes twice
 *
 * A control records its intent before it runs and its outcome once it has one.
 * The gap between those records is a real state — an operation that began and
 * whose result nobody knows — and a conversation interrupted inside a control
 * has to be readable as exactly that. One record written afterwards would make
 * an interrupted control indistinguishable from one that never began.
 *
 * ## Reads, writes, and which returns become feedback
 *
 * The read class observes and returns: bindings, the entry vocabulary, the six
 * guide chapters, the environment, and the four bounded reads of one entry's
 * saved evidence. The write class is
 * what changes something a person can see or asks them something: filling the
 * shared draft, submitting it, and canonical `<Elicit>`. Keeping them in
 * separate classes is what lets the captured ceiling say, exactly, that a reply
 * which only read could not have written and interrupted nobody.
 *
 * Some returns are *designated*: the root collects them and sends them back as
 * the next turn's input, because they are answers the reply asked for. A guide
 * chapter, the entry vocabulary, the environment snapshot and a question's
 * validated answer are designated. `<Syntax />` — Core's own description of
 * this response context — is not: its ordinary return is the reply's to
 * render, and intercepting it would turn every self-description into an
 * operation result.
 *
 * One admitted name is not a control written here at all. Canonical `<Elicit>`
 * is Core's own component, selected by name, so there is nothing for this
 * module to define and nothing for it to wrap — the provider the owner
 * installs is where its pair is written. See `questions.ts`.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { content } from "@executablemd/core";
import type { InvocationForm } from "@executablemd/core";
import type {
  FunctionComponentDefinition,
  GeneratedEffect,
  GeneratedForm,
  GeneratedForms,
} from "@executablemd/core";
import type { Json } from "@executablemd/durable-streams";

import type { RetainedPrefix } from "./history.ts";
import type { OutputRead, OutputReadRequest } from "./output.ts";
import type {
  EntryJournalPage,
  EntryPromptPage,
  EntryPromptRequest,
  EntryReadRequest,
  EntryTextPage,
} from "./entry-inspection.ts";

/** Where this feature's pinned identities come from. */
const ORIGIN = "@executablemd/cli:repl/sidekick";

/** The identity revision these components are pinned at. */
const REVISION = "1";

/** No component-specific props: every control's shape is its name and its form. */
const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/**
 * The canonical `names` schema, as `<Syntax />` declares it.
 *
 * A non-empty list of unique strings — the same shape the language already
 * uses, because the entry-vocabulary lookup is Syntax semantics over a
 * different symbol set rather than a second way of asking.
 */
const SYNTAX_NAMES_PROPS = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      uniqueItems: true,
      description:
        "Optional. Render these components' metadata and long-form documentation " +
        "instead of the list of available symbols.",
    },
  },
  additionalProperties: false,
} as const;

/** The six guide chapters, which are the whole of the teaching a reply can read. */
export const GUIDE_CHAPTERS = [
  "Entries",
  "Bindings",
  "Effection",
  "Lifetimes",
  "Recovery",
  "Environment",
] as const;

export type GuideChapter = (typeof GUIDE_CHAPTERS)[number];

/**
 * What the root will do for a reply, and nothing more.
 *
 * Supplied by the owner, which is where the REPL's own state is. Every member
 * answers with a `Result`: a refusal is this operation's outcome rather than
 * the end of the response, because a reply that asked for something
 * unavailable may well ask for something else next.
 */
export interface SidekickRequests {
  /** The acknowledged published root values, detached. */
  bindings(): Operation<Result<Json>>;
  /** The active entry vocabulary, or the lookup of particular names. */
  entrySyntax(names?: readonly string[]): Operation<Result<string>>;
  /** One guide chapter, as the literal Markdown it is. */
  guide(chapter: GuideChapter): Operation<Result<string>>;
  /** The environment facts this host knows, and its explicit unknowns. */
  environment(): Operation<Result<string>>;
  /** Fill the shared draft with exactly this source. Moves no focus. */
  fillDraft(source: string): Operation<Result<void>>;
  /** Admit the draft and wait for the exact admitted entry to finish. */
  submit(): Operation<Result<SubmitReceipt>>;
  /** Read one window of one entry's observed output. */
  entryOutput(request: OutputReadRequest): Operation<Result<OutputRead>>;
  /** Read one window of the exact source one entry was admitted with. */
  inspectSource(request: EntryReadRequest): Operation<Result<EntryTextPage>>;
  /** Read one window of one saved turn's reply, request or failure message. */
  inspectPrompt(request: EntryPromptRequest): Operation<Result<EntryPromptPage>>;
  /** Read one window of what one entry printed, by its admission number. */
  inspectOutput(request: EntryReadRequest): Operation<Result<EntryTextPage>>;
  /** Read where one entry's saved evidence is, and what it failed at. */
  inspectJournal(request: EntryReadRequest): Operation<Result<EntryJournalPage>>;
}

/**
 * What Submit answers with.
 *
 * A status, the exact entry, and a read that is ready to use — and no output
 * body, preview or summary. A reply that wants to know what the entry printed
 * reads it, which is a separate operation with its own bounds. Handing back a
 * body here would make every submission carry output nobody asked for.
 */
export interface SubmitReceipt {
  readonly entry: string;
  readonly status: "completed" | "failed" | "cancelled";
  /** Why it failed, when it did. */
  readonly failure: string | undefined;
  /** The read a reply follows to see what it printed. */
  readonly read: OutputReadRequest;
}

/** One control occurrence, as the conversation retains it. */
export interface ControlOccurrence {
  readonly component: string;
  readonly arguments: Json;
}

/**
 * How a control's invocation is recorded and answered.
 *
 * `began` is called before the work and `settled` afterwards, which is what
 * produces the intent/outcome pair. The owner supplies them because ordering
 * within a response is the owner's to keep: the number a control is given is
 * its position in admission order, not a count this module could know.
 */
export interface ControlJournal {
  /**
   * Record that this control is about to run, and give it its order.
   *
   * `reserved` is Submit's alone, and it is the whole reason the intent is
   * written before the work rather than after it: a reply's submission is read
   * back by whatever process comes next, so what it stated — the slot it
   * counted, the entry id, the exact source and the revision that source came
   * from — has to be on disk before the slot is acted on. Every other control
   * answers a question about state that is already there, so there is nothing
   * for it to bind.
   */
  began(occurrence: ControlOccurrence, reserved?: ReservedSlot): Operation<number>;
  settled(order: number, outcome: Result<unknown>, observed?: Json): Operation<void>;
}

/** The entry slot a Submit intent binds, so a dead process can be reconciled. */
export interface ReservedSlot {
  /** How many entries preceded the reservation, which names the slot. */
  readonly ordinal: number;
  readonly entry: string;
  readonly source: string;
  readonly revision: number;
  /**
   * The entry journal the slot was counted in.
   *
   * Separate from the ordinal, because the ordinal cannot say which records
   * preceded it: a different valid history of the same length has the same
   * ordinal, and only these bytes distinguish them.
   */
  readonly retained: RetainedPrefix;
}

/**
 * Canonical `<Elicit>`'s own name, as the designated set and the journal use it.
 *
 * Core's, not this CLI's: the conversation selects the name `Elicit` and the
 * capture retains the registry's own definition for it. Written once so the
 * component the journal records cannot drift from the component the selection
 * named — if the two disagreed, a validated answer would be retained under a
 * name the designated set does not hold and no reply would ever be told it.
 */
export const ELICIT_CONTROL = "Elicit";

/**
 * The four saved-evidence reads, by the names a reply writes them under.
 *
 * Dotted under `REPL.Entry` because they are four questions about one entry,
 * and a reply that has learned one has learned where the others are. Named
 * once, so the designated set and the definitions below cannot disagree about
 * which names this conversation owns.
 */
export const ENTRY_INSPECTIONS = [
  "REPL.Entry.Source",
  "REPL.Entry.Prompt",
  "REPL.Entry.Output",
  "REPL.Entry.Journal",
] as const;

/**
 * Which returns the root collects as the next turn's input.
 *
 * Every control this CLI supplies, reads and writes alike. A write is
 * designated for the same reason a read is: the reply asked the root to do
 * something and the answer is what it needs to continue — a Submit that
 * admitted `entry-3` has to be told so, and told which entry, or its next
 * response is written against a guess.
 *
 * Canonical `<Elicit>` is designated too, and it is the one whose answer the
 * reply cannot possibly have: a person typed it. Its ordinary `as` capture
 * still binds the validated value inside the response — capturing a designated
 * control's value does not switch its feedback off — so a reply may both use
 * the answer where it asked and be told it afterwards.
 *
 * Canonical `<Syntax />` is deliberately absent, and so is every ordinary
 * component return. `<Syntax />` describes this response context, and its
 * return is the reply's own to render or capture; intercepting it would turn
 * every self-description into an operation result.
 *
 * `REPL.EntryOutput` is here and is no longer a control a response may write.
 * The set is what decides which *retained* results come back, and a chat
 * saved before `<REPL.Entry.Output />` replaced it still holds that control's
 * own pairs: dropping the name would stop a reopened conversation being told
 * what its own history says it asked for. Admitting the name again is a
 * separate question, and `sidekickObservations()` answers it with nothing.
 */
export const DESIGNATED: ReadonlySet<string> = new Set([
  "REPL.Bindings",
  "REPL.Syntax",
  "REPL.Environment",
  "REPL.EntryInput",
  "REPL.Submit",
  "REPL.EntryOutput",
  ...ENTRY_INSPECTIONS,
  ELICIT_CONTROL,
  ...GUIDE_CHAPTERS.map((chapter) => `Guide.${chapter}`),
]);

/** The acknowledgement a filled draft answers with, which is not its source. */
export const DRAFT_FILLED = "Entry input updated.";

/**
 * The identity one control offers its admitted spelling under.
 *
 * An absolute `https://executable.md/` URL, because that is what a declaration
 * states a generated use under and what a retained policy is compared against.
 * It is the declaration's own: the capture reads it off the definition this
 * module builds rather than taking a value stated beside the entry, so a
 * control cannot be admitted under one identity and run under another.
 */
function identity(key: string): string {
  return `https://executable.md/components/repl/sidekick/${key.toLowerCase()}`;
}

/**
 * One control this conversation owns.
 *
 * What the owner's setup needs in one place: the name a reply writes, the
 * spelling it is offered for, whether writing it observes or mutates, and the
 * definition this CLI answers the name with. A control with no definition is a
 * *protected* name canonical resolution answers for itself — the conversation
 * selects it and core's own implementation is what the capture retains.
 */
export interface SidekickControl {
  readonly name: string;
  readonly form: InvocationForm;
  readonly effect: "read" | "write";
  readonly definition?: FunctionComponentDefinition;
  /**
   * The props the compact surface states for a control with no definition here.
   *
   * Only for a selected protected name: this module has no schema of its own to
   * read for one, and a reply still has to be told what the control takes. It
   * is the authored contract of a published language feature rather than a copy
   * of an internal — and the controls tier compares it against the canonical
   * definition's own schema, so a core component that gained a prop fails the
   * row rather than quietly leaving a reply under-told.
   */
  readonly props?: readonly string[];
}

/**
 * One reading control, offered self-closing.
 *
 * The generated metadata travels on the definition rather than beside it: the
 * capture resolves this name through the ordinary import chain and reads what
 * each offered spelling runs under off the answer, so the identity and the
 * effect are stated once, here, by the declaration that owns the body.
 */
function reading(
  name: string,
  key: string,
  definition: FunctionComponentDefinition,
): SidekickControl {
  return {
    name,
    form: "self-closing",
    effect: "read",
    definition: { ...definition, generated: offering(key, "self-closing", "read") },
  };
}

/** One writing control, offered in the single spelling that writes. */
function writing(
  name: string,
  key: string,
  form: InvocationForm,
  definition: FunctionComponentDefinition,
): SidekickControl {
  return {
    name,
    form,
    effect: "write",
    definition: { ...definition, generated: offering(key, form, "write") },
  };
}

/**
 * The generated use one control's declaration offers, for one spelling.
 *
 * The form is a value rather than a literal, so the table it keys is annotated
 * as the partial record `GeneratedForms` already is. That is what makes the
 * computed key check against `InvocationForm` instead of widening to a string
 * table nothing would have verified.
 */
function offering(key: string, form: InvocationForm, effect: GeneratedEffect): GeneratedForms {
  const offered: Partial<Record<InvocationForm, GeneratedForm>> = {
    [form]: { identity: identity(key), effect },
  };
  return offered;
}

/**
 * Run one control's work, recording the intent before and the outcome after.
 *
 * The outcome crosses as a `Result` and the *rendered* value is what the
 * element becomes. A refusal renders its reason, so a reply reads why its
 * operation did not happen in the place it asked for it.
 */
function* performed<T>(
  journal: ControlJournal,
  occurrence: ControlOccurrence,
  work: () => Operation<Result<T>>,
  render: (value: T) => string,
  observed?: (value: T) => Json,
): Operation<string> {
  const answer = yield* settled(journal, occurrence, work, observed);
  return answer.ok ? render(answer.value) : answer.error.message;
}

/**
 * Run one read and hand its page back as the object it is.
 *
 * The saved-evidence reads answer with structured pages rather than with
 * prose, so the element becomes that page: an ordinary `as` binds it by
 * reference, and an uncaptured one renders nothing. A refusal still renders
 * its reason, in the place the read was asked for, exactly as every other
 * control's does.
 *
 * The page is also what the outcome retains, which is why it is not serialized
 * first: a reply that captured one and a reply that did not are told the same
 * thing, and the thing they are told is the page the control answered with.
 */
function* inspected<T extends Json>(
  journal: ControlJournal,
  occurrence: ControlOccurrence,
  work: () => Operation<Result<T>>,
): Operation<T | string> {
  const answer = yield* settled(journal, occurrence, work, (page) => page);
  return answer.ok ? answer.value : answer.error.message;
}

/**
 * Record one control's intent, run its work, and record what it answered.
 *
 * One place, because the gap between the two records is the state an
 * interrupted control has to be readable as: an intent written after the work
 * would make a control that never finished indistinguishable from one that
 * never began. A thrown failure is recorded before it travels on, for the same
 * reason.
 */
function* settled<T>(
  journal: ControlJournal,
  occurrence: ControlOccurrence,
  work: () => Operation<Result<T>>,
  observed?: (value: T) => Json,
): Operation<Result<T>> {
  const order = yield* journal.began(occurrence);
  let answer: Result<T>;
  try {
    answer = yield* work();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    yield* journal.settled(order, Err(failure));
    throw failure;
  }
  yield* journal.settled(
    order,
    answer,
    answer.ok && observed !== undefined ? observed(answer.value) : undefined,
  );
  return answer;
}

/**
 * Run one control whose own work writes the pair, and render what it answered.
 *
 * `<REPL.Submit />` alone, and the reason is the thing that makes its intent
 * different from every other control's: that intent *binds the reservation it
 * took*, and the reservation does not exist until the root has established the
 * session's terms, let the entry writer settle and taken the slot — all inside
 * the work. A wrapper that recorded an intent out here would write one before
 * there was anything to bind, and the response's history would hold two
 * intents for one submission: an interrupted Submit would then be readable as
 * two attempts, which is the one reading recovery must never be given.
 *
 * So the ordering belongs to whoever takes the slot, and this does what is
 * left: it renders the answer, and renders a refusal as the reason it is. A
 * submission refused before the slot was taken writes nothing at all, which is
 * correct — a reservation that never existed has no outcome to record.
 */
function* delegated<T>(
  work: () => Operation<Result<T>>,
  render: (value: T) => string,
): Operation<string> {
  const answer = yield* work();
  return answer.ok ? render(answer.value) : answer.error.message;
}

/**
 * The read class: everything a reply may observe.
 *
 * Self-closing, every one of them, and with no component-specific props. A read
 * that took arguments a reply could compose would be a read whose ceiling could
 * not state what it reaches; the two that genuinely need an argument — the
 * vocabulary lookup and the output window — take them as ordinary props the
 * schema below admits by name.
 */
export function sidekickObservations(
  requests: SidekickRequests,
  journal: ControlJournal,
): SidekickControl[] {
  const observations: SidekickControl[] = [
    reading("REPL.Bindings", "Bindings", {
      kind: "function",
      name: "REPL.Bindings",
      props: NO_PROPS,
      *fn(): Operation<string> {
        return yield* performed(
          journal,
          { component: "REPL.Bindings", arguments: {} },
          () => requests.bindings(),
          // The detached map, as JSON a reply reads rather than as prose about
          // it. Pretty-printed because a reply reads it.
          (value) => JSON.stringify(value, null, 2),
          (value) => value,
        );
      },
    }),
    reading("REPL.Syntax", "Syntax", {
      kind: "function",
      name: "REPL.Syntax",
      // Canonical `<Syntax />`'s own schema, reused rather than restated: this
      // lookup *is* Syntax semantics applied to the entry vocabulary, so a
      // reply that has learned one spelling has learned both. A
      // comma-separated string would have been a third spelling nothing else
      // in the language uses.
      props: SYNTAX_NAMES_PROPS,
      *fn(props: { names?: readonly string[] }): Operation<string> {
        const names = props.names;
        return yield* performed(
          journal,
          {
            component: "REPL.Syntax",
            arguments: names === undefined ? {} : { names: [...names] },
          },
          () => requests.entrySyntax(names),
          (value) => value,
          (value) => value,
        );
      },
    }),
    reading("REPL.Environment", "Environment", {
      kind: "function",
      name: "REPL.Environment",
      props: NO_PROPS,
      *fn(): Operation<string> {
        return yield* performed(
          journal,
          { component: "REPL.Environment", arguments: {} },
          () => requests.environment(),
          (value) => value,
          (value) => value,
        );
      },
    }),
  ];
  observations.push(...entryInspections(requests, journal));
  for (const chapter of GUIDE_CHAPTERS) {
    const name = `Guide.${chapter}`;
    observations.push(
      reading(name, name, {
        kind: "function",
        name,
        props: NO_PROPS,
        *fn(): Operation<string> {
          return yield* performed(
            journal,
            { component: name, arguments: {} },
            () => requests.guide(chapter),
            // Literal Markdown, returned as it is written. Nothing in a guide
            // is interpolated or executed: an example in a chapter is text
            // about what to write, not something this read performs.
            (value) => value,
            (value) => value,
          );
        },
      }),
    );
  }
  return observations;
}

/** The selector props every saved-evidence read takes. */
const ENTRY_SELECTION = {
  entry: { type: "number" },
  offset: { type: "number" },
  limit: { type: "number" },
} as const;

/**
 * The four reads of one entry's saved evidence.
 *
 * Each returns its page as the object it is, so an ordinary `as` binds the
 * page and an uncaptured read renders nothing — no `returns` declaration,
 * which would make `as` mandatory and take the shortest form away. What the
 * outcome retains is that same page, which is what the next turn is sent.
 */
function entryInspections(requests: SidekickRequests, journal: ControlJournal): SidekickControl[] {
  return [
    reading("REPL.Entry.Source", "Entry.Source", {
      kind: "function",
      name: "REPL.Entry.Source",
      props: {
        type: "object",
        properties: { ...ENTRY_SELECTION },
        additionalProperties: false,
      },
      description:
        "Read the exact source one entry was admitted with. " +
        "`<REPL.Entry.Source entry={22} />` answers with a window of that source, counted in " +
        "Unicode code points, and the arguments of the windows either side of it.",
      *fn(props: EntryReadRequest): Operation<EntryTextPage | string> {
        return yield* inspected(
          journal,
          { component: "REPL.Entry.Source", arguments: { ...props } },
          () => requests.inspectSource(props),
        );
      },
    }),
    reading("REPL.Entry.Prompt", "Entry.Prompt", {
      kind: "function",
      name: "REPL.Entry.Prompt",
      props: {
        type: "object",
        properties: {
          ...ENTRY_SELECTION,
          prompt: { type: "number" },
          field: { type: "string" },
        },
        additionalProperties: false,
      },
      description:
        "Read one saved agent turn of one entry. " +
        '`<REPL.Entry.Prompt entry={22} prompt={9} field="error" />` answers with that turn\'s ' +
        "reply, request or complete failure message, its own status and where it was written. " +
        "A turn that recorded no failure answers with null text rather than an empty one.",
      *fn(props: EntryPromptRequest): Operation<EntryPromptPage | string> {
        return yield* inspected(
          journal,
          { component: "REPL.Entry.Prompt", arguments: { ...props } },
          () => requests.inspectPrompt(props),
        );
      },
    }),
    reading("REPL.Entry.Output", "Entry.Output", {
      kind: "function",
      name: "REPL.Entry.Output",
      props: {
        type: "object",
        properties: { ...ENTRY_SELECTION },
        additionalProperties: false,
      },
      description:
        "Read what one entry printed. `<REPL.Entry.Output entry={22} />` answers with the last " +
        "window of that entry's output; `offset={0}` reads from the beginning. An entry that " +
        "retained none answers with an empty window.",
      *fn(props: EntryReadRequest): Operation<EntryTextPage | string> {
        return yield* inspected(
          journal,
          { component: "REPL.Entry.Output", arguments: { ...props } },
          () => requests.inspectOutput(props),
        );
      },
    }),
    reading("REPL.Entry.Journal", "Entry.Journal", {
      kind: "function",
      name: "REPL.Entry.Journal",
      props: {
        type: "object",
        properties: { ...ENTRY_SELECTION },
        additionalProperties: false,
      },
      description:
        "Find where one entry's saved evidence is. `<REPL.Entry.Journal entry={22} />` answers " +
        "with that entry's complete failure message, how its agent turns ended, and a window of " +
        "its saved records — each naming what it was and which prompt to read next.",
      *fn(props: EntryReadRequest): Operation<EntryJournalPage | string> {
        return yield* inspected(
          journal,
          { component: "REPL.Entry.Journal", arguments: { ...props } },
          () => requests.inspectJournal(props),
        );
      },
    }),
  ];
}

/**
 * The write class: what a reply may change, and who it may interrupt.
 *
 * `REPL.EntryInput` is paired, `REPL.Submit` is self-closing and canonical
 * `<Elicit>` is paired, and each is admitted for that spelling alone. The forms
 * are part of the identity because the spellings mean different things: a
 * paired Submit would be a Submit with a body nobody reads, a self-closing
 * EntryInput would fill the draft with nothing, and a self-closing `<Elicit />`
 * would be a question with nothing in it.
 *
 * The question is in this class rather than the read one, and the reason is the
 * same reason it is in the fragment profile's write table: asking is not
 * reading. A `read` selection promises nobody will be interrupted, and a reply
 * admitted on that promise must not be able to stop and wait for a person.
 */
export function sidekickMutations(
  requests: SidekickRequests,
  journal: ControlJournal,
): SidekickControl[] {
  return [
    writing("REPL.EntryInput", "EntryInput", "paired", {
      kind: "function",
      name: "REPL.EntryInput",
      props: NO_PROPS,
      *fn(): Operation<string> {
        // The rendered content, once. It is entry source — not response
        // syntax — so it is handed over as the literal string it is and
        // never re-expanded.
        const source = String(yield* content());
        return yield* performed(
          journal,
          { component: "REPL.EntryInput", arguments: { source } },
          () => requests.fillDraft(source),
          // The acknowledgement, not the program. A reply that was handed its
          // own source back would spend a turn reading what it just wrote.
          () => DRAFT_FILLED,
        );
      },
    }),
    writing("REPL.Submit", "Submit", "self-closing", {
      kind: "function",
      name: "REPL.Submit",
      props: NO_PROPS,
      *fn(): Operation<string> {
        // Unjournaled here on purpose; see {@link delegated}. The root writes
        // this control's pair, because the intent binds the slot the root
        // took and nothing out here knows what that is yet.
        return yield* delegated(() => requests.submit(), renderReceipt);
      },
    }),
    // Core's own `<Elicit>`, admitted paired — and with **no definition of its
    // own**. `<Elicit>` is a protected component, so this conversation selects
    // the name and canonical resolution answers for it from core's own tier:
    // what the capture retains is the registry's definition, and the body a
    // reply reaches is the one an authored document reaches. A provider
    // published beside it would be a second definition for one name, and a
    // repository, registered or middleware `Elicit` reaches a generated reply
    // not at all.
    //
    // Paired and in the write class because `components/Elicit.ts` offers it
    // that way and nowhere else: the question is the content, so a self-closing
    // spelling is a request with nothing in it, and `allow={["read"]}` promises
    // nobody will be interrupted. Neither is stated here.
    //
    // Its answer still becomes feedback. The pair is written by the provider
    // the owner installs rather than by `performed()` here; see `questions.ts`.
    { name: ELICIT_CONTROL, form: "paired", effect: "write", props: ["schema"] },
  ];
}

/**
 * What a Submit receipt reads as.
 *
 * The status, the exact entry and the read to follow. No body: a reply that
 * wants the output asks for it, with its own bounds.
 *
 * Which read it points at follows what happened. An entry that completed has
 * output to read; one that failed or was cancelled has evidence to inspect,
 * and output alone would send a reply to an empty window for an entry that
 * never printed. Both name the entry the submission actually admitted, taken
 * from the receipt rather than from whatever a person has selected.
 *
 * Exported because the same receipt is read twice — once where the control was
 * written, and once as the operation result the next turn is sent — and two
 * renderings of one fact would be two accounts of one entry.
 */
export function renderReceipt(receipt: SubmitReceipt): string {
  const lines = [`Entry ${receipt.entry} ${receipt.status}.`];
  if (receipt.failure !== undefined) {
    lines.push(`It failed: ${receipt.failure}`);
  }
  const admitted = admissionNumber(receipt.entry);
  if (admitted !== undefined) {
    lines.push(
      receipt.status === "completed"
        ? `Read what it printed with <REPL.Entry.Output entry={${admitted}} />.`
        : `Inspect its saved evidence with <REPL.Entry.Journal entry={${admitted}} />.`,
    );
  }
  return lines.join("\n");
}

/**
 * The admission number one entry key spells.
 *
 * A read names an entry by that number, so a receipt that could not read one
 * off its own key says what happened and stops there: an invocation written
 * without it would name the latest entry, which is the one case a receipt must
 * never point at.
 */
function admissionNumber(entry: string): number | undefined {
  const spelled = /^entry-([1-9][0-9]*)$/.exec(entry);
  return spelled === null ? undefined : Number(spelled[1]);
}

/**
 * What one retained `REPL.EntryOutput` window reads as.
 *
 * Historical. The control that produced these windows is no longer one a
 * response may write — `<REPL.Entry.Output />` answers that question now, with
 * a page — but a chat saved before the replacement still holds its retained
 * observations, and a reopened conversation is told what its own history says.
 * So this renders a saved window as the window it was, rather than
 * reinterpreting the record it is reading.
 *
 * The output goes in a fence long enough to hold it, because entry output is
 * exactly the text most likely to contain one of its own. The range is stated
 * beside it so a reply knows what it is looking at, and the next instruction is
 * given only when there is more — a reply told there is more when there is not
 * would keep reading forever.
 */
export function renderRead(held: OutputRead): string {
  const fence = "`".repeat(Math.max(3, longestRun(held.text, "`") + 1));
  const lines = [
    `Entry ${held.entry} (${held.status}), code points ${held.offset}–` +
      `${held.offset + [...held.text].length} of ${held.length}.`,
    fence,
    held.text,
    fence,
  ];
  if (held.next !== undefined) {
    lines.push(
      `There is more. Read it with <REPL.EntryOutput entry="${held.next.entry}" ` +
        `offset={${held.next.offset}} limit={${held.next.limit}} />.`,
    );
  }
  return lines.join("\n");
}

/** The longest run of one character, so a fence can be longer than it. */
function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const held of text) {
    current = held === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
