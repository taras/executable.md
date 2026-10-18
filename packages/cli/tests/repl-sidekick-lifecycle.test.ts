/**
 * Tier R6 — Stop, and what it does and does not reach (#883, J3/J5/J11).
 *
 * Stop is the one action whose whole meaning is in what it leaves alone. It
 * ends the asking — the generation in flight, the controls of a response being
 * evaluated, the wait for an entry's outcome, and any turn that would have
 * followed — and it ends nothing else: not the conversation, not the chat, not
 * the drafts, and above all not an entry that has already been admitted, which
 * belongs to the session and goes on running on its own terms.
 *
 * So every row here holds something open, stops, and then asks what survived.
 * The provider is scripted and the holds are the fake's own barriers rather
 * than a clock: a turn that is left unfinished until it is cancelled is how an
 * interruption is modelled, and `startedTurns` is how a case knows the turn it
 * means to interrupt is actually in flight.
 *
 * The rows that need a mounted tree — Stop as a control, Exit, Control-C and
 * the question drawer — are section 5's, and are not covered here. The second
 * tier below owns the question itself, which needs no tree: a question has an
 * owner, an answer and a withdrawal whether or not anything is drawing it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { SidekickOperation } from "../src/repl/sidekick/model.ts";
import { ensure, Ok, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";

import { Execution } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";

import { submitForSidekick } from "../src/repl/sidekick/admission.ts";
import type { AdmittingSession } from "../src/repl/sidekick/admission.ts";
import { stillAdmissible } from "../src/repl/sidekick/gate.ts";
import type { ControlJournal } from "../src/repl/sidekick/controls.ts";
import type { ReplSubmission } from "../src/repl/session.ts";

import type { SidekickTurn } from "../src/repl/sidekick/owner.ts";
import type { ReplModel } from "../src/repl/model.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplElicitations, ReplQuestion } from "../src/repl/elicitation.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import {
  activate,
  appendGate,
  awaited,
  awaiting,
  click,
  draftText,
  focusDraft,
  focusFormValue,
  focusMessage,
  messageText,
  MOUNTED_AGENT,
  mountedExecution,
  mountedReading,
  sendMessage,
  settled,
  panePresented,
  shows,
  typing,
  useMountedHost,
  useMountedRepl,
} from "./fixtures/repl/issue-883/mounted-program.ts";
import type { MountedRepl, Terminal } from "./fixtures/repl/issue-883/mounted-program.ts";
import {
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  readSidekickRecords,
  SIDEKICK_FILE,
} from "../src/repl/sidekick/history.ts";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { SidekickRecord } from "../src/repl/sidekick/history.ts";

/** An entry that publishes nothing and stays open until it is torn down. */
const RUNS_ON = ["```js eval", "yield* suspend();", "```", ""].join("\n");

/** One message, sent in a task of its own so a case can stop it mid-flight. */
function sending(held: Harness, text: string): Operation<Task<Result<SidekickTurn>>> {
  return spawn(() => held.owner.message(text));
}

/** Wait for the first reprojection this is true of. Nothing is slept on. */
function* reprojected(
  session: ReplSession,
  satisfied: (model: ReplModel) => boolean,
): Operation<void> {
  if (satisfied(session.model)) {
    return;
  }
  const changes = yield* session.changes;
  while (true) {
    const next = yield* changes.next();
    if (next.done === true) {
      throw new Error("the session stopped reprojecting before that happened");
    }
    if (satisfied(next.value)) {
      return;
    }
  }
}

