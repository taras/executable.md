/**
 * What a turn is actually sent, and what the history retains about having sent it.
 *
 * Two jobs, and they are the same job seen from either end. A saved turn
 * carries text; the question "what did this agent actually know when it wrote
 * that?" is a question about that turn, forever, and the only honest answer is
 * the text itself. So this module composes the text and hands back the exact
 * pieces the `reference` record retains — rather than letting a projector
 * reconstruct an orientation from whatever the assets say later.
 *
 * ## The first turn of a conversation carries the orientation, and no other does
 *
 * An agent that has been told the vocabulary does not need telling again, and a
 * conversation is the unit that remembers: the provider keeps the turns, so
 * repeating the bootstrap every turn would spend the context window restating
 * what is already in it. A *new* conversation is a new agent as far as this is
 * concerned, and gets its own.
 *
 * ## Short on purpose
 *
 * The packet is orientation, not documentation: what a reply may write, which
 * guides exist and how to ask for one, the draft as it stands, and the person's
 * request. Chapter bodies, the entry vocabulary and component documentation are
 * reads, because a reply needs them only when it is about to use them — and a
 * first turn spent on vocabulary it may never use is a first turn that cannot
 * answer.
 *
 * ## Versions, so a later turn can tell what changed
 *
 * Each piece travels with a digest of exactly the bytes delivered. That is what
 * lets a compatible asset change refresh the relevant orientation before the
 * next explicit turn without re-sending what did not change, and what makes a
 * retained reference checkable rather than merely plausible.
 */

import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";

import { DESIGNATED, DRAFT_FILLED, renderRead, renderReceipt } from "./controls.ts";
import type { ControlOutcomeRecord, ControlPresentationRecord, ControlRecord } from "./history.ts";
import type { OutputRead } from "./output.ts";
import { describeGuideIndex, readSidekickBootstrap, sidekickGuideIndex } from "./guide.ts";
import { fingerprint } from "./history.ts";
import type { SidekickRecord } from "./history.ts";
import { describeSurface } from "./profile.ts";
import type { SurfaceEntry } from "./profile.ts";

/** Why a turn's orientation could not be assembled, which sends no turn. */
export class SidekickContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidekickContextError";
  }
}

/** The orientation one turn carried, and the record of having carried it. */
export interface TurnContext {
  readonly bootstrap: string;
  readonly index: string;
  readonly surface: string;
  /** A digest of exactly the bytes each piece was delivered as. */
  readonly versions: Readonly<Record<string, string>>;
}

/**
 * Assemble the orientation a conversation's first turn carries.
 *
 * `admitted` is the set of names the response ceiling actually pins, so the
 * index advertises a chapter this reply can read and no other — the same
 * entries the ceiling is built from rather than a list kept beside it. A
 * chapter whose asset cannot be read is left out of the index and still
 * refuses if asked for, which is the one order of events that cannot mislead.
 *
 * The bootstrap is required: it is the whole of what makes an unfamiliar agent
 * able to write a valid response at all, and a turn sent without it is a turn
 * asked to guess. A missing one refuses rather than sending a thinner packet.
 */
export function* turnContext(input: {
  readonly admitted: ReadonlySet<string>;
  readonly surface: readonly SurfaceEntry[];
}): Operation<Result<TurnContext>> {
  const bootstrap = yield* readSidekickBootstrap();
  if (!bootstrap.ok) {
    return Err(
      new SidekickContextError(
        `this build cannot read the Sidekick's own instructions, so no turn was sent: ` +
          `${bootstrap.error.message}`,
      ),
    );
  }
  const index = describeGuideIndex(yield* sidekickGuideIndex(input.admitted));
  const surface = describeSurface(input.surface);
  return Ok({
    bootstrap: bootstrap.value,
    index,
    surface,
    versions: Object.freeze({
      bootstrap: yield* digest(bootstrap.value),
      index: yield* digest(index),
      surface: yield* digest(surface),
    }),
  });
}

