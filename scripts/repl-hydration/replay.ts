/**
 * Restart resumption: the same document, run against a record that already
 * exists.
 *
 * A live run and a replay are one function. `resume()` walks the document's
 * steps beside the Journal in append order, and for each step it either
 * *consumes* the records that step already produced or *performs* the step for
 * the first time. That is the whole no-repeat claim: a consumed step never
 * reaches the performer, so a durable effect that is already written down
 * cannot happen twice. It is not ordinary Continue — Continue resolves a
 * suspended routine in a process that still exists (#841), and this rebuilds
 * a position from what was recorded.
 *
 * **A record is consumed only when it is that step's own record.** The kind
 * alone says far too little: every scope opening is a `scope.opened`, and a
 * replay that matched on kind would let one document's records stand in for
 * another's — suppressing an effect that never happened and reporting it as
 * done. So every replayable occurrence has an identity — operation, owning
 * entry, owning scope, and the durable name of the occurrence — and the
 * identity is separate from the result: replay *matches* the request and
 * *restores* what came back. An `outcome.recorded` carries both, which is why
 * `request` is a field and not the label.
 *
 * Alignment happens first and completely. The prior Journal is parsed,
 * projected, and then walked against the script before a single effect runs,
 * so a divergence refuses with nothing performed, nothing appended and the
 * supplied Journal untouched. A retained record left unclaimed when the
 * document has finished is a divergence too: it describes work this document
 * does not do.
 *
 * Where it stops is the **replay frontier**: the first elicitation with no
 * answer recorded. Live execution belongs after that point and nowhere else.
 *
 * **A matched operation returns its recorded result.** Consuming is not
 * merely declining to perform: the value the live performer would have
 * produced has to arrive at the same place, or the document carries on with
 * whatever its source happened to say and the replay only looked correct.
 * So every producing step names what it puts into execution state, every
 * consuming step derives from that state, and the two paths — the performer's
 * value and the matched record's — write to the same one. The script holds no
 * second copy of a result it did not compute.
 *
 * Two elicitations behave differently on the way there, and the difference is
 * the secret rule. An ordinary answer is in the record, so replay recovers it
 * and asks nobody. A secret answer is not in the record and never was, so
 * replay knows only that it was asked — and asks again. If there is nobody to
 * ask, that is a frontier too.
 *
 * The document here is a fixture, deliberately: #842 forbids a real model
 * provider, and a script of steps is the smallest thing that can be run twice
 * and compared.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import type { Secrets, Streaming } from "./ephemeral.ts";
import { parseJournal } from "./journal.ts";
import type { SemanticEvent, SemanticKind } from "./journal.ts";
import { projectPrefix } from "./project.ts";

/** One thing the document does. */
export type Step =
  | { readonly kind: "submit"; readonly entry: string; readonly title: string }
  | {
      readonly kind: "open";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly name: string;
      readonly source: number;
    }
  | {
      readonly kind: "complete";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly name: string;
    }
  | {
      readonly kind: "agent";
      readonly entry: string;
      readonly scope: readonly string[];
      /** What the Agent streamed on the way to its answer. Never durable. */
      readonly chunks: readonly string[];
      /** What it finally says when it runs. A replay never reads this. */
      readonly admitted: string;
      /** Where the admitted result lands, whoever produced it. */
      readonly produces: string;
    }
  | {
      readonly kind: "publish";
      readonly entry: string;
      readonly name: string;
      /** The execution-state value to publish. There is no literal to fall back to. */
      readonly from: string;
    }
  | {
      readonly kind: "elicit";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly wait: string;
      readonly prompt: string;
      readonly secret: boolean;
      /** Where the answer lands, whether a person gave it or the record did. */
      readonly produces: string;
    }
  | { readonly kind: "settle"; readonly entry: string };