describe("Tier R6 — Stop ends the asking and nothing else", () => {
  it("R6: Stop cancels the generation in flight and leaves the chat readable", function* () {
    const held = yield* useHarness();
    // A turn that never settles, which is how an interruption is modelled.
    held.fake.script({ reply: "", manual: true });
    held.fake.script({ reply: "<Output>Second time.</Output>\n" });

    const sent = yield* sending(held, "think about this");
    // The barrier: the turn this row means to interrupt is actually in flight.
    yield* held.fake.startedTurns(1);

    yield* held.owner.stop();

    // The owner is free: Stop is not a state somebody has to get out of.
    expect(held.owner.busy).toBe(false);

    // Measured before anything else happens: nothing was undone, the history is
    // readable and holds what the person said, and nothing claims work that did
    // not happen — no response record, and no canonical turn either, because a
    // record for a turn that did not finish would be a record of something that
    // did not happen.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.chat[0]).toMatchObject({ kind: "person", text: "think about this" });
    expect(
      (yield* records(held.execution)).filter(
        (record) => (record as { kind: string }).kind === "response",
      ),
    ).toHaveLength(0);
    expect(reading.value.conversations[0]?.attempted).toEqual([]);
    expect(reading.value.conversations[0]?.completed).toEqual([]);

    // Now said immediately, without first waiting for the stopped message to
    // return. Stop has already joined the work, so the conversation is free —
    // one turn runs at a time in it, and a Stop that returned while its turn
    // was still in flight would make this refuse.
    const again = yield* held.owner.message("try again");
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.output).toContain("Second time.");

    const answered = yield* sent;
    expect(answered.ok).toBe(false);
    expect(answered.ok ? "" : answered.error.message).toContain("stopped");
    // It says what it left alone, because that is the whole of what Stop means.
    expect(answered.ok ? "" : answered.error.message).toContain("still running");

    // And it was the same conversation, continued, rather than a second one.
    expect(again.value.conversation).toBe(reading.value.active);
  });

  it("R6: a submission cancelled before its entry starts withdraws its own request", function* () {
    const held = yield* useHarness();
    // The window this is about: the slot is held, the intent is written, and
    // the entry has not started — which is where a suspended preflight leaves a
    // submission, and where Stop reaches it.
    const wrote = withResolvers<void>();
    const journal: ControlJournal = {
      *began(): Operation<number> {
        wrote.resolve();
        return 0;
      },
      // deno-lint-ignore require-yield
      *settled(): Operation<void> {},
      // deno-lint-ignore require-yield
      *presented(): Operation<void> {},
    };
    const session: AdmittingSession = {
      entries: () => Ok([]),
      admits: () => Ok(undefined),
      *submit(): Operation<Result<ReplSubmission>> {
        // Held here, as a preflight that suspends holds it.
        yield* suspend();
        throw new Error("this submission was not supposed to finish");
      },
    };
    const task = yield* spawn(() =>
      submitForSidekick(
        { conversation: "c", response: "response:1" },
        {
          // No receiver: this case is about the reservation, not a selection.
          presenting: undefined,
          session,
          facts: () => ({
            live: true,
            revisions: { draft: 1, message: 0 },
            takenOver: false,
            draft: "Something to submit.\n",
          }),
          held: held.admitting,
          journal,
          writer: held.execution.stream,
          woke: () => {},
        },
      ),
    );
    yield* wrote.operation;

    // The reservation is live and nothing has started it.
    expect(held.admitting.held?.by).toBe("sidekick");
    expect(held.admitting.held?.live).toBe(true);
    expect(held.session.model.entries).toHaveLength(0);

    yield* task.halt();

    // Withdrawn by its own unwinding. `live` means the asker still wants this,
    // and a cancelled submission is the asker not wanting it — so the entry's
    // own start, which asks that question, now answers no.
    expect(held.admitting.held?.live).toBe(false);
    expect(
      stillAdmissible(held.admitting.held!, {
        live: true,
        revisions: { draft: 1, message: 0 },
        takenOver: false,
        draft: "Something to submit.\n",
      }).ok,
    ).toBe(false);
    // And still no entry: a request nobody wants any more admits nothing.
    expect(held.session.model.entries).toHaveLength(0);
  });

  /**
   * One real entry startup, held where it is allocated and not yet admitted.
   *
   * The interval this is about is inside the entry's own execution: the task
   * exists, the session is live, and the record that gives the entry a position
   * has not been appended. Holding `Execution.document` before it delegates is
   * exactly that moment, and it is a real installation rather than a stub —
   * nothing else puts a case in that window.
   */
  function* startupHold(): Operation<{
    readonly installation: ExecutionInstallation;
    readonly reached: Operation<void>;
    readonly finished: Operation<void>;
    release(): void;
  }> {
    const reached = withResolvers<void>();
    const finished = withResolvers<void>();
    const release = withResolvers<void>();
    // Released at the end of the case whatever happened, so a row that fails
    // mid-hold does not leave the suite waiting on its own latch.
    yield* ensure(() => release.resolve());
    return {
      reached: reached.operation,
      finished: finished.operation,
      release: () => release.resolve(),
      installation: {
        *install(): Operation<void> {
          yield* Execution.around({
            *document([request], next): Operation<void> {
              yield* ensure(() => finished.resolve());
              reached.resolve();
              yield* release.operation;
              return yield* next(request);
            },
          });
        },
      },
    };
  }

  /** The entry a held startup would admit, and the reply that asks for it. */
  const LATE_SOURCE = "<Output>LATE-ADMISSION</Output>";
  const LATE_REPLY = [
    '<Let as="code" select="code">',
    "```xmd",
    LATE_SOURCE,
    "```",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
    "<REPL.Submit />",
    "",
  ].join("\n");

  it("R6: control — released without Stop, a held startup admits what was asked", function* () {
    const startup = yield* startupHold();
    const held = yield* useHarness(undefined, { entryInstallation: startup.installation });
    held.fake.script({ reply: LATE_REPLY });
    held.fake.script({ reply: "<Output>Completed.</Output>\n" });

    const sent = yield* sending(held, "submit");
    yield* startup.reached;
    // The window: a task is allocated, the session is live, and no entry has
    // been admitted. A taken slot and a live session are not an admission.
    expect(held.session.live).toBe(true);
    expect(held.session.model.entries).toHaveLength(0);

    startup.release();
    const answered = yield* sent;
    if (!answered.ok) {
      throw answered.error;
    }
    // Exactly the requested source, admitted and run. Without this control, a
    // regression that simply never started anything would look like a fix.
    expect(held.session.model.entries).toHaveLength(1);
    expect(held.session.model.entries[0]?.source).toBe(LATE_SOURCE);
    expect(held.session.model.entries[0]?.terminal?.output).toContain("LATE-ADMISSION");
  });

  it("R6: Stop before durable admission keeps that startup from ever admitting", function* () {
    const startup = yield* startupHold();
    const held = yield* useHarness(undefined, { entryInstallation: startup.installation });
    held.fake.script({ reply: LATE_REPLY });

    const sent = yield* sending(held, "submit");
    yield* startup.reached;
    expect(held.session.live).toBe(true);
    expect(held.session.model.entries).toHaveLength(0);

    yield* held.owner.stop();
    expect(held.admitting.held?.live).toBe(false);
    expect(held.session.model.entries).toHaveLength(0);

    // Released afterwards. The startup is already cancelled and joined, so
    // there is nothing left to resume: a task allocated before its entry was
    // admitted is not an entry, and Stop must not leave one that goes on to
    // become one.
    startup.release();
    yield* startup.finished;
    expect(held.session.model.entries).toHaveLength(0);
    // And nothing was invented for it: no admission, no terminal, no
    // settlement — the history is readable and holds no entry at all.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.unfinished.map((one) => one.component)).toEqual(["REPL.Submit"]);
    // The intent stands as what it is: a reserved request whose result was
    // never acknowledged. No completion receipt is manufactured for it.
    expect(
      (yield* records(held.execution)).filter(
        (record) => (record as { kind: string }).kind === "response",
      ),
    ).toHaveLength(0);
    // No stopped cycle starts a follow-up.
    expect(held.fake.prompts).toHaveLength(1);
    const answered = yield* sent;
    expect(answered.ok).toBe(false);
  });

  it("R6: Stop does not return, or free the owner, while a control's cleanup is held", function* () {
    const entered = withResolvers<void>();
    const cleaning = withResolvers<void>();
    const release = withResolvers<void>();
    let cleaned = false;
    // A control that suspends and whose cleanup is held. This is the only way
    // to observe what Stop waits for: without a hold, the work comes down so
    // fast that returning early and returning late look the same.
    const held = yield* useHarness(undefined, {
      *fill(): Operation<Result<void>> {
        yield* ensure(function* () {
          cleaning.resolve();
          yield* release.operation;
          cleaned = true;
        });
        entered.resolve();
        yield* suspend();
        return Ok(undefined);
      },
    });
    held.fake.script({ reply: "<REPL.EntryInput>held fill</REPL.EntryInput>\n" });
    // The successor runs a control of its own, so the row can say which
    // response each retained pair belongs to rather than only that a successor
    // ran at all.
    held.fake.script({ reply: "<REPL.Bindings />\n" });
    held.fake.script({ reply: "<Output>After Stop.</Output>\n" });

    const sent = yield* sending(held, "prepare something");
    yield* entered.operation;

    let returned = false;
    const stopped = yield* spawn(function* (): Operation<void> {
      yield* held.owner.stop();
      returned = true;
    });
    yield* cleaning.operation;

    // Stop is inside the teardown it asked for. It has not returned, and the
    // owner is not free — a Stop that answered here would tell somebody their
    // Sidekick had stopped while it was still unwinding.
    expect(cleaned).toBe(false);
    expect(returned).toBe(false);
    expect(held.owner.busy).toBe(true);
    const refused = yield* held.owner.message("while cleanup is held");
    expect(refused.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);

    release.resolve();
    yield* stopped;
    expect(cleaned).toBe(true);
    expect(returned).toBe(true);
    expect(held.owner.busy).toBe(false);

    // The control began and never answered, which is exactly what it was.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.unfinished.map((one) => one.component)).toEqual(["REPL.EntryInput"]);

    // And the same conversation answers afterwards.
    const again = yield* held.owner.message("after cleanup");
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.output).toContain("After Stop.");
    expect(again.value.conversation).toBe(reading.value.active);
    const first = yield* sent;
    expect(first.ok).toBe(false);

    // IN6's association half, read off the retained history rather than off
    // this process. The controls were captured once when the conversation
    // opened, so what tells these two pairs apart is the response each was
    // filed under — and a late outcome moving to the successor is exactly what
    // a holder cleared too early would produce.
    const after = held.owner.reading;
    if (!after.ok) {
      throw after.error;
    }
    const described = (one: SidekickOperation) => ({
      response: one.response,
      order: one.order,
      component: one.component,
      status: one.status,
    });
    // The successor's read is the one answered pair, and it belongs to the
    // successor's own response with its own order.
    expect(after.value.operations.map(described)).toEqual([
      { response: "response:2", order: 0, component: "REPL.Bindings", status: "ok" },
    ]);
    // The held fill began under the response that was stopped and never
    // answered, and it stays there: an outcome arriving late is exactly what a
    // response naming cleared before its cleanup had joined would have filed
    // under the successor instead.
    expect(after.value.unfinished.map(described)).toEqual([
      { response: "response:1", order: 0, component: "REPL.EntryInput", status: "unfinished" },
    ]);
    // Said the other way round, because that is the failure that mattered:
    // nothing of the stopped response's control is filed under the successor.
    expect(
      [...after.value.operations, ...after.value.unfinished].filter(
        (one) => one.response === "response:2" && one.component === "REPL.EntryInput",
      ),
    ).toEqual([]);
  });

  it("R6: Stop leaves an entry it admitted running, and starts no further turn", function* () {
    const held = yield* useHarness();
    // A reply that prepares an entry which stays open, and submits it. The
    // cycle then waits for that entry — which is where this row stops it.
    held.fake.script({
      reply: [
        '<Let as="code" select="code">',
        "````xmd",
        RUNS_ON,
        "````",
        "</Let>",
        "<REPL.EntryInput>{code}</REPL.EntryInput>",
        "<REPL.Submit />",
        "",
      ].join("\n"),
    });

    const sent = yield* sending(held, "run something long");
    // The barrier: the entry exists, so the submission is past admission and
    // the cycle is waiting for its outcome.
    yield* reprojected(held.session, (model) => model.entries.length === 1);

    yield* held.owner.stop();
    const answered = yield* sent;
    expect(answered.ok).toBe(false);

    // The entry is still running. It belongs to the session's own task, and
    // this was only ever waiting for it.
    expect(held.session.live).toBe(true);
    const [entry] = held.session.model.entries;
    expect(entry?.key).toBe("entry-1");
    expect(entry?.terminal).toBe(undefined);
    expect(entry?.source).toContain("yield* suspend()");

    // The submission's intent is retained with no outcome, which is exactly
    // what it is: an operation that began and whose result nobody knows.
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.unfinished.map((one) => one.component)).toEqual(["REPL.Submit"]);

    // And no turn followed. One message, one turn: whatever the entry does
    // later, nothing automatic is waiting to tell the agent about it.
    expect(held.fake.prompts).toHaveLength(1);
    expect(held.owner.busy).toBe(false);
  });

  it("R6: Stop with nothing running changes nothing", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Still here.</Output>\n" });

    // Before anything has been said. Stop is not a way to discard a
    // conversation, so there is nothing to do and nothing is done.
    yield* held.owner.stop();
    expect(held.fake.prompts).toHaveLength(0);
    const before = held.owner.reading;
    if (!before.ok) {
      throw before.error;
    }
    expect(before.value.chat).toEqual([]);

    const answered = yield* held.owner.message("hello");
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.output).toContain("Still here.");

    // And again, after a cycle that finished on its own: there is nothing in
    // flight, so Stop reaches nothing and revokes nothing.
    yield* held.owner.stop();
    expect(held.fake.prompts).toHaveLength(1);
    const after = held.owner.reading;
    if (!after.ok) {
      throw after.error;
    }
    expect(after.value.chat.map((item) => item.kind)).toEqual(["person", "reply"]);
  });
});

/**
 * Tier R6 — the question the Sidekick owns (#883, J5).
 *
 * A reply may write canonical paired `<Elicit>`, which is the same element an
 * authored document writes and the same component Core runs. Nothing about the
 * asking is this feature's: the bounded form language, Core's compiler, Core's
 * validator and the durable answer are all the ones an entry's question uses.
 *
 * What *is* this feature's is ownership, and these rows are about that. The
 * provider is installed in the owner's scope, so a reply's question and an
 * entry's are two pending questions with two answers — and the validated
 * answer is a designated operation result, so it reaches the reply that asked
 * through the same records every other control's answer travels in.
 *
 * The drawer, the tab and the focus are section 5's: these rows read the two
 * owners directly, which is what the mounted tree will read.
 */