/**
 * Whether the orientation an agent was last given still describes this build.
 *
 * Compared by digest, piece by piece, against what a `reference` record says a
 * turn of this conversation actually carried. `undefined` means no turn has
 * been oriented yet, which is not a change — it is the first turn, and that is
 * a different question.
 *
 * The case this exists for is a conversation continued by a later process: the
 * assets and the admitted ceiling are fixed for the life of one build, so
 * nothing moves within a single run. A newer build reopening a chat is where an
 * agent is holding orientation that no longer describes what it may write, and
 * the only honest way to notice is to compare what was delivered with what is
 * current.
 */
export function orientationChanged(
  current: Readonly<Record<string, string>>,
  delivered: Readonly<Record<string, string>> | undefined,
): boolean {
  if (delivered === undefined) {
    return false;
  }
  const names = new Set([...Object.keys(current), ...Object.keys(delivered)]);
  for (const name of names) {
    if (current[name] !== delivered[name]) {
      return true;
    }
  }
  return false;
}

/**
 * The exact text one turn is sent.
 *
 * The orientation first when there is one, then the draft as it stands, then
 * what the person said — in that order, because the request is what the reply
 * is answering and the last thing read is the thing answered. The draft travels
 * with every turn rather than only the first: it is the one piece of this that
 * changes between turns, and a reply revising a draft it was shown three turns
 * ago is revising something else.
 */
export function turnRequest(input: {
  readonly context: TurnContext | undefined;
  /**
   * What an interrupted response of this conversation actually did, when one is
   * still unaccounted for.
   *
   * Before the draft and the message, because it is what the person's request
   * is being made *after*: a reply that read the new message first and the
   * recovered work second would plan from the state it expected rather than the
   * state it is in.
   */
  readonly recovered: string | undefined;
  readonly draft: string;
  readonly message: string;
}): string {
  const parts: string[] = [];
  if (input.context !== undefined) {
    parts.push(input.context.bootstrap, input.context.index, input.context.surface);
  }
  if (input.recovered !== undefined) {
    parts.push(input.recovered);
  }
  parts.push(describeDraft(input.draft), `The person says:\n\n${input.message}`);
  return parts.join("\n\n");
}

/**
 * The shared draft, as the turn shows it.
 *
 * Fenced, and the fence is longer than the longest run of backticks inside it,
 * because entry source is exactly the text most likely to contain one of its
 * own. An empty draft is stated as empty rather than shown as an empty fence: a
 * reply has to be able to tell "nothing is prepared" from "something is
 * prepared and it is blank".
 */
export function describeDraft(draft: string): string {
  if (draft.length === 0) {
    return "The shared entry draft is empty.";
  }
  const fence = "`".repeat(Math.max(3, longestRun(draft, "`") + 1));
  return ["The shared entry draft holds this now:", fence, draft, fence].join("\n");
}

/* ------------------------------------------------- the results a turn is sent */

/** One designated operation's result, as the next turn is told about it. */
export interface DesignatedResult {
  /** Its position among this response's controls, in admission order. */
  readonly order: number;
  /** The control that produced it, spelled as the reply wrote it. */
  readonly component: string;
  /**
   * Whether this operation answered, or did not happen.
   *
   * Not the same as whether the retained outcome is a failure. An operation can
   * answer with bad news and still have answered: a submission whose entry ran
   * and failed produced that entry's receipt, and the receipt *is* the answer —
   * so it is `answered`, and a batch must not introduce it as a refusal. Only an
   * operation that did not happen is `refused`.
   *
   * Decided from the retained facts rather than from the text, because the text
   * is what this decision chooses the wording of.
   */
  readonly kind: "answered" | "refused" | "incomplete";
  /** The answer itself, or the reason — the text, with nothing wrapped round it. */
  readonly text: string;
  /**
   * Whether that text is a serialized JSON value rather than canonical prose.
   *
   * Carried rather than guessed at. A batch has to fence a JSON value and must
   * not fence a chapter, and the only honest way to tell them apart is to
   * remember which one was serialized — trying to parse rendered text would
   * fence whatever happened to look like JSON.
   */
  readonly json: boolean;
  /**
   * The read context a selected presentation kept beside its value.
   *
   * Present only for a queried read whose original observation carried one.
   * Stated beside the selected payload rather than merged into it: selecting a
   * field out of a window neither reads another page nor changes the extent the
   * producer observed.
   */
  readonly read?: string;
}