/**
 * The representative document.
 *
 * It drafts release notes with an Agent, admits the result, opens the scope
 * that result creates, and publishes **what the Agent produced** — read out of
 * execution state, not out of this list, which is why changing the recorded
 * result changes what the replay goes on to publish. It then needs two
 * answers: an ordinary one, whose value the next step publishes, and a secret
 * one, whose value nothing records. Everything after the secret exists so
 * that a replay which stopped there can be told apart from one that got past
 * it.
 */
export const SCRIPT: readonly Step[] = [
  { kind: "submit", entry: "entry-1", title: "Publish the release notes" },
  { kind: "open", entry: "entry-1", scope: [], name: "document", source: 0 },
  { kind: "open", entry: "entry-1", scope: ["document"], name: "draft", source: 0 },
  {
    kind: "agent",
    entry: "entry-1",
    scope: ["document", "draft"],
    chunks: ["Rele", "Release notes for ", "Release notes for 0.14.0"],
    admitted: "Release notes for 0.14.0",
    produces: "notes",
  },
  { kind: "open", entry: "entry-1", scope: ["document", "draft"], name: "review", source: 0 },
  { kind: "complete", entry: "entry-1", scope: ["document", "draft"], name: "review" },
  { kind: "complete", entry: "entry-1", scope: ["document"], name: "draft" },
  { kind: "publish", entry: "entry-1", name: "notes", from: "notes" },
  { kind: "open", entry: "entry-1", scope: ["document"], name: "publish", source: 1 },
  {
    kind: "elicit",
    entry: "entry-1",
    scope: ["document", "publish"],
    wait: "channel",
    prompt: "Which channel should this be announced on?",
    secret: false,
    produces: "channel",
  },
  { kind: "publish", entry: "entry-1", name: "announced", from: "channel" },
  {
    kind: "elicit",
    entry: "entry-1",
    scope: ["document", "publish"],
    wait: "token",
    prompt: "Registry token?",
    secret: true,
    produces: "token",
  },
  { kind: "complete", entry: "entry-1", scope: ["document"], name: "publish" },
  { kind: "complete", entry: "entry-1", scope: [], name: "document" },
  { kind: "settle", entry: "entry-1" },
];

/** Where a run stopped. */
export type Frontier =
  | { readonly kind: "complete" }
  /** Waiting on a person. Live execution resumes when the answer is recorded. */
  | {
      readonly kind: "awaiting";
      readonly wait: string;
      readonly prompt: string;
      readonly secret: boolean;
    }
  /** A secret whose value is gone and whom nobody is here to ask again. */
  | { readonly kind: "unrevealed"; readonly wait: string; readonly prompt: string };

export interface Run {
  /** The journal after this run: what it found, plus what it appended. */
  readonly records: readonly unknown[];
  /** Durable effects this run actually carried out. */
  readonly performed: readonly string[];
  /** Durable effects it read out of the record instead of carrying out. */
  readonly consumed: readonly string[];
  /** Answers it recovered from the record without asking anyone. */
  readonly recovered: readonly string[];
  /** Waits it had to put in front of a person. Never what they said. */
  readonly asked: readonly string[];
  /** Scopes still mid-stream when it stopped. Empty after a replay. */
  readonly streaming: readonly string[];
  readonly frontier: Frontier;
}

/**
 * What makes one replayable occurrence that occurrence and no other.
 *
 * Four things, and none of them is the result: the operation, the entry that
 * owns it, the scope path inside that entry, and the durable name of the
 * occurrence there. A step and a record agree when all four agree.
 */
interface Identity {
  readonly kind: SemanticKind;
  readonly entry: string;
  readonly scope: readonly string[];
  readonly name: string;
}

function says(identity: Identity): string {
  const where =
    identity.scope.length === 0 ? identity.entry : `${identity.entry}/${identity.scope.join("/")}`;
  return `${identity.kind} ${JSON.stringify(identity.name)} in ${where}`;
}

function same(one: Identity, other: Identity): boolean {
  return (
    one.kind === other.kind &&
    one.entry === other.entry &&
    one.name === other.name &&
    one.scope.length === other.scope.length &&
    one.scope.every((segment, at) => segment === other.scope[at])
  );
}

