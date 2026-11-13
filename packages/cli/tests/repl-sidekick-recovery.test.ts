import { PLACEMENT } from "../src/repl/entry-placement.ts";
import { useSidekickOwner } from "../src/repl/sidekick/owner.ts";
import { rootReads } from "../src/repl/sidekick/requests.ts";
import { attachChildUi } from "../src/headless/ui.ts";
import { useHeadlessFixture, promptChild } from "./support/headless-repl.ts";
/**
 * Tier R2 — what a reopened Sidekick knows, and what it refuses to assert (#883, J8).
 *
 * Two kinds of row live here, and they are about the same question from
 * different distances.
 *
 * **The projector.** Cold reconstruction is a pure function, so these rows hand
 * it records and read what it says. What they are checking is not that it can
 * parse — the storage tier does that — but that it never reports something this
 * CLI made about itself as though a provider had confirmed it. A `response`
 * record and a `feedback` marker are both this CLI's own writing; what makes
 * either of them true is a canonical completed turn in the same conversation,
 * read through Core's own Prompt reader.
 *
 * **The boundary.** The recovery cases run the real storage path over a real
 * directory, interrupt it at one exact point, and then read what survived from
 * a scope that shares nothing with the one that wrote it — no host, no stream,
 * no repository, no task. Only the files cross.
 *
 * R2 has six interruption boundaries and this file grew one at a time, because
 * the boundaries are where production code is: case 1 is publication and the
 * writer handoff, cases 3 and 4 are the root's own Submit reservation and
 * admission, and cases 2, 5 and 6 are the conversation owner's. A case cannot
 * be proved by appending its records by hand — that would omit the path it
 * exists to prove — so each arrived with the section that built it, and all six
 * are here now.
 */