/**
 * The designated results one response produced, in admission order.
 *
 * Read back out of the records rather than collected as the controls ran, so
 * what is delivered is what was retained: a result the history does not hold is
 * a result nobody can check this delivery against afterwards. The *intent* is
 * read too, not only the outcome, because some answers are made of both — a
 * Submit's receipt names the entry its intent reserved and the terminal status
 * its outcome observed, and neither record holds the whole of it.
 *
 * `refused` carries the operations that produced no record at all. One does: a
 * Submit refused before it reserved anything writes nothing, correctly, because
 * a reservation that was never taken has no outcome to record — and the reply
 * still has to be told. Each carries the order the next pair would have taken,
 * so it sorts into the place it happened rather than being appended at the end.
 */
export function designatedResults(
  records: readonly SidekickRecord[],
  at: { readonly conversation: string; readonly response: string },
  refused: readonly {
    readonly order: number;
    readonly component: string;
    readonly reason: string;
  }[] = [],
): readonly DesignatedResult[] {
  const intents = new Map<number, ControlRecord>();
  /** The acknowledged selected presentation each occurrence has, if any. */
  const presentations = new Map<number, ControlPresentationRecord>();
  for (const record of records) {
    if (
      record.kind === "control-presentation" &&
      record.conversation === at.conversation &&
      record.response === at.response
    ) {
      presentations.set(record.order, record);
    }
  }
  const results: DesignatedResult[] = refused
    // Through the same set, so a control that is not designated does not get
    // its refusals delivered either. One set decides what comes back.
    .filter((held) => DESIGNATED.has(held.component))
    .map((held) => ({
      order: held.order,
      component: held.component,
      kind: "refused" as const,
      text: held.reason,
      json: false,
    }));
  for (const record of records) {
    if (record.kind === "control") {
      if (record.conversation === at.conversation && record.response === at.response) {
        intents.set(record.order, record);
      }
      continue;
    }
    if (record.kind !== "control-outcome") {
      continue;
    }
    if (record.conversation !== at.conversation || record.response !== at.response) {
      continue;
    }
    const intent = intents.get(record.order);
    if (intent === undefined || !DESIGNATED.has(intent.component)) {
      continue;
    }
    results.push({
      order: record.order,
      ...(intent.presentation === "selected-v1"
        ? presented(intent, record, presentations.get(record.order))
        : answered(intent, record)),
    });
  }
  // Stable, so a refusal and the pair that followed it keep the order they
  // happened in: the refusal was pushed first and holds the order that pair
  // took, which is exactly where it belongs.
  return Object.freeze(results.sort((left, right) => left.order - right.order));
}

/**
 * What an interrupted response did, as the next explicit turn is told about it.
 *
 * A process that stopped part-way through a response leaves two kinds of fact
 * in the history: operations that answered, and operations that began and never
 * did. An explicit continuation has to carry both, because a reply that is told
 * neither will plan from a state this conversation is not in — it will prepare
 * a draft that is already prepared, or ask a question that is already in front
 * of the person.
 *
 * Read out of the retained records and rendered by the same per-control
 * machinery the ordinary delivery uses, so what a reply is told after an
 * interruption reads like what it is told after a turn. Nothing internal
 * crosses: no order number, no record kind, no `Result` wrapper.
 *
 * Every item carries its heading, including when there is only one. The
 * ordinary delivery drops the heading for a single answer because the whole
 * message *is* that answer; here the message is an account of several kinds of
 * thing, and an unlabelled one would read as though it were the reply's own.
 */