describe("Tier R6 — a reply asks, and the Sidekick owns the answer", () => {
  /** The answer shape these rows ask for, in the bounded language this REPL draws. */
  const DECISION = {
    type: "object",
    properties: { decision: { type: "string", enum: ["approve", "reject"] } },
    required: ["decision"],
    additionalProperties: false,
  } as const;

  /** One reply that asks, with its schema as the declarative data it must be. */
  function asking(body: string, schema: Readonly<Record<string, unknown>> = DECISION): string {
    return `<Elicit schema={${JSON.stringify(schema)}} as="answer">${body}</Elicit>\n`;
  }

  /** An entry that asks a question of its own and waits for it. */
  const ENTRY_ASKS = [
    "```js eval",
    'const shape = {"type":"object","properties":{"ok":{"type":"string","enum":["yes"]}},' +
      '"required":["ok"],"additionalProperties":false};',
    "```",
    "",
    '<Elicit schema={shape} as="said">The entry is asking.</Elicit>',
    "",
  ].join("\n");

  /**
   * The next question this owner publishes.
   *
   * Subscribed before `pending` is read, so a question published between the
   * two is not missed — and nothing is slept on.
   */
  function* asked(questions: ReplElicitations): Operation<ReplQuestion> {
    const changes = yield* questions.changes;
    if (questions.pending !== undefined) {
      return questions.pending;
    }
    while (true) {
      const next = yield* changes.next();
      if (next.done === true) {
        throw new Error("that owner stopped publishing questions before it asked one");
      }
      if (next.value !== undefined) {
        return next.value;
      }
    }
  }

  /**
   * The reply the first turn produced, read out of the chat.
   *
   * Read from there rather than from what `message()` answered with, because a
   * designated answer starts another turn: the message is answered by the
   * *last* reply of the exchange, and the one that asked the question is the
   * first. Both being there is itself the shape under test.
   */
  function replied(held: Harness, turn: number): { text: string; failure: string | undefined } {
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    const item = reading.value.chat.find((one) => one.kind === "reply" && one.turn === turn);
    if (item === undefined || item.kind !== "reply") {
      throw new Error(`this conversation holds no reply for turn ${turn}`);
    }
    return { text: item.text, failure: item.failure };
  }

  /** Every control record this response wrote, by the component that wrote it. */
  function pairs(
    held: readonly unknown[],
    kind: "control" | "control-outcome",
  ): readonly Record<string, unknown>[] {
    return held.filter((record) => (record as { kind: string }).kind === kind) as readonly Record<
      string,
      unknown
    >[];
  }

  it("R6: a reply's question is this owner's, asked once, and its answer comes back", function* () {
    const held = yield* useHarness();
    held.fake.script({
      reply: `${asking("Approve the plan?")}\n<Output>\n<Json value={answer} />\n</Output>\n`,
    });
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });

    const sent = yield* sending(held, "ask me something");
    const question = yield* asked(held.owner.questions);

    // The Sidekick's, and nobody else's. The entry session has its own
    // provider in its own scope and was asked nothing.
    expect(held.session.elicitation.pending).toBe(undefined);
    // What a person is shown: the reply's own rendered request, and the form
    // read off the schema Core normalized.
    expect(question.message).toContain("Approve the plan?");
    expect(question.form.fields.map((field) => field.name)).toEqual(["decision"]);
    expect(question.form.fields[0]?.choices).toEqual(["approve", "reject"]);

    const outcome = question.submit({ decision: "approve" });
    expect(outcome.kind).toBe("answered");

    const answered = yield* sent;
    if (!answered.ok) {
      throw answered.error;
    }
    // The validated value reached the reply where it asked, through ordinary
    // `as` capture — this is that response's own rendering of it.
    expect(JSON.parse(replied(held, 1).text)).toEqual({ decision: "approve" });
    // And the exchange continued, which is what a designated answer does: the
    // message is answered by the reply that came after the feedback.
    expect(answered.value.output).toContain("Noted.");
    // Asked once. A question re-presented per turn would interrupt somebody
    // twice for one answer.
    expect(held.owner.questions.asked).toBe(1);
    // And nothing is left pending: the question existed only while the root
    // that asked it was suspended.
    expect(held.owner.questions.pending).toBe(undefined);

    // It is a designated result, so it went back to the same conversation as
    // the next turn's input — alone, so it is the value itself.
    expect(JSON.parse(held.fake.prompts[1] ?? "")).toEqual({ decision: "approve" });

    // Retained as the pair every control writes: the intent before the asking,
    // naming the question, and the outcome holding the validated answer.
    const written = yield* records(held.execution);
    const intents = pairs(written, "control").filter((one) => one["component"] === "Elicit");
    expect(intents).toHaveLength(1);
    expect(intents[0]?.["arguments"]).toMatchObject({ message: "Approve the plan?" });
    const outcomes = pairs(written, "control-outcome").filter(
      (one) => one["order"] === intents[0]?.["order"],
    );
    expect(outcomes[0]?.["observed"]).toEqual({ decision: "approve" });
  });

  it("R6: an invalid answer answers nobody and leaves the same question pending", function* () {
    const held = yield* useHarness();
    held.fake.script({
      reply: `${asking("Approve the plan?")}\n<Output>\n<Json value={answer} />\n</Output>\n`,
    });
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });

    const sent = yield* sending(held, "ask me something");
    const question = yield* asked(held.owner.questions);

    // A partly filled form is an invalid submission, which is the same thing:
    // the issues come back and the question is untouched.
    const partial = question.submit({});
    expect(partial.kind).toBe("invalid");
    expect(partial.kind === "invalid" ? partial.issues.length : 0).toBeGreaterThan(0);
    // A value the enum does not offer, which the form draws and Core judges.
    expect(question.submit({ decision: "maybe" }).kind).toBe("invalid");

    // The same question, still waiting. Not a second one, and not a closed one.
    expect(held.owner.questions.pending).toBe(question);
    expect(held.owner.questions.asked).toBe(1);
    // And no outcome was retained: an answer nobody gave is not written down.
    expect(
      pairs(yield* records(held.execution), "control-outcome").filter((one) => one["order"] === 0),
    ).toHaveLength(0);

    expect(question.submit({ decision: "reject" }).kind).toBe("answered");
    const answered = yield* sent;
    if (!answered.ok) {
      throw answered.error;
    }
    expect(answered.value.output).toContain("Noted.");
    // The answer the person actually gave, and not the one they tried to.
    expect(JSON.parse(replied(held, 1).text)).toEqual({ decision: "reject" });
  });

  it("R6: an entry's question and a reply's are two questions with two answers", function* () {
    const held = yield* useHarness();
    held.fake.script({
      reply: `${asking("Approve the plan?")}\n<Output>\n<Json value={answer} />\n</Output>\n`,
    });
    held.fake.script({ reply: "<Output>Noted.</Output>\n" });

    // The person's own Run, which asks through the session's provider.
    const entry = yield* held.session.submit(ENTRY_ASKS);
    if (!entry.ok) {
      throw entry.error;
    }
    const theirs = yield* asked(held.session.elicitation);
    expect(theirs.message).toContain("The entry is asking.");

    const sent = yield* sending(held, "ask me something");
    const ours = yield* asked(held.owner.questions);

    // Two owners, two pending questions, and neither is the other's.
    expect(ours).not.toBe(theirs);
    expect(held.session.elicitation.pending).toBe(theirs);
    expect(held.owner.questions.pending).toBe(ours);
    // The entry's own shape, which is not the one the reply asked.
    expect(theirs.form.fields.map((field) => field.name)).toEqual(["ok"]);

    // Answering the Sidekick's answers only the Sidekick's.
    expect(ours.submit({ decision: "approve" }).kind).toBe("answered");
    const answered = yield* sent;
    if (!answered.ok) {
      throw answered.error;
    }
    expect(JSON.parse(replied(held, 1).text)).toEqual({ decision: "approve" });
    expect(held.session.elicitation.pending).toBe(theirs);

    // And the entry's is still answerable afterwards, on its own terms.
    expect(theirs.submit({ ok: "yes" }).kind).toBe("answered");
    yield* reprojected(held.session, (model) => model.entries[0]?.settled === true);
  });

  it("R6: Stop withdraws the pending question and invents no answer", function* () {
    const held = yield* useHarness();
    held.fake.script({
      reply: `${asking("Approve the plan?")}\n<Output>\n<Json value={answer} />\n</Output>\n`,
    });
    held.fake.script({ reply: "<Output>After Stop.</Output>\n" });

    const entry = yield* held.session.submit(ENTRY_ASKS);
    if (!entry.ok) {
      throw entry.error;
    }
    const theirs = yield* asked(held.session.elicitation);

    const sent = yield* sending(held, "ask me something");
    yield* asked(held.owner.questions);

    yield* held.owner.stop();

    // Withdrawn, because the root that asked it came down — and Stop returned
    // only once that had joined, so there is nothing still waiting behind a
    // screen that says it stopped.
    expect(held.owner.questions.pending).toBe(undefined);
    // Nothing was answered. The intent stands with no outcome beside it, which
    // is what an operation that began and whose result nobody knows looks
    // like — an interruption is an absence, never a receipt saying so.
    const written = yield* records(held.execution);
    const intents = pairs(written, "control").filter((one) => one["component"] === "Elicit");
    expect(intents).toHaveLength(1);
    expect(
      pairs(written, "control-outcome").filter((one) => one["order"] === intents[0]?.["order"]),
    ).toHaveLength(0);
    // No response record either: the root never finished.
    expect(written.filter((one) => (one as { kind: string }).kind === "response")).toHaveLength(0);
    // And the projection says so in the terms the rest of this history uses:
    // an operation that began and never answered, reported rather than resumed.
    const stopped = held.owner.reading;
    if (!stopped.ok) {
      throw stopped.error;
    }
    expect(stopped.value.unfinished.map((one) => [one.component, one.status])).toEqual([
      ["Elicit", "unfinished"],
    ]);

    // The entry's question is untouched and still answerable. Stop ended the
    // asking the Sidekick was doing, not the asking anything else was.
    expect(held.session.elicitation.pending).toBe(theirs);
    expect(theirs.submit({ ok: "yes" }).kind).toBe("answered");

    // And the conversation is free immediately.
    const again = yield* held.owner.message("never mind");
    if (!again.ok) {
      throw again.error;
    }
    expect(again.value.output).toContain("After Stop.");
    expect((yield* sent).ok).toBe(false);
  });

  it("R6: a schema this surface cannot draw asks nobody, and the reply is told why", function* () {
    const held = yield* useHarness();
    // A number field. The form language is a closed object of string fields, so
    // this is refused before anybody is asked rather than drawn as something
    // else and judged later.
    held.fake.script({
      reply: asking("How many?", {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
        additionalProperties: false,
      }),
    });
    held.fake.script({ reply: "<Output>Understood.</Output>\n" });

    const answer = yield* held.owner.message("ask me something");
    if (!answer.ok) {
      throw answer.error;
    }

    // Nobody was asked, and nothing was published.
    expect(held.owner.questions.asked).toBe(0);
    expect(held.owner.questions.pending).toBe(undefined);
    // That response failed — `<Elicit>` is unmarked, so a question that cannot
    // be presented fails the reply that asked it.
    expect(replied(held, 1).failure).toContain("bounded form language");

    // And the reply was told, labelled with the component that failed, so its
    // next response can ask something this surface can draw. The refusal names
    // the subset, which is the teaching.
    const told = held.fake.prompts[1] ?? "";
    expect(told).toContain("Elicit");
    expect(told).toContain("a closed object of string fields");
  });
});