import { cwd, agentSessionKeyDigest } from "@executablemd/runtime";
import { ReplHost } from "../src/repl/host.ts";
import { inspectRecoveryOwnership } from "../src/repl/sidekick/recovery-owner.ts";
import { pairedLocation } from "../src/repl/sidekick/history.ts";
import { useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensure, Err, Ok, race, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import type { AgentSessionOwnershipAdministration } from "@executablemd/runtime";
import { createSidekickAdmission, useSidekickDispatch } from "../src/repl/sidekick/dispatch.ts";
import type { SidekickDispatch, SidekickExchange } from "../src/repl/sidekick/dispatch.ts";
import type { SidekickOwner } from "../src/repl/sidekick/owner.ts";
import type { PairedChatStorage } from "../src/repl/sidekick/repository.ts";
import type { Harness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import type { ScriptedTurn } from "./support/fake-acp.ts";
import { useTempFileCompiler, Elicitation } from "@executablemd/core";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import { AGENT_PROMPT, parsePromptRecord } from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";

import {
  bindRetainedPrefix,
  ENTRIES_FILE,
  PAIRED_DIRECTORY,
  parseEntryRecords,
  parseSidekickRecord,
  readSidekickRecords,
  SIDEKICK_FILE,
  serializeSidekickRecord,
} from "../src/repl/sidekick/history.ts";
import type { ControlRecord, SidekickRecord } from "../src/repl/sidekick/history.ts";
import { designatedResults } from "../src/repl/sidekick/feedback.ts";
import { projectHistory, projectSidekick, recoveryRequired } from "../src/repl/sidekick/model.ts";
import { sidekickChatRows } from "../src/repl/program.ts";
import type { ReplSidekickChatRow } from "../src/repl/application.ts";
import type { SidekickReading } from "../src/repl/sidekick/model.ts";
import { pairedReplRepository } from "../src/repl/sidekick/repository.ts";
import {
  admitting,
  coldReservations,
  controlJournal,
  retainResolution,
  submitForSidekick,
} from "../src/repl/sidekick/admission.ts";
import { ROOT_IMPORT } from "../src/repl/entries.ts";
import { openReplSession } from "../src/repl/session.ts";
import {
  createRepositoryRoot,
  openGate,
  runPhase,
  useRepositoryRoot,
} from "./fixtures/repl/issue-883/host.ts";
import type { RepositoryRoot } from "./fixtures/repl/issue-883/host.ts";
import {
  awaited,
  mountedExecution,
  operationGate,
  useMountedHost,
  awaitedFact,
  recordingTerminal,
} from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import { useReplPage } from "./support/repl-page.ts";
import { draftText, entrySettles, sendMessage } from "./support/screen-journeys.ts";
import { encodeLocation } from "../src/repl/route.ts";
import { initialState } from "../src/repl/application.ts";
import { projectRepl } from "../src/repl/model.ts";
import type { ReplEntry } from "../src/repl/model.ts";

const CHAT = "chat-1";
const AGENT = "scribe";

/** The publication every projector row starts from. */
const PUBLISHED: SidekickRecord[] = [
  { kind: "owner", version: 1, execution: "exec" },
  { kind: "ready" },
];

/** A published, activated conversation, with no turns yet. */
function opened(): SidekickRecord[] {
  return [
    { kind: "owner", version: 1, execution: "exec" },
    { kind: "ready" },
    { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "prepared" },
    { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "activated" },
  ];
}

/**
 * One canonical turn, as `useAgentConversation` retains one.
 *
 * Built to the shape Core writes rather than to a shape convenient here: the
 * durable name is what says which turn it is, and the retained Prompt record is
 * what says it completed. A fixture that invented either would be proving that
 * the projector agrees with this file.
 */
function turn(
  order: number,
  text: string,
  options: {
    input?: string;
    status?: string;
    /** The provider conversation this record names, which may be none. */
    sessionKey?: string;
    stopReason?: string;
    error?: { message: string };
  } = {},
): SidekickRecord {
  const event: DurableEvent = {
    type: "yield",
    coroutineId: "root",
    description: {
      type: "agent_prompt",
      name: `turn:${order}`,
      // What this turn was actually sent. A fixture that wrote something else
      // here while a feedback record claimed delivery into it would be the very
      // mismatch the projector exists to refuse — which is how the first
      // version of this row passed while proving nothing.
      input: options.input ?? "ask",
    },
    result: {
      status: "ok",
      value: {
        sequence: 0,
        agent: AGENT,
        // Exactly what this record names, empty included: a record naming no
        // conversation is the one a turn can have, and a fixture that always
        // supplied one could not produce it.
        sessionKey: options.sessionKey ?? "stub:default",
        status: options.status ?? "completed",
        text,
        ...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
        ...(options.error === undefined ? {} : { error: options.error }),
      },
    },
  } as unknown as DurableEvent;
  return {
    kind: "event",
    conversation: CHAT,
    sequence: order - 1,
    event: serializeDurableEvent(event),
  };
}

function reply(order: number, text: string): SidekickRecord {
  return {
    kind: "response",
    conversation: CHAT,
    turn: order,
    response: `r${order}`,
    outcome: { status: "ok" },
    hasOutput: true,
    output: text,
  };
}

function project(records: readonly SidekickRecord[]): SidekickReading {
  const projected = projectSidekick(records);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function refusalOf(records: readonly SidekickRecord[]): string {
  const projected = projectSidekick(records);
  if (projected.ok) {
    throw new Error("this history was projected rather than refused");
  }
  return projected.error.message;
}

describe("Tier R2 — a reading claims nothing a canonical turn does not establish", () => {
  it("R2a: a published pair with no conversation reads as an empty chat", function* () {
    const reading = project(PUBLISHED);

    expect(reading.conversations).toEqual([]);
    expect(reading.chat).toEqual([]);
    expect(reading.active).toBe(undefined);
    expect(reading.delivered).toEqual([]);
    expect(reading.unestablished).toEqual([]);
  });

  it("R2b: a reply whose owning turn never completed refuses", function* () {
    // Schema-valid, after a valid publication and an activated conversation.
    // What it has no business asserting is that the provider replied.
    expect(refusalOf([...opened(), reply(1, "Hello")])).toContain("never completed");

    // A turn whose own outcome the journal does not hold establishes nothing
    // either, which is the same rule one step earlier.
    expect(
      refusalOf([...opened(), turn(1, "", { status: "failed" }), reply(1, "Hello")]),
    ).toContain("never completed");
  });

  it("R2c: a feedback marker alone does not establish that a turn carried it", function* () {
    const reading = project([
      ...opened(),
      { kind: "feedback", conversation: CHAT, response: "r1", turn: 1, text: "results" },
    ]);

    // The marker is this CLI saying it sent something. Nothing canonical says
    // the turn happened, so it is reported as what it is — a delivery to
    // reconcile, never a delivery to count on.
    expect(reading.delivered).toEqual([]);
    expect(reading.unestablished).toEqual([{ conversation: CHAT, turn: 1 }]);
  });

  it("R2d: a canonical completed turn establishes both its reply and its delivery", function* () {
    // The control the two rows above would otherwise suppress: with the turn
    // actually retained, the reply is published and the delivery counted.
    const reading = project([
      ...opened(),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "greet them",
      },
      turn(1, "Hello", { input: "greet them" }),
      reply(1, "Hello"),
      // The feedback text, retained before the turn that carries it — which is
      // also what begins the records for that second request. Without it both
      // canonical turns would sit among one message's records, which is a
      // history this writer does not produce and a reader refuses.
      { kind: "feedback", conversation: CHAT, response: "r1", turn: null, text: "results" },
      // A second turn, carrying exactly the feedback this acknowledgement says
      // was delivered into it. That equality is what establishes the delivery.
      turn(2, "", { input: "results" }),
      { kind: "feedback", conversation: CHAT, response: "r1", turn: 2, text: "results" },
    ]);

    expect(reading.conversations[0]).toMatchObject({
      id: CHAT,
      agent: AGENT,
      phase: "activated",
      completed: [1, 2],
    });
    expect(reading.active).toBe(CHAT);
    expect(reading.chat).toEqual([
      // Its own ID, and the canonical turn its request became. They agree here
      // — and that they agree is a coincidence of this history rather than the
      // thing that associated them: the association comes from the canonical
      // turn sitting among that message's own records.
      {
        kind: "person",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        message: 1,
        turn: 1,
        text: "greet them",
      },
      {
        kind: "reply",
        conversation: CHAT,
        turn: 1,
        response: "r1",
        text: "Hello",
        hasOutput: true,
        failure: undefined,
      },
      // The second turn, which completed and whose evaluated reply nobody
      // recorded. Since #883 PR 2 that is a readable fact rather than a gap: a
      // saved Prompt says the provider finished its turn and nothing about the
      // program it returned, and this is the turn saying exactly that. It
      // carried a response's results rather than anything a person said.
      {
        kind: "saved",
        conversation: CHAT,
        turn: 2,
        automatic: true,
        status: "Turn saved; no evaluated reply recorded.",
      },
    ]);
    expect(reading.delivered).toEqual([{ conversation: CHAT, turn: 2 }]);
    expect(reading.unestablished).toEqual([]);
  });

  it("R2d2: a completed turn that carried something else establishes nothing", function* () {
    // The turn happened and completed. It was sent an unrelated prompt, so it
    // is not the turn that carried this feedback — and an ordinal alone would
    // have counted it.
    const reading = project([
      ...opened(),
      turn(1, "Hello", { input: "greet them" }),
      reply(1, "Hello"),
      turn(2, "", { input: "an unrelated prompt" }),
      { kind: "feedback", conversation: CHAT, response: "r1", turn: 2, text: "results" },
    ]);

    expect(reading.delivered).toEqual([]);
    expect(reading.unestablished).toEqual([{ conversation: CHAT, turn: 2 }]);
  });

  it("R2e: an operation that began and never answered is reported, not resumed", function* () {
    const reading = project([
      ...opened(),
      turn(1, "Hello", { input: "greet them" }),
      reply(1, "Hello"),
      {
        kind: "control",
        conversation: CHAT,
        response: "r1",
        order: 0,
        component: "REPL.Bindings",
        arguments: {},
      },
      {
        kind: "control-outcome",
        conversation: CHAT,
        response: "r1",
        order: 0,
        outcome: { status: "ok" },
      },
      {
        kind: "control",
        conversation: CHAT,
        response: "r1",
        order: 1,
        component: "Elicit",
        arguments: { schema: "table-format" },
      },
    ]);

    expect(reading.operations).toEqual([
      {
        conversation: CHAT,
        response: "r1",
        order: 0,
        component: "REPL.Bindings",
        status: "ok",
        failure: undefined,
      },
    ]);
    // The question is shown as waiting. Asking it again would be asking a
    // second question, and inventing its answer would be worse.
    expect(reading.unfinished).toEqual([
      {
        conversation: CHAT,
        response: "r1",
        order: 1,
        component: "Elicit",
        status: "unfinished",
        failure: undefined,
      },
    ]);
  });

  it("R2f: a history describing work it never opened refuses", function* () {
    expect(
      refusalOf([
        { kind: "owner", version: 1, execution: "exec" },
        { kind: "ready" },
        {
          kind: "message",
          id: "message-1",
          origin: { kind: "ui" },
          conversation: "never-opened",
          turn: 1,
          revision: 1,
          text: "hi",
        },
      ]),
    ).toContain("never opened");

    expect(
      refusalOf([
        ...opened(),
        {
          kind: "control-outcome",
          conversation: CHAT,
          response: "r1",
          order: 0,
          outcome: { status: "ok" },
        },
      ]),
    ).toContain("without recording the operation");
  });
});

describe("Tier R2 — case 1: publication across real process boundaries", () => {
  /**
   * Both phases of each row are separate processes.
   *
   * That is the point of case 1 rather than an implementation detail: what R2
   * asks is what survives a process *ending*, and a second scope in this
   * process shares module state, caches and open handles with the first. The
   * writer reaches the production publication boundary and exits; the reader
   * independently loads the production host and repository and reports what it
   * found. Only the files under the data root cross, and the synchronization is
   * the child exiting — there is no sleep in any of it.
   */
  it("R2g: interrupted before ready, a later process still finds the original", function* () {
    const root = yield* createRepositoryRoot();

    const seeded = yield* runPhase("seed", root, "legacy");
    expect(seeded.seeded).toBe(true);
    const before = yield* runPhase("bytes", root, "legacy");

    // One process publishes and dies on `ready`, the last of the four writes,
    // so everything before it has happened. The interruption comes from inside
    // the production code; this row does not write the half-published state.
    const interrupted = yield* runPhase("interrupt", root, "legacy");
    expect(interrupted.published).toBe(false);
    expect(String(interrupted.refused)).toContain("stopped before it could finish publishing");

    // A different process entirely.
    const reopened = yield* runPhase("read", root, "legacy");

    expect(reopened.opened).toBe(false);
    expect(String(reopened.refused)).toContain("never acknowledged as ready");
    // Opening refused, so it wrote nothing — and the original is byte-for-byte
    // what it was before any of this.
    expect(reopened.appended).toBe(0);
    const after = yield* runPhase("bytes", root, "legacy");
    expect(after.legacy).toBe(before.legacy);

    yield* root.discard();
  });

  it("R2h: published and handed off, a later process establishes the origin", function* () {
    const root = yield* createRepositoryRoot();

    yield* runPhase("seed", root, "legacy");
    const before = yield* runPhase("bytes", root, "legacy");

    // Published, and then the entry that was running carries on through the
    // same facade past the copy — which is what the writer handoff is for.
    const published = yield* runPhase("publish", root, "legacy");
    expect(published.published).toBe(true);

    const reopened = yield* runPhase("read", root, "legacy");

    expect(reopened.opened).toBe(true);
    expect(reopened.form).toBe("paired");
    // The pair establishes the origin it was published from: one record, and
    // the digest of the bytes that file still holds.
    expect(reopened.origin).toMatchObject({ records: 1 });
    const after = yield* runPhase("bytes", root, "legacy");
    expect(after.legacy).toBe(before.legacy);
    // The copied prefix is still exactly the origin's bytes, with the later
    // append after it.
    expect(String(after.entries).startsWith(String(before.legacy))).toBe(true);
    expect(reopened.entries).toBe(2);
    // Reopening ran no conversation and appended nothing: the chat history
    // holds its publication and nothing else.
    expect(reopened.records).toEqual(["owner", "ready"]);
    expect(reopened.appended).toBe(0);

    yield* root.discard();
  });
});

/**
 * A reservation a dead process left, across real process boundaries (#883 R2
 * cases 3 and 4).
 *
 * A reply's Submit is written down before the slot it took is acted on, which
 * means a process can stop in two different places and leave two readable
 * states that look identical from the chat history alone: one that admitted
 * nothing, and one that admitted exactly one entry. Both phases of each row are
 * separate processes, because what R2 asks is what survives a process *ending*
 * — and the stop is a write that never completes inside the production path,
 * not a file this test wrote.
 */
describe("Tier R2 — cases 3 and 4: a reservation across real process boundaries", () => {
  it("R2i: an intent with no entry reconciles as absent, and submits nothing", function* () {
    const root = yield* createRepositoryRoot();

    const seeded = yield* runPhase("seed-chat", root, "chat");
    expect(seeded.seeded).toBe(true);
    expect(seeded.records).toEqual([
      "owner",
      "ready",
      "conversation",
      "conversation",
      "event",
      "response",
    ]);

    // One process acknowledges the intent and stops before the record that
    // would admit the entry it reserved. The intent is the only trace.
    const stopped = yield* runPhase("reserve", root, "chat");
    expect(stopped.stopped).toBe("reserve");
    expect(stopped.records).toEqual([
      "owner",
      "ready",
      "conversation",
      "conversation",
      "event",
      "response",
      "control",
    ]);

    // A different process entirely.
    const reopened = yield* runPhase("reconcile", root, "chat");

    expect(reopened.opened).toBe(true);
    expect(reopened.reconciled).toBe(true);
    // Nothing took the slot, which is what `absent` means: the reservation
    // named entry-1 and the entry history has no entries at all.
    expect(reopened.finding).toBe("absent");
    expect(reopened.reserved).toBe("entry-1");
    expect(reopened.entries).toEqual([]);
    // Reading it appended nothing. The finding is a reading of two files, not a
    // write either of them needed.
    expect(reopened.appendedByOpening).toBe(0);
    // The explicit action that followed retained the finding — and admitted
    // nothing. The source the dead process reserved is still unadmitted, which
    // is the whole of "never automatically submits its old source".
    expect(reopened.retained).toEqual([
      "owner",
      "ready",
      "conversation",
      "conversation",
      "event",
      "response",
      "control",
      "control-outcome",
    ]);
    expect(reopened.entriesAfter).toEqual([]);
    // And it is answered: a later reading finds nothing left to reconcile
    // rather than rediscovering the same unanswered Submit forever. This is a
    // second projection inside the reconcile process, not a further boundary.
    expect(reopened.again).toBe("resolved");

    yield* root.discard();
  });

  it("R2j: an entry admitted before its receipt reconciles to that exact entry", function* () {
    const root = yield* createRepositoryRoot();

    yield* runPhase("seed-chat", root, "chat");

    // This process gets further: the entry it reserved is admitted and runs,
    // and it stops before writing the receipt saying how that went.
    const stopped = yield* runPhase("admit", root, "chat");
    expect(stopped.stopped).toBe("admit");
    expect(stopped.records).toEqual([
      "owner",
      "ready",
      "conversation",
      "conversation",
      "event",
      "response",
      "control",
    ]);

    const reopened = yield* runPhase("reconcile", root, "chat");

    expect(reopened.opened).toBe(true);
    expect(reopened.reconciled).toBe(true);
    // Found once, and found by all three of prefix, identity and bytes: the
    // entry after none others is `entry-1`, and what it ran is what was
    // reserved. Any one of the three alone would have matched something else.
    expect(reopened.finding).toBe("admitted");
    expect(reopened.reserved).toBe("entry-1");
    expect(reopened.entries).toEqual(["entry-1"]);
    expect(reopened.sources).toEqual([reopened.source]);
    expect(reopened.appendedByOpening).toBe(0);
    // Its work is already in the entry history, so the resolution records what
    // happened and runs nothing again: still one entry afterwards.
    expect(reopened.retained).toEqual([
      "owner",
      "ready",
      "conversation",
      "conversation",
      "event",
      "response",
      "control",
      "control-outcome",
    ]);
    expect(reopened.entriesAfter).toEqual(["entry-1"]);
    expect(reopened.again).toBe("resolved");

    yield* root.discard();
  });

  /**
   * The entry journal of one execution, and where it lives.
   *
   * Reached by path because what this case swaps is a whole file that another
   * execution really produced. Nothing is edited: the bytes written over the
   * first execution's journal are bytes the session wrote for the second.
   */
  function journalOf(root: RepositoryRoot, execution: string): string {
    return join(root.repository, PAIRED_DIRECTORY, execution, ENTRIES_FILE);
  }

  /**
   * Two executions, each with one real prior entry of the same length.
   *
   * Both are run through the production session, so both journals are histories
   * this CLI actually produced — which is what makes the swap below a *valid
   * different history* rather than a malformed fixture. The sources are the same
   * length so the two journals hold the same number of records.
   */
  function* twoPriors(
    root: RepositoryRoot,
  ): Operation<{ held: Record<string, unknown>; other: Record<string, unknown> }> {
    yield* runPhase("seed-chat", root, "chat");
    yield* runPhase("seed-chat", root, "other");
    const held = yield* runPhase("prior", root, "chat", "Prior A.\n");
    const other = yield* runPhase("prior", root, "other", "Prior B.\n");
    expect(held.ran).toBe(true);
    expect(other.ran).toBe(true);
    expect(held.entries).toEqual(["entry-1"]);
    expect(other.entries).toEqual(["entry-1"]);
    return { held, other };
  }

  it("R2k: a reservation whose earlier history changed refuses, at the same length", function* () {
    const root = yield* createRepositoryRoot();
    const { held, other } = yield* twoPriors(root);

    // The reservation, taken against the journal `Prior A.` left behind, and
    // interrupted before the entry it reserved existed.
    const stopped = yield* runPhase("reserve", root, "chat");
    expect(stopped.stopped).toBe("reserve");

    // Now the earlier history is a different valid one. Same record count and
    // same byte count — the sources are the same length — so an ordinal, an
    // entry id and a source all still agree. Only the bytes differ.
    const mine = held.bound as { records: number; bytes: number; sha256: string };
    const theirs = other.bound as { records: number; bytes: number; sha256: string };
    expect(theirs.records).toBe(mine.records);
    expect(theirs.bytes).toBe(mine.bytes);
    expect(theirs.sha256).not.toBe(mine.sha256);
    yield* until(
      writeFile(journalOf(root, "chat"), yield* until(readFile(journalOf(root, "other"), "utf8"))),
    );

    const reopened = yield* runPhase("reconcile", root, "chat");

    // Refused, and refused before a finding: the slot the reservation counted
    // is a slot in a history nobody has, so neither "nothing took it" nor "that
    // entry took it" is a thing this reading may say.
    expect(reopened.opened).toBe(true);
    expect(reopened.reconciled).toBe(false);
    expect(String(reopened.refused)).toContain("no longer begins with the records");
    // And nothing was written on the way to saying so.
    expect(reopened.appended).toBe(0);

    yield* root.discard();
  });

  it("R2k control: the same reservation over its own unchanged history resolves", function* () {
    const root = yield* createRepositoryRoot();
    yield* twoPriors(root);

    const stopped = yield* runPhase("reserve", root, "chat");
    expect(stopped.stopped).toBe("reserve");

    // Everything the row above does, without the swap. The journal is the one
    // the reservation was taken against, so the reading goes through.
    const reopened = yield* runPhase("reconcile", root, "chat");

    expect(reopened.reconciled).toBe(true);
    // One entry preceded the reservation, and the entry it reserved is the one
    // that never arrived.
    expect(reopened.entries).toEqual(["entry-1"]);
    expect(reopened.reserved).toBe("entry-2");
    expect(reopened.finding).toBe("absent");
    expect(reopened.appendedByOpening).toBe(0);
    expect(reopened.entriesAfter).toEqual(["entry-1"]);
    expect(reopened.again).toBe("resolved");

    yield* root.discard();
  });
});

/**
 * A reservation is bound to an acknowledged prefix, not an in-flight one (#883).
 *
 * Owning the next slot stops another submitter taking it. It does not stop an
 * append that has already been issued from landing, and "the file only grows"
 * says nothing about whether what is in it right now is all of it. So a prefix
 * bound while the writer is mid-append describes a history the file is already
 * past — and unlike the states R2i and R2j recover from, the record saying so
 * would outlive the process that wrote it and be believed.
 *
 * In this process rather than across a boundary, because what is being proved
 * is an ordering inside one call. The append is held inside the production host,
 * before the write, so the writer's own count is raised and a wait on it has
 * something to wait for.
 */
/**
 * A conversation a dead process left, across real process boundaries (#883 R2
 * cases 2, 5 and 6).
 *
 * These three boundaries are the conversation owner's, so they arrive with it.
 * Each phase assembles the whole Sidekick the way the command does — host,
 * repository, profile, session, owner — and the only thing standing in for
 * something is the agent, because the facts a case has to control are transport
 * facts: which native conversation the provider says a turn ran in, what it
 * replies, and whether it replies at all.
 *
 * Every row's phases are separate processes. That is the point rather than a
 * detail: a second scope in this process shares module state, caches and open
 * handles with the first, and what R2 asks is what survives a process *ending*.
 * Only the files under the data root cross, and the synchronization is the
 * child exiting.
 */
describe("Tier R2 — cases 2, 5 and 6: a conversation across real process boundaries", () => {
  /** A reply that fills the draft and then waits for an answer nobody gives. */
  const ASKS = [
    "<REPL.EntryInput>Prepared body.</REPL.EntryInput>",
    `<Elicit schema={${JSON.stringify({
      type: "object",
      properties: { pick: { type: "string" } },
      required: ["pick"],
      additionalProperties: false,
    })}} as="answer">Which one?</Elicit>`,
    "<Output>Done.</Output>",
    "",
  ].join("\n");

  /** One reply that reads, so the turn after it carries that read as feedback. */
  const READS = "<REPL.Bindings />\n";

  /** The first words of the orientation, so a row can say a turn carried it. */
  const ORIENTED = "You are Sidekick for this shared REPL.";

  /** The script one conversation phase runs under. */
  function script(held: Record<string, unknown>): string {
    return JSON.stringify(held);
  }

  it("R2m: a turn's own record establishes the conversation it ran in, and a later process continues there", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // One process, one turn, and the provider names the native conversation it
    // ran in. Nothing acknowledges that mapping separately — there is no
    // mapping record, by design: the canonical turn is the acknowledgement.
    const first = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>One.</Output>\n"], identity: "native-one", say: "first" }),
    );
    expect(first.sent).toBe(true);
    expect(first.turns).toEqual([
      expect.objectContaining({ name: "turn:1", status: "completed", conversation: "native-one" }),
    ]);

    // A different process entirely. It reads the identity out of that retained
    // turn, so a conversation whose mapping was never acknowledged separately
    // is still established — and the turn it sends is the next one of the same
    // conversation rather than a first turn somewhere else.
    const next = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Two.</Output>\n"], identity: "native-one", say: "second" }),
    );
    expect(next.sent).toBe(true);
    expect(next.turn).toBe(2);
    expect(next.output).toContain("Two.");
    expect(next.conversations).toEqual([
      expect.objectContaining({ attempted: [1, 2], completed: [1, 2] }),
    ]);
    // One conversation, and the chat a person reads is both processes' work in
    // order.
    expect((next.chat as { text: string }[]).map((item) => item.text)).toEqual([
      "first",
      "One.",
      "second",
      "Two.",
    ]);

    yield* root.discard();
  });

  it("SC2: a reopening continues its native conversation, under its own configuration or a changed one", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // One real completed chat, in its own process, over the persistent ACPX
    // store on disk.
    const created = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>One.</Output>\n"], identity: "native-one", say: "first" }),
    );
    expect(created.sent).toBe(true);
    expect(created.turns).toEqual([
      expect.objectContaining({ name: "turn:1", status: "completed", conversation: "native-one" }),
    ]);
    // The configuration that chat was created under is in its own history.
    expect(created.durables).toContain("agent_conversation_configuration");

    // A cold process that only reads. The same chat, and no provider work.
    const read = yield* runPhase("chat-read", root, "chat");
    expect((read.chat as { text: string }[]).map((item) => item.text)).toEqual(["first", "One."]);
    expect(read.sessions).toBe(0);
    expect(read.prompts).toBe(0);
    expect(read.appended).toBe(0);

    // The compatible arm: another process, same assembly, explicit message. It
    // answers from the same native conversation.
    const continued = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Two.</Output>\n"], identity: "native-one", say: "second" }),
    );
    expect(continued.sent).toBe(true);
    expect(continued.output).toContain("Two.");
    expect(continued.turns).toEqual([
      expect.objectContaining({ name: "turn:1", conversation: "native-one" }),
      expect.objectContaining({ name: "turn:2", conversation: "native-one" }),
    ]);

    // A second cold read, so the arm below starts from the same place this one
    // did: the same chat, and still no provider work.
    const before = yield* runPhase("chat-read", root, "chat");
    expect((before.chat as { text: string }[]).map((item) => item.text)).toEqual([
      "first",
      "One.",
      "second",
      "Two.",
    ]);
    expect(before.sessions).toBe(0);
    expect(before.prompts).toBe(0);
    expect(before.appended).toBe(0);

    // The changed arm. Everything is held fixed — the provider, the resolved
    // command, the conversation, the native identity, the tools, the servers and
    // the permissions — and one value differs: this host states a system prompt
    // where the conversation was created with none. The same native
    // conversation continues through what this host builds under today (#1221).
    const changed = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({
        replies: ["<Output>Three.</Output>\n"],
        identity: "native-one",
        say: "third",
        systemPrompt: "You are a differently configured assistant.",
      }),
    );
    expect(changed.sent).toBe(true);
    expect(changed.failure).toBe(null);
    expect(changed.output).toContain("Three.");
    // Exactly the new message was sent, and nothing earlier was sent again.
    expect(changed.prompts).toBe(1);
    expect(changed.turns).toEqual([
      expect.objectContaining({ name: "turn:1", conversation: "native-one" }),
      expect.objectContaining({ name: "turn:2", conversation: "native-one" }),
      expect.objectContaining({ name: "turn:3", conversation: "native-one" }),
    ]);

    // Nothing was replaced. The chat, its turns, its native identity and the
    // configuration it was first created under all stand, and a later process
    // with the original assembly still continues it.
    const after = yield* runPhase("chat-read", root, "chat");
    expect(after.turns).toEqual([
      expect.objectContaining({ name: "turn:1", conversation: "native-one" }),
      expect.objectContaining({ name: "turn:2", conversation: "native-one" }),
      expect.objectContaining({ name: "turn:3", conversation: "native-one" }),
    ]);
    expect(
      (after.durables as string[]).filter((one) => one === "agent_conversation_configuration"),
    ).toEqual(["agent_conversation_configuration"]);
    const again = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Four.</Output>\n"], identity: "native-one", say: "fourth" }),
    );
    expect(again.sent).toBe(true);
    expect(again.output).toContain("Four.");

    yield* root.discard();
  });

  it("R2m2: a turn accepted before its acknowledgement landed is reconciled to that same conversation", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // The process stops on the canonical Prompt append — the record that *is*
    // this history's acknowledgement of which conversation the turn ran in.
    // Everything before it has happened: the provider took the turn and wrote
    // down the native conversation it created for it.
    const stopped = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({
        replies: ["<Output>One.</Output>\n"],
        identity: "native-one",
        stop: "turn",
        say: "first",
      }),
    );
    // The held record is the one this case means, and not some other write that
    // happened to match: the canonical agent prompt for turn 1, whose own
    // outcome is already settled.
    expect(stopped.held).toEqual({
      kind: "event",
      durable: "agent_prompt",
      name: "turn:1",
      status: "ok",
    });
    // Acceptance, and the provider's own durable account of it. Read out of the
    // canonical session store on disk, so it is an assertion that will outlive
    // this process rather than one this process is holding in memory.
    expect(stopped.accepted).toBe(1);
    expect(stopped.asserted).toEqual(["native-one"]);
    // And the history acknowledges none of it. The person's message is the last
    // thing in it.
    expect(stopped.records).toEqual([
      "owner",
      "ready",
      "conversation",
      "event",
      "event",
      "event",
      "conversation",
      "reference",
      "message",
      // SC6. The configuration this conversation's sessions are built under,
      // committed by the turn's activation — which is before the provider
      // could create anything, and therefore before the acknowledgement this
      // process is holding. It is in the history in exactly this position.
      "event",
    ]);
    // And it is that record rather than some other durable write: the
    // conversation bind, the configuration, and nothing else the history
    // acknowledges.
    expect(stopped.durables).toEqual([
      "import_component",
      "import_component",
      "agent_conversation",
      "agent_conversation_configuration",
    ]);

    const reopened = yield* runPhase("chat-read", root, "chat");
    // A turn the history does not hold is a turn this conversation has not had:
    // no attempt, no reply, and nothing stating otherwise.
    expect(reopened.conversations).toEqual([
      expect.objectContaining({ attempted: [], completed: [] }),
    ]);

    // MC1. The message keeps its own ID and has no turn: its request's records
    // hold none, so the association is unknown rather than absent — the person
    // said this, and whether a turn carried it is a different question.
    expect(reopened.chat).toEqual([{ kind: "person", message: 1, turn: null, text: "first" }]);
    // And reopening asks the provider nothing and writes nothing.
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);

    // Explicit new work, in a third process. It reaches the same native
    // conversation the interrupted turn asserted — reconciled through the
    // provider's own retained account rather than guessed from an ordinal — and
    // it starts no second conversation.
    const next = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Two.</Output>\n"], identity: "native-one", say: "second" }),
    );
    expect(next.sent).toBe(true);
    expect(next.output).toContain("Two.");

    // MC2. Both messages, in the order they were saved, with their own IDs. The
    // second's request holds turn 1, so that is its association; the first's
    // holds none and stays unknown — and it is *not* associated by the later
    // outcome, nor by its ID happening to equal that turn's number.
    expect(next.chat).toEqual([
      { kind: "person", message: 1, turn: null, text: "first" },
      { kind: "person", message: 2, turn: 1, text: "second" },
      { kind: "reply", turn: 1, text: "Two." },
    ]);

    // MC4. The original contract of this row, unchanged: one conversation, no
    // replacement, the same native identity the interrupted turn asserted, and
    // the message nobody acknowledged is not sent again.
    expect(next.conversations).toHaveLength(1);
    expect(next.conversations).toEqual([expect.objectContaining({ id: reopened.active })]);
    const turns = next.turns as { name: string; conversation: string | null; input: string }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.conversation).toBe("native-one");
    expect(turns[0]?.input.endsWith("The person says:\n\nsecond")).toBe(true);
    expect(turns[0]?.input).not.toContain("The person says:\n\nfirst");

    // MC3. That successor carried its orientation, and the reading establishes
    // it through the turn recorded for *that* message's request — turn 1, not
    // the message's own ID of 2.
    expect(turns[0]?.input).toContain(ORIENTED);
    expect(next.conversations).toEqual([
      expect.objectContaining({ oriented: ["bootstrap", "index", "surface"] }),
    ]);

    // And it is not offered again once established, which is the existing
    // orientation control: a third message is sent without it.
    const third = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Three.</Output>\n"], identity: "native-one", say: "third" }),
    );
    if (third.sent !== true) {
      throw new Error(String(third.failure));
    }
    const later = third.turns as { name: string; input: string }[];
    expect(later.map((turn) => turn.name)).toEqual(["turn:1", "turn:2"]);
    expect(later[1]?.input).not.toContain(ORIENTED);
    // Its own ID and its own turn, both one further on and still not equal.
    expect(third.chat).toEqual([
      { kind: "person", message: 1, turn: null, text: "first" },
      { kind: "person", message: 2, turn: 1, text: "second" },
      { kind: "reply", turn: 1, text: "Two." },
      { kind: "person", message: 3, turn: 2, text: "third" },
      { kind: "reply", turn: 2, text: "Three." },
    ]);

    yield* root.discard();
  });

  it("R2n: a provider naming another conversation replaces nothing and runs nothing", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    yield* runPhase("chat-open", root, "chat");
    yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>One.</Output>\n"], identity: "native-one", say: "first" }),
    );
    const elsewhere = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: [READS], identity: "native-two", say: "second" }),
    );
    expect(String(elsewhere.failure)).toContain("different native conversation");
    expect(elsewhere.operations).toEqual([]);
    expect(elsewhere.prompts).toBe(0);
    expect(elsewhere.conversations).toEqual([
      expect.objectContaining({ attempted: [1], completed: [1] }),
    ]);
    expect(elsewhere.turns).toEqual([expect.objectContaining({ name: "turn:1" })]);
    expect(elsewhere.conversations).toHaveLength(1);
  });

  it("R2n control: missing provider storage refuses before a replacement turn", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    yield* runPhase("chat-open", root, "chat");
    yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>One.</Output>\n"], identity: "native-one", say: "first" }),
    );
    const missing = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: [READS], identity: "native-two", forget: true, say: "second" }),
    );
    expect(String(missing.failure)).toContain("provider has no record");
    expect(missing.prompts).toBe(0);
    expect(missing.operations).toEqual([]);
    expect(missing.turns).toEqual([expect.objectContaining({ name: "turn:1" })]);
  });

  it("R2o: a settled effect and an interrupted question both survive, and a continuation authors a fresh response", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // The process ends while the question is pending. Nothing is held in the
    // writer: the response is genuinely waiting for an answer nobody will
    // give, which is what an interrupted ask is.
    const stopped = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: [ASKS], stopAtQuestion: true, say: "prepare something" }),
    );
    expect(stopped.stopped).toBe("question");
    expect(stopped.pending).toBe("Which one?");
    // Its first control settled and its second did not, which is the pair of
    // records this case is about.
    expect(stopped.records).toEqual([
      "owner",
      "ready",
      "conversation",
      "event",
      "event",
      "event",
      "conversation",
      "reference",
      "message",
      // One more mirrored durable event than before: the configuration this
      // conversation's sessions are built under, committed by the turn's
      // activation. R2m2 names it by its durable type.
      "event",
      "event",
      "event",
      "control",
      "control-outcome",
      "control",
    ]);

    // The interrupted response, as its own retained intent names it.
    const sidekick = join(root.repository, PAIRED_DIRECTORY, "chat", SIDEKICK_FILE);
    const interrupted = (yield* readSidekickRecords(sidekick)).find(
      (one) => one.kind === "control",
    )?.response;
    expect(interrupted).toBeDefined();

    const reopened = yield* runPhase("chat-read", root, "chat");
    // The effect that happened is retained as what it was: the fill ran and
    // answered.
    expect(reopened.operations).toEqual([
      { response: interrupted, order: 0, component: "REPL.EntryInput", status: "ok" },
    ]);
    // The question that was waiting is reported as waiting and is never
    // re-asked: asking again is asking a second question.
    expect(reopened.unfinished).toEqual([["Elicit", "unfinished"]]);
    // No suffix is replayed. The response rendered nothing for the person
    // because it never got that far, so the chat holds the message and no
    // reply, and reopening asked the provider nothing at all.
    // The message and no reply, which is the claim — and the turn that did
    // complete is readable as a saved turn nobody recorded a reply for, which
    // is what it is.
    expect((reopened.chat as { kind: string }[]).map((item) => item.kind)).toEqual([
      "person",
      "saved",
    ]);
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);

    // Only an explicit continuation moves, and it authors a *fresh* response
    // rather than resuming the interrupted one: a new turn, a new response, and
    // the old response's question still standing as an operation nobody
    // answered.
    const continued = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Carrying on.</Output>\n"], say: "never mind that" }),
    );
    expect(continued.sent).toBe(true);
    expect(continued.turn).toBe(2);
    expect(continued.output).toContain("Carrying on.");
    expect(continued.unfinished).toEqual([["Elicit", "unfinished"]]);
    expect(continued.operations).toEqual([
      { response: interrupted, order: 0, component: "REPL.EntryInput", status: "ok" },
    ]);
    // The fresh response is a name of its own, attributed to the new turn.
    const fresh = (yield* readSidekickRecords(sidekick)).flatMap((one) =>
      one.kind === "response" ? [{ response: one.response, turn: one.turn }] : [],
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.turn).toBe(2);
    expect(fresh[0]?.response).not.toBe(interrupted);

    // What that turn was actually sent, read off its canonical record. The reply
    // is told what the interrupted response did and what it left waiting — in
    // operation order, in the words each control answers in — beside the
    // person's new message and the draft as it actually stands now.
    const carried = (continued.turns as { input: string }[]).at(-1)?.input ?? "";
    const effect = carried.indexOf("## REPL.EntryInput");
    const question = carried.indexOf("## Elicit");
    expect(effect).toBeGreaterThan(-1);
    expect(question).toBeGreaterThan(effect);
    expect(carried).toContain("Entry input updated.");
    expect(carried).toContain("Which one?");
    expect(carried).toContain("Do not ask it again");
    // The draft is this process's own, not the one the dead process filled: an
    // old fill does not come back and overwrite what is there now.
    expect(carried).toContain("The shared entry draft is empty.");
    expect(carried.endsWith("The person says:\n\nnever mind that")).toBe(true);
    // Nothing internal crosses with it.
    expect(carried).not.toContain(String(interrupted));
    expect(carried).not.toContain("control-outcome");

    yield* root.discard();
  });

  it("R2q: a delivery its turn accepted before the marker landed is reconciled from the turn itself", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // A reply that reads, so the turn after it carries that read back as
    // feedback — and the process stops before the marker that would name the
    // turn which accepted it.
    const stopped = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({
        replies: [READS, "<Output>Noted.</Output>\n"],
        stop: "delivered",
        say: "look at this",
      }),
    );
    expect(stopped.stopped).toBe("delivered");
    expect(stopped.prompts).toBe(2);

    const reopened = yield* runPhase("chat-read", root, "chat");
    // Both turns are canonically complete, so the delivery did happen.
    expect(reopened.conversations).toEqual([
      expect.objectContaining({ attempted: [1, 2], completed: [1, 2] }),
    ]);
    // The marker that would have claimed it is the write this process never
    // finished — the only delivery record here names no turn.
    const claims = reopened.feedback as { turn: number | null; text: string }[];
    expect(claims).toHaveLength(1);
    expect(claims[0]?.turn).toBeNull();

    // And the *production reading* establishes the delivery anyway, from the
    // offer and the canonical turn that owns it. This is the reconciliation
    // itself rather than evidence that one could be made: nothing in this row
    // compares the two texts, and an idle reopen that reconciled nothing would
    // report no delivery at all.
    expect(reopened.delivered).toEqual([{ conversation: reopened.active, turn: 2 }]);
    expect(reopened.unestablished).toEqual([]);

    // And nothing is resent. A reopened process has no exchange to resume — the
    // turn that would follow a response belongs to the cycle that ran it — so
    // it asks the provider nothing and writes nothing.
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);

    yield* root.discard();
  });

  it("R2q unknown: a delivery whose turn left no record is unresolved, and refuses new work", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // The same exchange, stopped one write earlier: on the canonical record of
    // the turn that was carrying the delivery. The offer is on disk and the
    // provider may well have accepted the turn — this history simply cannot
    // say, which is the one state nothing may round off.
    const stopped = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({
        replies: [READS, "<Output>Noted.</Output>\n"],
        stop: "laterTurn",
        say: "look at this",
      }),
    );
    expect(stopped.held).toEqual(
      expect.objectContaining({ durable: "agent_prompt", name: "turn:2" }),
    );
    expect(stopped.accepted).toBe(2);

    const reopened = yield* runPhase("chat-read", root, "chat");
    // Unknown stays unknown. It is not promoted to delivered, and it is not
    // dropped because the cycle that composed it is gone.
    expect(reopened.delivered).toEqual([]);
    expect(reopened.unestablished).toEqual([{ conversation: reopened.active, turn: null }]);
    // The conversation holds one completed turn — the first — so there is no
    // later turn for the offer to belong to.
    expect(reopened.conversations).toEqual([
      expect.objectContaining({ attempted: [1], completed: [1] }),
    ]);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);

    // Explicit work on this conversation is refused rather than continued. The
    // provider may already have taken that turn: sending another would either
    // repeat work the agent has or carry on as though it never happened, and
    // this history cannot tell which.
    const bytes = yield* runPhase("bytes", root, "chat");
    const next = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: ["<Output>Moving on.</Output>\n"], say: "carry on" }),
    );
    expect(next.sent).toBe(false);
    expect(String(next.failure)).toContain("acceptance cannot be established");
    // Refused before anything reached the agent and before anything was
    // written — proved by the provider's own traffic and by the files, not only
    // by the returned refusal.
    expect(next.prompts).toBe(0);
    expect(next.sessions).toEqual([]);
    const after = yield* runPhase("bytes", root, "chat");
    expect(after.sidekick).toBe(bytes.sidekick);
    expect(after.entries).toBe(bytes.entries);
    // And it stays unresolved. Nothing here resolved it by choosing.
    const again = yield* runPhase("chat-read", root, "chat");
    expect(again.unestablished).toEqual([{ conversation: again.active, turn: null }]);
    expect(again.delivered).toEqual([]);

    yield* root.discard();
  });

  it("R2q control: a finished exchange reopened cold claims its delivery, calls no provider and changes no byte", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // The same exchange, finished. The marker lands, so the claim is made and
    // established — which is what makes the row above a missing marker rather
    // than a missing delivery.
    const done = yield* runPhase(
      "chat-say",
      root,
      "chat",
      script({ replies: [READS, "<Output>Noted.</Output>\n"], say: "look at this" }),
    );
    expect(done.sent).toBe(true);
    expect(done.output).toContain("Noted.");
    expect(done.delivered).toEqual([{ conversation: done.active, turn: 2 }]);

    const before = yield* runPhase("bytes", root, "chat");
    const reopened = yield* runPhase("chat-read", root, "chat");
    expect(reopened.delivered).toEqual([{ conversation: done.active, turn: 2 }]);
    // Zero Sidekick provider calls: no session established, no turn started.
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);

    // And both halves of the pair are byte-identical. Reading a conversation
    // back is not an event in it.
    const after = yield* runPhase("bytes", root, "chat");
    expect(after.sidekick).toBe(before.sidekick);
    expect(after.entries).toBe(before.entries);

    yield* root.discard();
  });

  it("R2q fixture: a message that settles before its cut fails the phase rather than waiting", function* () {
    const root = yield* createRepositoryRoot();
    yield* runPhase("chat-open", root, "chat");

    // One reply that reads nothing, so the exchange has one canonical Prompt
    // and the second one this cut holds is never written.
    let observed: unknown;
    try {
      yield* runPhase(
        "chat-say",
        root,
        "chat",
        script({ replies: ["<Output>Done.</Output>\n"], stop: "laterTurn" }),
      );
    } catch (error) {
      observed = error;
    }
    expect(String(observed)).toContain("the message settled before the laterTurn boundary");

    yield* root.discard();
  });
});