export function recoveredWork(
  records: readonly SidekickRecord[],
  at: { readonly conversation: string; readonly response: string },
): string | undefined {
  const items: { order: number; component: string; body: string }[] = [];
  for (const result of designatedResults(records, at)) {
    items.push({
      order: result.order,
      component: result.component,
      body: labelled(result),
    });
  }
  for (const waiting of unanswered(records, at)) {
    items.push(waiting);
  }
  if (items.length === 0) {
    return undefined;
  }
  items.sort((left, right) => left.order - right.order);
  return [
    "A response in this conversation was interrupted before it finished. This is what it " +
      "actually did; it is not running any more, and nothing of it will be repeated:",
    ...items.map((item) => `## ${item.component}\n\n${item.body}`),
  ].join("\n\n");
}

/**
 * The operations of one response that began and never answered, in order.
 *
 * An intent with no outcome beside it. For a question that means the person was
 * asked and nobody answered — so the words it was asked in are what the next
 * turn is told, because a reply that knows a question is open and not what it
 * said can neither use the answer nor sensibly withdraw it.
 */
function unanswered(
  records: readonly SidekickRecord[],
  at: { readonly conversation: string; readonly response: string },
): { order: number; component: string; body: string }[] {
  const intents = new Map<number, ControlRecord>();
  const settled = new Set<number>();
  for (const record of records) {
    if (record.kind === "control") {
      if (record.conversation === at.conversation && record.response === at.response) {
        intents.set(record.order, record);
      }
      continue;
    }
    if (record.kind !== "control-outcome") {
      continue;
    }
    if (record.conversation === at.conversation && record.response === at.response) {
      settled.add(record.order);
    }
  }
  const waiting: { order: number; component: string; body: string }[] = [];
  for (const [order, intent] of intents) {
    if (settled.has(order) || !DESIGNATED.has(intent.component)) {
      continue;
    }
    waiting.push({ order, component: intent.component, body: asking(intent) });
  }
  return waiting;
}

/** How one unanswered operation is introduced, by what it was. */
function asking(intent: ControlRecord): string {
  const held = intent.arguments;
  const message =
    typeof held === "object" && held !== null && "message" in held
      ? (held as { message?: unknown }).message
      : undefined;
  if (typeof message === "string") {
    return (
      `This asked the person and nobody answered it, so it is still waiting:\n\n${message}\n\n` +
      "Do not ask it again — that would be a second question — and do not answer it yourself."
    );
  }
  return (
    "This began and nobody recorded what became of it, so what it did is not known. " +
    "Do not assume it succeeded or failed."
  );
}

/**
 * What one *queried* operation answered, which is only ever its acknowledged
 * selected presentation.
 *
 * A marked occurrence has one source of feedback and no fallback. An
 * acknowledged presentation is the selected value, as the JSON it is, with the
 * read context the original observation carried stated beside it rather than
 * inside it. A recorded selection failure is a failure of the selection and
 * says so. And a marked intent with no presentation at all is an **interrupted
 * selection**: the original work may well have happened, and what must not
 * happen is answering with the observation the producer retained — the reply
 * asked for a selection, and sending it the whole thing instead is the one
 * substitution this protocol exists to prevent.
 */