/**
 * Tier R6/MP — Stop as the control a person actually presses.
 *
 * The rows above drive the owner directly, because what Stop leaves alone is
 * the same whether or not anything is drawing it. These add the half that only
 * the mounted command has: the control is reached through the tree, the work is
 * spawned on the screen's own task, and the keyboard has to stay usable while
 * Stop joins everything the Sidekick had in flight.
 */
describe("Tier R6 — Stop, pressed on the screen", () => {
  /** A reply that prepares an entry and submits it. */
  const SUBMITTING_REPLY = [
    '<Let as="code" select="code">',
    "````xmd",
    "```js eval",
    'const held = "the entry kept running";',
    "```",
    "",
    "<Output>{held}</Output>",
    "````",
    "</Let>",
    "<REPL.EntryInput>{code}</REPL.EntryInput>",
    "<REPL.Submit />",
    "",
  ].join("\n");

  it("M6: Stop withdraws the wait and leaves the entry it admitted running", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.script({ reply: SUBMITTING_REPLY });

    // The entry's own closing record, held open: the entry has run and has not
    // settled, which is where the submission is still waiting for its outcome.
    const closing = gate.holdNext(
      (path, record) => path.endsWith(ENTRIES_FILE) && record.includes('"type":"close"'),
    );

    yield* sendMessage(repl, "run it");
    yield* closing.started();
    // The entry is admitted and has produced what it produced.
    yield* awaiting(repl.terminal, "the entry's output arriving", (one) =>
      shows(one, "the entry kept running"),
    );
    expect(shows(repl.terminal, "[stop]")).toBe(true);

    // Stop, through its own control.
    yield* click(repl.terminal, "[stop]");
    yield* awaiting(repl.terminal, "Stop joining and the Sidekick coming to rest", (one) =>
      shows(one, "[send]"),
    );

    // No turn followed. One message, one turn: whatever the entry does later,
    // nothing automatic is waiting to tell the agent about it.
    expect(repl.fake.prompts).toHaveLength(1);
    // The submission's intent is retained with no outcome, which is exactly
    // what it is: an operation that began and whose result nobody knows.
    const stopped = yield* mountedReading(repl);
    const controls = stopped.chat.filter((record) => record.kind === "control");
    const answered = new Set(
      stopped.chat
        .filter((record) => record.kind === "control-outcome")
        .map((record) => (record.kind === "control-outcome" ? record.order : -1)),
    );
    expect(controls.map((record) => (record.kind === "control" ? record.component : ""))).toEqual([
      "REPL.EntryInput",
      "REPL.Submit",
    ]);
    // The fill answered; the submission did not. An intent with no outcome is
    // an operation that began and whose result nobody knows, which is exactly
    // the state Stop leaves a wait in.
    expect(
      controls
        .filter((record) => !answered.has(record.kind === "control" ? record.order : -1))
        .map((record) => (record.kind === "control" ? record.component : "")),
    ).toEqual(["REPL.Submit"]);
    // The chat a person was reading is still there, and so is the draft the
    // reply filled.
    expect(shows(repl.terminal, "you: run it")).toBe(true);
    expect(draftText(repl.terminal)).toBe("");

    // The entry was never among what came down: it is still running, and it
    // settles when its own record lands rather than when Stop said so.
    expect(stopped.model.entries.map((entry) => entry.terminal)).toEqual([undefined]);
    closing.release();
    yield* awaiting(repl.terminal, "the entry settling on its own", (one) => shows(one, "[ok]"));

    // And a later explicit message is possible: Stop ended the asking, not the
    // conversation.
    repl.fake.script({ reply: "<Output>Still here.</Output>\n" });
    yield* sendMessage(repl, "again");
    yield* awaiting(repl.terminal, "the next message being answered", (one) =>
      shows(one, `${MOUNTED_AGENT}: Still here.`),
    );
    expect(repl.fake.prompts).toHaveLength(2);
  });

  it("M6: Stop reports nothing and enables no successor while its cleanup is held", function* () {
    const repl = yield* useMountedRepl();
    // Generation that has been accepted and is saying nothing, and whose
    // cancellation this case holds: the only way to tell a Stop that returned
    // early from one that returned late.
    repl.fake.script({ held: true, reply: "<Output>Never said.</Output>\n" });
    const cancelling = repl.fake.holdCancellation();

    yield* sendMessage(repl, "stop me");
    yield* repl.fake.holdingTurns(1);
    yield* click(repl.terminal, "[stop]");
    yield* cancelling.reached;

    // Stop is inside the teardown it asked for. The row still says the Sidekick
    // is working, and there is no Send to start a successor with — a screen
    // that offered one here would be claiming the Sidekick had stopped while it
    // was still unwinding.
    expect(shows(repl.terminal, "[stop]")).toBe(true);
    expect(shows(repl.terminal, "[send]")).toBe(false);
    expect(repl.fake.prompts).toHaveLength(1);

    // And ordinary typing still works, because the join is on the screen's own
    // task rather than on the keyboard's.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "meanwhile");
    expect(draftText(repl.terminal)).toBe("meanwhile");

    cancelling.release();
    yield* awaiting(repl.terminal, "Stop returning once its cleanup joined", (one) =>
      shows(one, "[send]"),
    );
    expect(draftText(repl.terminal)).toBe("meanwhile");
    expect(repl.fake.prompts).toHaveLength(1);
  });
});

/**
 * Tier R6/MP — the command ending while the Sidekick is still working.
 *
 * Stop ends the asking; these end the command. The difference is what M6 above
 * already drew the line at: Stop leaves an admitted entry running, and leaving
 * does not. Both rows hold a real cleanup open, because a command that returned
 * early and one that joined everything it owned look the same otherwise.
 */
/**
 * Tier PV — a candidate that never became a reply (#883, PV3).
 *
 * Generation can end two ways that are not an answer: the provider fails, or a
 * person stops it. Neither runs any of the controls the candidate declared, and
 * neither names a turn, an acceptance or a reply. What is left is the attempt —
 * said as one, and only as much of one as was actually saved.
 */