/**
 * 1234 — a response is named for itself, not for a message or a turn.
 *
 * A saved message's ordinal and the canonical turn its request became are
 * different numbers once a turn is interrupted before Core retained it: the
 * message keeps its ordinal and Core never counted the turn. Automatic feedback
 * adds turns without adding messages. A response named after either number can
 * therefore share its control slots with another response, and the reader
 * refuses the history that results. These rows run that interruption across
 * real process boundaries and read the identities the retained records carry.
 */
describe("1234: a response's identity belongs to no message or turn number", () => {
  const READS = "<REPL.Bindings />\n";
  const DONE = "<Output>Done.</Output>\n";

  function* recordsAt(root: RepositoryRoot): Operation<SidekickRecord[]> {
    return yield* readSidekickRecords(
      join(root.repository, PAIRED_DIRECTORY, "chat", SIDEKICK_FILE),
    );
  }

  /** Every canonical turn, read through Core's own Prompt reader. */
  function canonicalTurns(
    records: readonly SidekickRecord[],
  ): { name: string; input: unknown; native: string | undefined }[] {
    const turns: { name: string; input: unknown; native: string | undefined }[] = [];
    for (const record of records) {
      if (record.kind !== "event") {
        continue;
      }
      for (const event of parseEntryRecords(record.event)) {
        if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
          continue;
        }
        if (event.result.status !== "ok") {
          continue;
        }
        turns.push({
          name: event.description.name,
          input: (event.description as { input?: unknown }).input,
          native: parsePromptRecord(event.result.value)?.agentSessionId,
        });
      }
    }
    return turns;
  }

  /** The durable name each generated root evaluation was admitted under. */
  function admissions(records: readonly SidekickRecord[]): string[] {
    const names: string[] = [];
    for (const record of records) {
      if (record.kind !== "event") {
        continue;
      }
      for (const event of parseEntryRecords(record.event)) {
        if (event.type === "yield" && event.description.type === "generated_xmd") {
          names.push(event.description.name);
        }
      }
    }
    return names;
  }

  function slots(records: readonly SidekickRecord[], kind: "control" | "control-outcome") {
    return records.flatMap((one) =>
      one.kind === kind ? [{ response: one.response, order: one.order }] : [],
    );
  }

  it("1234: an interrupted message and automatic feedback leave each response its own slots", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    const NATIVE = "native-1234";
    yield* runPhase("chat-open", root, "chat");

    // The first message is saved as message 1, and the process ends on its
    // canonical Prompt: Core never retains a turn for it.
    const stopped = yield* runPhase(
      "chat-say",
      root,
      "chat",
      JSON.stringify({
        replies: ["<Output>Interrupted.</Output>\n"],
        identity: NATIVE,
        stop: "turn",
        say: "interrupted request",
      }),
    );
    expect(stopped.stopped).toBe("turn");

    // A distinct instruction in a new process. It is saved as message 2 and
    // becomes canonical turn 1; each of its three reads earns an automatic
    // feedback turn, and the last reply asks for nothing.
    const continued = yield* runPhase(
      "chat-say",
      root,
      "chat",
      JSON.stringify({
        replies: [READS, READS, READS, DONE],
        identity: NATIVE,
        say: "new instruction",
      }),
    );
    expect(continued.refused).toBeUndefined();
    expect(continued.readable).toBe(true);
    expect(continued.sent).toBe(true);
    expect(continued.output).toContain("Done.");

    const records = yield* recordsAt(root);
    const turns = canonicalTurns(records);
    expect(turns.map((one) => one.name)).toEqual(["turn:1", "turn:2", "turn:3", "turn:4"]);
    // One native conversation throughout.
    expect(turns.map((one) => one.native)).toEqual([NATIVE, NATIVE, NATIVE, NATIVE]);

    // Four responses, each attributed to the canonical turn it ran in, and no
    // two sharing a name.
    const responses = records.flatMap((one) =>
      one.kind === "response" ? [{ response: one.response, turn: one.turn }] : [],
    );
    expect(responses.map((one) => one.turn)).toEqual([1, 2, 3, 4]);
    const names = responses.map((one) => one.response);
    expect(new Set(names).size).toBe(4);

    // The three reads, each at order 0 of the response that performed it, each
    // answered once — three slots rather than two.
    const reads = names.slice(0, 3).map((response) => ({ response, order: 0 }));
    expect(slots(records, "control")).toEqual(reads);
    expect(slots(records, "control-outcome")).toEqual(reads);
    expect(records.flatMap((one) => (one.kind === "control" ? [one.component] : []))).toEqual([
      "REPL.Bindings",
      "REPL.Bindings",
      "REPL.Bindings",
    ]);

    // Each evaluation was admitted under its own response's name.
    expect(admissions(records)).toEqual(names.map((response) => `generated:${response}`));

    // The saved messages keep their own facts: message 1 became no turn, and
    // message 2 became canonical turn 1.
    const people = (continued.chat as { kind: string }[]).filter((one) => one.kind === "person");
    expect(people).toEqual([
      { kind: "person", message: 1, turn: null, text: "interrupted request" },
      { kind: "person", message: 2, turn: 1, text: "new instruction" },
    ]);

    // Each read's results were delivered into the next canonical turn, with
    // exactly the text that turn was sent, against the response that read.
    const claims = records.flatMap((one) =>
      one.kind === "feedback" && one.turn !== null
        ? [{ response: one.response, turn: one.turn, text: one.text }]
        : [],
    );
    expect(claims).toEqual(
      names.slice(0, 3).map((response, index) => ({
        response,
        turn: index + 2,
        text: turns[index + 1]?.input,
      })),
    );
    // The reading keeps the latest established delivery per conversation, and
    // establishes every claim above: none is left unresolved.
    expect(continued.delivered).toEqual([{ conversation: continued.active, turn: 4 }]);
    expect(continued.unestablished).toEqual([]);

    // Everything above happened in one conversation.
    const conversations = new Set(
      records.flatMap((one) =>
        one.kind === "response" ||
        one.kind === "control" ||
        one.kind === "control-outcome" ||
        one.kind === "feedback" ||
        one.kind === "message"
          ? [one.conversation]
          : [],
      ),
    );
    expect([...conversations]).toEqual([continued.active]);

    // Reopened cold, the same relationships read back, nothing is asked of the
    // provider and no byte changes.
    const before = yield* runPhase("bytes", root, "chat");
    const reopened = yield* runPhase("chat-read", root, "chat");
    const after = yield* runPhase("bytes", root, "chat");
    expect(after.sidekick).toBe(before.sidekick);
    expect(after.entries).toBe(before.entries);
    expect(reopened.readable).toBe(true);
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);
    expect(reopened.chat).toEqual(continued.chat);
    expect(reopened.operations).toEqual(
      names.slice(0, 3).map((response) => ({
        response,
        order: 0,
        component: "REPL.Bindings",
        status: "ok",
      })),
    );
    expect(reopened.delivered).toEqual(continued.delivered);
    expect(reopened.unestablished).toEqual([]);
    expect(reopened.unfinished).toEqual([]);
  });

  it("1234: a response after an old writer's orphan takes neither its name nor its slots", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    const NATIVE = "native-1234-legacy";
    const fixture = new URL("./fixtures/repl/issue-1234/legacy-orphan/", import.meta.url);
    const directory = join(root.repository, PAIRED_DIRECTORY, "chat");
    yield* until(mkdir(directory, { recursive: true }));
    const prefix = yield* until(readFile(new URL("sidekick.jsonl", fixture), "utf8"));
    yield* until(writeFile(join(directory, SIDEKICK_FILE), prefix));
    yield* until(writeFile(join(directory, ENTRIES_FILE), ""));

    // The fixture's own shape: canonical turn 1 ran as `response:2`, with a
    // settled fill at order 0 and a question at order 1 nobody answered.
    const seeded = yield* recordsAt(root);
    expect(canonicalTurns(seeded).map((one) => one.name)).toEqual(["turn:1"]);
    expect(slots(seeded, "control")).toEqual([
      { response: "response:2", order: 0 },
      { response: "response:2", order: 1 },
    ]);
    expect(seeded.some((one) => one.kind === "response")).toBe(false);

    const said = yield* runPhase(
      "chat-say",
      root,
      "chat",
      JSON.stringify({
        replies: [READS, DONE],
        identity: NATIVE,
        existing: true,
        say: "new instruction",
      }),
    );
    expect(said.refused).toBeUndefined();
    expect(said.readable).toBe(true);
    expect(said.sent).toBe(true);
    expect(said.output).toContain("Done.");

    // The old history is still there, byte for byte, ahead of what was added.
    const now = yield* until(readFile(join(directory, SIDEKICK_FILE), "utf8"));
    expect(now.startsWith(prefix)).toBe(true);

    const records = yield* recordsAt(root);
    const turns = canonicalTurns(records);
    expect(turns.map((one) => one.name)).toEqual(["turn:1", "turn:2", "turn:3"]);
    expect(turns.map((one) => one.native)).toEqual([NATIVE, NATIVE, NATIVE]);

    // Canonical turn 2 is a new response, and neither it nor the feedback turn
    // after it is called what the orphan is called.
    const responses = records.flatMap((one) =>
      one.kind === "response" ? [{ response: one.response, turn: one.turn }] : [],
    );
    expect(responses.map((one) => one.turn)).toEqual([2, 3]);
    const [reader, last] = responses.map((one) => one.response);
    expect(reader).not.toBe("response:2");
    expect(last).not.toBe("response:2");
    expect(reader).not.toBe(last);

    // The new read has its own order-0 slot; the orphan's settled fill keeps its
    // outcome and its question is still unanswered.
    expect(slots(records, "control")).toEqual([
      { response: "response:2", order: 0 },
      { response: "response:2", order: 1 },
      { response: reader, order: 0 },
    ]);
    expect(said.operations).toEqual([
      { response: "response:2", order: 0, component: "REPL.EntryInput", status: "ok" },
      { response: reader, order: 0, component: "REPL.Bindings", status: "ok" },
    ]);
    expect(said.unfinished).toEqual([["Elicit", "unfinished"]]);
    expect(admissions(records)).toEqual([
      "generated:response:2",
      `generated:${reader}`,
      `generated:${last}`,
    ]);

    // Turn 2 carried the orphan's account once — the fill that happened and
    // the question left waiting — and restored no old draft.
    const carried = String(turns[1]?.input ?? "");
    expect(carried.split("## REPL.EntryInput")).toHaveLength(2);
    expect(carried.split("## Elicit")).toHaveLength(2);
    expect(carried).toContain("Which one?");
    expect(carried).toContain("Do not ask it again");
    expect(carried).toContain("The shared entry draft is empty.");
    expect(said.draft).toBe("");
    expect(
      records.filter((one) => one.kind === "control" && one.component === "REPL.EntryInput"),
    ).toHaveLength(1);
    expect(
      records.filter((one) => one.kind === "control" && one.component === "Elicit"),
    ).toHaveLength(1);

    // The orphan's account went with turn 2, and the read's results with turn
    // 3 against the response that read — not against the orphan.
    const claims = records.flatMap((one) =>
      one.kind === "feedback" && one.turn !== null
        ? [{ response: one.response, turn: one.turn, text: one.text }]
        : [],
    );
    expect(claims).toEqual([
      { response: "response:2", turn: 2, text: turns[1]?.input },
      { response: reader, turn: 3, text: turns[2]?.input },
    ]);

    const before = yield* runPhase("bytes", root, "chat");
    const reopened = yield* runPhase("chat-read", root, "chat");
    const after = yield* runPhase("bytes", root, "chat");
    expect(after.sidekick).toBe(before.sidekick);
    expect(after.entries).toBe(before.entries);
    expect(reopened.readable).toBe(true);
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);
    expect(reopened.operations).toEqual(said.operations);
    expect(reopened.unfinished).toEqual([["Elicit", "unfinished"]]);
  });

  it("1234: two operations at one position are still refused, whatever the response is called", function* () {
    for (const response of ["response:2", "response:journal:9"]) {
      const control: SidekickRecord = {
        kind: "control",
        conversation: CHAT,
        response,
        order: 0,
        component: "REPL.Bindings",
        arguments: {},
      };
      expect(refusalOf([...opened(), control, control])).toBe(
        "this chat history records two operations at one position (record 6).",
      );
    }
  });
});