function presented(
  intent: ControlRecord,
  record: ControlOutcomeRecord,
  presentation: ControlPresentationRecord | undefined,
): Omit<DesignatedResult, "order"> {
  const component = intent.component;
  if (record.outcome.status !== "ok") {
    // The original outcome stands. A refused control keeps refused feedback,
    // whatever a selection would have produced from a constant.
    return { component, kind: "refused", text: record.outcome.error.message, json: false };
  }
  if (presentation === undefined) {
    return {
      component,
      kind: "incomplete",
      text:
        "This operation completed and its selected result was never recorded, so what it " +
        "selected is not known. Nothing of it will be repeated.",
      json: false,
    };
  }
  if (presentation.outcome.status !== "ok") {
    return {
      component,
      kind: "refused",
      text: `its yq expression did not select one value: ${presentation.outcome.error.message}`,
      json: false,
    };
  }
  const selected = JSON.stringify(presentation.selected ?? null, null, 2);
  if (presentation.read === undefined) {
    return { component, kind: "answered", text: selected, json: true };
  }
  return {
    component,
    kind: "answered",
    // The range outside the payload, so a reply can tell what it selected from
    // how much the producer actually observed.
    text: selected,
    json: true,
    read: JSON.stringify(presentation.read, null, 2),
  };
}

/**
 * What one retained operation answered, in the words the reply is told it in.
 *
 * Per control, because the controls answer different kinds of thing and one
 * generic serialization would answer none of them well: a binding map is data,
 * a filled draft is an acknowledgement, a submission is a receipt, and an
 * output window is a window. The two that already have a rendering reuse it,
 * so what a reply reads where it asked and what it is sent afterwards are the
 * same text.
 *
 * It also decides whether this *answered*, which is not the same question as
 * whether the retained outcome is a failure — see {@link DesignatedResult.kind}.
 */
function answered(
  intent: ControlRecord,
  record: ControlOutcomeRecord,
): Omit<DesignatedResult, "order"> {
  const component = intent.component;
  const reason = record.outcome.status === "ok" ? undefined : record.outcome.error.message;
  const refused = (text: string): Omit<DesignatedResult, "order"> => ({
    component,
    kind: "refused",
    text,
    json: false,
  });
  const plain = (text: string): Omit<DesignatedResult, "order"> => ({
    component,
    kind: "answered",
    text,
    json: false,
  });
  switch (component) {
    case "REPL.EntryInput":
      // The acknowledgement, never the program. A reply handed its own source
      // back would spend a turn reading what it had just written.
      return reason === undefined ? plain(DRAFT_FILLED) : refused(reason);
    case "REPL.Submit":
      return submitted(intent, record, reason, plain, refused);
    case "REPL.EntryOutput":
      return reason === undefined
        ? plain(renderRead(record.observed as unknown as OutputRead))
        : refused(reason);
    default: {
      // Reads whose answer is their own value: the entry vocabulary, the
      // environment snapshot, a chapter, the binding map. A string is the text
      // it is; anything else was serialized, and a batch has to say so.
      if (reason !== undefined) {
        return refused(reason);
      }
      if (typeof record.observed === "string") {
        return plain(record.observed);
      }
      return {
        component,
        kind: "answered",
        text: JSON.stringify(record.observed ?? null, null, 2),
        json: true,
      };
    }
  }
}

/**
 * What became of one submission, from the two records that know it.
 *
 * The entry comes from the intent, because the intent is what reserved it, and
 * the terminal status from the outcome's observation, because that is what the
 * entry settled to. Holding both means an entry was admitted and reached an
 * outcome of its own, so this *answered* — with that entry's receipt, bad news
 * included. Holding neither means the submission did not happen: it was refused,
 * before or after it reserved a slot, and names no entry.
 *
 * Keeping those apart is the difference between "your entry failed" and "your
 * entry never started", which a reply has to act on differently — and it is
 * decided here, from the records, rather than by a batch reading the prose this
 * produces.
 */
function submitted(
  intent: ControlRecord,
  record: ControlOutcomeRecord,
  reason: string | undefined,
  plain: (text: string) => Omit<DesignatedResult, "order">,
  refused: (text: string) => Omit<DesignatedResult, "order">,
): Omit<DesignatedResult, "order"> {
  const entry = intent.submit?.entry;
  const status = typeof record.observed === "string" ? record.observed : undefined;
  if (entry === undefined || status === undefined) {
    return refused(reason ?? "this submission's outcome was not retained.");
  }
  return plain(
    renderReceipt({
      entry,
      status: status === "completed" || status === "cancelled" ? status : "failed",
      failure: reason,
      read: { entry },
    }),
  );
}