describe("Tier PV — generation that ended without a reply", () => {
  /** A candidate that says something and then asks for work to be done. */
  const CANDIDATE = [
    "<Output>As far as I got.</Output>\n",
    [
      '<Let as="code" select="code">',
      "````xmd",
      "```js eval",
      'const said = "the entry ran";',
      "```",
      "",
      "<Output>{said}</Output>",
      "````",
      "</Let>",
      "<REPL.EntryInput>{code}</REPL.EntryInput>",
      "<REPL.Submit />",
      "",
    ].join("\n"),
  ];

  it("PV3: a provider that fails after saying something leaves an unfinished attempt", function* () {
    const repl = yield* useMountedRepl();
    // It streams, then the backend reports the turn failed: the record holds
    // what it had said, which is what the attempt is projected from.
    repl.fake.script({ deltas: CANDIDATE, holdAfter: 1, stopReason: "refusal" });
    repl.fake.script({ reply: "<Output>A fresh start.</Output>\n" });

    yield* sendMessage(repl, "try it");
    yield* repl.fake.streamingTurns(1);
    // Said in this pane's own width, which clips the rest of the sentence.
    yield* awaiting(repl.terminal, "the preview", (one) =>
      shows(one, `${MOUNTED_AGENT} (preview): As far as I`),
    );
    repl.fake.releaseDeltas();

    // The saved failed turn is the account now: said as unfinished, with the
    // literal Output it had managed and the reason it stopped.
    yield* awaiting(repl.terminal, "the unfinished attempt", (one) =>
      shows(one, `${MOUNTED_AGENT} (unfinished)`),
    );
    yield* settled(40);
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    expect(shows(repl.terminal, "As far as I")).toBe(true);

    // None of its controls ran: no entry, no control pair, no reply — and no
    // automatic successor turn either.
    const read = yield* mountedReading(repl);
    expect(read.model.entries).toEqual([]);
    expect(read.chat.filter((record) => record.kind === "control")).toEqual([]);
    expect(read.chat.filter((record) => record.kind === "response")).toEqual([]);
    expect(repl.fake.prompts).toHaveLength(1);

    // A following explicit message is its own item, and the stopped candidate
    // does not update it.
    yield* sendMessage(repl, "again");
    yield* awaiting(repl.terminal, "the next reply", (one) => shows(one, "A fresh start."));
    expect(shows(repl.terminal, "(preview)")).toBe(false);
    expect(shows(repl.terminal, `${MOUNTED_AGENT} (unfinished)`)).toBe(true);
  });

  /** An entry of this person's own, which says something and then closes. */
  const OWN_ENTRY = [
    "```js eval",
    'const mine = "my own entry";',
    "```",
    "",
    "<Output>{mine}</Output>",
    "",
  ].join("\n");

  it("PV3: Stop keeps what was said as an attempt, and claims nothing that was not saved", function* () {
    const gate = appendGate();
    const host = yield* useMountedHost({ gate });
    const repl = yield* useMountedRepl({ host });
    repl.fake.script({ deltas: CANDIDATE, holdAfter: 1 });

    // An entry this person admitted, held open before it closes: it is the
    // document's work, and Stop is not about it.
    const closing = gate.holdNext(
      (path, record) => path.endsWith("entries.jsonl") && record.includes('"type":"close"'),
    );
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(OWN_ENTRY));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* closing.started();

    yield* sendMessage(repl, "try it");
    yield* repl.fake.streamingTurns(1);
    yield* awaiting(repl.terminal, "the preview", (one) =>
      shows(one, `${MOUNTED_AGENT} (preview): As far as I`),
    );

    // Stopped, with the provider's own cancellation held: this is what says
    // Stop joined what it asked for rather than returning over the top of it.
    const cancelling = repl.fake.holdCancellation();
    yield* click(repl.terminal, "[stop]");
    yield* cancelling.reached;
    expect(repl.outcome()).toBe(undefined);
    cancelling.release();

    // What the agent said stays, as the attempt it is — and it claims nothing:
    // no turn, no response, no acceptance, no recorded failure.
    yield* awaiting(repl.terminal, "the attempt Stop left", (one) =>
      shows(one, `${MOUNTED_AGENT} (unfinished): As far as I`),
    );
    const read = yield* mountedReading(repl);
    expect(read.chat.filter((record) => record.kind === "response")).toEqual([]);
    expect(read.chat.filter((record) => record.kind === "control")).toEqual([]);
    expect(shows(repl.terminal, "[retry]")).toBe(false);
    // None of the candidate's controls ran, and no successor turn started.
    expect(repl.fake.prompts).toHaveLength(1);

    // The entry is untouched by any of it: still open, and still the
    // document's own work to finish.
    expect(closing.released).toBe(false);
    closing.release();
    yield* awaiting(repl.terminal, "the entry finishing on its own", (one) =>
      shows(one, "my own entry"),
    );

    // And nothing of that attempt was persisted to preserve a screen: a cold
    // reopen of this same history has no account of it.
    const execution = yield* mountedExecution(repl);
    yield* click(repl.terminal, "[exit]");
    yield* awaited("the command returning", () => repl.outcome() !== undefined);
    const again = yield* useMountedRepl({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    yield* awaiting(again.terminal, "the reopened chat", (one) => shows(one, "you: try it"));
    expect(shows(again.terminal, "(unfinished)")).toBe(false);
    expect(shows(again.terminal, "As far as I")).toBe(false);
  });

  /**
   * A successful reply and then a failed successor, optionally after an
   * interrupted first message.
   *
   * `gap` is the whole distinction. A message whose generation was stopped
   * before anything was saved stays in the history, so the owner's next
   * response is named from an ordinal that counts it while Core numbers its own
   * turns without it — and from then on a response name and a saved turn are
   * different numbers for the same conversation. An attempt addressed by a
   * response name reconstructed from its turn would take the earlier reply's
   * row, which is one row named twice.
   */
  function* failedSuccessor(gap: boolean): Operation<void> {
    const host = yield* useMountedHost();
    let repl = yield* useMountedRepl({ host });
    if (gap) {
      repl.fake.script({ held: true, reply: "<Output>Unrecorded.</Output>\n" });
      yield* sendMessage(repl, "unrecorded");
      yield* repl.fake.holdingTurns(1);
      yield* click(repl.terminal, "[stop]");
      yield* awaiting(repl.terminal, "Stop finishing", (one) => shows(one, "[send]"));
      const execution = yield* mountedExecution(repl);
      yield* click(repl.terminal, "[exit]");
      yield* awaited("the first command closing", () => repl.outcome() !== undefined);
      repl = yield* useMountedRepl({ host, location: `xmd://repl/${execution}/entries` });
    }

    repl.fake.script({ reply: "<Output>First reply.</Output>\n" });
    yield* sendMessage(repl, "saved");
    yield* awaiting(repl.terminal, "the successful predecessor", (one) =>
      shows(one, `${MOUNTED_AGENT}: First reply.`),
    );
    yield* awaiting(repl.terminal, "the box being ready again", (one) => shows(one, "[send]"));
    // Which response that reply was recorded as, and which turn it actually
    // ran as — read out of the history the command wrote.
    const preceding = (yield* mountedReading(repl)).chat.flatMap((record) =>
      record.kind === "response" ? [{ response: record.response, turn: record.turn }] : [],
    );
    expect(preceding).toHaveLength(1);
    expect(preceding[0]?.response === `response:${preceding[0]?.turn}`).toBe(!gap);

    repl.fake.script({
      deltas: ["<Output>Second attempt.</Output>\n", "<REPL.Bindings />\n"],
      holdAfter: 1,
      stopReason: "refusal",
    });
    yield* sendMessage(repl, "failed");
    yield* repl.fake.streamingTurns(1);
    yield* awaiting(repl.terminal, "the successor's preview", (one) =>
      shows(one, "(preview): Second attempt."),
    );
    repl.fake.releaseDeltas();

    // Both items stand: the reply that was answered and the attempt that was
    // not. Drawing them is what a duplicated row would have crashed.
    yield* awaiting(repl.terminal, "the failed successor", (one) => shows(one, "(unfinished)"));
    yield* settled(60);
    expect(repl.outcome()).toBe(undefined);
    expect(shows(repl.terminal, "First reply.")).toBe(true);
    expect(shows(repl.terminal, "Second attempt.")).toBe(true);
    // And the attempt is addressed by the turn it really became, which is the
    // one its own record holds.
    const read = yield* mountedReading(repl);
    const attempts = read.chat.flatMap((record) =>
      record.kind === "message" ? [record.turn] : [],
    );
    expect(attempts.length).toBeGreaterThan(1);
    expect(read.model.entries).toEqual([]);
  }

  it("PV3: a failed successor keeps its own row after an interrupted first message", function* () {
    yield* failedSuccessor(true);
  });

  it("PV3: control — the same successor with no interrupted message behind it", function* () {
    yield* failedSuccessor(false);
  });

  it("PV3: a reopened history shows that attempt from its own record, reading nothing live", function* () {
    const host = yield* useMountedHost();
    const first = yield* useMountedRepl({ host });
    first.fake.script({ deltas: CANDIDATE, stopReason: "refusal" });

    yield* sendMessage(first, "try it");
    yield* awaiting(first.terminal, "the unfinished attempt", (one) =>
      shows(one, `${MOUNTED_AGENT} (unfinished)`),
    );
    const execution = yield* mountedExecution(first);
    // What this host's provider was asked for by the command that really ran.
    // The reopen below shares the same fake, so what it must add is nothing.
    const asked = first.fake.prompts.length;
    const opened = first.fake.ensured.length;
    yield* click(first.terminal, "[exit]");
    yield* awaited("the first command returning", () => first.outcome() !== undefined);
    const written = yield* until(
      readFile(join(host.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE), "utf8"),
    );

    // The same history, opened cold by another command.
    const again = yield* useMountedRepl({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    yield* awaiting(again.terminal, "the attempt as this history holds it", (one) =>
      shows(one, `${MOUNTED_AGENT} (unfinished)`),
    );
    // Its literal Output, projected from the saved source — and nothing a live
    // process remembered: this command never saw that generation.
    expect(shows(again.terminal, "As far as I")).toBe(true);
    expect(shows(again.terminal, "(preview)")).toBe(false);
    // Reading it cost nothing: no turn, no session, not one byte.
    expect(again.fake.prompts).toHaveLength(asked);
    expect(again.fake.ensured).toHaveLength(opened);
    expect(
      yield* until(readFile(join(host.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE), "utf8")),
    ).toBe(written);
  });
});

describe("Tier R6 — leaving, with Sidekick work in flight", () => {
  /** An entry that publishes nothing and stays open until it is torn down. */
  const SUSPENDS = ["```js eval", "yield* suspend();", "```", ""].join("\n");

  /**
   * One command with an entry running and a Sidekick turn accepted, left by
   * whichever of the two ways out this row is about.
   */
  function* leaving(leave: (terminal: Terminal) => Operation<void>): Operation<void> {
    const repl = yield* useMountedRepl();
    repl.fake.script({ held: true, reply: "<Output>Never said.</Output>\n" });

    // An ordinary entry of this person's, admitted and still open.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(SUSPENDS));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry being admitted", (one) => shows(one, "Entry 1"));

    // And a Sidekick turn the agent has accepted and not answered.
    yield* sendMessage(repl, "hold on");
    yield* repl.fake.holdingTurns(1);

    // The provider's own teardown, held: this is what says the command joined
    // its work rather than returning over the top of it.
    const cancelling = repl.fake.holdCancellation();
    const restored = repl.terminal.resets;
    yield* leave(repl.terminal);
    yield* cancelling.reached;

    // Inside the teardown it asked for: nothing has been returned and the
    // terminal is still this program's.
    expect(repl.outcome()).toBe(undefined);
    expect(repl.terminal.resets).toBe(restored);
    expect(repl.terminal.readers).toBe(1);

    cancelling.release();
    yield* awaited("the command returning", () => repl.outcome() !== undefined);

    // Once, and with everything released: one restore, no reader left on the
    // input and no listener left on the size.
    const outcome = repl.outcome();
    expect(outcome?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(restored + 1);
    expect(repl.terminal.readers).toBe(0);
    expect(repl.terminal.listeners).toBe(0);
    // And nothing was asked of the agent on the way out.
    expect(repl.fake.prompts).toHaveLength(1);
  }

  it("M8: Exit joins the owner and the entry before the command returns", function* () {
    yield* leaving(function* (terminal: Terminal): Operation<void> {
      yield* click(terminal, "[exit]");
    });
  });

  it("M8: Control-C joins the same work, without another key", function* () {
    yield* leaving(function* (terminal: Terminal): Operation<void> {
      terminal.feed("\x03");
      yield* settled(30);
    });
  });
});

/**
 * Tier MQ — the Sidekick's question, answered from the screen it is drawn on.
 *
 * The rows above drive the owner's `submit` directly, because what a validated
 * answer is worth is the same whether or not anything is drawing it. These add
 * the half only the mounted command has: the form is reached through its own
 * opener, filled through its own fields, told what was wrong with it, closed and
 * reopened with what was typed still in it, and answered — all of it through the
 * tree, with only the terminal and the transport replaced.
 */
describe("Tier MQ — a Sidekick question, filled in and answered on the screen", () => {
  /** A choice, and a reason long enough that a short one is a real refusal. */
  const REVIEW = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "reject"] },
      message: { type: "string", minLength: 4 },
    },
    required: ["decision", "message"],
    additionalProperties: false,
  } as const;

  /**
   * Drive one whole question, with or without leaving the pane in the middle.
   *
   * `interrupted` is the only difference between the two arms: closing the form
   * and going away has to change nothing about what is in it, and the arm that
   * never leaves is what says the preservation is not merely an unanswerable
   * form left on screen.
   */
  function* answeringJourney(interrupted: boolean): Operation<{
    readonly chat: readonly SidekickRecord[];
    readonly draft: string;
    readonly message: string;
    readonly prompts: readonly string[];
  }> {
    const repl = yield* useMountedRepl();
    repl.fake.script({
      reply: `<Elicit schema={${JSON.stringify(REVIEW)}} as="answer">Approve the plan?</Elicit>\n`,
    });
    repl.fake.script({ reply: "<Output>Thanks for deciding.</Output>\n" });

    // Their own text in the draft before any of this, which the question must
    // leave alone.
    yield* focusDraft(repl.terminal);
    yield* typing(repl.terminal, "mine");

    yield* sendMessage(repl, "review it");
    // And a message typed while the Sidekick is working, which is unsent and
    // stays unsent: answering a question is not sending what is in the box.
    yield* focusMessage(repl.terminal);
    yield* typing(repl.terminal, "later");

    yield* awaiting(repl.terminal, "the question announcing itself", (one) =>
      shows(one, `${MOUNTED_AGENT} has a question.`),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "[submit]"));

    // The enum, chosen by typing the offered value into the line the form
    // opened on and pressing Enter. That is an answer attempt, and it is
    // invalid: the reason is required and there is none.
    yield* typing(repl.terminal, "approve");
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the issue the schema reported", (one) => shows(one, "message"));
    expect(shows(repl.terminal, "[submit]")).toBe(true);

    // A field named `message`, edited through the form. It must reach the form
    // and not the Sidekick's own composer, which still holds what was typed
    // into it.
    yield* focusFormValue(repl.terminal, 1);
    yield* typing(repl.terminal, "ok");
    expect(shows(repl.terminal, "message: ok")).toBe(true);

    if (interrupted) {
      // Away, and back. Closing hides the form and keeps the question; the pane
      // change keeps both.
      yield* click(repl.terminal, "[close]");
      yield* awaiting(repl.terminal, "the form closing", (one) => !shows(one, "[submit]"));
      expect(shows(repl.terminal, "[answer sidekick]")).toBe(true);
      yield* activate(repl.terminal, "Bindings");
      yield* awaiting(
        repl.terminal,
        "Bindings being selected",
        (one) => panePresented(one) === "bindings",
      );
      yield* activate(repl.terminal, "Sidekick");
      yield* awaiting(repl.terminal, "the notice still in the pane", (one) =>
        shows(one, `${MOUNTED_AGENT} has a question.`),
      );
      yield* click(repl.terminal, "[answer sidekick]");
      yield* awaiting(repl.terminal, "the form reopening", (one) => shows(one, "[submit]"));
      // Exactly what was in it: the choice, the partial reason and what the
      // schema said about it.
      expect(shows(repl.terminal, "decision: approve")).toBe(true);
      expect(shows(repl.terminal, "message: ok")).toBe(true);
    }

    // Long enough now, submitted through its own control.
    yield* focusFormValue(repl.terminal, 1);
    yield* typing(repl.terminal, "ay");
    expect(shows(repl.terminal, "message: okay")).toBe(true);
    yield* click(repl.terminal, "[submit]");

    yield* awaiting(repl.terminal, "the reply answering once the question was", (one) =>
      shows(one, `${MOUNTED_AGENT}: Thanks for deciding.`),
    );
    // The form and its way in are both gone, because the question is.
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    expect(shows(repl.terminal, "[answer]")).toBe(false);

    const read = yield* mountedReading(repl);
    return {
      chat: read.chat,
      draft: draftText(repl.terminal),
      message: messageText(repl.terminal),
      prompts: repl.fake.prompts,
    };
  }

  /** Every Elicit record of one kind this history holds. */
  function elicits(
    chat: readonly SidekickRecord[],
    kind: "control" | "control-outcome",
  ): readonly SidekickRecord[] {
    return chat.filter(
      (record) =>
        record.kind === kind && (record.kind === "control" ? record.component === "Elicit" : true),
    );
  }

  it("MQ2: an invalid answer keeps the question, and closing keeps what was typed", function* () {
    const done = yield* answeringJourney(true);

    // Exactly one question was asked and exactly one answer was retained: the
    // invalid attempts wrote nothing at all.
    const intents = elicits(done.chat, "control");
    expect(intents).toHaveLength(1);
    const answers = done.chat.filter(
      (record) =>
        record.kind === "control-outcome" &&
        intents.some((one) => one.kind === "control" && one.order === record.order),
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      observed: { decision: "approve", message: "okay" },
    });
    // And it reached the reply that asked, as its own designated feedback.
    expect(JSON.parse(done.prompts[1] ?? "")).toEqual({
      decision: "approve",
      message: "okay",
    });
    // Both composers are untouched by any of it.
    expect(done.draft).toBe("mine");
    expect(done.message).toBe("later");
  });

  it("MQ2: control — the same answer without closing or changing panes", function* () {
    const done = yield* answeringJourney(false);

    expect(elicits(done.chat, "control")).toHaveLength(1);
    expect(JSON.parse(done.prompts[1] ?? "")).toEqual({
      decision: "approve",
      message: "okay",
    });
    expect(done.draft).toBe("mine");
    expect(done.message).toBe("later");
  });
});