describe("Tier R2 — a reservation binds what the writer has acknowledged", () => {
  const CHAT = "chat-1";
  const RESPONSE = "r1";
  const AGENT = "stub";
  const PRIOR = "Prior A.\n";
  const RESERVED = "Reserved body.\n";

  /** The conversation and reply a Submit control belongs to. */
  function conversation(): SidekickRecord[] {
    const prompt: DurableEvent = {
      type: "yield",
      coroutineId: "root",
      description: { type: "agent_prompt", name: "turn:1", input: "ask" },
      result: {
        status: "ok",
        value: {
          sequence: 0,
          agent: AGENT,
          sessionKey: "stub:default",
          status: "completed",
          text: "working on it",
        },
      },
    } as unknown as DurableEvent;
    return [
      { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "prepared" },
      { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "activated" },
      { kind: "event", conversation: CHAT, sequence: 0, event: serializeDurableEvent(prompt) },
      {
        kind: "response",
        conversation: CHAT,
        turn: 1,
        response: RESPONSE,
        outcome: { status: "ok" },
        hasOutput: true,
        output: "working on it",
      },
    ];
  }

  it("R2l: no prefix is bound and no intent written while an append is in flight", function* () {
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    const gate = openGate();
    let holding = 0;
    yield* scoped(function* (): Operation<void> {
      yield* useTempFileCompiler();
      const root = yield* useRepositoryRoot(gate);
      // Released however this row ends, so a failure reports rather than hangs.
      yield* ensure(() => release.resolve());

      const pair = yield* pairedReplRepository(root.repository).create();
      if (pair.chat.form !== "paired") {
        throw new Error("a created execution is published as a pair");
      }
      for (const record of conversation()) {
        yield* pair.chat.writer.append(record);
      }
      const opened = yield* openReplSession({ execution: pair });
      if (!opened.ok) {
        throw opened.error;
      }
      const live = opened.value;

      // Hold the prior entry's own admitting record, inside the host and before
      // the write. From here the writer has an append in flight.
      gate.hold = (path, record) => {
        if (holding > 0 || !path.endsWith(ENTRIES_FILE) || !record.includes(ROOT_IMPORT)) {
          return undefined;
        }
        holding += 1;
        entered.resolve();
        return release.operation;
      };
      const prior = yield* spawn(function* (): Operation<void> {
        const ran = yield* live.submit(PRIOR);
        if (!ran.ok) {
          throw ran.error;
        }
        yield* ran.value.join();
      });
      yield* entered.operation;
      expect(pair.stream.appending).toBe(true);

      // A reply asks for an entry now. It is refused, and refused on the
      // session's own terms rather than queued behind the entry in flight —
      // nothing here waits for that append, which is also why this returns at
      // all while the gate is still holding it.
      const asked = yield* submitForSidekick(
        { conversation: CHAT, response: RESPONSE },
        {
          session: {
            // The acknowledged history, read the way the root reads it.
            entries: () => {
              const read = live.reading(undefined);
              return read.ok ? Ok(read.value.model.entries) : read;
            },
            admits: () => live.admits(),
            submit: (source) => live.submit(source),
          },
          facts: () => ({
            live: true,
            revisions: { draft: 0, message: 0 },
            takenOver: false,
            draft: RESERVED,
          }),
          held: admitting(),
          journal: controlJournal(pair.chat.writer, {
            conversation: CHAT,
            response: RESPONSE,
          }),
          writer: pair.stream,
          woke: () => {},
        },
      );
      expect(asked.ok).toBe(false);
      if (asked.ok) {
        throw new Error("a session running an entry admits no second one");
      }
      expect(asked.error.message).toContain("has not finished");
      // Nothing was written. No intent, so nothing claims an attempt, and no
      // prefix was bound from a file the writer had not finished with.
      expect((yield* pair.chat.writer.readAll()).map((one) => one.kind)).toEqual([
        "owner",
        "ready",
        "conversation",
        "conversation",
        "event",
        "response",
      ]);
      expect(pair.stream.appending).toBe(true);

      // Let the prior entry finish, and the writer settle with it.
      release.resolve();
      yield* prior;
      yield* pair.stream.settled();
      expect(pair.stream.appending).toBe(false);
      expect(live.model.entries.map((entry) => entry.key)).toEqual(["entry-1"]);

      // The control: the same ask over a settled writer goes through, and what
      // it bound is the prefix the writer had actually acknowledged.
      const acknowledged = yield* bindRetainedPrefix(pair.stream.path);
      const accepted = yield* submitForSidekick(
        { conversation: CHAT, response: RESPONSE },
        {
          session: {
            // The acknowledged history, read the way the root reads it.
            entries: () => {
              const read = live.reading(undefined);
              return read.ok ? Ok(read.value.model.entries) : read;
            },
            admits: () => live.admits(),
            submit: (source) => live.submit(source),
          },
          facts: () => ({
            live: true,
            revisions: { draft: 0, message: 0 },
            takenOver: false,
            draft: RESERVED,
          }),
          held: admitting(),
          journal: controlJournal(pair.chat.writer, {
            conversation: CHAT,
            response: RESPONSE,
          }),
          writer: pair.stream,
          woke: () => {},
        },
      );
      if (!accepted.ok) {
        throw accepted.error;
      }
      expect(accepted.value.entry).toBe("entry-2");
      expect(accepted.value.status).toBe("completed");

      // The intent it wrote binds that acknowledged prefix exactly — the
      // records the writer had finished with, not the file as it stands now
      // with this entry's own records in it.
      const written = yield* pair.chat.writer.readAll();
      const intent = written.find((one) => one.kind === "control" && one.submit !== undefined);
      if (intent === undefined || intent.kind !== "control" || intent.submit === undefined) {
        throw new Error("an admitted Submit writes its intent");
      }
      expect(intent.submit.retained).toEqual(acknowledged);
      expect(intent.submit.ordinal).toBe(1);
      expect(intent.submit.entry).toBe("entry-2");
      expect(intent.submit.source).toBe(RESERVED);
      // And it grew past what it bound, which is what makes the binding a
      // prefix rather than the whole file.
      const now = yield* bindRetainedPrefix(pair.stream.path);
      expect(now.records).toBeGreaterThan(acknowledged.records);
    });
  });
});

describe("987 — whole-set Submit findings", () => {
  it("validates all slots before retaining findings and resumes only missing outcomes", function* () {
    yield* useTempFileCompiler();
    const root = yield* useRepositoryRoot();
    const pair = yield* pairedReplRepository(root.repository).create();
    if (pair.chat.form !== "paired") {
      throw new Error("a created execution is published as a pair");
    }
    for (const record of [...opened().slice(2), turn(1, "working"), reply(1, "working")]) {
      yield* pair.chat.writer.append(record);
    }
    const openedSession = yield* openReplSession({ execution: pair });
    if (!openedSession.ok) {
      throw openedSession.error;
    }
    const session = openedSession.value;
    const journal = controlJournal(pair.chat.writer, { conversation: CHAT, response: "r1" });
    for (const source of ["First established entry.\n", "Second established entry.\n"]) {
      yield* pair.stream.settled();
      const ordinal = session.model.entries.length;
      yield* journal.began(
        { component: "REPL.Submit", arguments: {} },
        {
          ordinal,
          entry: `entry-${ordinal + 1}`,
          source,
          revision: ordinal,
          workspace: true,
          retained: yield* bindRetainedPrefix(pair.stream.path),
        },
      );
      const submitted = yield* session.submit(source);
      if (!submitted.ok) {
        throw submitted.error;
      }
      yield* submitted.value.join();
    }
    const records = yield* pair.chat.writer.readAll();
    const before = yield* until(readFile(pair.chat.location.sidekick, "utf8"));
    const findings = yield* coldReservations(records, session.model.entries, pair.stream.path);
    if (!findings.ok) {
      throw findings.error;
    }
    expect(findings.value.map((one) => one.finding)).toEqual([
      { kind: "admitted", entry: "entry-1" },
      { kind: "admitted", entry: "entry-2" },
    ]);
    expect(findings.value.map((one) => one.intent.workspace)).toEqual([true, true]);
    expect(yield* until(readFile(pair.chat.location.sidekick, "utf8"))).toBe(before);

    for (const change of ["prefix", "ordinal", "key", "source", "competing slot"]) {
      const conflicting = records.map((record): SidekickRecord => {
        if (record.kind !== "control" || record.order !== 1 || record.submit === undefined) {
          return record;
        }
        const submit = record.submit;
        return {
          ...record,
          submit: {
            ...submit,
            ...(change === "prefix"
              ? { retained: { ...submit.retained, sha256: "0".repeat(64) } }
              : {}),
            ...(change === "ordinal" ? { ordinal: 3 } : {}),
            ...(change === "key" ? { entry: "entry-other" } : {}),
            ...(change === "source" ? { source: "different" } : {}),
            ...(change === "competing slot" ? { ordinal: 0, entry: "entry-1" } : {}),
          },
        };
      });
      const refused = yield* coldReservations(conflicting, session.model.entries, pair.stream.path);
      expect(refused.ok).toBe(false);
      expect(yield* until(readFile(pair.chat.location.sidekick, "utf8"))).toBe(before);
    }

    const first = findings.value[0];
    if (first === undefined) {
      throw new Error("the first reservation is missing");
    }
    const storage = pair.chat;
    yield* scoped(function* () {
      const failure = new Error("Late outcome append failed.");
      yield* ReplHost.around(
        {
          *appendRecord([path, line], next) {
            const record = parseSidekickRecord(line.trim());
            if (record?.kind === "control-outcome") {
              throw failure;
            }
            yield* next(path, line);
          },
        },
        { at: "max" },
      );
      let observed: unknown;
      try {
        yield* retainResolution(storage.writer, first);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(yield* until(readFile(storage.location.sidekick, "utf8"))).toBe(before);
    });
    yield* retainResolution(pair.chat.writer, first);
    const partial = yield* readSidekickRecords(pair.chat.location.sidekick);
    const afterFirst = yield* until(readFile(pair.chat.location.sidekick, "utf8"));
    const remaining = yield* coldReservations(partial, session.model.entries, pair.stream.path);
    if (!remaining.ok) {
      throw remaining.error;
    }
    expect(remaining.value.map((one) => one.finding)).toEqual([
      { kind: "admitted", entry: "entry-2" },
    ]);
    expect(yield* until(readFile(pair.chat.location.sidekick, "utf8"))).toBe(afterFirst);
    for (const finding of remaining.value) {
      yield* retainResolution(pair.chat.writer, finding);
    }
    const settled = yield* coldReservations(
      yield* pair.chat.writer.readAll(),
      session.model.entries,
      pair.stream.path,
    );
    expect(settled).toEqual(Ok([]));
    expect(session.model.entries.map((one) => one.source)).toEqual([
      "First established entry.\n",
      "Second established entry.\n",
    ]);
    expect(
      (yield* pair.chat.writer.readAll()).filter((one) => one.kind === "control-outcome"),
    ).toHaveLength(2);
    const absent = {
      ordinal: 2,
      entry: "entry-3",
      source: "Never admitted.\n",
      revision: 2,
      retained: yield* bindRetainedPrefix(pair.stream.path),
    };
    yield* journal.began({ component: "REPL.Submit", arguments: {} }, absent);
    const oneAbsent = yield* coldReservations(
      yield* pair.chat.writer.readAll(),
      session.model.entries,
      pair.stream.path,
    );
    expect(oneAbsent.ok && oneAbsent.value.map((one) => one.finding)).toEqual([{ kind: "absent" }]);
    yield* journal.began({ component: "REPL.Submit", arguments: {} }, absent);
    const competing = yield* coldReservations(
      yield* pair.chat.writer.readAll(),
      session.model.entries,
      pair.stream.path,
    );
    expect(competing.ok).toBe(false);
    expect(session.model.entries).toHaveLength(2);
  });
});

describe("Tier SS — what a saved Sidekick turn establishes about itself", () => {
  it("SS6: each actual nonempty key is filter evidence, and a record lacking one gains none", function* () {
    // Four turns of one conversation, each carrying what its own record
    // carries: a completed turn with a key, a failed one with a key of its
    // own, a cancelled one with a third, and one whose record names no
    // conversation at all.
    const reading = project([
      ...opened(),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "first",
      },
      turn(1, "Hello", { input: "first", sessionKey: "sk:one" }),
      reply(1, "Hello"),
      {
        kind: "message",
        id: "message-2",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 2,
        revision: 1,
        text: "second",
      },
      turn(2, "half a", {
        input: "second",
        status: "failed",
        sessionKey: "sk:two",
        error: { message: "the agent gave up." },
      }),
      {
        kind: "message",
        id: "message-3",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 3,
        revision: 1,
        text: "third",
      },
      turn(3, "", { input: "third", status: "cancelled", sessionKey: "sk:three" }),
      {
        kind: "message",
        id: "message-4",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 4,
        revision: 1,
        text: "fourth",
      },
      turn(4, "", { input: "fourth", sessionKey: "" }),
    ]);

    // Every turn is a turn, whatever became of it, and each names exactly the
    // conversation its own record does. A failed or cancelled record naming a
    // key is still evidence for *that* turn.
    expect(
      reading.turns.map((one) => [one.turn, one.status, one.sessionKey, one.asked, one.title]),
    ).toEqual([
      [1, "completed", "sk:one", "person", "first"],
      [2, "failed", "sk:two", "person", "second"],
      [3, "cancelled", "sk:three", "person", "third"],
      // A record naming no conversation gains none from the three before it:
      // an earlier turn's key is not substituted for evidence about a later
      // one, so this turn has no provider filter membership at all.
      [4, "completed", undefined, "person", "fourth"],
    ]);
    // Each turn's own chat and agent, read from the conversation that holds it.
    expect(new Set(reading.turns.map((one) => `${one.conversation}/${one.agent}`))).toEqual(
      new Set([`${CHAT}/${AGENT}`]),
    );
    // The completed turn with an evaluated response has the reply; the turn
    // with none shows the exact inert status instead, and the two that did not
    // complete show what they streamed and why they stopped — never source.
    expect(reading.turns[0]?.reply).toEqual({
      response: "r1",
      output: "Hello",
      hasOutput: true,
      failure: undefined,
    });
    expect(reading.turns[0]?.incomplete).toBeUndefined();
    expect(reading.turns[1]?.incomplete).toEqual({
      output: "",
      failure: "the agent gave up.",
    });
    expect(reading.turns[2]?.incomplete).toEqual({
      output: "",
      failure: "the agent's turn cancelled.",
    });
    expect(reading.turns[3]?.reply).toBeUndefined();
    // And that fourth turn is the one readable anchor this chat gains: the
    // provider finished, nothing recorded a reply, and the chat says so where
    // the record sits rather than leaving a gap or replaying the source.
    const anchors = reading.chat.filter((item) => item.kind === "saved");
    expect(anchors).toEqual([
      {
        kind: "saved",
        conversation: CHAT,
        turn: 4,
        automatic: false,
        status: "Turn saved; no evaluated reply recorded.",
      },
    ]);
  });

  it("SS6: a completed turn's literal Output is what it says, and never its source", function* () {
    // A failed turn whose retained source is a whole root with machinery in it.
    // What a reader gets is the literal Output and nothing else: the control,
    // the binding and the fence around them are the agent's working.
    const source = [
      '<Let as="hidden" select="code">',
      "```md",
      "<REPL.Bindings />",
      "```",
      "</Let>",
      "<Output>Half an answer.</Output>",
      "",
    ].join("\n");
    const reading = project([
      ...opened(),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "ask",
      },
      turn(1, source, { input: "ask", status: "failed", stopReason: "max_tokens" }),
    ]);

    expect(reading.turns[0]?.incomplete).toEqual({
      output: "Half an answer.",
      failure: "the agent stopped early (max_tokens).",
    });
    // None of the machinery reached the reading.
    expect(reading.turns[0]?.incomplete?.output).not.toContain("REPL.Bindings");
    expect(reading.turns[0]?.incomplete?.output).not.toContain("Let");

    // And a source the pure reader cannot project has no body at all rather
    // than a body of its own text: an unfinished region naming something this
    // vocabulary does not have renders nothing, and nothing is what is shown.
    const unreadable = project([
      ...opened(),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "ask",
      },
      turn(1, "<Output><NotAThing /></Output>", { input: "ask", status: "failed" }),
    ]);
    expect(unreadable.turns[0]?.incomplete?.output).toBe("");
  });

  it("SS6: automatic feedback is labelled, and its machine input is not a title", function* () {
    // A person's message, its reply, and then the turn that carried that
    // response's results — whose request is this host's own account of what the
    // reply did rather than anything anybody said.
    const machine = "## Results\n\n<REPL.Bindings /> returned two names.";
    const reading = project([
      ...opened(),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "greet them",
      },
      turn(1, "Hello", { input: "greet them" }),
      reply(1, "Hello"),
      { kind: "feedback", conversation: CHAT, response: "r1", turn: null, text: machine },
      turn(2, "", { input: machine }),
      { kind: "feedback", conversation: CHAT, response: "r1", turn: 2, text: machine },
    ]);

    const automatic = reading.turns.find((one) => one.turn === 2);
    expect(automatic?.asked).toBe("automatic");
    // No title at all: the machine input is not something a person said, so it
    // is not offered as one.
    expect(automatic?.title).toBeUndefined();
    // And the anchor it opens at says the same thing.
    expect(reading.chat.filter((item) => item.kind === "saved")).toEqual([
      {
        kind: "saved",
        conversation: CHAT,
        turn: 2,
        automatic: true,
        status: "Turn saved; no evaluated reply recorded.",
      },
    ]);
  });

  it("SS6: a turn no request bounds has no title, and the latest message is not one", function* () {
    // A canonical turn with no request begun before it in this conversation.
    // Nothing owns it, and nothing is invented to: substituting the message
    // after it would attribute somebody's words to a turn that cannot have
    // carried them.
    const reading = project([
      ...opened(),
      turn(1, "Hello", { input: "something this history never wrote down" }),
      reply(1, "Hello"),
      {
        kind: "message",
        id: "message-2",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 2,
        revision: 1,
        text: "a later question",
      },
    ]);

    expect(reading.turns.map((one) => [one.turn, one.asked, one.title])).toEqual([
      [1, undefined, undefined],
    ]);
  });

  /**
   * Two chats of one execution, and what is being said in the current one.
   *
   * `diverged` gives the older chat an unacknowledged first message, so this
   * history's own response ordinals run ahead of Core's turn numbers in it from
   * then on: its saved reply at turn 1 is `response:2`, and its failed turn 2
   * has no response record of its own. That is the condition under which a
   * current failure registered as `response:2` could reach into it.
   */
  function crossChat(diverged: boolean): readonly ReplSidekickChatRow[] {
    const opening = (id: string, agent: string): SidekickRecord[] => [
      { kind: "conversation", conversation: id, agent, phase: "prepared" },
      { kind: "conversation", conversation: id, agent, phase: "activated" },
    ];
    const attempted = (
      id: string,
      agent: string,
      order: number,
      failed: boolean,
    ): SidekickRecord => ({
      kind: "event",
      conversation: id,
      sequence: order - 1,
      // The serialized durable event this record carries, written as the text
      // it is. A record's `event` member is that text, so there is nothing to
      // assert about its shape on the way in — the reader under test parses it.
      event: JSON.stringify({
        type: "yield",
        coroutineId: "root",
        description: { type: "agent_prompt", name: `turn:${order}`, input: "canonical request" },
        result: {
          status: "ok",
          value: {
            sequence: order - 1,
            agent,
            sessionKey: `provider:${id}`,
            status: failed ? "failed" : "completed",
            text: "<Output>Visible.</Output>\n",
            ...(failed ? { error: { message: "Stopped early." } } : {}),
          },
        },
      }),
    });
    // Two different agents, which is what an ordinary replacement leaves.
    const saved: SidekickRecord[] = [
      { kind: "owner", version: 1, execution: "exec" },
      { kind: "ready" },
      ...opening("old", "scribe"),
      ...(diverged
        ? [
            {
              kind: "message",
              id: "message-unacknowledged",
              origin: { kind: "ui" },
              conversation: "old",
              turn: 1,
              revision: 0,
              text: "unacknowledged",
            } satisfies SidekickRecord,
          ]
        : []),
      {
        kind: "message",
        id: "message-saved",
        origin: { kind: "ui" },
        conversation: "old",
        turn: diverged ? 2 : 1,
        revision: 0,
        text: "saved",
      },
      attempted("old", "scribe", 1, false),
      {
        kind: "response",
        conversation: "old",
        turn: 1,
        response: diverged ? "response:2" : "response:1",
        outcome: { status: "ok" },
        hasOutput: true,
        output: "Old reply.",
      },
      {
        kind: "message",
        id: "message-old-failed",
        origin: { kind: "ui" },
        conversation: "old",
        turn: diverged ? 3 : 2,
        revision: 0,
        text: "old failed",
      },
      attempted("old", "scribe", 2, true),
      ...opening("current", "scrivener"),
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: "current",
        turn: 1,
        revision: 0,
        text: "first",
      },
      attempted("current", "scrivener", 1, false),
      {
        kind: "response",
        conversation: "current",
        turn: 1,
        response: "response:1",
        outcome: { status: "ok" },
        hasOutput: true,
        output: "New reply.",
      },
      {
        kind: "message",
        id: "message-2",
        origin: { kind: "ui" },
        conversation: "current",
        turn: 2,
        revision: 0,
        text: "new failed",
      },
      attempted("current", "scrivener", 2, true),
    ];
    const known = project(saved);
    // What the current chat's own failure is saying right now, under the
    // response this process registered for it — which in the diverged history
    // is the same name the older chat's saved reply already carries.
    return sidekickChatRows(known, {
      conversation: "current",
      response: "response:2",
      turn: 2,
      output: "Visible.",
      incomplete: true,
    }).filter((one) => one.conversation === "old");
  }

  it("SS2: a current failure cannot readdress a previous chat's attempt", function* () {
    const rows = crossChat(true);
    // Five items in the older chat, each with an identity of its own: the two
    // messages the divergence produced, the saved reply, the message that
    // failed, and that failure. Nothing is merged, renamed or dropped.
    expect(rows.map((one) => [one.key, one.kind])).toEqual([
      ["chat:old:message:1", "person"],
      ["chat:old:message:2", "person"],
      ["chat:old:response:2", "reply"],
      ["chat:old:message:3", "person"],
      ["chat:old:turn:2:incomplete", "incomplete"],
    ]);
    expect(new Set(rows.map((one) => one.key)).size).toBe(rows.length);
  });

  it("SS2: control — with no divergence there is no earlier reply to collide with", function* () {
    const rows = crossChat(false);
    expect(rows.map((one) => [one.key, one.kind])).toEqual([
      ["chat:old:message:1", "person"],
      ["chat:old:response:1", "reply"],
      ["chat:old:message:2", "person"],
      ["chat:old:turn:2:incomplete", "incomplete"],
    ]);
    expect(new Set(rows.map((one) => one.key)).size).toBe(rows.length);
  });

  it("SS3: two chats keep their own agents, and an equal key is one choice", function* () {
    // One execution, two conversations with two agents, and the same provider
    // conversation named by a turn of each. Their rows stay their own.
    const second = "chat-2";
    const reading = project([
      { kind: "owner", version: 1, execution: "exec" },
      { kind: "ready" },
      { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "prepared" },
      { kind: "conversation", conversation: CHAT, agent: AGENT, phase: "activated" },
      {
        kind: "message",
        id: "message-1",
        origin: { kind: "ui" },
        conversation: CHAT,
        turn: 1,
        revision: 1,
        text: "first",
      },
      turn(1, "Hello", { input: "first", sessionKey: "sk:shared" }),
      reply(1, "Hello"),
      {
        kind: "conversation",
        conversation: second,
        agent: "scrivener",
        phase: "prepared",
        previous: CHAT,
      },
      { kind: "conversation", conversation: second, agent: "scrivener", phase: "activated" },
    ]);

    // The chat that preceded the replacement is still readable, with its own
    // agent, and the active association is the one that replaced it.
    expect(reading.conversations.map((one) => [one.id, one.agent])).toEqual([
      [CHAT, AGENT],
      [second, "scrivener"],
    ]);
    expect(reading.active).toBe(second);
    // The turn belongs to the chat that ran it and names that chat's agent,
    // never whichever agent is active now.
    expect(reading.turns.map((one) => [one.conversation, one.agent, one.sessionKey])).toEqual([
      [CHAT, AGENT, "sk:shared"],
    ]);
  });
});