/** The identity of a record that is already durable. */
function identityOf(event: SemanticEvent): Identity {
  if (event.kind === "scope.opened" || event.kind === "scope.completed") {
    return { kind: event.kind, entry: event.entry, scope: event.scope, name: event.name };
  }
  if (event.kind === "binding.published") {
    return { kind: event.kind, entry: event.entry, scope: [], name: event.name };
  }
  if (event.kind === "suspension.opened" || event.kind === "suspension.answered") {
    return { kind: event.kind, entry: event.entry, scope: event.scope, name: event.wait };
  }
  if (event.kind === "outcome.recorded") {
    // The request, never the label: an outcome recognized by its own result
    // could only be recognized by a replay that already knew the answer.
    return { kind: event.kind, entry: event.entry, scope: event.scope, name: event.request };
  }
  return { kind: event.kind, entry: event.entry, scope: [], name: event.entry };
}

/** The durable name this fixture gives one Agent occurrence. */
function agentRequest(step: Extract<Step, { kind: "agent" }>): string {
  return [step.entry, ...step.scope].join("/");
}

/** The records one step writes, in order, as the identities they will have. */
function expectations(step: Step): readonly Identity[] {
  if (step.kind === "submit") {
    return [{ kind: "entry.submitted", entry: step.entry, scope: [], name: step.entry }];
  }
  if (step.kind === "settle") {
    return [{ kind: "entry.settled", entry: step.entry, scope: [], name: step.entry }];
  }
  if (step.kind === "open") {
    return [{ kind: "scope.opened", entry: step.entry, scope: step.scope, name: step.name }];
  }
  if (step.kind === "complete") {
    return [{ kind: "scope.completed", entry: step.entry, scope: step.scope, name: step.name }];
  }
  if (step.kind === "publish") {
    return [{ kind: "binding.published", entry: step.entry, scope: [], name: step.name }];
  }
  if (step.kind === "agent") {
    return [
      {
        kind: "outcome.recorded",
        entry: step.entry,
        scope: step.scope,
        name: agentRequest(step),
      },
    ];
  }
  return [
    { kind: "suspension.opened", entry: step.entry, scope: step.scope, name: step.wait },
    { kind: "suspension.answered", entry: step.entry, scope: step.scope, name: step.wait },
  ];
}

/** A step that needs a value nothing before it produced. */
export class ExecutionGap extends Error {
  /** The step that could not proceed. */
  readonly step: string;
  /** The execution-state value it wanted. */
  readonly needed: string;

  constructor(step: string, needed: string) {
    super(`${step} needs ${JSON.stringify(needed)}, and nothing before it produced one`);
    this.name = "ExecutionGap";
    this.step = step;
    this.needed = needed;
  }
}

/** A retained Journal that is not this document's. */
export class ReplayDivergence extends Error {
  /** The append position that diverged, or the record count when one is left over. */
  readonly position: number;
  readonly expected: string;
  readonly found: string;

  constructor(position: number, expected: string, found: string) {
    super(`record ${position}: expected ${expected}, found ${found}`);
    this.name = "ReplayDivergence";
    this.position = position;
    this.expected = expected;
    this.found = found;
  }
}

/** Which retained records each step claimed, in script order. */
type Alignment = readonly (readonly number[])[];

/**
 * Pair the script against what is already durable, or refuse.
 *
 * This runs to completion before anything is performed, so a divergence costs
 * nothing: no effect happens, no record is written, and the Journal handed in
 * is the Journal handed back to the caller untouched.
 *
 * Running out of retained records is not a divergence — it is where the live
 * frontier is. Having some left over when the document is finished *is* one.
 */
