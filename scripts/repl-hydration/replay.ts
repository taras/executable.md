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
 * Where it stops is the **replay frontier**: the first elicitation with no
 * answer recorded. Live execution belongs after that point and nowhere else.
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
import type { SemanticKind } from "./journal.ts";

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
      /** What it finally said, which is the durable outcome. */
      readonly admitted: string;
    }
  | {
      readonly kind: "publish";
      readonly entry: string;
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly kind: "elicit";
      readonly entry: string;
      readonly scope: readonly string[];
      readonly wait: string;
      readonly prompt: string;
      readonly secret: boolean;
    }
  | { readonly kind: "settle"; readonly entry: string };

/**
 * The representative document.
 *
 * It drafts release notes with an Agent, admits the result, opens the scope
 * that result creates, publishes what it produced, and then needs two answers
 * before it can publish: an ordinary one and a secret one. Everything after
 * the secret exists so that a replay which stopped there can be told apart
 * from one that got past it.
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
  },
  { kind: "open", entry: "entry-1", scope: ["document", "draft"], name: "review", source: 0 },
  { kind: "complete", entry: "entry-1", scope: ["document", "draft"], name: "review" },
  { kind: "complete", entry: "entry-1", scope: ["document"], name: "draft" },
  { kind: "publish", entry: "entry-1", name: "notes", value: "Release notes for 0.14.0" },
  { kind: "open", entry: "entry-1", scope: ["document"], name: "publish", source: 1 },
  {
    kind: "elicit",
    entry: "entry-1",
    scope: ["document", "publish"],
    wait: "channel",
    prompt: "Which channel should this be announced on?",
    secret: false,
  },
  {
    kind: "elicit",
    entry: "entry-1",
    scope: ["document", "publish"],
    wait: "token",
    prompt: "Registry token?",
    secret: true,
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

interface Cursor {
  readonly records: unknown[];
  at: number;
  seq: number;
}

function kindAt(cursor: Cursor): string {
  const record = cursor.records[cursor.at];
  if (record === null || typeof record !== "object" || !("kind" in record)) {
    return "";
  }
  const kind = record.kind;
  return typeof kind === "string" ? kind : "";
}

function answerAt(cursor: Cursor): string {
  const record = cursor.records[cursor.at];
  if (record === null || typeof record !== "object" || !("answer" in record)) {
    return "";
  }
  const answer = record.answer;
  return typeof answer === "string" ? answer : "";
}

function append(cursor: Cursor, kind: SemanticKind, fields: Record<string, unknown>): void {
  cursor.records.push({
    id: `s-${String(cursor.seq).padStart(2, "0")}`,
    seq: cursor.seq,
    // Recorded time advances with the record, which is all this fixture needs
    // of a clock and all a replay can know about one.
    at: cursor.seq,
    kind,
    ...fields,
  });
  cursor.seq += 1;
  cursor.at += 1;
}

/** Whether the record under the cursor is the one this step would have written. */
function recorded(cursor: Cursor, kind: SemanticKind): boolean {
  return cursor.at < cursor.records.length && kindAt(cursor) === kind;
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

  const { secrets, streaming } = options;
  const cursor: Cursor = {
    records: [...options.prior],
    at: 0,
    seq: options.prior.length + 1,
  };
  const performed: string[] = [];
  const consumed: string[] = [];
  const recovered: string[] = [];

  for (const step of options.script) {
    if (step.kind === "submit") {
      if (recorded(cursor, "entry.submitted")) {
        cursor.at += 1;
        continue;
      }
      append(cursor, "entry.submitted", { entry: step.entry, title: step.title });
      continue;
    }

    if (step.kind === "open") {
      if (recorded(cursor, "scope.opened")) {
        cursor.at += 1;
        continue;
      }
      append(cursor, "scope.opened", {
        entry: step.entry,
        scope: step.scope,
        name: step.name,
        source: step.source,
      });
      continue;
    }

    if (step.kind === "complete") {
      if (recorded(cursor, "scope.completed")) {
        cursor.at += 1;
        continue;
      }
      append(cursor, "scope.completed", {
        entry: step.entry,
        scope: step.scope,
        name: step.name,
      });
      continue;
    }

    if (step.kind === "settle") {
      if (recorded(cursor, "entry.settled")) {
        cursor.at += 1;
        continue;
      }
      append(cursor, "entry.settled", { entry: step.entry });
      continue;
    }

    if (step.kind === "publish") {
      if (recorded(cursor, "binding.published")) {
        cursor.at += 1;
        consumed.push(`publish ${step.name}`);
        continue;
      }
      performed.push(`publish ${step.name}`);
      append(cursor, "binding.published", {
        entry: step.entry,
        name: step.name,
        value: step.value,
      });
      continue;
    }

    if (step.kind === "agent") {
      const where = [step.entry, ...step.scope].join("/");
      if (recorded(cursor, "outcome.recorded")) {
        // The result is written down, so the Agent does not run and nothing
        // streams. There is no partial output after a restart because none
        // was produced, not because it was hidden.
        cursor.at += 1;
        consumed.push(`agent ${where}`);
        continue;
      }
      for (const chunk of step.chunks) {
        streaming.receive(where, chunk);
      }
      performed.push(`agent ${where}`);
      streaming.admit(where);
      append(cursor, "outcome.recorded", {
        entry: step.entry,
        scope: step.scope,
        label: step.admitted,
      });
      continue;
    }

    const opened = recorded(cursor, "suspension.opened");
    if (opened) {
      cursor.at += 1;
    } else {
      append(cursor, "suspension.opened", {
        entry: step.entry,
        scope: step.scope,
        wait: step.wait,
        prompt: step.prompt,
        secret: step.secret,
      });
    }

    if (!recorded(cursor, "suspension.answered")) {
      // Nobody has answered yet. This is the replay frontier: everything
      // before it is reconstructed and everything after it is live.
      return Ok({
        records: cursor.records,
        performed,
        consumed,
        recovered,
        asked: secrets.asked,
        streaming: streaming.streaming(),
        frontier: {
          kind: "awaiting",
          wait: step.wait,
          prompt: step.prompt,
          secret: step.secret,
        },
      });
    }

    if (!step.secret) {
      recovered.push(`${step.wait}=${answerAt(cursor)}`);
      cursor.at += 1;
      continue;
    }

    // The record says this was answered and says nothing about what with,
    // which is the point. Replay reconstructs the question, not the answer.
    const revealed = secrets.reveal(step.wait, step.prompt);
    if (!revealed.known) {
      return Ok({
        records: cursor.records,
        performed,
        consumed,
        recovered,
        asked: secrets.asked,
        streaming: streaming.streaming(),
        frontier: { kind: "unrevealed", wait: step.wait, prompt: step.prompt },
      });
    }
    cursor.at += 1;
  }

  return Ok({
    records: cursor.records,
    performed,
    consumed,
    recovered,
    asked: secrets.asked,
    streaming: streaming.streaming(),
    frontier: { kind: "complete" },
  });
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