/**
 * The results and failures one next turn is sent, sealed as one request.
 *
 * Shaped by how much there is to say, because an envelope costs an agent
 * attention and buys nothing. One successful result is its own value with
 * nothing round it: the reply asked one question and this is the answer. More
 * than one needs saying which is which, so each gets a short heading naming the
 * control that produced it — the spelling the reply wrote, so it can tell them
 * apart without being told a convention. A failure is its reason.
 *
 * `failure` is the response's own, when the response failed in a way a reply
 * can do something about. It comes last, after the results, because the results
 * are what the reply was waiting for and the failure is what it has to fix.
 *
 * Nothing internal crosses: no correlation id, no order number, no `Result`
 * wrapper and no status word for a result that succeeded. An agent reading this
 * sees answers and reasons.
 */
export function sealedFeedback(
  results: readonly DesignatedResult[],
  failure?: string,
): string | undefined {
  if (results.length === 0 && failure === undefined) {
    // Nothing was asked for and nothing went wrong, so there is nothing to say
    // and no turn to spend saying it. The person has the reply; it is their
    // move.
    return undefined;
  }
  const parts: string[] = [];
  if (results.length === 1 && failure === undefined) {
    const only = results[0];
    if (only !== undefined) {
      // One answer to one question, with nothing round it — not even a fence
      // around a JSON value, because the whole message is that value and a
      // reply can parse it as it stands.
      parts.push(sole(only));
    }
  } else {
    for (const result of results) {
      parts.push(`## ${result.component}\n\n${labelled(result)}`);
    }
  }
  if (failure !== undefined) {
    parts.push(
      `Your response did not finish: ${failure}\n\nWhat it did before that stands. ` +
        "Continue from there rather than repeating it.",
    );
  }
  return parts.join("\n\n");
}

/**
 * One result alone, with nothing round it.
 *
 * The reply asked one question and this is the answer, so a JSON value is not
 * even fenced: the whole message is that value and a reply can parse it as it
 * stands. A read context is the one thing that still needs saying, because it
 * is a second fact about the same read.
 */
function sole(result: DesignatedResult): string {
  if (result.kind === "refused") {
    return `${refusal(result.component)}: ${result.text}`;
  }
  if (result.kind === "incomplete") {
    return result.text;
  }
  return result.read === undefined
    ? result.text
    : [result.text, `What that was selected from:`, fenced(result.read)].join("\n\n");
}

/** One result among others, under its own heading. */
function labelled(result: DesignatedResult): string {
  if (result.kind === "refused") {
    return `${refusal(result.component)}: ${result.text}`;
  }
  if (result.kind === "incomplete") {
    return result.text;
  }
  const body = result.json
    ? // Fenced, because this one is sitting among other things now and a reply
      // has to know where the value ends. Longer than any run inside it, since
      // a published string may hold a fence of its own.
      fenced(result.text)
    : result.text;
  return result.read === undefined
    ? body
    : [body, "What that was selected from:", fenced(result.read)].join("\n\n");
}

/**
 * How one control's failure is introduced.
 *
 * A submission that was not admitted was *refused* — nothing it asked for
 * happened and nothing is wrong with it — while a read that could not answer
 * *failed*. The words are the contract's own, and a reply reading "refused"
 * knows its draft is still sitting there.
 */
function refusal(component: string): string {
  return component === "REPL.Submit" ? `${component} refused` : `${component} failed`;
}

/** One JSON value in a fence longer than any backtick run inside it. */
function fenced(value: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(value, "`") + 1));
  return [`${fence}json`, value, fence].join("\n");
}

/** The digest of exactly these bytes, which is what a version is. */
function* digest(text: string): Operation<string> {
  return (yield* fingerprint(text)).sha256;
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