function align(script: readonly Step[], events: readonly SemanticEvent[]): Result<Alignment> {
  const claimed: number[][] = [];
  let at = 0;
  for (const step of script) {
    const mine: number[] = [];
    for (const expected of expectations(step)) {
      if (at >= events.length) {
        break;
      }
      const found = identityOf(events[at]);
      if (!same(expected, found)) {
        return Err(new ReplayDivergence(at, says(expected), says(found)));
      }
      mine.push(at);
      at += 1;
    }
    claimed.push(mine);
  }
  if (at < events.length) {
    return Err(
      new ReplayDivergence(at, "the document to be finished", says(identityOf(events[at]))),
    );
  }
  return Ok(claimed);
}

interface Appending {
  readonly records: unknown[];
  seq: number;
}

function append(into: Appending, kind: SemanticKind, fields: Record<string, unknown>): void {
  into.records.push({
    id: `s-${String(into.seq).padStart(2, "0")}`,
    seq: into.seq,
    // Recorded time advances with the record, which is all this fixture needs
    // of a clock and all a replay can know about one.
    at: into.seq,
    kind,
    ...fields,
  });
  into.seq += 1;
}

export interface Resume {
  /** The document to run. */
  readonly script: readonly Step[];
  /** What is already durable. Empty is a first run. */
  readonly prior: readonly unknown[];
  /**
   * Who to ask for a secret.
   *
   * Required rather than defaulted: whether anyone is at the keyboard decides
   * whether this run can get past a secret frontier, and a default would let
   * a caller be headless without saying so. A process with nobody there
   * passes `noSecrets()`.
   */
  readonly secrets: Secrets;
  /** Where partial Agent output goes while it is in flight. */
  readonly streaming: Streaming;
}

/**
 * Run the document against what is already recorded.
 *
 * The answer is a `Result` because the journal it was handed may not be one
 * this vocabulary can read, and a run that cannot read its own past has
 * nothing to say about where to continue from.
 */