/**
 * Tier HI — reopening at an earlier checkpoint reconciles the whole history.
 *
 * A reservation a dead process left behind is answered against every entry the
 * file holds, not against the prefix the new screen happens to open at. These
 * two rows reach that through **the command**: the subprocess phases leave the
 * interrupted state on disk, and the mounted program is then started over that
 * same root with a location frozen at the first entry's outcome — so what runs
 * is `program.ts`'s own cold adapter rather than `coldReservation` called here
 * with a list this file chose.
 */
describe("Tier HI — a reopening reconciles against the acknowledged history", () => {
  const FIRST = "First prior.\n";
  const SECOND = "Second prior.\n";
  /** What the next ordinary entry says, distinct from the reserved source. */
  const ORDINARY = "<Output>an ordinary entry</Output>";

  const entriesPath = (root: RepositoryRoot): string =>
    join(root.repository, PAIRED_DIRECTORY, CHAT, ENTRIES_FILE);
  const sidekickPath = (root: RepositoryRoot): string =>
    join(root.repository, PAIRED_DIRECTORY, CHAT, SIDEKICK_FILE);

  /** Both files of this pair, as the exact bytes they hold. */
  function* pairBytes(
    root: RepositoryRoot,
  ): Operation<{ readonly entries: string; readonly sidekick: string }> {
    return {
      entries: yield* until(readFile(entriesPath(root), "utf8")),
      sidekick: yield* until(readFile(sidekickPath(root), "utf8")),
    };
  }

  /** Every entry this root's chat execution holds, parsed from the file. */
  function* entriesOf(root: RepositoryRoot): Operation<readonly ReplEntry[]> {
    const projected = projectRepl(
      parseEntryRecords(yield* until(readFile(entriesPath(root), "utf8"))),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    return projected.value.entries;
  }

  /**
   * The Submit intent the interrupted process left behind.
   *
   * Read from the records rather than restated here: what the reservation
   * stated is the thing under test, so a constant copied from the phase would
   * assert this file's own idea of it instead.
   */
  function reservationOf(records: readonly SidekickRecord[]): NonNullable<ControlRecord["submit"]> {
    for (let at = records.length - 1; at >= 0; at -= 1) {
      const held = records[at];
      if (held?.kind === "control" && held.submit !== undefined) {
        return held.submit;
      }
    }
    throw new Error("this history holds no Submit intent to reconcile");
  }

  /** Every retained resolution of a control, in the order they were written. */
  function resolutionsIn(
    records: readonly SidekickRecord[],
  ): readonly { readonly outcome: unknown; readonly observed?: unknown }[] {
    return records.flatMap((one) => (one.kind === "control-outcome" ? [one] : []));
  }

  /**
   * Two completed entries and an interrupted reservation, on one real root.
   *
   * `admit` stops before the receipt, so its entry exists and nothing says how
   * it ended. `reserve` stops before the entry is admitted, so the intent is
   * the only trace. Both reserve at the head, which is why the intent they
   * leave correctly names the third entry.
   */
  function* interrupted(root: RepositoryRoot, stopping: "reserve" | "admit"): Operation<void> {
    yield* runPhase("seed-chat", root, CHAT);
    expect((yield* runPhase("prior", root, CHAT, FIRST)).entries).toEqual(["entry-1"]);
    expect((yield* runPhase("prior", root, CHAT, SECOND)).entries).toEqual(["entry-1", "entry-2"]);
    const stopped = yield* runPhase(stopping, root, CHAT);
    expect(stopped.stopped).toBe(stopping);
  }

  /**
   * The location a person would copy while reading the first entry's outcome.
   *
   * Encoded by the production codec from the position the history actually
   * retained, so the string is a real location rather than a shape assembled
   * here. The first `terminal` checkpoint is the first entry's own outcome:
   * two entries retain admitted, outcome, admitted, outcome.
   */
  function* frozenLocation(root: RepositoryRoot): Operation<string> {
    const projected = projectRepl(
      parseEntryRecords(yield* until(readFile(entriesPath(root), "utf8"))),
    );
    if (!projected.ok) {
      throw projected.error;
    }
    const outcome = projected.value.checkpoints.find((one) => one.kind === "terminal");
    if (outcome === undefined) {
      throw new Error("this history retained no entry outcome to freeze at");
    }
    const base = initialState(CHAT);
    return encodeLocation({ ...base.route, at: outcome.marker, inspect: true });
  }

  for (const row of [
    {
      name: "HI4",
      stopping: "admit" as const,
      what: "an entry that was admitted",
      // An admitted finding records that entry as its own observation, which
      // is the whole point of the row: the entry it names has to be the one
      // the dead process actually admitted, not the one an opening prefix
      // would have counted to.
      observed: "entry-3",
      says: '"status":"ok"',
      entriesWhenFound: ["entry-1", "entry-2", "entry-3"],
      /** The reserved entry really ran, so its source is in the history once. */
      reservedRuns: 1,
    },
    {
      name: "HI5",
      stopping: "reserve" as const,
      what: "an entry that was never admitted",
      observed: null,
      says: "never admitted",
      entriesWhenFound: ["entry-1", "entry-2"],
      /** Nothing took the slot, and recovery does not submit it later. */
      reservedRuns: 0,
    },
  ]) {
    it(`${row.name}: reopened at the first entry, ${row.what} is still found`, function* () {
      const root = yield* createRepositoryRoot();
      yield* interrupted(root, row.stopping);
      const location = yield* frozenLocation(root);
      const before = yield* pairBytes(root);
      const reserved = reservationOf(yield* readSidekickRecords(sidekickPath(root)));
      // The intent the dead process wrote names the third entry, because it
      // reserved at the head. That is the identity recovery has to find.
      expect(reserved.entry).toBe("entry-3");
      expect(reserved.ordinal).toBe(2);

      const operations = operationGate();

      yield* scoped(function* (): Operation<void> {
        const page = yield* useReplPage({ dataRoot: root.data, location, operations });
        const repl = page.repl;

        // Opening is a reading. Both files are byte-identical afterwards —
        // not merely the same record kinds — and no provider work happened at
        // all: no runtime created, no session established, no prompt, no turn.
        expect(yield* pairBytes(root)).toEqual(before);
        expect(repl.fake.ensured).toHaveLength(0);
        expect(repl.fake.prompts).toHaveLength(0);
        expect(repl.fake.turns).toHaveLength(0);
        expect(repl.fake.started).toBe(false);
        // And the entries are the ones this history actually holds, whatever
        // the frozen screen is showing.
        const opened = yield* entriesOf(root);
        expect(opened.map((one) => one.key)).toEqual(row.entriesWhenFound);
        expect(opened.filter((one) => one.source === reserved.source)).toHaveLength(
          row.reservedRuns,
        );

        // The first explicit mutating action retains the finding *before* its
        // own work. Held at the operation that would append this successor's
        // admission, so what is read below is the file as it stands while that
        // admission has not landed — an append already handed to the
        // filesystem could not establish that order.
        const admission = operations.holdNext((path) => path.endsWith(ENTRIES_FILE));

        // This location names a position and no drawer, so the way back is
        // reachable straight away.
        yield* page.press("[live]");
        yield* page.until("the live head coming back", (one) => !one.shows("[live]"));
        yield* draftText(page, ORDINARY);
        yield* page.key("Enter");
        yield* admission.started();

        // Before the successor is admitted: the finding is on disk, it is the
        // one this history held, and it names the entry it observed.
        const held = resolutionsIn(yield* readSidekickRecords(sidekickPath(root)));
        expect(held).toHaveLength(1);
        expect(JSON.stringify(held[0]?.outcome)).toContain(row.says);
        expect(held[0]?.observed ?? null).toEqual(row.observed);
        // Nothing new has been admitted yet — which is what makes the read
        // above a claim about order rather than about existence — so the
        // reserved source still occurs exactly as often as it did.
        const during = yield* entriesOf(root);
        expect(during.map((one) => one.key)).toEqual(row.entriesWhenFound);
        expect(during.filter((one) => one.source === reserved.source)).toHaveLength(
          row.reservedRuns,
        );

        admission.release();
        yield* page.until("the ordinary entry printing", (one) => one.shows("an ordinary entry"));
        // Settled, not merely printed: the boundary the reads below need is the
        // entry's outcome being in the journal. Read from the History rail,
        // which marks every entry this file holds with the state it reached —
        // the catalog spells the same fact `[ok]`, and the catalog is a drawer
        // nobody opened here.
        yield* entrySettles(page, row.entriesWhenFound.length + 1, "ok");

        // The successor took the next slot with its own source, the finding was
        // not written twice, and the reserved work was neither resubmitted nor
        // repeated: its source occurs exactly as often as before.
        const ran = yield* entriesOf(root);
        expect(ran).toHaveLength(row.entriesWhenFound.length + 1);
        expect(ran[ran.length - 1]?.source).toBe(ORDINARY);
        expect(ran.filter((one) => one.source === reserved.source)).toHaveLength(row.reservedRuns);
        expect(resolutionsIn(yield* readSidekickRecords(sidekickPath(root)))).toHaveLength(1);
      });

      yield* root.discard();
    });
  }
});

/**
 * Tier IN5 — a chat the build before this one saved is still a chat.
 *
 * The fixture is not written here. It is the bytes a real run of the
 * **pre-integration writer at `d4b0e326`** left behind — three subprocess
 * phases over a real repository root, before this branch existed — and it is
 * checked in beside this file with the receipt that says so
 * (`fixtures/repl/issue-883/old-chat/RECEIPT.md`). That matters because the
 * thing under test is compatibility: a fixture this build wrote, relabelled,
 * would establish nothing at all.
 *
 * What it holds is one paired chat with two responses. Turn 1 completed and is
 * retained as a `response` record with its rendering. Turn 2 was interrupted
 * with a question pending, and holds a `control`/`control-outcome` pair for the
 * draft fill that *did* happen beside a second `control` with no outcome for the
 * question that was still waiting. Both of its root evaluations are **marker 2**
 * — the record shape that writer wrote — each on its own `generated_root:N`
 * sequence.
 *
 * Three things have to hold for such a chat to stay usable, and they are the
 * three rows below: opening it changes nothing and asks nobody anything; what
 * it already said is still readable; and a new message continues the same
 * native conversation and writes this build's marker rather than resuming a
 * grant whose rules this build does not have.
 */
describe("Tier IN5 — a chat saved by the build before this one", () => {
  /** Where the checked-in fixture lives. */
  const FIXTURE = new URL("./fixtures/repl/issue-883/old-chat/", import.meta.url);

  /** The native conversation both of the fixture's turns ran in. */
  const NATIVE = "native-old";

  /** Lay the fixture's bytes down as the chat of one execution. */
  function* seedOldChat(root: RepositoryRoot, execution: string): Operation<string> {
    const directory = join(root.repository, PAIRED_DIRECTORY, execution);
    yield* until(mkdir(directory, { recursive: true }));
    const chat = yield* until(readFile(new URL("sidekick.jsonl", FIXTURE), "utf8"));
    yield* until(writeFile(join(directory, SIDEKICK_FILE), chat));
    yield* until(writeFile(join(directory, ENTRIES_FILE), ""));
    return chat;
  }

  /**
   * Every canonical turn this chat retains, with the native conversation it ran
   * in.
   *
   * Read through the same typed readers the product reads these records with —
   * `parseEntryRecords` for the mirrored durable event, `parsePromptRecord` for
   * the Prompt record inside it — so what this names is the canonical account
   * of a turn rather than a substring of the file.
   */
  function canonicalTurns(
    records: readonly SidekickRecord[],
  ): readonly { readonly name: string; readonly native: string | undefined }[] {
    const turns: { name: string; native: string | undefined }[] = [];
    for (const record of records) {
      if (record.kind !== "event") {
        continue;
      }
      for (const event of parseEntryRecords(record.event)) {
        if (event.type !== "yield" || event.description.type !== AGENT_PROMPT) {
          continue;
        }
        if (event.result.status !== "ok") {
          continue;
        }
        const saved = parsePromptRecord(event.result.value);
        turns.push({ name: event.description.name, native: saved?.agentSessionId });
      }
    }
    return turns;
  }

  /** Each conversation record's phase, in append order. */
  function conversationPhases(
    records: readonly SidekickRecord[],
  ): readonly { readonly conversation: string; readonly phase: string }[] {
    const phases: { conversation: string; phase: string }[] = [];
    for (const record of records) {
      if (record.kind === "conversation") {
        phases.push({ conversation: record.conversation, phase: record.phase });
      }
    }
    return phases;
  }

  /**
   * The kinds one phase reported its chat as, read rather than asserted.
   *
   * A phase answers across a process boundary as JSON, so what arrives is
   * `unknown`: each item is narrowed and its `kind` read, and anything that is
   * not an object with a string `kind` is reported as the unreadable item it
   * is rather than being taken on trust.
   */
  function chatKinds(reported: unknown): readonly string[] {
    if (!Array.isArray(reported)) {
      throw new Error(`the phase reported no chat: ${JSON.stringify(reported)}`);
    }
    return reported.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`the phase reported a chat item that is not one: ${JSON.stringify(item)}`);
      }
      if (!("kind" in item)) {
        throw new Error(`the phase reported a chat item with no kind: ${JSON.stringify(item)}`);
      }
      const { kind } = item;
      if (typeof kind !== "string") {
        throw new Error(`the phase reported a chat item with no kind: ${JSON.stringify(item)}`);
      }
      return kind;
    });
  }

  /** The admission markers one chat's mirrored durable events carry, in order. */
  function markersOf(records: readonly SidekickRecord[]): { sequence: string; marker: number }[] {
    const found: { sequence: string; marker: number }[] = [];
    for (const record of records) {
      if (record.kind !== "event") {
        continue;
      }
      for (const event of parseEntryRecords(record.event)) {
        if (event.type !== "yield" || event.description.type !== "generated_xmd") {
          continue;
        }
        if (event.result.status !== "ok") {
          continue;
        }
        const value = event.result.value;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          continue;
        }
        found.push({
          sequence: String(event.coroutineId),
          marker: typeof value.version === "number" ? value.version : -1,
        });
      }
    }
    return found;
  }

  it("IN5: opening it cold changes no byte, sends no prompt and replays no suffix", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    const before = yield* seedOldChat(root, "chat");

    const reopened = yield* runPhase("chat-read", root, "chat");

    // Nothing was asked of anybody and nothing was written.
    expect(reopened.sessions).toBe(0);
    expect(reopened.prompts).toBe(0);
    expect(reopened.appended).toBe(0);
    // And the file is the file: reading a saved chat is not an event in it.
    const after = yield* runPhase("bytes", root, "chat");
    expect(after.sidekick).toBe(before);

    // The interrupted response's completed control is retained as what it was,
    // and its question is reported as waiting rather than asked again. Asking
    // again would be asking a second question.
    expect(reopened.operations).toEqual([
      { response: "response:2", order: 0, component: "REPL.EntryInput", status: "ok" },
    ]);
    expect(reopened.unfinished).toEqual([["Elicit", "unfinished"]]);
  });

  it("IN5: what it already said is still what it says", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    yield* seedOldChat(root, "chat");

    const reopened = yield* runPhase("chat-read", root, "chat");

    // The completed turn reads as a reply; the interrupted one reads as a turn
    // saved with no evaluated reply, which is what it is. Neither is invented
    // and neither is dropped.
    expect(chatKinds(reopened.chat)).toEqual(["person", "reply", "person", "saved"]);
    expect(JSON.stringify(reopened.chat)).toContain("The first reply.");
    // The native conversation its retained turns name, read from the turns
    // themselves rather than from a mapping record — there is none, by design.
    expect(JSON.stringify(reopened.turns)).toContain(NATIVE);
  });

  it("IN5: a new message continues the same conversation and writes marker 5", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    yield* seedOldChat(root, "chat");

    const sidekick = join(root.repository, PAIRED_DIRECTORY, "chat", SIDEKICK_FILE);
    const seeded = yield* readSidekickRecords(sidekick);
    const old = markersOf(seeded);
    // What the fixture holds before anything is added to it, so each assertion
    // below is about what the new message changed rather than about the file.
    const before = canonicalTurns(seeded);
    const phases = conversationPhases(seeded);
    const opened = phases.at(0);
    const prefix = yield* until(readFile(sidekick, "utf8"));
    // The conversation this chat is active in, as a cold read reports it.
    const { active } = yield* runPhase("chat-read", root, "chat");
    // The fixture's own shape, asserted before anything is added to it: two
    // old root sequences, both marker 2.
    expect(old).toEqual([
      { sequence: "generated_root:1", marker: 2 },
      { sequence: "generated_root:2", marker: 2 },
    ]);

    const said = yield* runPhase(
      "chat-say",
      root,
      "chat",
      JSON.stringify({
        replies: ["<Output>Carrying on.</Output>\n"],
        identity: NATIVE,
        existing: true,
        say: "one more thing",
      }),
    );
    expect(said.sent).toBe(true);
    expect(said.output).toContain("Carrying on.");

    const records = yield* readSidekickRecords(sidekick);
    // The same native conversation, continued rather than replaced — read off
    // the turn this message actually became rather than from the whole file.
    // The fixture already names `native-old` twice, so a substring search over
    // the complete history would hold even if the new turn ran somewhere else.
    const turns = canonicalTurns(records);
    expect(before.map((one) => one.name)).toEqual(["turn:1", "turn:2"]);
    expect(turns.map((one) => one.name)).toEqual(["turn:1", "turn:2", "turn:3"]);
    const appended = turns.at(-1);
    expect(appended?.name).toBe("turn:3");
    expect(appended?.native).toBe(NATIVE);

    // And it is the conversation this chat was already active in: the same id,
    // with no further preparation or activation appended for a second one.
    expect(active).toBe(opened?.conversation);
    expect(conversationPhases(records)).toEqual(phases);
    expect(records.filter((one) => one.kind === "owner")).toHaveLength(1);
    expect(records.some((one) => one.kind === "reference")).toBe(true);

    // The old sequences still say marker 2, and the new response says marker 5.
    const markers = markersOf(records);
    expect(markers.slice(0, 2)).toEqual(old);
    expect(markers.at(-1)?.marker).toBe(5);
    // Past both of them, so nothing asked for a retained address again.
    expect(markers.at(-1)?.sequence).toBe("generated_root:3");

    // The old history is still there, byte for byte, in front of what this
    // message added: continuing a saved chat appends and rewrites nothing.
    const now = yield* until(readFile(sidekick, "utf8"));
    expect(now.startsWith(prefix)).toBe(true);
    expect(JSON.stringify(canonicalTurns(records).slice(0, 2))).toBe(JSON.stringify(before));

    // And the interrupted response's control was not repeated: the fill that
    // happened in the old process happened once, and this turn did its own work.
    const fills = records.filter(
      (one) => one.kind === "control" && one.component === "REPL.EntryInput",
    );
    expect(fills).toHaveLength(1);
  });
});