/**
 * Tier MQ — two owners asking at once, and what Stop does to one of them.
 *
 * The entry's provider lives in the session's scope and the Sidekick's in the
 * owner's, so these are two questions by construction rather than by a rule.
 * What the mounted rows add is that the screen keeps them apart: two forms, two
 * answers, and a Stop that withdraws one without inventing an answer to either.
 */
describe("Tier MQ — two questions, two answers, and Stop", () => {
  /** Overlapping field names, so an answer reaching the wrong form would show. */
  const SIDEKICK_ASKS = {
    type: "object",
    properties: { choice: { type: "string", enum: ["yes", "no"] } },
    required: ["choice"],
    additionalProperties: false,
  } as const;

  /** The entry's own question, with the same field name and its own values. */
  const ENTRY_ASKS = [
    "```js eval",
    'const shape = {"type":"object","properties":{"choice":{"type":"string",' +
      '"enum":["left","right"]}},"required":["choice"],"additionalProperties":false};',
    "```",
    "",
    '<Elicit schema={shape} as="said">The entry is asking.</Elicit>',
    "",
    "<Output>Entry said {said.choice}.</Output>",
    "",
  ].join("\n");

  function asks(schema: Readonly<Record<string, unknown>>, body: string): string {
    return `<Elicit schema={${JSON.stringify(schema)}} as="answer">${body}</Elicit>\n`;
  }

  it("MQ3: answering the Sidekick leaves the entry's question pending, and vice versa", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: asks(SIDEKICK_ASKS, "Shall I go on?") });
    repl.fake.script({ reply: "<Output>Sidekick heard yes.</Output>\n" });

    // The entry's question first, so both are pending at once.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(ENTRY_ASKS));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry's question announcing itself", (one) =>
      shows(one, "[answer]"),
    );

    yield* sendMessage(repl, "go on?");
    yield* awaiting(repl.terminal, "the Sidekick's question announcing itself", (one) =>
      shows(one, `${MOUNTED_AGENT} has a question.`),
    );

    // The Sidekick's own, opened from its own pane and answered through its own
    // form. Its enum offers values the entry's does not, so an answer that
    // reached the other form could not be mistaken for this one.
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the Sidekick's form", (one) => shows(one, "Shall I go on?"));
    expect(shows(repl.terminal, "choice: yes | no")).toBe(true);
    yield* typing(repl.terminal, "yes");
    repl.terminal.feed("\r");

    yield* awaiting(repl.terminal, "the reply hearing it", (one) =>
      shows(one, `${MOUNTED_AGENT}: Sidekick heard yes.`),
    );

    // The entry's question is untouched: still waiting, still its own. Read
    // from its announcement rather than from its text — the entry's source is
    // drawn in the transcript, so its words are on the screen either way.
    expect(shows(repl.terminal, "[submit]")).toBe(false);
    yield* awaiting(repl.terminal, "the entry's question still waiting", (one) =>
      shows(one, "[answer]"),
    );

    // And answered independently, with its own values, producing its own result.
    yield* click(repl.terminal, "[answer]");
    yield* awaiting(repl.terminal, "the entry's own form", (one) =>
      shows(one, "The entry is asking."),
    );
    expect(shows(repl.terminal, "choice: left | right")).toBe(true);
    yield* typing(repl.terminal, "left");
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry rendering what it was told", (one) =>
      shows(one, "Entry said left."),
    );
    // One turn for the message and one for its feedback, and nothing extra.
    expect(repl.fake.prompts).toHaveLength(2);
  });

  it("MQ3: Stop withdraws the Sidekick's question and invents no answer", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.script({ reply: asks(SIDEKICK_ASKS, "Shall I go on?") });

    // The entry's question, pending throughout: Stop is the Sidekick's and must
    // not reach it.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(ENTRY_ASKS));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry's question announcing itself", (one) =>
      shows(one, "[answer]"),
    );

    yield* sendMessage(repl, "go on?");
    yield* awaiting(repl.terminal, "the Sidekick's question announcing itself", (one) =>
      shows(one, `${MOUNTED_AGENT} has a question.`),
    );
    // Open, and half filled in, so Stop is reaching a form somebody is using.
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the Sidekick's form", (one) => shows(one, "Shall I go on?"));
    yield* typing(repl.terminal, "yes");

    // Stop, through its own control. The form was open; it goes without an
    // answer.
    yield* click(repl.terminal, "[stop]");
    yield* awaiting(repl.terminal, "Stop joining and the Sidekick coming to rest", (one) =>
      shows(one, "[send]"),
    );
    expect(shows(repl.terminal, "Shall I go on?")).toBe(false);
    expect(shows(repl.terminal, `${MOUNTED_AGENT} has a question.`)).toBe(false);

    // Nothing was answered and nothing followed: the intent stands with no
    // outcome beside it, which is what an interrupted question is.
    const stopped = yield* mountedReading(repl);
    const intents = stopped.chat.filter(
      (record) => record.kind === "control" && record.component === "Elicit",
    );
    expect(intents).toHaveLength(1);
    expect(
      stopped.chat.filter(
        (record) =>
          record.kind === "control-outcome" &&
          intents.some((one) => one.kind === "control" && one.order === record.order),
      ),
    ).toHaveLength(0);
    expect(repl.fake.prompts).toHaveLength(1);

    // The entry's question is still there, and still answerable.
    yield* click(repl.terminal, "[answer]");
    yield* awaiting(repl.terminal, "the entry's own form", (one) =>
      shows(one, "The entry is asking."),
    );
    yield* typing(repl.terminal, "right");
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry rendering what it was told", (one) =>
      shows(one, "Entry said right."),
    );

    // And a later message asks a new question, with the same field names and an
    // empty form: the values typed into the stopped one are not an answer to it.
    repl.fake.script({ reply: asks(SIDEKICK_ASKS, "Asking again.") });
    yield* sendMessage(repl, "ask again");
    yield* awaiting(repl.terminal, "the next question announcing itself", (one) =>
      shows(one, `${MOUNTED_AGENT} has a question.`),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the new form", (one) => shows(one, "Asking again."));
    // Empty: no option is marked at all, which is what an untouched form of
    // this shape looks like. Read from the markers rather than from the field
    // row, whose label collides with the line naming what the field accepts.
    expect(shows(repl.terminal, "(x)")).toBe(false);
    expect(shows(repl.terminal, "( ) yes")).toBe(true);
  });
});