export function resume(options: Resume): Result<Run> {
  const parsed = parseJournal(options.prior);
  if (!parsed.ok) {
    return parsed;
  }
  // A Journal that reads but cannot have happened is not something to resume
  // from, and finding that out after performing half the document would be
  // finding out too late.
  const projected = projectPrefix("", parsed.value, undefined);
  if (!projected.ok) {
    return projected;
  }
  const aligned = align(options.script, parsed.value);
  if (!aligned.ok) {
    return aligned;
  }

  const { secrets, streaming } = options;
  const events = parsed.value;
  const plan = aligned.value;
  const into: Appending = {
    records: [...options.prior],
    seq: options.prior.length + 1,
  };
  const performed: string[] = [];
  const consumed: string[] = [];
  const recovered: string[] = [];
  /**
   * What the document has produced so far.
   *
   * One map, written by the live performer and by the matched record alike,
   * so a consumed operation and a performed one hand the same thing to
   * whatever comes next. It never leaves this function: a secret is in here.
   */
  const state = new Map<string, string>();

  function stopped(frontier: Frontier): Result<Run> {
    return Ok({
      records: into.records,
      performed,
      consumed,
      recovered,
      asked: secrets.asked,
      streaming: streaming.streaming(),
      frontier,
    });
  }

  for (const [index, step] of options.script.entries()) {
    const claimed = plan[index];

    if (step.kind === "submit") {
      if (claimed.length === 0) {
        append(into, "entry.submitted", { entry: step.entry, title: step.title });
      }
      continue;
    }

    if (step.kind === "open") {
      if (claimed.length === 0) {
        append(into, "scope.opened", {
          entry: step.entry,
          scope: step.scope,
          name: step.name,
          source: step.source,
        });
      }
      continue;
    }

    if (step.kind === "complete") {
      if (claimed.length === 0) {
        append(into, "scope.completed", {
          entry: step.entry,
          scope: step.scope,
          name: step.name,
        });
      }
      continue;
    }

    if (step.kind === "settle") {
      if (claimed.length === 0) {
        append(into, "entry.settled", { entry: step.entry });
      }
      continue;
    }

    if (step.kind === "publish") {
      if (claimed.length === 1) {
        // The recorded value is the one that was published, and it lands in
        // execution state exactly where a live publication would have put it.
        const record = events[claimed[0]];
        const value = record.kind === "binding.published" ? record.value : "";
        state.set(step.name, value);
        consumed.push(`publish ${step.name}`);
        continue;
      }
      const value = state.get(step.from);
      if (value === undefined) {
        return Err(new ExecutionGap(`publish ${step.name}`, step.from));
      }
      state.set(step.name, value);
      performed.push(`publish ${step.name}`);
      append(into, "binding.published", {
        entry: step.entry,
        name: step.name,
        value,
      });
      continue;
    }

    if (step.kind === "agent") {
      const request = agentRequest(step);
      if (claimed.length === 1) {
        // The result is written down against this request, so the Agent does
        // not run and nothing streams. There is no partial output after a
        // restart because none was produced, not because it was hidden — and
        // the recorded result goes where the live one would have gone, which
        // is what makes the rest of the document follow it.
        const record = events[claimed[0]];
        state.set(step.produces, record.kind === "outcome.recorded" ? record.label : "");
        consumed.push(`agent ${request}`);
        continue;
      }
      for (const chunk of step.chunks) {
        streaming.receive(request, chunk);
      }
      state.set(step.produces, step.admitted);
      performed.push(`agent ${request}`);
      streaming.admit(request);
      append(into, "outcome.recorded", {
        entry: step.entry,
        scope: step.scope,
        request,
        label: step.admitted,
      });
      continue;
    }

    if (claimed.length === 0) {
      append(into, "suspension.opened", {
        entry: step.entry,
        scope: step.scope,
        wait: step.wait,
        prompt: step.prompt,
        secret: step.secret,
      });
    }

    if (claimed.length < 2) {
      // Nobody has answered yet. This is the replay frontier: everything
      // before it is reconstructed and everything after it is live.
      return stopped({
        kind: "awaiting",
        wait: step.wait,
        prompt: step.prompt,
        secret: step.secret,
      });
    }

    if (!step.secret) {
      // Read out of the matched record and nowhere else, and put where the
      // person's answer would have gone, so the steps after it see it.
      const record = events[claimed[1]];
      const answer = record.kind === "suspension.answered" ? record.answer : "";
      state.set(step.produces, answer);
      recovered.push(`${step.wait}=${answer}`);
      continue;
    }

    // The record says this was answered and says nothing about what with,
    // which is the point. Replay reconstructs the question, not the answer.
    const revealed = secrets.reveal(step.wait, step.prompt);
    if (!revealed.known) {
      return stopped({ kind: "unrevealed", wait: step.wait, prompt: step.prompt });
    }
    // Used, and used only here: nothing downstream records it.
    state.set(step.produces, revealed.value);
  }

  return stopped({ kind: "complete" });
}

/**
 * The record an operator's answer makes.
 *
 * A secret's answer is recorded as the empty string, because what is durable
 * is that the question was answered. Handing a value here for a wait the
 * Journal opened as secret is refused by the projection, so the leak cannot
 * be written and then merely ignored.
 */
export function answered(
  records: readonly unknown[],
  step: Extract<Step, { kind: "elicit" }>,
  value: string,
): Result<readonly unknown[]> {
  if (step.secret && value !== "") {
    return Err(new Error(`the answer to the secret wait ${step.wait} is not recorded`));
  }
  return Ok([
    ...records,
    {
      id: `s-${String(records.length + 1).padStart(2, "0")}`,
      seq: records.length + 1,
      at: records.length + 1,
      kind: "suspension.answered",
      entry: step.entry,
      scope: step.scope,
      wait: step.wait,
      answer: value,
    },
  ]);
}

/** The elicitation step one wait belongs to. */
export function elicitation(wait: string): Extract<Step, { kind: "elicit" }> {
  const step = SCRIPT.find((one) => one.kind === "elicit" && one.wait === wait);
  if (step === undefined || step.kind !== "elicit") {
    throw new Error(`the document has no ${wait} elicitation`);
  }
  return step;
}