/**
 * Tier IN5 — a saved output read still reads as the window it was (#932).
 *
 * The four dotted reads answer with structured pages, and the designated
 * branch sends a structured observation as JSON. `REPL.EntryOutput` came
 * before them and answered with a rendered window, and a chat that holds one
 * is a chat whose history has to go on meaning what it meant.
 *
 * The pair read here was produced by a real run — the producer under
 * `fixtures/repl/issue-932/` ran a reply that wrote `<REPL.EntryOutput />`
 * over an entry that had printed something, and the control's own intent and
 * outcome are what the chat retained. It was taken before that name was
 * retired from response admission, and its receipt says so: a reply written
 * now cannot produce one, which is exactly the situation a reopened chat is
 * in. The `issue-883/old-chat` fixture beside it holds an `REPL.EntryInput`
 * pair and a waiting `Elicit` and no output read at all, which is why this row
 * reads this one.
 */
describe("Tier IN5 — a saved EntryOutput result keeps its own renderer", () => {
  const SAVED = new URL("./fixtures/repl/issue-932/sidekick.jsonl", import.meta.url);

  it("E5: a historical output read is rendered, not reinterpreted, and nothing runs it", function* () {
    const path = fileURLToPath(SAVED);
    const before = yield* until(readFile(path));
    const saved = yield* readSidekickRecords(path);

    // The pair this chat holds, found in the records rather than named here.
    const intent = saved.find(
      (record): record is ControlRecord =>
        record.kind === "control" && record.component === "REPL.EntryOutput",
    );
    if (intent === undefined) {
      throw new Error("this chat holds no saved REPL.EntryOutput control");
    }

    const results = designatedResults(saved, {
      conversation: intent.conversation,
      response: intent.response,
    });
    const read = results.find((result) => result.component === "REPL.EntryOutput");
    expect(read).toMatchObject({ kind: "answered", json: false });
    // The historical renderer's own words: the entry, its state, the range it
    // read, and the text in a fence. Not a serialized page, which is what a
    // reader of this record would be told if the new reads had taken its
    // rendering with them.
    expect(read?.text).toContain("Entry entry-2 (completed), code points 0–");
    expect(read?.text).toContain("The harbour register");
    expect(read?.text).toContain("```");
    expect(read?.text).not.toContain('"offset"');
    expect(read?.text).not.toContain('"previous"');

    // Reading a record is not running the control it describes, and nothing
    // rewrote the file to make it readable.
    expect(yield* until(readFile(path))).toEqual(before);
  });
});

describe("975 — placement survives cold Submit reconciliation", () => {
  for (const marked of [true, false]) {
    it(`975: ${marked ? "legacy workspace-marked" : "project-placed"} entry resumes in its owned directory`, function* () {
      const project = yield* useTemporary("xmd-placement-project-");
      const host = yield* useMountedHost({
        projectCwd: project,
        hostFiles: true,
      });
      const observed: string[] = [];
      let waiting = withResolvers<void>();
      let answer = false;
      yield* Elicitation.around({
        *elicit([request], next) {
          observed.push(yield* cwd());
          waiting.resolve();
          return answer ? { go: "yes" } : yield* next(request);
        },
      });
      let execution = "";
      const source =
        '<Elicit schema={{ type: "object", properties: { go: { type: "string" } }, required: ["go"], additionalProperties: false }} as="answer">Continue?</Elicit>\n' +
        (marked
          ? '<AssertThrows message="outside the working directory"><File path="entries.jsonl" as="privateBytes" />{privateBytes}</AssertThrows>\n'
          : "") +
        '<File path="components/fixtures/suffix.md">continued</File>';
      yield* scoped(function* () {
        const page = yield* useReplPage({ host });
        const repl = page.repl;
        execution = yield* mountedExecution(repl);
        repl.fake.script({
          reply:
            '<Let as="code" select="code">\n```xmd\n' +
            source +
            "\n```\n</Let>\n<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />",
        });
        yield* sendMessage(page, "start and wait");
        yield* awaited("the admitted entry to wait", () => observed.length === 1);
        const read = yield* settledReading(repl);
        expect(read.model.entries[0]?.source).toBe(source);
        expect(read.model.entries[0]?.settled).toBe(false);
      });
      const location = pairedLocation(host.root, execution);
      if (marked) {
        const opened = yield* host.repository.open(execution);
        const events = (yield* opened.stream.readAll()).map((event) => {
          if (
            event.type !== "yield" ||
            event.description.type !== "import_component" ||
            event.description.name !== ROOT_IMPORT
          ) {
            return event;
          }
          const { [PLACEMENT]: _placement, ...description } = event.description;
          return { ...event, description };
        });
        yield* until(writeFile(location.entries, events.map(serializeDurableEvent).join("")));
        const records = yield* readSidekickRecords(location.sidekick);
        const legacy = records.map((record): SidekickRecord => {
          if (record.kind !== "control" || record.submit === undefined) {
            return record;
          }
          const { placement: _placement, ...submit } = record.submit;
          return { ...record, submit: { ...submit, workspace: true } };
        });
        yield* until(writeFile(location.sidekick, legacy.map(serializeSidekickRecord).join("")));
      }
      const where = marked ? location.directory : project;
      const coldLocation = encodeLocation(initialState(execution).route);
      const prefix = yield* until(readFile(location.entries, "utf8"));
      waiting = withResolvers<void>();
      yield* scoped(function* () {
        const page = yield* useReplPage({ host, location: coldLocation });
        yield* awaited("the first cold continuation", () => observed.length === 2);
        expect(observed.at(-1)).toBe(where);
        expect(yield* until(readFile(location.entries, "utf8"))).toBe(prefix);
        yield* draftText(page, "manual successor waits");
        yield* page.key("Enter");
        yield* page.until("the refused successor after reconciliation", (one) =>
          one.shows("has not finished"),
        );
        const reading = projectSidekick(yield* readSidekickRecords(location.sidekick));
        if (!reading.ok) {
          throw reading.error;
        }
        expect(reading.value.submits.filter((one) => !one.settled)).toEqual([]);
        expect(
          reading.value.submits.some(
            (intent) =>
              intent.entry === "entry-1" && intent.workspace === (marked ? true : undefined),
          ),
        ).toBe(true);
      });
      answer = true;
      waiting = withResolvers<void>();
      yield* scoped(function* () {
        const page = yield* useReplPage({ host, location: coldLocation });
        const repl = page.repl;
        yield* awaited("the second cold continuation", () => observed.length === 3);
        // The reserved entry ran and settled here, read from the History rail.
        // `1. [ok] entry-1` is a catalog row, and the catalog is a drawer
        // nobody opened in this reading.
        yield* entrySettles(page, 1, "ok");
        expect(observed.at(-1)).toBe(where);
        expect(yield* until(readFile(join(where, "components/fixtures/suffix.md"), "utf8"))).toBe(
          "continued",
        );
        expect(yield* cwd()).toBe(project);
        const read = yield* settledReading(repl);
        expect(read.model.entries[0]?.source).toBe(source);
      });
    });
  }
});

describe("987 — distinct instruction after unknown feedback", () => {
  it("joins the exact owned turn before a distinct same-session instruction", function* () {
    let effects = 0;
    let independent = false;
    let acknowledgements = 0;
    const admittedWork = withResolvers<void>();
    const held = yield* useHarness(undefined, {
      *acknowledge() {
        acknowledgements++;
      },
      state: (initial) => ({ ...initial, message: "Message remains", draft: "Draft remains" }),
      entryInstallation: {
        components: [
          {
            name: "EstablishedEffect",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            factory: () =>
              function* () {
                effects++;
                return "established once";
              },
          },
          {
            name: "IndependentWork",
            origin: "test",
            props: { type: "object", additionalProperties: false },
            factory: () =>
              function* () {
                yield* ensure(() => {
                  independent = false;
                });
                independent = true;
                admittedWork.resolve();
                yield* suspend();
                return null;
              },
          },
        ],
      },
    });
    const completed = yield* held.session.submit("<EstablishedEffect />");
    if (!completed.ok) {
      throw completed.error;
    }
    yield* completed.value.join();
    const active = yield* held.session.submit("<IndependentWork />");
    if (!active.ok) {
      throw active.error;
    }
    yield* admittedWork.operation;
    held.fake.script({ reply: "<REPL.Bindings />" });
    held.fake.script({ deltas: ["<Output>Thinking", " further.</Output>"], holdAfter: 1 });
    const original = yield* spawn(() => held.owner.message("Inspect the retained bindings."));
    yield* held.fake.streamingTurns(1);
    const review = yield* held.owner.reviewRecovery();
    if (!review.ok) {
      throw review.error;
    }
    expect(review.value.requests).toHaveLength(1);
    const before = held.fake.prompts[1];
    const cleanup = held.fake.holdCancellation();
    yield* ensure(() => cleanup.release());
    held.fake.script({ reply: "<Output>Continuing from the established result.</Output>" });
    const recovering = yield* spawn(() =>
      held.owner.recover(
        review.value,
        "Propose the next step from the established result.",
        false,
        { current: () => true },
      ),
    );
    const stopping = yield* race([cleanup.reached, recovering]);
    if (stopping !== undefined) {
      throw stopping.ok ? new Error("Recovery returned before the cleanup gate.") : stopping.error;
    }
    expect(held.fake.prompts).toHaveLength(2);
    cleanup.release();
    const result = yield* recovering;
    if (!result.ok) {
      throw result.error;
    }
    yield* original;
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.prompts[2]).toContain("Propose the next step from the established result.");
    expect(held.fake.prompts[2]).toContain("acceptance remains unknown");
    expect(held.fake.prompts[2]).not.toBe(before);
    expect(held.fake.turns[2]?.handle.sessionKey).toBe(held.fake.turns[0]?.handle.sessionKey);
    expect(held.session.model.entries).toHaveLength(2);
    expect(effects).toBe(1);
    expect(independent).toBe(true);
    expect(acknowledgements).toBe(1);
    expect(held.state().message).toBe("Message remains");
    expect(held.state().draft).toBe("Draft remains");
    expect(held.fake.prompts[2]).toContain("Entry entry-1: completed");
    expect(held.fake.prompts[2]).toContain("Entry entry-2: running");
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.unestablished).toHaveLength(1);
    expect(reading.value.recoveries.map((one) => one.used)).toEqual([true]);
    expect(reading.value.recoveryPending).toBe(false);
    held.fake.script({ reply: "<Output>A subsequent ordinary message.</Output>" });
    const subsequent = yield* held.owner.message("Continue normally.");
    expect(subsequent.ok).toBe(true);
    expect(held.fake.prompts).toHaveLength(4);
  });
});

describe("987 — retained unsuccessful feedback", () => {
  for (const status of ["failed", "cancelled"]) {
    it(`continues after a locally joined ${status} attempt without evaluating its controls`, function* () {
      const held = yield* useHarness();
      held.fake.script({ reply: "<REPL.Bindings />" });
      held.fake.script({
        reply: "<REPL.Submit /><Output>Untrusted failed reply.</Output>",
        ...(status === "failed" ? { failure: "Internal error" } : { cancelled: true }),
      });
      yield* held.owner.message("Inspect established work.");
      const before = held.owner.reading;
      if (!before.ok) {
        throw before.error;
      }
      expect(before.value.turns.at(-1)?.status).toBe(status);
      if (status === "failed") {
        expect(before.value.turns.at(-1)?.incomplete?.failure).toContain("Internal error");
      }
      expect(held.session.model.entries).toHaveLength(0);
      const review = yield* held.owner.reviewRecovery();
      if (!review.ok) {
        throw review.error;
      }
      held.fake.script({ reply: "<Output>A distinct new request.</Output>" });
      const result = yield* held.owner.recover(
        review.value,
        "Inspect the established result and propose the next step.",
        false,
        { current: () => true },
      );
      if (!result.ok) {
        throw result.error;
      }
      expect(held.fake.prompts).toHaveLength(3);
      expect(held.fake.turns[2]?.handle.sessionKey).toBe(held.fake.turns[0]?.handle.sessionKey);
      expect(held.fake.prompts[2]).toContain("earlier feedback".replace("earlier", "Earlier"));
      expect(held.session.model.entries).toHaveLength(0);
      expect(held.owner.reading.ok && held.owner.reading.value.recoveryPending).toBe(false);
    });
  }
});

describe("987 — exact retained ownership eligibility", () => {
  it("uses only the captured construction and clean release, without forcing ownership", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<REPL.Bindings />" });
    held.fake.script({ reply: "", failure: "Internal error" });
    yield* held.owner.message("Inspect established work.");
    const review = yield* held.owner.reviewRecovery();
    if (!review.ok) {
      throw review.error;
    }
    if (held.execution.chat.form !== "paired") {
      throw new Error("Expected paired history.");
    }
    const records = yield* held.execution.chat.writer.readAll();
    const key = held.fake.turns[0]?.handle.sessionKey;
    if (key === undefined) {
      throw new Error("The canonical turn has no session key.");
    }
    const expected = agentSessionKeyDigest({
      provider: "acpx",
      agent: "scripted-sidekick-cmd",
      sessionKey: key,
    });
    const cases: {
      state: "active" | "idle";
      release: "none" | "quiesced" | "forced";
      accepted: boolean;
    }[] = [
      { state: "idle", release: "quiesced", accepted: true },
      { state: "idle", release: "forced", accepted: false },
      { state: "active", release: "none", accepted: false },
    ];
    for (const one of cases) {
      let inspected: string | undefined;
      const result = yield* inspectRecoveryOwnership(records, review.value.conversation, {
        *inspectOwnership(keyDigest) {
          inspected = keyDigest;
          return Ok({
            keyDigest,
            recordRevision: "retained-revision",
            record: {
              keyDigest,
              state: one.state,
              release: one.release,
              ownerKind: "session",
              operationId: "retained-owner",
              lastForcedRecovery: null,
            },
          });
        },
        *forceRecoverOwnership() {
          throw new Error("Recovery must not force ownership.");
        },
      });
      expect(inspected).toBe(expected);
      expect(result.ok).toBe(one.accepted);
    }
    expect(
      (yield* inspectRecoveryOwnership(records, review.value.conversation, undefined)).ok,
    ).toBe(false);
    expect(held.fake.prompts).toHaveLength(2);
  });
});