/**
 * Tier MQ — leaving while two questions are waiting, and coming back.
 *
 * Neither question is answered by the command ending, and neither is answered
 * by reopening: a pending request lives exactly as long as the suspended
 * operation holding it, so a process that stops takes its questions with it and
 * leaves a readable account of what it was in the middle of.
 */
describe("Tier MQ — leaving with questions pending, and the cold reopen after", () => {
  const ASKS = {
    type: "object",
    properties: { choice: { type: "string", enum: ["yes", "no"] } },
    required: ["choice"],
    additionalProperties: false,
  } as const;

  const ENTRY_WAITS = [
    "```js eval",
    'const shape = {"type":"object","properties":{"ok":{"type":"string","enum":["yes"]}},' +
      '"required":["ok"],"additionalProperties":false};',
    "```",
    "",
    '<Elicit schema={shape} as="said">The entry is waiting.</Elicit>',
    "",
  ].join("\n");

  /** One command left with a half-filled Sidekick form and an entry question. */
  function* leavingWithQuestions(leave: (terminal: Terminal) => Operation<void>): Operation<void> {
    const host = yield* useMountedHost();
    host.fake.script({
      reply: `<Elicit schema={${JSON.stringify(ASKS)}} as="answer">Shall I?</Elicit>\n`,
    });
    const repl = yield* useMountedRepl({ host });

    // The entry's question, pending and unanswered throughout.
    yield* focusDraft(repl.terminal);
    repl.terminal.bytes(new TextEncoder().encode(ENTRY_WAITS));
    yield* settled(60);
    repl.terminal.feed("\r");
    yield* awaiting(repl.terminal, "the entry's question announcing itself", (one) =>
      shows(one, "[answer]"),
    );

    // And the Sidekick's, opened and half filled in.
    yield* sendMessage(repl, "shall you?");
    yield* awaiting(repl.terminal, "the Sidekick's question announcing itself", (one) =>
      shows(one, `${MOUNTED_AGENT} has a question.`),
    );
    yield* click(repl.terminal, "[answer sidekick]");
    yield* awaiting(repl.terminal, "the form opening", (one) => shows(one, "Shall I?"));
    yield* typing(repl.terminal, "ye");

    const restored = repl.terminal.resets;
    yield* leave(repl.terminal);
    yield* awaited("the command returning", () => repl.outcome() !== undefined);

    // Once, and with everything released.
    expect(repl.outcome()?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(restored + 1);
    expect(repl.terminal.readers).toBe(0);
    expect(repl.terminal.listeners).toBe(0);

    // Neither question was answered. The Sidekick's intent stands with nothing
    // beside it, which is what an interrupted operation is, and no turn
    // followed it.
    const execution = yield* mountedExecution(repl);
    const left = yield* readSidekickRecords(
      join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
    );
    const intents = left.filter(
      (record) => record.kind === "control" && record.component === "Elicit",
    );
    expect(intents).toHaveLength(1);
    expect(
      left.filter(
        (record) =>
          record.kind === "control-outcome" &&
          intents.some((one) => one.kind === "control" && one.order === record.order),
      ),
    ).toHaveLength(0);
    expect(repl.fake.prompts).toHaveLength(1);

    // Reopened cold. The interrupted operation is readable and nothing of this
    // process's form is: a partial answer was never durable, and reopening asks
    // no provider for anything.
    const before = {
      ensured: host.fake.ensured.length,
      prompts: host.fake.prompts.length,
    };
    const again = yield* useMountedRepl({
      host,
      location: `xmd://repl/${execution}/entries`,
    });
    expect(shows(again.terminal, `${MOUNTED_AGENT} has a question.`)).toBe(false);
    expect(shows(again.terminal, "[answer sidekick]")).toBe(false);
    expect(shows(again.terminal, "Shall I?")).toBe(false);
    expect(shows(again.terminal, "[close]")).toBe(false);
    // And the chat it does project holds what the stopped process wrote.
    expect(shows(again.terminal, "you: shall you?")).toBe(true);
    expect(host.fake.ensured).toHaveLength(before.ensured);
    expect(host.fake.prompts).toHaveLength(before.prompts);
  }

  it("MQ5: Exit answers neither question and restores the terminal once", function* () {
    yield* leavingWithQuestions(function* (terminal: Terminal): Operation<void> {
      yield* click(terminal, "[exit]");
    });
  });

  it("MQ5: Control-C does the same, without another key", function* () {
    yield* leavingWithQuestions(function* (terminal: Terminal): Operation<void> {
      terminal.feed("\x03");
      yield* settled(30);
    });
  });
});

/**
 * Tier CFG — leaving while a preference is being written (#883, CFG9).
 *
 * A save is a record in this history, and the command that owns the writer is
 * the thing that lets go of it. So the one ordering that matters here is: a
 * record already on its way to the file is seen through to the file *and* to
 * this writer's memory of it before the command returns, and a save that has
 * written nothing publishes nothing.
 */
describe("Tier CFG — a preference being written when the command leaves", () => {
  const ADVERTISED = {
    model: {
      selected: "balanced",
      choices: [
        { id: "balanced", name: "Balanced" },
        { id: "fast", name: "Fast" },
      ],
    },
    effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
  } as const;

  /** Open Configure from the pane's own header. */
  function* configure(repl: MountedRepl): Operation<void> {
    yield* click(repl.terminal, `[configure ${MOUNTED_AGENT}]`);
    yield* settled(60);
    expect(shows(repl.terminal, "[refresh]")).toBe(true);
  }

  /** Where this execution's chat history is. */
  function savedAt(repl: MountedRepl, execution: string): string {
    return join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE);
  }

  it("CFG9: Exit waits for a preference already reaching the file", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Hello back.</Output>\n" });

    // A conversation to save a preference for.
    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Hello back."));

    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Fast"));
    yield* click(repl.terminal, "( ) Fast", 96);
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));

    // The record this save writes, held open inside the host: the bytes are on
    // their way and this writer's memory of them is not there yet, which is the
    // one window the ordering is about.
    const saving = gate.holdNext((_path, record) => record.includes('"kind":"preferences"'));
    yield* click(repl.terminal, "[apply]", 96);
    yield* saving.started();

    // Leave while it is in flight.
    yield* click(repl.terminal, "[exit]");
    yield* settled(60);

    // The command has not returned: it is waiting for the record it admitted.
    expect(repl.outcome()).toBe(undefined);
    expect(repl.terminal.resets).toBe(0);

    saving.release();
    yield* awaited("the command returning", () => repl.outcome() !== undefined);

    // Once, and with everything released.
    expect(repl.outcome()?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(1);
    expect(repl.terminal.readers).toBe(0);
    expect(repl.terminal.listeners).toBe(0);

    // And the record is on disk: a save that had been let go of halfway would
    // have left the file holding something nothing acknowledged, or nothing at
    // all after the drawer said it had saved.
    const execution = yield* mountedExecution(repl);
    const written = yield* readSidekickRecords(
      join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
    );
    const saved = written.filter((record) => record.kind === "preferences");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ model: "fast" });
  });

  it("CFG9: a save still waiting for the writer is cancelled, and appends nothing", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Hello back.</Output>\n" });
    repl.fake.script({ reply: "<Output>And again.</Output>\n" });

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Hello back."));
    // One read of this conversation's choices, so the drawer has them later
    // while the Sidekick is busy.
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Fast"));
    yield* click(repl.terminal, "[close]", 96);
    yield* awaiting(repl.terminal, "the pane again", (one) => shows(one, "[send]"));

    // Somebody else's record held inside the host, so the writer is occupied
    // by an append that is not this save's.
    const writing = gate.holdNext((_path, record) => record.includes('"kind":"response"'));
    yield* sendMessage(repl, "again");
    yield* writing.started();

    // And now the save, which is admitted and then *waits*: it is behind that
    // append in the one order this history has.
    yield* configure(repl);
    yield* click(repl.terminal, "( ) Fast", 96);
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));
    yield* click(repl.terminal, "[apply]", 96);
    yield* settled(60);
    const before = yield* readSidekickRecords(savedAt(repl, yield* mountedExecution(repl)));
    expect(before.filter((record) => record.kind === "preferences")).toEqual([]);

    // Control-C while it is still waiting. A waiter is not a write: it has
    // nothing in flight to join, so leaving cancels it.
    repl.terminal.feed("\x03");
    writing.release();
    yield* awaited("the command returning", () => repl.outcome() !== undefined);
    expect(repl.outcome()?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(1);

    // Nothing of it reached the file, then or later: a cancelled waiter writes
    // no record, and no record arrives after the command has gone.
    yield* settled(40);
    const written = yield* readSidekickRecords(savedAt(repl, yield* mountedExecution(repl)));
    expect(written.filter((record) => record.kind === "preferences")).toEqual([]);
  });

  it("CFG9: an inspection in flight is cancelled, and its result reaches nothing", function* () {
    const repl = yield* useMountedRepl();
    repl.fake.configuration(ADVERTISED);

    // One explicit inspection, admitted and held inside the provider.
    const reading = repl.fake.holdStatus();
    yield* configure(repl);
    yield* reading.reached;
    yield* awaiting(repl.terminal, "the read in flight", (one) =>
      shows(one, "Reading what this agent"),
    );
    const asked = repl.fake.configCalls.length;

    // Control-C while it is in flight.
    repl.terminal.feed("\x03");
    yield* awaited("the command returning", () => repl.outcome() !== undefined);
    expect(repl.outcome()?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(1);
    expect(repl.terminal.readers).toBe(0);
    expect(repl.terminal.listeners).toBe(0);

    // Released afterwards: the answer arrives to nobody. Nothing further is
    // asked of the agent, nothing is written, and the terminal is not touched
    // again — a late result that reached the screen would redraw it after the
    // command had restored it.
    const drawn = repl.terminal.presented.length;
    reading.release();
    yield* settled(60);
    expect(repl.fake.configCalls).toHaveLength(asked);
    expect(repl.terminal.presented.length).toBe(drawn);
    expect(repl.terminal.resets).toBe(1);
    const execution = yield* mountedExecution(repl);
    const written = yield* readSidekickRecords(savedAt(repl, execution));
    expect(written.filter((record) => record.kind === "preferences")).toEqual([]);
  });

  it("CFG9: control — Control-C with no save in flight leaves nothing behind", function* () {
    const gate = appendGate();
    const repl = yield* useMountedRepl({ gate });
    repl.fake.configuration(ADVERTISED);
    repl.fake.script({ reply: "<Output>Hello back.</Output>\n" });

    yield* sendMessage(repl, "hello");
    yield* awaiting(repl.terminal, "the reply", (one) => shows(one, "Hello back."));

    // Chosen and *not* applied, so nothing was ever admitted to write.
    yield* configure(repl);
    yield* awaiting(repl.terminal, "the advertised models", (one) => shows(one, "Fast"));
    yield* click(repl.terminal, "( ) Fast", 96);
    yield* awaiting(repl.terminal, "the model being chosen", (one) => shows(one, "(x) Fast"));

    repl.terminal.feed("\x03");
    yield* awaited("the command returning", () => repl.outcome() !== undefined);

    expect(repl.outcome()?.ok).toBe(true);
    expect(repl.terminal.resets).toBe(1);
    expect(repl.terminal.readers).toBe(0);

    // A selection nobody applied is not a preference: the history holds none.
    const execution = yield* mountedExecution(repl);
    const written = yield* readSidekickRecords(
      join(repl.root, PAIRED_DIRECTORY, execution, SIDEKICK_FILE),
    );
    expect(written.filter((record) => record.kind === "preferences")).toEqual([]);
  });
});