describe("987 — recovery recording failures", () => {
  for (const cut of ["recovery-decision", "message"]) {
    it(`sends nothing and retains the actual unused state when ${cut} append fails`, function* () {
      const held = yield* useHarness();
      held.fake.script({ reply: "<REPL.Bindings />" });
      held.fake.script({ reply: "", failure: "Internal error" });
      yield* held.owner.message("Inspect established work.");
      const review = yield* held.owner.reviewRecovery();
      if (!review.ok) {
        throw review.error;
      }
      const failure = new Error(`Recording failure at ${cut}`);
      let refused = false;
      yield* ReplHost.around(
        {
          *appendRecord([path, line], next) {
            const record = parseSidekickRecord(line.trim());
            if (record?.kind === cut) {
              refused = true;
              throw failure;
            }
            if (refused) {
              throw new Error("A failed append must not cause a compensating write.");
            }
            yield* next(path, line);
          },
        },
        { at: "max" },
      );
      let observed: unknown;
      try {
        yield* scoped(() =>
          held.owner.recover(review.value, "Inspect the actual established result.", false, {
            current: () => true,
          }),
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(held.fake.prompts).toHaveLength(2);
      if (held.execution.chat.form !== "paired") {
        throw new Error("Expected paired history.");
      }
      const records = yield* held.execution.chat.writer.readAll();
      const decisions = records.filter((one) => one.kind === "recovery-decision");
      expect(decisions).toHaveLength(cut === "message" ? 1 : 0);
      const reading = projectSidekick(records);
      if (!reading.ok) {
        throw reading.error;
      }
      expect(reading.value.recoveries.every((one) => !one.used)).toBe(true);
      const before = held.fake.prompts.length;
      yield* held.owner.reviewRecovery();
      expect(held.fake.prompts).toHaveLength(before);
    });
  }
});

describe("987 — recovery permission consumption", () => {
  for (const cut of ["decision", "message", "prompt"]) {
    it(`observes passively and never reuses consumed permission after ${cut}`, function* () {
      const reached = withResolvers<void>();
      const held = yield* useHarness();
      held.fake.script({ reply: "<REPL.Bindings />" });
      held.fake.script({ reply: "", failure: "Internal error" });
      const initial = yield* held.owner.message("Inspect established work.");
      if (!initial.ok && held.fake.prompts.length === 0) {
        throw initial.error;
      }
      const review = yield* held.owner.reviewRecovery();
      if (!review.ok) {
        throw review.error;
      }
      let gate = cut === "message" ? held.fake.holdStatus() : undefined;
      yield* ensure(() => gate?.release());
      if (cut === "message") {
        held.fake.configuration({
          model: { selected: "fast", choices: [{ id: "fast", name: "Fast" }] },
        });
        const saved = yield* held.owner.configure({ model: "fast" });
        if (!saved.ok) {
          throw saved.error;
        }
      }
      let holdMessage = true;
      yield* ReplHost.around(
        {
          *appendRecord([path, line], next) {
            const record = parseSidekickRecord(line.trim());
            if (holdMessage && cut === "decision" && record?.kind === "message") {
              reached.resolve();
              yield* suspend();
            }
            yield* next(path, line);
          },
        },
        { at: "max" },
      );
      held.fake.script({ held: true, reply: "<Output>A distinct request.</Output>" });
      const task = yield* spawn(() =>
        held.owner.recover(review.value, "Inspect the actual established result.", false, {
          current: () => true,
        }),
      );
      if (cut === "decision") {
        yield* reached.operation;
      } else if (gate !== undefined) {
        yield* gate.reached;
      } else {
        yield* held.fake.holdingTurns(1);
      }
      if (held.execution.chat.form !== "paired") {
        throw new Error("Expected paired history.");
      }
      const during = projectSidekick(yield* held.execution.chat.writer.readAll());
      if (!during.ok) {
        throw during.error;
      }
      expect(during.value.recoveries[0]?.used).toBe(cut !== "decision");
      expect(held.fake.prompts).toHaveLength(cut === "prompt" ? 3 : 2);
      yield* task.halt();
      gate?.release();
      gate = undefined;
      yield* held.owner.stop();
      const before = yield* readSidekickRecords(held.execution.chat.writer.path);
      yield* held.repository.open(held.execution.id);
      yield* held.owner.reviewRecovery();
      expect(yield* readSidekickRecords(held.execution.chat.writer.path)).toEqual(before);
      const promptCount = held.fake.prompts.length;
      if (cut === "decision") {
        holdMessage = false;
        const activated = yield* spawn(() =>
          held.owner.recover(review.value, "Inspect the actual established result.", false, {
            current: () => true,
          }),
        );
        const arrival = yield* race([held.fake.holdingTurns(1), activated]);
        if (arrival !== undefined) {
          throw arrival.ok
            ? new Error("The deliberate activation returned without its new turn.")
            : arrival.error;
        }
        held.fake.releaseTurn();
        const result = yield* activated;
        if (!result.ok) {
          throw result.error;
        }
        const after = held.owner.reading;
        if (!after.ok) {
          throw after.error;
        }
        expect(after.value.recoveries).toHaveLength(1);
        expect(after.value.recoveries[0]?.used).toBe(true);
      }
      if (cut !== "decision") {
        const next = yield* held.owner.recover(
          review.value,
          "Inspect the actual established result.",
          false,
          { current: () => true },
        );
        expect(next.ok).toBe(false);
        expect(held.fake.prompts).toHaveLength(promptCount);
      }
    });
  }
});

describe("987 — outer Prompt refusal", () => {
  it("refuses recovery without rewriting an outer failed canonical Prompt", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<Output>Established first turn.</Output>" });
    yield* held.owner.message("Inspect the original conversation.");
    const known = held.owner.reading;
    if (!known.ok || known.value.active === undefined || held.execution.chat.form !== "paired") {
      throw new Error("Expected the original readable paired conversation.");
    }
    const event = parseDurableEvent(
      JSON.stringify({
        type: "yield",
        coroutineId: "root",
        description: { type: AGENT_PROMPT, name: "turn:2", input: "uncertain request" },
        result: { status: "err", error: { name: "Error", message: "Outer Prompt failure" } },
      }),
    );
    if (!event.ok) {
      throw event.error;
    }
    const writer = held.execution.chat.writer;
    yield* writer.append({
      kind: "event",
      conversation: known.value.active,
      sequence: 999,
      event: serializeDurableEvent(event.value),
    });
    const before = yield* writer.readAll();
    const review = yield* held.owner.reviewRecovery();
    expect(review.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(1);
    expect(yield* writer.readAll()).toEqual(before);
    expect(before.some((one) => one.kind === "recovery-decision")).toBe(false);
  });
});

describe("987 — joined recovery before canonical feedback publication", () => {
  it("keeps accepted old input unknown and sends only the new instruction after joined Stop", function* () {
    const reached = withResolvers<void>();
    let prompts = 0;
    yield* ReplHost.around(
      {
        *appendRecord([path, line], next) {
          const record = parseSidekickRecord(line.trim());
          if (record?.kind === "event") {
            const event = parseDurableEvent(record.event);
            if (
              event.ok &&
              event.value.type === "yield" &&
              event.value.description.type === AGENT_PROMPT &&
              ++prompts === 2
            ) {
              reached.resolve();
              yield* suspend();
            }
          }
          yield* next(path, line);
        },
      },
      { at: "max" },
    );
    const held = yield* useHarness();
    held.fake.script({ reply: "<REPL.Bindings />" });
    held.fake.script({ reply: "<Output>The old accepted result.</Output>" });
    const original = yield* spawn(() => held.owner.message("Inspect established work."));
    yield* reached.operation;
    expect(held.fake.prompts).toHaveLength(2);
    const review = yield* held.owner.reviewRecovery();
    if (!review.ok) {
      throw review.error;
    }
    expect(review.value.requests).toHaveLength(1);
    held.fake.script({ reply: "<Output>A distinct next step.</Output>" });
    const recovered = yield* held.owner.recover(
      review.value,
      "Propose the distinct next step.",
      false,
      { current: () => true },
    );
    if (!recovered.ok) {
      throw recovered.error;
    }
    yield* original;
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.prompts[2]).toContain("Propose the distinct next step.");
    expect(held.fake.turns[2]?.handle.sessionKey).toBe(held.fake.turns[0]?.handle.sessionKey);
    expect(held.owner.reading.ok && held.owner.reading.value.unestablished).toHaveLength(1);
  });
});

describe("987 — actual child reference recording faults", () => {
  for (const cut of ["offered", "acknowledged", "activation", "activation-uncertain"]) {
    it(`sends nothing and retains fatal recording precedence at ${cut}`, function* () {
      const failure = new Error(`Reference recording failure: ${cut}`);
      let asserted = false;
      try {
        yield* scoped(function* () {
          let armed = false;
          let reached = false;
          yield* ReplHost.around(
            {
              *appendRecord([path, line], next) {
                const record = parseSidekickRecord(line.trim());
                const selected =
                  armed &&
                  ((record?.kind === "recovery-reference" && record.phase === cut) ||
                    (record?.kind === "conversation" &&
                      record.phase === "activated" &&
                      cut.startsWith("activation")));
                if (selected) {
                  reached = true;
                  if (cut === "activation-uncertain") {
                    yield* next(path, line);
                  }
                  throw failure;
                }
                if (reached) {
                  throw new Error("Recording failure caused a compensating append.");
                }
                yield* next(path, line);
              },
            },
            { at: "max" },
          );
          const held = yield* useHeadlessFixture();
          held.host.fake.script({ reply: "<REPL.Bindings />" });
          held.host.fake.script({ reply: "<REPL.Submit />", failure: "Internal error" });
          const sent = yield* held.root.session.submit(promptChild("Inspect established work."));
          if (!sent.ok) {
            throw sent.error;
          }
          yield* sent.value.join();
          const terminal = recordingTerminal();
          const ui = yield* spawn(function* () {
            yield* terminal.install();
            try {
              yield* attachChildUi(held.reference.sessionId);
            } catch (error) {
              return error;
            }
            return undefined;
          });
          const click = function* (label: string, wait = true) {
            yield* held.input.ready(terminal.terminal);
            const rows = terminal.terminal.screen?.rows() ?? [];
            const found = rows.flatMap((line, row) => {
              const column = line.indexOf(label);
              return column < 0 ? [] : [{ row, column }];
            });
            const at = found.length === 1 ? found[0] : undefined;
            if (at === undefined) {
              throw new Error(`Expected one ${label}: ${rows.join("\n")}`);
            }
            const bytes = `\x1b[<0;${at.column + 1};${at.row + 1}M`;
            if (wait) {
              yield* held.input.input(terminal.terminal, bytes);
            } else {
              terminal.terminal.feed(bytes);
            }
          };
          yield* held.input.ready(terminal.terminal);
          yield* awaited(
            "the inline fallback",
            () =>
              terminal.terminal.screen?.rows().some((line) => line.includes("[Start new chat]")) ===
              true,
          );
          for (
            let step = 0;
            step < 12 &&
            !terminal.terminal.screen
              ?.rows()
              .some((row) => row.includes("> › message the sidekick"));
            step++
          ) {
            yield* held.input.input(terminal.terminal, "\t");
            yield* held.input.ready(terminal.terminal);
          }
          expect(
            terminal.terminal.screen
              ?.rows()
              .some((row) => row.includes("> › message the sidekick")),
          ).toBe(true);
          yield* held.input.input(
            terminal.terminal,
            "Inspect the established result and propose the next step.",
          );
          armed = true;
          yield* click("[Start new chat]", false);
          if (cut !== "offered") {
            yield* awaitedFact("the actual offered reference", function* () {
              return (yield* readSidekickRecords(
                pairedLocation(held.host.root, held.descriptor.execution).sidekick,
              )).some((one) => one.kind === "recovery-reference" && one.phase === "offered");
            });
            yield* held.input.ready(terminal.terminal);
            yield* click("[saved reference; continue]", false);
          }
          yield* ui;
          expect(reached).toBe(true);
          expect(held.host.fake.prompts).toHaveLength(2);
          const location = pairedLocation(held.host.root, held.descriptor.execution);
          const records = yield* readSidekickRecords(location.sidekick);
          const projected = projectSidekick(records);
          if (!projected.ok) {
            throw projected.error;
          }
          expect(projected.value.active === held.descriptor.conversation).toBe(
            cut !== "activation-uncertain",
          );
          expect(
            records.filter((one) => one.kind === "recovery-reference" && one.phase === "offered"),
          ).toHaveLength(cut === "offered" ? 0 : 1);
          expect(
            records.filter(
              (one) => one.kind === "recovery-reference" && one.phase === "acknowledged",
            ),
          ).toHaveLength(cut.startsWith("activation") ? 1 : 0);
          expect(
            records.filter((one) => one.kind === "conversation" && one.phase === "failed"),
          ).toHaveLength(0);
          yield* held.host.repository.open(held.descriptor.execution);
          expect(held.host.fake.prompts).toHaveLength(2);
          asserted = true;
        });
      } catch (error) {
        const messages: string[] = [];
        let cause: unknown = error;
        while (cause instanceof Error) {
          messages.push(cause.message);
          cause = cause.cause;
        }
        expect(messages).toEqual(
          expect.arrayContaining([expect.stringContaining(failure.message)]),
        );
      }
      expect(asserted).toBe(true);
    });
  }
});

describe("987 — exact missing original and deliberate fallback", () => {
  it("refuses unsupported cold stopping and replaces only after exact load failure and explicit action", function* () {
    const held = yield* useHarness();
    held.fake.script({ reply: "<REPL.Bindings />" });
    held.fake.script({ reply: "", failure: "Internal error" });
    yield* held.owner.message("Inspect established work.");
    const original = held.fake.turns[0]?.handle.sessionKey;
    if (original === undefined) {
      throw new Error("Expected the original native session.");
    }
    const reopened = yield* held.repository.open(held.execution.id);
    if (reopened.chat.form !== "paired") {
      throw new Error("Expected paired history.");
    }
    const chat = reopened.chat;
    let clean = false;
    const cold = yield* useSidekickOwner({
      assembly: {
        ...held.profile.sidekickAssembly,
        ownershipAdministration: {
          *inspectOwnership(keyDigest) {
            return clean
              ? Ok({
                  keyDigest,
                  recordRevision: "clean",
                  record: {
                    keyDigest,
                    state: "idle",
                    release: "quiesced",
                    ownerKind: "session",
                    operationId: "joined-owner",
                    lastForcedRecovery: null,
                  },
                })
              : Err(new Error("No supported retained controller."));
          },
          *forceRecoverOwnership() {
            throw new Error("Recovery cannot force a backend stop.");
          },
        },
      },
      chat,
      *establish() {
        return Ok(chat);
      },
      root: {
        ...rootReads(held.session, held.profile),
        *fill() {
          return Err(new Error("This witness admits no draft fill."));
        },
      },
      *submit() {
        return Err(new Error("This witness admits no entry."));
      },
      revision: () => 0,
      *acknowledge() {},
      draft: () => "",
    });
    const review = yield* cold.reviewRecovery();
    if (!review.ok) {
      throw review.error;
    }
    const before = yield* reopened.chat.writer.readAll();
    const refused = yield* cold.recover(review.value, "Inspect the established result.", false, {
      current: () => true,
    });
    expect(refused.ok).toBe(false);
    expect(yield* reopened.chat.writer.readAll()).toEqual(before);
    expect(held.fake.prompts).toHaveLength(2);
    clean = true;
    held.fake.missingSession(original);
    const missing = yield* cold.recover(review.value, "Inspect the established result.", false, {
      current: () => true,
    });
    expect(missing.ok ? missing.value.failure : missing.error.message).toContain(
      "exact retained backend session is missing",
    );
    expect(held.fake.prompts).toHaveLength(2);
    const afterFailure = cold.reading;
    if (!afterFailure.ok) {
      throw afterFailure.error;
    }
    expect(afterFailure.value.active).toBe(review.value.conversation);
    const replacement = yield* cold.reviewRecovery();
    if (!replacement.ok) {
      throw replacement.error;
    }
    held.fake.script({ reply: "<Output>A deliberately different conversation.</Output>" });
    const result = yield* cold.recover(
      replacement.value,
      "Continue from the established result in a different conversation.",
      true,
      { current: () => true },
    );
    if (!result.ok) {
      throw result.error;
    }
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.turns[2]?.handle.sessionKey).not.toBe(original);
    expect(cold.agent).toBe(held.owner.agent);
    expect(held.session.model.entries).toHaveLength(0);
  });
});

describe("987 — root whole-set reconciliation", () => {
  for (const interrupted of [false, true]) {
    it(`reconciles the acknowledged head while inspecting older History${interrupted ? " across the first outcome cut" : ""}`, function* () {
      const host = yield* useMountedHost();
      const pair = yield* host.repository.create();
      if (pair.chat.form !== "paired") {
        throw new Error("Expected paired history.");
      }
      const chat = pair.chat;
      for (const record of [...opened().slice(2), turn(1, "working"), reply(1, "working")]) {
        yield* chat.writer.append(record);
      }
      let marker = "";
      yield* scoped(function* () {
        const profile = yield* host.profile.finalize(chat.location.directory);
        const opened = yield* openReplSession({
          execution: pair,
          includes: profile.includes,
          installations: profile.installations,
          permissionMode: profile.permissionMode,
        });
        if (!opened.ok) {
          throw opened.error;
        }
        const session = opened.value;
        const journal = controlJournal(chat.writer, { conversation: CHAT, response: "r1" });
        for (const source of [
          "First actual established entry.\n",
          "Second actual established entry.\n",
        ]) {
          yield* pair.stream.settled();
          const ordinal = session.model.entries.length;
          yield* journal.began(
            { component: "REPL.Submit", arguments: {} },
            {
              ordinal,
              entry: `entry-${ordinal + 1}`,
              source,
              revision: ordinal,
              workspace: true,
              retained: yield* bindRetainedPrefix(pair.stream.path),
            },
          );
          const entry = yield* session.submit(source);
          if (!entry.ok) {
            throw entry.error;
          }
          yield* entry.value.join();
          if (ordinal === 0) {
            marker = session.model.checkpoints.at(-1)?.marker ?? "";
          }
        }
      });
      yield* chat.writer.append({
        kind: "feedback",
        conversation: CHAT,
        response: "r1",
        turn: null,
        text: "The old feedback with unknown acceptance.",
      });
      const entriesBefore = yield* until(readFile(chat.location.entries, "utf8"));
      const originalLocation = encodeLocation({
        ...initialState(pair.id).route,
        at: marker,
        inspect: true,
        view: "sidekick",
      });
      let hold = interrupted;
      const reached = withResolvers<void>();
      yield* ReplHost.around(
        {
          *appendRecord([path, line], next) {
            const record = parseSidekickRecord(line.trim());
            if (hold && record?.kind === "control-outcome" && record.order === 1) {
              reached.resolve();
              yield* suspend();
            }
            yield* next(path, line);
          },
        },
        { at: "max" },
      );
      const activate = function* (page: import("./support/repl-page.ts").ReplPage) {
        yield* page.until("the inline fallback", (one) => one.shows("[Start new chat]"));
        const pending = yield* readSidekickRecords(chat.location.sidekick);
        expect(host.fake.prompts).toHaveLength(0);
        expect(pending.filter((one) => one.kind === "recovery-decision")).toHaveLength(0);
        yield* page.press("[Start new chat]");
      };
      if (interrupted) {
        yield* scoped(function* () {
          const page = yield* useReplPage({ host, location: originalLocation });
          yield* activate(page);
          yield* reached.operation;
          const partial = yield* readSidekickRecords(chat.location.sidekick);
          expect(partial.filter((one) => one.kind === "control-outcome")).toHaveLength(1);
          page.repl.terminal.end();
          yield* awaited("the interrupted root joining", () => page.repl.outcome() !== undefined);
        });
        hold = false;
      }
      const beforeOpen = yield* until(readFile(chat.location.sidekick, "utf8"));
      const page = yield* useReplPage({ host, location: originalLocation });
      expect(yield* until(readFile(chat.location.sidekick, "utf8"))).toBe(beforeOpen);
      yield* activate(page);
      yield* page.until("the new conversation", (one) => !one.shows("[Start new chat]"));
      const final = yield* readSidekickRecords(chat.location.sidekick);
      expect(final.filter((one) => one.kind === "control-outcome")).toHaveLength(2);
      expect(yield* until(readFile(chat.location.entries, "utf8"))).toBe(entriesBefore);
      expect(host.fake.prompts).toHaveLength(0);
    });
  }
});

describe("987 — replacement preparation disposition", () => {
  for (const cut of ["setup failure", "cancelled preparation"]) {
    it(`preserves the original and never recreates a target after ${cut}`, function* () {
      const held = yield* useHarness();
      held.fake.script({ reply: "<REPL.Bindings />" });
      held.fake.script({ reply: "", failure: "Internal error" });
      yield* held.owner.message("Inspect established work.");
      const review = yield* held.owner.reviewRecovery();
      if (!review.ok) {
        throw review.error;
      }
      const waiting = withResolvers<void>();
      if (cut === "setup failure") {
        held.fake.unavailable(held.owner.agent, new Error("The new session could not be started."));
      }
      const attempt = yield* spawn(() =>
        held.owner.recover(review.value, "A distinct replacement instruction.", true, {
          current: () => true,
          *handoff() {
            waiting.resolve();
            yield* suspend();
            return Ok(undefined);
          },
        }),
      );
      if (cut === "cancelled preparation") {
        yield* waiting.operation;
        yield* attempt.halt();
      } else {
        expect((yield* attempt).ok).toBe(false);
      }
      const reading = held.owner.reading;
      if (!reading.ok) {
        throw reading.error;
      }
      expect(reading.value.active).toBe(review.value.conversation);
      expect(reading.value.conversations.filter((one) => one.phase === "failed")).toHaveLength(1);
      expect(reading.value.recoveries[0]?.withdrawn).toBe(true);
      if (held.execution.chat.form !== "paired") {
        throw new Error("Expected paired history.");
      }
      const before = yield* held.execution.chat.writer.readAll();
      yield* held.owner.reviewRecovery();
      yield* held.repository.open(held.execution.id);
      expect(yield* held.execution.chat.writer.readAll()).toEqual(before);
      expect(held.fake.prompts).toHaveLength(2);
    });
  }
});

describe("987 correction — cold prepared replacement", () => {
  it("withdraws only on deliberate action and permits a fresh decision after a real process cut", function* () {
    const root = yield* createRepositoryRoot();
    yield* ensure(() => root.discard());
    yield* runPhase("chat-open", root, "cold-preparation");
    const cut = yield* runPhase("recovery-prepared-cut", root, "cold-preparation");
    expect(cut.prompts).toBe(2);
    const before = yield* runPhase("bytes", root, "cold-preparation");
    expect(before.sidekick).toContain('"phase":"prepared"');
    expect(before.sidekick).not.toContain('"phase":"failed"');
    const resumed = yield* runPhase("recovery-prepared-reopen", root, "cold-preparation");
    expect(resumed.passive).toBe(true);
    expect(resumed.firstRefused).toBe(true);
    expect(resumed.withdrawn).toBe(true);
    expect(resumed.originalSelected).toBe(true);
    expect(resumed.renewed).toBe(true);
    expect(resumed.prompts).toHaveLength(1);
    expect(JSON.stringify(resumed.prompts)).toContain("A new deliberate replacement instruction.");
    expect(resumed.decisions).toHaveLength(2);
    expect(resumed.unknown).toBeGreaterThan(0);
  });
});

type Administration = "clean" | "active" | "forced" | "missing";
function administered(mode: Administration): AgentSessionOwnershipAdministration | undefined {
  if (mode === "missing") {
    return undefined;
  }
  return {
    *inspectOwnership(keyDigest) {
      return Ok({
        keyDigest,
        recordRevision: mode,
        record: {
          keyDigest,
          state: mode === "active" ? "active" : "idle",
          release: mode === "clean" ? "quiesced" : mode === "forced" ? "forced" : "none",
          ownerKind: "session",
          operationId: "retained-owner",
          lastForcedRecovery: null,
        },
      });
    },
    *forceRecoverOwnership() {
      throw new Error("Recovery must not force ownership.");
    },
  };
}
function reconciling(
  chat: PairedChatStorage,
  stream: { settled(): Operation<void> },
  session: Harness["session"],
): () => Operation<Result<void>> {
  return function* () {
    yield* stream.settled();
    const entries = session.reading(undefined);
    if (!entries.ok) {
      throw entries.error;
    }
    const findings = yield* coldReservations(
      yield* chat.writer.readAll(),
      entries.value.model.entries,
      chat.location.entries,
    );
    if (!findings.ok) {
      return findings;
    }
    for (const finding of findings.value) {
      yield* retainResolution(chat.writer, finding);
    }
    return Ok(undefined);
  };
}
/** Reply 1 submits one counted entry, and its automatic feedback is held streaming. */
function* counted(
  feedback: ScriptedTurn = { deltas: ["<Output>Thinking", " further.</Output>"], holdAfter: 1 },
): Operation<{ held: Harness; chat: PairedChatStorage; effects(): number }> {
  let effects = 0;
  const held = yield* useHarness(undefined, {
    entryInstallation: {
      components: [
        {
          name: "CountedEffect",
          origin: "test",
          props: { type: "object", additionalProperties: false },
          factory: () =>
            function* () {
              effects++;
              return "counted once";
            },
        },
      ],
    },
  });
  if (held.execution.chat.form !== "paired") {
    throw new Error("Expected paired history.");
  }
  held.fake.script({
    reply:
      '<Let as="code" select="code">\n```xmd\n<CountedEffect />\n```\n</Let>\n' +
      "<REPL.EntryInput>{code}</REPL.EntryInput>\n<REPL.Submit />\n<Output>Working.</Output>",
  });
  held.fake.script(feedback);
  return { held, chat: held.execution.chat, effects: () => effects };
}
function* liveFeedback(
  held: Harness,
  chat: PairedChatStorage,
): Operation<{ dispatch: SidekickDispatch; first: SidekickExchange }> {
  const dispatch = yield* useSidekickDispatch({
    owner: held.owner,
    admission: createSidekickAdmission(),
    execution: held.execution.id,
    workspace: held.workspace,
    changed() {},
    reconcile: reconciling(chat, held.execution.stream, held.session),
  });
  const first = yield* dispatch.send("Run the counted effect.");
  if (!first.ok) {
    throw first.error;
  }
  yield* held.fake.streamingTurns(1);
  dispatch.hold();
  return { dispatch, first: first.value };
}
function* stoppedFeedback(): Operation<{ held: Harness; effects(): number }> {
  const { held, chat, effects } = yield* counted();
  yield* scoped(function* () {
    const { first } = yield* liveFeedback(held, chat);
    yield* first.cancel("human");
  });
  return { held, effects };
}
function failing(kind: SidekickRecord["kind"], failure: Error, text?: string): Operation<void> {
  return ReplHost.around(
    {
      *appendRecord([path, line], next) {
        const record = parseSidekickRecord(line.trim());
        if (
          record?.kind === kind &&
          (text === undefined || (record.kind === "message" && record.text === text))
        ) {
          throw failure;
        }
        yield* next(path, line);
      },
    },
    { at: "max" },
  );
}
function* coldOwner(
  held: Harness,
  administration: AgentSessionOwnershipAdministration | undefined,
): Operation<{ owner: SidekickOwner; chat: PairedChatStorage; dispatch: SidekickDispatch }> {
  const reopened = yield* held.repository.open(held.execution.id);
  if (reopened.chat.form !== "paired") {
    throw new Error("Expected paired history.");
  }
  const chat = reopened.chat;
  const owner = yield* useSidekickOwner({
    assembly: { ...held.profile.sidekickAssembly, ownershipAdministration: administration },
    chat,
    *establish() {
      return Ok(chat);
    },
    root: {
      ...rootReads(held.session, held.profile),
      *fill() {
        return Err(new Error("This witness admits no draft fill."));
      },
    },
    *submit() {
      return Err(new Error("This witness admits no entry."));
    },
    revision: () => 0,
    *acknowledge() {},
    draft: () => "",
  });
  const dispatch = yield* useSidekickDispatch({
    owner,
    admission: createSidekickAdmission(),
    execution: held.execution.id,
    workspace: held.workspace,
    changed() {},
    reconcile: reconciling(chat, reopened.stream, held.session),
  });
  return { owner, chat, dispatch };
}
function* bytes(held: Harness): Operation<string> {
  if (held.execution.chat.form !== "paired") {
    throw new Error("Expected paired history.");
  }
  return yield* until(readFile(held.execution.chat.location.sidekick, "utf8"));
}

describe("1151 — cold ordinary Send after a retained human Stop", () => {
  for (const mode of ["clean", "active", "forced", "missing"] as const) {
    it(`A2: a cold eligible Send ${mode === "clean" ? "binds clean retained ownership" : `refuses ${mode} ownership`}`, function* () {
      const { held, effects } = yield* stoppedFeedback();
      const key = held.fake.turns[0]?.handle.sessionKey;
      const before = yield* bytes(held);
      const prompts = held.fake.prompts.length;
      expect(prompts).toBe(2);
      const cold = yield* coldOwner(held, administered(mode));
      expect(yield* bytes(held)).toBe(before);
      expect(held.fake.prompts).toHaveLength(prompts);
      expect(cold.dispatch.queue.held?.kind).toBe("stopped");
      held.fake.script({ reply: "<Output>The next step.</Output>" });
      const next = yield* cold.dispatch.send(
        "Propose the next step from the counted result.",
        { from: "composer", message: 1, draft: 0 },
        () => true,
      );
      if (mode === "clean") {
        if (!next.ok) {
          throw next.error;
        }
        const sent = yield* next.value.completion;
        if (!sent.ok) {
          throw sent.error;
        }
        expect(held.fake.prompts).toHaveLength(prompts + 1);
        expect(held.fake.prompts.at(-1)).toContain(
          "Propose the next step from the counted result.",
        );
        expect(held.fake.prompts.at(-1)).toContain("acceptance remains unknown");
        expect(held.fake.turns.at(-1)?.handle.sessionKey).toBe(key);
        const decisions = (yield* cold.chat.writer.readAll()).filter(
          (one) => one.kind === "recovery-decision",
        );
        expect(decisions.map((one) => [one.action, one.basis])).toEqual([
          ["continue-original", "retained-clean-ownership"],
        ]);
      } else {
        expect(next.ok).toBe(false);
        expect(held.fake.prompts).toHaveLength(prompts);
        expect(yield* bytes(held)).toBe(before);
        expect(cold.dispatch.queue.pending).toHaveLength(0);
      }
      expect(held.session.model.entries).toHaveLength(1);
      expect(effects()).toBe(1);
    });
  }

  it("A4: a cut before the Stop is acknowledged leaves only the existing refusal", function* () {
    const { held, chat, effects } = yield* counted();
    const reached = withResolvers<void>();
    yield* ReplHost.around(
      {
        *appendRecord([path, line], next) {
          if (parseSidekickRecord(line.trim())?.kind === "human-stop") {
            reached.resolve();
            yield* suspend();
          }
          yield* next(path, line);
        },
      },
      { at: "max" },
    );
    const { first } = yield* liveFeedback(held, chat);
    yield* spawn(() => first.cancel("human"));
    yield* reached.operation;
    const before = yield* bytes(held);
    const cold = yield* coldOwner(held, administered("clean"));
    expect(cold.owner.humanStop).toBe(undefined);
    expect(cold.dispatch.queue.held).toBe(undefined);
    const refused = yield* cold.dispatch.send("Propose the next step from the counted result.");
    expect(refused.ok ? "" : refused.error.message).toContain("cannot be established");
    const review = yield* cold.owner.reviewRecovery();
    expect(review.ok && review.value.requests).toHaveLength(1);
    expect(held.fake.prompts).toHaveLength(2);
    expect(yield* bytes(held)).toBe(before);
    expect(held.session.model.entries).toHaveLength(1);
    expect(effects()).toBe(1);
  });

  it("A4: a cut between the decision and its message needs renewed Send of the same text", function* () {
    const { held, chat, effects } = yield* counted();
    const text = "Propose the next step from the counted result.";
    const failure = new Error("Recording failure at the bound message");
    const observed = yield* scoped(function* () {
      const { dispatch, first } = yield* liveFeedback(held, chat);
      yield* first.cancel("human");
      const next = yield* dispatch.send(text);
      if (!next.ok) {
        throw next.error;
      }
      yield* failing("message", failure, text);
      expect((yield* dispatch.resume()).ok).toBe(true);
      const done = yield* next.value.completion;
      return done.ok ? undefined : done.error;
    });
    expect(observed).toBe(failure);
    const cut = yield* chat.writer.readAll();
    expect(cut.filter((one) => one.kind === "recovery-decision")).toHaveLength(1);
    expect(cut.filter((one) => one.kind === "message").map((one) => one.text)).toEqual([
      "Run the counted effect.",
    ]);
    expect(held.fake.prompts).toHaveLength(2);
    const before = yield* bytes(held);

    const other = yield* coldOwner(held, administered("clean"));
    expect(other.dispatch.queue.held?.kind).toBe("stopped");
    expect(held.fake.prompts).toHaveLength(2);
    const different = yield* other.dispatch.send("A different instruction.");
    if (!different.ok) {
      throw different.error;
    }
    expect((yield* other.dispatch.resume()).ok).toBe(true);
    yield* awaitedFact("the refused different instruction", function* () {
      return other.dispatch.queue.held?.kind === "failure";
    });
    expect(other.dispatch.queue.held?.reason).toContain("different instruction");
    expect(held.fake.prompts).toHaveLength(2);
    expect(yield* bytes(held)).toBe(before);
    yield* different.value.cancel();

    const renewed = yield* coldOwner(held, administered("clean"));
    held.fake.script({ reply: "<Output>The next step.</Output>" });
    const same = yield* renewed.dispatch.send(text);
    if (!same.ok) {
      throw same.error;
    }
    expect((yield* renewed.dispatch.resume()).ok).toBe(true);
    const sent = yield* same.value.completion;
    if (!sent.ok) {
      throw sent.error;
    }
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.prompts[2]).toContain(text);
    const after = yield* renewed.chat.writer.readAll();
    const decisions = after.filter((one) => one.kind === "recovery-decision");
    expect(decisions).toHaveLength(1);
    const messages = after.filter((one) => one.kind === "message");
    expect(messages.map((one) => one.text)).toEqual(["Run the counted effect.", text]);
    expect(messages[1]?.id).toBe(decisions[0]?.message);
    expect(after.filter((one) => one.kind === "feedback")).toHaveLength(1);
    expect(held.session.model.entries).toHaveLength(1);
    expect(effects()).toBe(1);
  });

  it("A5: a Stop whose frontier changed afterwards permits nothing", function* () {
    const { held } = yield* stoppedFeedback();
    if (held.execution.chat.form !== "paired") {
      throw new Error("Expected paired history.");
    }
    const stopped = yield* held.execution.chat.writer.readAll();
    const response = stopped.find((one) => one.kind === "response");
    if (response?.kind !== "response") {
      throw new Error("Expected the first reply's response.");
    }
    yield* held.execution.chat.writer.append({
      kind: "control",
      conversation: response.conversation,
      response: response.response,
      order: 99,
      component: "REPL.Bindings",
      arguments: {},
    });
    const before = yield* bytes(held);
    const cold = yield* coldOwner(held, administered("clean"));
    const reading = cold.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.humanStops).toHaveLength(1);
    expect(reading.value.unfinished.some((one) => one.order === 99)).toBe(true);
    expect(cold.owner.humanStop).toBe(undefined);
    expect(cold.dispatch.queue.held).toBe(undefined);
    const refused = yield* cold.dispatch.send("Propose the next step from the counted result.");
    expect(refused.ok).toBe(false);
    expect(held.fake.prompts).toHaveLength(2);
    expect(yield* bytes(held)).toBe(before);
  });

  it("A5: a failed Stop publication surfaces and leaves Send refused", function* () {
    const { held, chat } = yield* counted();
    const failure = new Error("Recording failure at the human Stop");
    yield* failing("human-stop", failure);
    let observed: unknown;
    try {
      yield* scoped(function* () {
        const { first } = yield* liveFeedback(held, chat);
        yield* first.cancel("human");
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    expect((yield* chat.writer.readAll()).some((one) => one.kind === "human-stop")).toBe(false);
    expect(held.owner.humanStop).toBe(undefined);
    const dispatch = yield* useSidekickDispatch({
      owner: held.owner,
      admission: createSidekickAdmission(),
      execution: held.execution.id,
      workspace: held.workspace,
      changed() {},
      reconcile: reconciling(chat, held.execution.stream, held.session),
    });
    expect(dispatch.queue.held).toBe(undefined);
    const refused = yield* dispatch.send("Propose the next step from the counted result.");
    expect(refused.ok ? "" : refused.error.message).toContain("cannot be established");
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("A5: a preference saved while the continuation decision waits stays outside its prefix", function* () {
    const { held } = yield* stoppedFeedback();
    held.fake.configuration({
      model: {
        selected: "default-model",
        choices: [{ id: "default-model" }, { id: "saved-model" }],
      },
    });
    const clean = administered("clean");
    if (clean === undefined) {
      throw new Error("Expected clean administration.");
    }
    const inspecting = withResolvers<void>();
    const inspected = withResolvers<void>();
    const cold = yield* coldOwner(held, {
      *inspectOwnership(digest) {
        inspecting.resolve();
        yield* inspected.operation;
        return yield* clean.inspectOwnership(digest);
      },
      forceRecoverOwnership: clean.forceRecoverOwnership,
    });
    const saving = withResolvers<void>();
    const saved = withResolvers<void>();
    yield* ensure(() => {
      inspected.resolve();
      saved.resolve();
    });
    yield* ReplHost.around(
      {
        *appendRecord([path, line], next) {
          if (parseSidekickRecord(line.trim())?.kind === "preferences") {
            saving.resolve();
            yield* saved.operation;
          }
          yield* next(path, line);
        },
      },
      { at: "max" },
    );
    const deciding = withResolvers<void>();
    const writer = cold.chat.writer;
    const append = writer.append.bind(writer);
    writer.append = function* (record) {
      if (record.kind === "recovery-decision") {
        deciding.resolve();
      }
      yield* append(record);
    };
    const appendPrepared = writer.appendPrepared.bind(writer);
    writer.appendPrepared = (prepare) => {
      deciding.resolve();
      return appendPrepared(prepare);
    };
    const text = "The exact new instruction.";
    held.fake.script({ reply: "<Output>The next step.</Output>" });
    const next = yield* cold.dispatch.send(text);
    if (!next.ok) {
      throw next.error;
    }
    expect((yield* cold.dispatch.resume()).ok).toBe(true);
    yield* inspecting.operation;
    const save = yield* spawn(() => cold.owner.configure({ model: "saved-model" }));
    yield* saving.operation;
    inspected.resolve();
    yield* deciding.operation;
    saved.resolve();
    yield* save;
    yield* awaitedFact("the continuation to send or refuse", function* () {
      return cold.dispatch.queue.held !== undefined || next.value.snapshot.terminal !== undefined;
    });
    expect(cold.dispatch.queue.held).toBe(undefined);
    const sent = yield* next.value.completion;
    if (!sent.ok) {
      throw sent.error;
    }
    if (held.execution.chat.form !== "paired") {
      throw new Error("Expected paired history.");
    }
    const read = yield* readSidekickRecords(held.execution.chat.location.sidekick);
    expect(read).toEqual(yield* writer.readAll());
    const at = read.findIndex((one) => one.kind === "recovery-decision");
    const decision = read[at];
    if (decision?.kind !== "recovery-decision") {
      throw new Error("Expected the continuation decision.");
    }
    expect(decision.retained.records).toBe(at);
    expect(read.slice(0, at).some((one) => one.kind === "preferences")).toBe(true);
    const messages = read.filter((one) => one.kind === "message");
    expect(messages.map((one) => one.text)).toEqual(["Run the counted effect.", text]);
    expect(messages[1]?.id).toBe(decision.message);
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.prompts[2]).toContain(text);
    expect(cold.dispatch.queue.held).toBe(undefined);
    const reading = cold.owner.reading;
    expect(reading.ok && reading.value.recoveries.map((one) => one.used)).toEqual([true]);
  });

  it("A3: an instruction withdrawn while its decision prefix is measured records no decision", function* () {
    const { held, chat } = yield* (function* () {
      const stopped = yield* stoppedFeedback();
      if (stopped.held.execution.chat.form !== "paired") {
        throw new Error("Expected paired history.");
      }
      return { held: stopped.held, chat: stopped.held.execution.chat };
    })();
    const writer = chat.writer;
    const appendPrepared = writer.appendPrepared.bind(writer);
    let preparing = false;
    writer.appendPrepared = (prepare) =>
      appendPrepared(function* (records) {
        preparing = true;
        try {
          return yield* prepare(records);
        } finally {
          preparing = false;
        }
      });
    let live = true;
    let measured = false;
    const withdrawn = yield* held.owner.prepareContinuation("Withdraw this instruction.", {
      current() {
        if (!preparing) {
          return live;
        }
        if (!measured) {
          measured = true;
          return live;
        }
        live = false;
        return live;
      },
    });
    expect(measured).toBe(true);
    expect(withdrawn.ok).toBe(false);
    expect(
      (yield* readSidekickRecords(chat.location.sidekick)).some(
        (one) => one.kind === "recovery-decision",
      ),
    ).toBe(false);
    expect(held.owner.reading.ok && held.owner.reading.value.recoveries).toEqual([]);
    expect(held.owner.humanStop).toBeDefined();

    const dispatch = yield* useSidekickDispatch({
      owner: held.owner,
      admission: createSidekickAdmission(),
      execution: held.execution.id,
      workspace: held.workspace,
      changed() {},
      reconcile: reconciling(chat, held.execution.stream, held.session),
    });
    expect(dispatch.queue.held?.kind).toBe("stopped");
    const text = "A different next instruction.";
    held.fake.script({ reply: "<Output>The different step.</Output>" });
    const next = yield* dispatch.send(text);
    if (!next.ok) {
      throw next.error;
    }
    expect((yield* dispatch.resume()).ok).toBe(true);
    yield* awaitedFact("the different instruction to send or refuse", function* () {
      return dispatch.queue.held !== undefined || next.value.snapshot.terminal !== undefined;
    });
    expect(dispatch.queue.held).toBe(undefined);
    const sent = yield* next.value.completion;
    if (!sent.ok) {
      throw sent.error;
    }
    expect(held.fake.prompts).toHaveLength(3);
    expect(held.fake.prompts[2]).toContain(text);
    expect(held.fake.prompts[2]).not.toContain("Withdraw this instruction.");
    const after = yield* readSidekickRecords(chat.location.sidekick);
    const decisions = after.filter((one) => one.kind === "recovery-decision");
    expect(decisions.map((one) => one.text)).toEqual([text]);
    const messages = after.filter((one) => one.kind === "message");
    expect(messages.map((one) => one.text)).toEqual(["Run the counted effect.", text]);
    expect(messages[1]?.id).toBe(decisions[0]?.message);
  });
});

function required(records: readonly SidekickRecord[], live: number | undefined): boolean {
  const projected = projectHistory(records);
  if (!projected.ok) {
    throw projected.error;
  }
  return recoveryRequired(records, projected.value, live);
}

describe("1183 — the exact live feedback request is the only exception", () => {
  function* waiting(held: Harness, chat: PairedChatStorage): Operation<SidekickDispatch> {
    const dispatch = yield* useSidekickDispatch({
      owner: held.owner,
      admission: createSidekickAdmission(),
      execution: held.execution.id,
      workspace: held.workspace,
      changed() {},
      reconcile: reconciling(chat, held.execution.stream, held.session),
    });
    const first = yield* dispatch.send("Run the counted effect.");
    if (!first.ok) {
      throw first.error;
    }
    return dispatch;
  }

  it("A4: an identical earlier request, a mismatched acknowledgement and no owner keep the guard", function* () {
    const { held, chat } = yield* counted();
    yield* waiting(held, chat);
    yield* held.fake.streamingTurns(1);
    const prefix = yield* chat.writer.readAll();
    const live = prefix.findIndex((one) => one.kind === "feedback" && one.turn === null);
    const pending = prefix[live];
    if (pending?.kind !== "feedback") {
      throw new Error("Expected the live feedback record.");
    }
    const reading = held.owner.reading;
    if (!reading.ok) {
      throw reading.error;
    }
    expect(reading.value.unestablished).toEqual([
      { conversation: pending.conversation, turn: null },
    ]);
    expect(reading.value.recoveryPending).toBe(true);
    expect(held.owner.recoveryPending).toBe(false);
    expect(required(prefix, live)).toBe(false);
    expect(required(prefix, undefined)).toBe(true);

    const repeated = [...prefix, pending];
    expect(required(repeated, repeated.length - 1)).toBe(true);
    expect(required(repeated, live)).toBe(true);
    const mismatched: SidekickRecord[] = [
      ...prefix,
      {
        kind: "feedback",
        conversation: pending.conversation,
        response: pending.response,
        turn: 1,
        text: "Something turn 1 never carried.",
      },
    ];
    expect(required(mismatched, live)).toBe(true);
    expect(held.fake.prompts).toHaveLength(2);
  });

  it("A4: a fresh owner of the held and of the failed prefix still requires recovery and sends nothing", function* () {
    const { held, chat, effects } = yield* counted({
      reply: "<Output>Unfinished</Output>",
      held: true,
      failure: "The provider failed the feedback.",
    });
    const dispatch = yield* waiting(held, chat);
    yield* held.fake.holdingTurns(1);
    expect(held.owner.recoveryPending).toBe(false);
    const before = yield* bytes(held);
    const during = yield* coldOwner(held, administered("clean"));
    expect(during.owner.recoveryPending).toBe(true);
    const refused = yield* during.dispatch.send("Explain the counted result.");
    expect(refused.ok ? "" : refused.error.message).toContain("cannot be established");
    const queued = yield* dispatch.send("When that finishes, explain the changes.");
    expect(queued.ok && queued.value.snapshot.state).toBe("queued");
    expect(held.fake.prompts).toHaveLength(2);
    expect(yield* bytes(held)).toBe(before);

    held.fake.releaseTurn();
    yield* awaitedFact("the held failure", function* () {
      return dispatch.queue.held?.kind === "failure";
    });
    expect(held.owner.recoveryPending).toBe(true);
    const after = yield* coldOwner(held, administered("clean"));
    expect(after.owner.recoveryPending).toBe(true);
    const again = yield* after.dispatch.send("Explain the counted result.");
    expect(again.ok ? "" : again.error.message).toContain("cannot be established");
    const read = after.owner.reading;
    if (!read.ok) {
      throw read.error;
    }
    expect(read.value.unestablished).toEqual([{ conversation: read.value.active, turn: null }]);
    expect(dispatch.queue.pending.map((one) => one.text)).toEqual([
      "When that finishes, explain the changes.",
    ]);
    expect(held.fake.prompts).toHaveLength(2);
    expect(held.session.model.entries).toHaveLength(1);
    expect(effects()).toBe(1);
  });
});
