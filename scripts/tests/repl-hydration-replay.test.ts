/**
 * What survives a restart, and what must not.
 *
 * Slice 3 of #842. Slices 1 and 2 showed that a Journal and a URL determine
 * the view; this asks what happens when the process that produced them is
 * gone. Three things are being separated:
 *
 * - typing, which moves the URL and touches neither the Journal nor the
 *   ordinary navigation history;
 * - an Agent's partial output, which is how someone watched it think, against
 *   its admitted result, which is what happened;
 * - a recovered answer, which replay reads out of the record, against a
 *   secret, which it can only ask for again.
 *
 * The document is a fixture and there is no model provider anywhere near it:
 * `SCRIPT` is a deterministic list of steps, and the whole point is that it
 * can be run twice and the two runs compared.
 *
 * The secret used throughout is a literal this file owns, so "it appears
 * nowhere" is a claim the evidence can actually search for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { createStreaming, noSecrets, scriptedSecrets } from "../repl-hydration/ephemeral.ts";
import { parseJournal } from "../repl-hydration/journal.ts";
import * as overlay from "../repl-hydration/overlay.ts";
import { projectPrefix } from "../repl-hydration/project.ts";
import {
  answered,
  elicitation,
  ExecutionGap,
  ReplayDivergence,
  resume,
  SCRIPT,
} from "../repl-hydration/replay.ts";
import type { Run } from "../repl-hydration/replay.ts";
import { hydrate } from "../repl-hydration/store.ts";
import type { ReplSession } from "../repl-hydration/store.ts";

/** The secret, written once so the evidence can hunt for it. */
const TOKEN = "npm_Ie4Xz9QqSECRETvalue";
const EXECUTION = "e3";

const CHANNEL = elicitation("channel");
const SECRET = elicitation("token");

function ran(run: ReturnType<typeof resume>): Run {
  if (!run.ok) {
    throw run.error;
  }
  return run.value;
}

function recorded(records: readonly unknown[], step = CHANNEL, value = "#releases") {
  const next = answered(records, step, value);
  if (!next.ok) {
    throw next.error;
  }
  return next.value;
}

/** The journal of a first run that stopped at the ordinary elicitation. */
function firstRun() {
  const streaming = createStreaming();
  const run = ran(resume({ script: SCRIPT, prior: [], streaming, secrets: noSecrets() }));
  return { run, streaming };
}

/** The journal where the secret has been asked and not yet answered. */
function awaitingSecret(): readonly unknown[] {
  const first = ran(
    resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
  );
  const withChannel = recorded(first.records, CHANNEL, "#releases");
  return ran(
    resume({
      script: SCRIPT,
      prior: withChannel,
      streaming: createStreaming(),
      secrets: noSecrets(),
    }),
  ).records;
}

/** The journal after both answers were recorded: what a restart would find. */
function bothAnswered(): readonly unknown[] {
  return recorded(awaitingSecret(), SECRET, "");
}

/** The journal of a document that ran all the way to the end. */
function finished(): readonly unknown[] {
  return ran(
    resume({
      script: SCRIPT,
      prior: bothAnswered(),
      secrets: scriptedSecrets({ token: TOKEN }),
      streaming: createStreaming(),
    }),
  ).records;
}

function* open(url: string, records: readonly unknown[]): Operation<ReplSession> {
  const session = yield* hydrate(EXECUTION, url, records);
  if (!session.ok) {
    throw session.error;
  }
  return session.value;
}

describe("a draft is not a record and not a visit", () => {
  const AT = "xmd://repl/e3/transcript/entry-1/document";

  it("moves the URL and nothing else", function* () {
    const records = bothAnswered();
    const session = yield* open(AT, records);
    const before = session.semantic();

    for (const draft of ["g", "gi", "git"]) {
      const typed = yield* session.type(draft);
      expect(typed.ok).toBe(true);
    }

    const after = session.semantic();
    expect(after.url).toBe(`${AT}?draft=git`);
    expect(after.url).not.toBe(before.url);

    // The Journal did not move, and neither did anything projected from it.
    expect(session.state().records).toEqual(records);
    expect(after.model).toEqual(before.model);
    expect(after.history).toEqual(before.history);

    // Three keystrokes are one place, not three.
    expect(session.visits()).toEqual([`${AT}?draft=git`]);
  });

  it("grows the navigation history when the location actually changes", function* () {
    const session = yield* open(AT, bothAnswered());
    yield* session.type("gi");
    const moved = yield* session.navigate("xmd://repl/e3/bindings");
    expect(moved.ok).toBe(true);
    yield* session.type("no");

    expect(session.visits()).toEqual([`${AT}?draft=gi`, "xmd://repl/e3/bindings?draft=no"]);
    expect(session.state().records.length).toBe(bothAnswered().length);
  });

  it("keeps the draft out of every record kind", function* () {
    const session = yield* open(AT, bothAnswered());
    yield* session.type("something typed and never run");

    const serialized = JSON.stringify(session.state().records);
    expect(serialized).not.toContain("something typed");
    expect(session.semantic().url).toContain("something%20typed");
  });
});

describe("an Agent's stream is not its result", () => {
  it("streams while it runs and records only what was admitted", function* () {
    const { run, streaming } = firstRun();

    expect(run.performed).toContain("agent entry-1/document/draft");
    expect(run.consumed).toEqual([]);
    // The chunks went somewhere process-local and were dropped at admission.
    expect(streaming.streaming()).toEqual([]);
    expect(run.streaming).toEqual([]);

    const events = parseJournal(run.records);
    if (!events.ok) {
      throw events.error;
    }
    const outcomes = events.value.filter((event) => event.kind === "outcome.recorded");
    expect(outcomes.length).toBe(1);
    expect(JSON.stringify(run.records)).not.toContain('Rele"');
    expect(JSON.stringify(run.records)).toContain("Release notes for 0.14.0");
  });

  it("shows the admitted result and its scopes after a cold restart, and no partial text", function* () {
    const records = bothAnswered();
    const streaming = createStreaming();
    const replayed = ran(
      resume({
        script: SCRIPT,
        prior: records,
        secrets: scriptedSecrets({ token: TOKEN }),
        streaming,
      }),
    );

    // The Agent did not run: its result was read out of the record.
    expect(replayed.performed).toEqual([]);
    expect(replayed.consumed).toContain("agent entry-1/document/draft");
    expect(streaming.streaming()).toEqual([]);

    const session = yield* open("xmd://repl/e3/transcript/entry-1/document/draft", records);
    const draft = session.semantic().model.entries[0].scopes[0].children[0];
    expect(draft.name).toBe("draft");
    // The semantic scope the admitted result created survives with it.
    expect(draft.children.map((scope) => scope.name)).toEqual(["review"]);
    expect(session.semantic().model.outcomes.map((one) => one.label)).toEqual([
      "Release notes for 0.14.0",
    ]);
    expect(JSON.stringify(session.state())).not.toContain('"Rele"');
  });
});

describe("replay consumes what was recorded and stops at the frontier", () => {
  it("reaches the first unanswered elicitation without repeating anything", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );

    expect(first.frontier).toEqual({
      kind: "awaiting",
      wait: "channel",
      prompt: CHANNEL.prompt,
      secret: false,
    });
    expect(first.performed).toEqual(["agent entry-1/document/draft", "publish notes"]);

    // Run it again over what it wrote: the same position, nothing performed.
    const again = ran(
      resume({
        script: SCRIPT,
        prior: first.records,
        streaming: createStreaming(),
        secrets: noSecrets(),
      }),
    );
    expect(again.frontier).toEqual(first.frontier);
    expect(again.performed).toEqual([]);
    expect(again.consumed).toEqual(["agent entry-1/document/draft", "publish notes"]);
    expect(again.records).toEqual(first.records);
  });

  it("recovers an ordinary answer from the record and advances the frontier", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const secrets = scriptedSecrets({ token: TOKEN });
    const second = ran(
      resume({
        script: SCRIPT,
        prior: recorded(first.records, CHANNEL, "#releases"),
        secrets,
        streaming: createStreaming(),
      }),
    );

    expect(second.recovered).toEqual(["channel=#releases"]);
    expect(secrets.asked).toEqual([]);

    // The recovered answer reached the continuation, not just the report:
    // the step after it publishes what the person said.
    expect(second.performed).toEqual(["publish announced"]);
    const announced = second.records.find((record) => Object(record).name === "announced");
    expect(Object(announced).value).toBe("#releases");

    expect(second.frontier).toEqual({
      kind: "awaiting",
      wait: "token",
      prompt: SECRET.prompt,
      secret: true,
    });
  });

  it("runs to completion once every answer is recorded, performing nothing twice", function* () {
    const secrets = scriptedSecrets({ token: TOKEN });
    const run = ran(
      resume({ script: SCRIPT, prior: bothAnswered(), secrets, streaming: createStreaming() }),
    );

    expect(run.frontier).toEqual({ kind: "complete" });
    expect(run.performed).toEqual([]);
    expect(run.consumed).toEqual([
      "agent entry-1/document/draft",
      "publish notes",
      "publish announced",
    ]);

    // The document finished, and the journal it finished on projects.
    const events = parseJournal(run.records);
    if (!events.ok) {
      throw events.error;
    }
    const model = projectPrefix(EXECUTION, events.value, undefined);
    if (!model.ok) {
      throw model.error;
    }
    expect(model.value.entries[0].outcome).toEqual({ status: "settled" });
    expect(model.value.bindings.map((one) => one.name)).toEqual(["notes", "announced"]);
  });
});

describe("a secret is asked for again, never recovered", () => {
  it("records that it was asked and answered, and nothing of what was said", function* () {
    const records = bothAnswered();
    const events = parseJournal(records);
    if (!events.ok) {
      throw events.error;
    }

    const opened = events.value.filter((event) => event.kind === "suspension.opened");
    const secret = opened.find((event) => event.kind === "suspension.opened" && event.secret);
    expect(secret?.kind).toBe("suspension.opened");

    const answers = events.value.filter((event) => event.kind === "suspension.answered");
    expect(
      answers.map((event) => (event.kind === "suspension.answered" ? event.answer : "?")),
    ).toEqual(["#releases", ""]);
  });

  it("re-prompts on replay rather than reading a value that is not there", function* () {
    const secrets = scriptedSecrets({ token: TOKEN });
    const replayed = ran(
      resume({ script: SCRIPT, prior: bothAnswered(), secrets, streaming: createStreaming() }),
    );

    expect(replayed.frontier).toEqual({ kind: "complete" });
    expect(secrets.asked).toEqual(["token"]);
    expect(replayed.asked).toEqual(["token"]);
    expect(replayed.recovered).toEqual(["channel=#releases"]);
  });

  it("stops at the secret frontier when nobody is there to ask", function* () {
    const secrets = noSecrets();
    const headless = ran(
      resume({ script: SCRIPT, prior: bothAnswered(), secrets, streaming: createStreaming() }),
    );

    expect(headless.frontier).toEqual({
      kind: "unrevealed",
      wait: "token",
      prompt: SECRET.prompt,
    });
    expect(secrets.asked).toEqual(["token"]);
  });

  it("appears in no journal, URL, store, history or error", function* () {
    const records = bothAnswered();
    const secrets = scriptedSecrets({ token: TOKEN });
    const replayed = ran(
      resume({ script: SCRIPT, prior: records, secrets, streaming: createStreaming() }),
    );

    const session = yield* open("xmd://repl/e3/transcript/entry-1/document/publish", records);
    yield* session.type(TOKEN.slice(0, 4));

    const refused = yield* session.navigate("xmd://repl/e3/transcript/entry-9");
    expect(refused.ok).toBe(false);

    const surfaces = [
      JSON.stringify(records),
      JSON.stringify(replayed),
      JSON.stringify(session.state()),
      JSON.stringify(session.semantic()),
      JSON.stringify(session.visits()),
      JSON.stringify(secrets.asked),
      refused.ok ? "" : `${refused.error.name} ${refused.error.message}`,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(TOKEN);
    }
  });

  it("refuses a journal that recorded a secret's value", function* () {
    // The same wait, answered as though it were ordinary. A record like this
    // is well formed, so the parser reads it; the projection is what refuses
    // it, because only the projection knows the wait was opened as secret.
    const leaked = answered(awaitingSecret(), { ...SECRET, secret: false }, TOKEN);
    if (!leaked.ok) {
      throw leaked.error;
    }

    const events = parseJournal(leaked.value);
    expect(events.ok).toBe(true);
    if (!events.ok) {
      return;
    }
    const projected = projectPrefix(EXECUTION, events.value, undefined);
    expect(projected.ok).toBe(false);
    if (projected.ok) {
      return;
    }
    expect(projected.error.message).toContain("with a recorded value");
    expect(projected.error.message).not.toContain(TOKEN);

    // The helper refuses to write one in the first place.
    expect(answered([], SECRET, TOKEN).ok).toBe(false);
  });
});

describe("replay consumes only its own records", () => {
  function replayed(prior: readonly unknown[]) {
    return resume({
      script: SCRIPT,
      prior,
      streaming: createStreaming(),
      secrets: scriptedSecrets({ token: TOKEN }),
    });
  }

  function diverged(prior: readonly unknown[]): ReplayDivergence {
    const run = replayed(prior);
    if (run.ok) {
      throw new Error("the journal was resumed, and should not have been");
    }
    if (!(run.error instanceof ReplayDivergence)) {
      throw run.error;
    }
    return run.error;
  }

  /** The representative journal with one record's fields changed. */
  function changing(prior: readonly unknown[], at: number, changes: Record<string, unknown>) {
    return prior.map((record, index) =>
      index === at ? { ...Object(record), ...changes } : record,
    );
  }

  function positionOf(prior: readonly unknown[], kind: string): number {
    const at = prior.findIndex((record) => Object(record).kind === kind);
    if (at === -1) {
      throw new Error(`no ${kind} in this journal`);
    }
    return at;
  }

  it("refuses a journal that submitted another entry", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    // A coherent journal belonging to another document, not a damaged one:
    // it projects perfectly well, and it is still not this document's past.
    const foreign = first.records.map((record) => ({ ...Object(record), entry: "other-entry" }));
    const before = JSON.stringify(foreign);
    const refusal = diverged(foreign);

    expect(refusal.position).toBe(0);
    expect(refusal.expected).toContain('entry.submitted "entry-1"');
    expect(refusal.found).toContain("other-entry");
    // Nothing ran and nothing was written: the journal handed in is intact.
    expect(JSON.stringify(foreign)).toBe(before);
  });

  it("refuses another binding under the right record kind", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const at = positionOf(first.records, "binding.published");
    const refusal = diverged(changing(first.records, at, { name: "other", value: "wrong" }));

    expect(refusal.position).toBe(at);
    expect(refusal.expected).toContain('binding.published "notes"');
    expect(refusal.found).toContain('"other"');
  });

  it("refuses another Agent occurrence under outcome.recorded", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const at = positionOf(first.records, "outcome.recorded");

    // The result is untouched; only the request differs. Matching on what
    // came back rather than what was asked would have accepted this.
    const refusal = diverged(
      changing(first.records, at, { request: "entry-1/document/elsewhere" }),
    );
    expect(refusal.position).toBe(at);
    expect(refusal.expected).toContain("entry-1/document/draft");
    expect(refusal.found).toContain("elsewhere");

    const moved = diverged(changing(first.records, at, { scope: ["document"] }));
    expect(moved.position).toBe(at);
  });

  it("refuses another suspension under the right record kind", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const at = positionOf(first.records, "suspension.opened");
    const renamed = diverged(changing(first.records, at, { wait: "elsewhere" }));

    expect(renamed.position).toBe(at);
    expect(renamed.expected).toContain('suspension.opened "channel"');
    expect(renamed.found).toContain("elsewhere");

    // An answer that belongs to no open wait never reaches alignment: the
    // projection refuses it first, which is the earlier of the two guards.
    const records = bothAnswered();
    const answers = records.findIndex((record) => Object(record).kind === "suspension.answered");
    expect(replayed(changing(records, answers, { wait: "elsewhere" })).ok).toBe(false);
  });

  it("refuses a retained record left over once the document has finished", function* () {
    const complete = finished();
    // A perfectly valid record — a second entry may follow a settled one —
    // that this document nonetheless does not write.
    const extra = [
      ...complete,
      {
        id: "x-01",
        seq: complete.length + 1,
        at: 99,
        kind: "entry.submitted",
        entry: "entry-2",
        title: "Something this document never submits",
      },
    ];

    const refusal = diverged(extra);
    expect(refusal.position).toBe(complete.length);
    expect(refusal.expected).toContain("the document to be finished");
    expect(refusal.found).toContain("entry-2");

    // The same journal without it resumes to completion and appends nothing.
    const run = ran(replayed(complete));
    expect(run.frontier).toEqual({ kind: "complete" });
    expect(run.records).toEqual(complete);
  });

  it("performs the first unrecorded effect exactly once on a compatible prefix", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const agentAt = positionOf(first.records, "outcome.recorded");
    // Everything up to and including the admitted Agent result, and no more.
    const prefix = first.records.slice(0, agentAt + 1);

    const run = ran(replayed(prefix));
    expect(run.consumed).toEqual(["agent entry-1/document/draft"]);
    expect(run.performed).toEqual(["publish notes"]);
    expect(run.frontier).toEqual({
      kind: "awaiting",
      wait: "channel",
      prompt: CHANNEL.prompt,
      secret: false,
    });

    // Once, not twice: resuming over what it just wrote performs nothing.
    const again = ran(replayed(run.records));
    expect(again.performed).toEqual([]);
    expect(again.consumed).toEqual(["agent entry-1/document/draft", "publish notes"]);
    expect(again.records).toEqual(run.records);
  });

  it("performs nothing at all on an exact replay", function* () {
    const records = finished();
    const run = ran(replayed(records));

    expect(run.performed).toEqual([]);
    expect(run.consumed).toEqual([
      "agent entry-1/document/draft",
      "publish notes",
      "publish announced",
    ]);
    expect(run.records).toEqual(records);
    expect(run.frontier).toEqual({ kind: "complete" });

    // An unfinished journal appends the records its remaining steps write,
    // and still performs no durable effect that is already recorded.
    const partial = ran(replayed(bothAnswered()));
    expect(partial.performed).toEqual([]);
    expect(partial.records.length).toBeGreaterThan(bothAnswered().length);
  });

  it("refuses a journal that reads but cannot have happened, before performing anything", function* () {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    // A scope completed twice describes a run the projection refuses, and the
    // refusal has to arrive before any effect does.
    const impossible = [
      ...first.records.slice(0, 3),
      first.records[5],
      ...first.records.slice(3),
    ].map((record, index) => ({ ...Object(record), seq: index + 1 }));

    const run = replayed(impossible);
    expect(run.ok).toBe(false);
  });

  describe("negative controls", () => {
    it("kind-only-replay: matching on the record kind consumes another document's records", function* () {
      const first = ran(
        resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
      );
      const kindOnly = (one: unknown, other: unknown) => Object(one).kind === Object(other).kind;

      const foreign = changing(first.records, 0, { entry: "other-entry" });
      const wrongBinding = changing(first.records, positionOf(first.records, "binding.published"), {
        name: "other",
        value: "wrong",
      });
      const wrongAgent = changing(first.records, positionOf(first.records, "outcome.recorded"), {
        request: "entry-1/document/elsewhere",
      });
      const leftOver = [
        ...finished(),
        {
          id: "x-01",
          seq: finished().length + 1,
          at: 99,
          kind: "entry.submitted",
          entry: "entry-2",
          title: "Something this document never submits",
        },
      ];

      // A kind-only reader sees nothing wrong with any of the first three,
      // and has no opinion at all about the fourth.
      expect(kindOnly(foreign[0], first.records[0])).toBe(true);
      expect(
        kindOnly(
          wrongBinding[positionOf(first.records, "binding.published")],
          first.records[positionOf(first.records, "binding.published")],
        ),
      ).toBe(true);
      expect(
        kindOnly(
          wrongAgent[positionOf(first.records, "outcome.recorded")],
          first.records[positionOf(first.records, "outcome.recorded")],
        ),
      ).toBe(true);

      for (const journal of [foreign, wrongBinding, wrongAgent, leftOver]) {
        expect(replayed(journal).ok).toBe(false);
      }
    });
  });
});

describe("a matched operation returns its recorded result", () => {
  const RESTORED = "RESTORED AGENT RESULT";

  /** The valid prefix through the admitted Agent result, with that result altered. */
  function altered(): readonly unknown[] {
    const first = ran(
      resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
    );
    const at = first.records.findIndex((record) => Object(record).kind === "outcome.recorded");
    return first.records
      .slice(0, at + 1)
      .map((record, index) => (index === at ? { ...Object(record), label: RESTORED } : record));
  }

  function replayed(prior: readonly unknown[]) {
    return ran(
      resume({
        script: SCRIPT,
        prior,
        streaming: createStreaming(),
        secrets: scriptedSecrets({ token: TOKEN }),
      }),
    );
  }

  it("publishes the recorded Agent result, not the one the script would have produced", function* () {
    const prior = altered();
    const run = replayed(prior);

    // 1. The Agent is consumed, not performed.
    expect(run.consumed).toEqual(["agent entry-1/document/draft"]);
    expect(run.performed).toEqual(["publish notes"]);

    // 2 and 3. The binding is published once, carrying the recorded result.
    const published = run.records.filter(
      (record) => Object(record).kind === "binding.published" && Object(record).name === "notes",
    );
    expect(published.length).toBe(1);
    expect(Object(published[0]).value).toBe(RESTORED);
    expect(Object(published[0]).value).not.toBe("Release notes for 0.14.0");

    // 4. Resuming what it wrote performs nothing.
    const again = replayed(run.records);
    expect(again.performed).toEqual([]);
    expect(again.consumed).toEqual(["agent entry-1/document/draft", "publish notes"]);
    expect(again.records).toEqual(run.records);
  });

  it("projects the altered result and the binding derived from it", function* () {
    const run = replayed(altered());
    const events = parseJournal(run.records);
    if (!events.ok) {
      throw events.error;
    }
    const model = projectPrefix(EXECUTION, events.value, undefined);
    if (!model.ok) {
      throw model.error;
    }

    // 5. A cold projection of the resulting journal agrees with both.
    expect(model.value.outcomes.map((one) => one.label)).toEqual([RESTORED]);
    const notes = model.value.bindings.find((one) => one.name === "notes");
    expect(notes?.value).toBe(RESTORED);
    expect(JSON.stringify(model.value)).not.toContain("Release notes for 0.14.0");
  });

  it("refuses a step whose value nothing before it produced", function* () {
    const orphan = SCRIPT.filter((step) => !(step.kind === "agent" && step.produces === "notes"));
    const run = resume({
      script: orphan,
      prior: [],
      streaming: createStreaming(),
      secrets: noSecrets(),
    });

    expect(run.ok).toBe(false);
    if (run.ok) {
      return;
    }
    expect(run.error).toBeInstanceOf(ExecutionGap);
    expect(run.error.message).toContain('publish notes needs "notes"');
  });

  describe("negative controls", () => {
    it("discarded-result: recognizing the record and then using the script's own literal", function* () {
      const prior = altered();
      const run = replayed(prior);
      const agent = SCRIPT.find((step) => step.kind === "agent");
      if (agent === undefined || agent.kind !== "agent") {
        throw new Error("the document has no Agent step");
      }

      // A replay that matched the record, reported it consumed, and then let
      // the continuation read `step.admitted` would publish this instead.
      const discarded = agent.admitted;
      const restored = Object(
        run.records.find(
          (record) =>
            Object(record).kind === "binding.published" && Object(record).name === "notes",
        ),
      ).value;

      expect(discarded).toBe("Release notes for 0.14.0");
      expect(restored).toBe(RESTORED);
      expect(restored).not.toBe(discarded);

      // And the script has no second copy of the result to fall back to.
      const publishes = SCRIPT.filter((step) => step.kind === "publish");
      expect(publishes.length).toBeGreaterThan(0);
      for (const step of publishes) {
        expect(Object.keys(step)).not.toContain("value");
      }
    });
  });
});

describe("process loss offers replay, not Continue", () => {
  it("removes Continue and claims no pause, while the reconstruction is unchanged", function* () {
    const records = bothAnswered();
    const events = parseJournal(records);
    if (!events.ok) {
      throw events.error;
    }
    const waits = events.value.filter((event) => event.kind === "suspension.opened");
    const at = waits[waits.length - 1].id;

    const live = yield* open(`xmd://repl/e3/transcript?at=${at}`, records);
    expect(live.semantic().model.marker).toBe(at);

    // A process that is holding expansion there offers Continue.
    expect(overlay.canContinueAt(overlay.live(at), live.semantic().model.marker)).toBe(true);

    // The same records and the same URL, read by a process that holds
    // nothing. Continue is gone; the reconstruction is byte-for-byte the one
    // the live process had.
    const cold = yield* open(`xmd://repl/e3/transcript?at=${at}`, records);
    expect(overlay.canContinueAt(overlay.cold(), cold.semantic().model.marker)).toBe(false);
    expect(cold.semantic()).toEqual(live.semantic());

    // What a cold process has instead of Continue is a frontier.
    const headless = ran(
      resume({
        script: SCRIPT,
        prior: records,
        secrets: noSecrets(),
        streaming: createStreaming(),
      }),
    );
    expect(headless.frontier.kind).toBe("unrevealed");
    for (const word of ["EXPANSION PAUSED", "canContinue", "pauseMarker", "held"]) {
      expect(JSON.stringify(cold.state())).not.toContain(word);
    }
  });

  describe("negative controls", () => {
    it("replay-reperforms: a run that ignores the record does the durable work twice", function* () {
      const records = bothAnswered();
      const honest = ran(
        resume({
          script: SCRIPT,
          prior: records,
          secrets: scriptedSecrets({ token: TOKEN }),
          streaming: createStreaming(),
        }),
      );
      // A replay that started from nothing would perform everything again,
      // and the effects it names are the ones that must not repeat.
      const ignoring = ran(
        resume({ script: SCRIPT, prior: [], streaming: createStreaming(), secrets: noSecrets() }),
      );

      expect(ignoring.performed).toEqual(["agent entry-1/document/draft", "publish notes"]);
      expect(honest.performed).toEqual([]);
      // Every effect the ignoring run carried out is one the honest run read
      // out of the record instead.
      for (const effect of ignoring.performed) {
        expect(honest.consumed).toContain(effect);
      }
    });

    it("recoverable-secret: an answer in the record makes the re-prompt disappear", function* () {
      const secrets = scriptedSecrets({ token: TOKEN });
      ran(resume({ script: SCRIPT, prior: bothAnswered(), secrets, streaming: createStreaming() }));
      expect(secrets.asked).toEqual(["token"]);

      // Treating the secret as ordinary is what a recoverable answer would
      // look like: nobody is asked, and the value would have to be somewhere.
      const ordinary = scriptedSecrets({ token: TOKEN });
      const script = SCRIPT.map((step) =>
        step.kind === "elicit" && step.wait === "token" ? { ...step, secret: false } : step,
      );
      const run = ran(
        resume({ script, prior: bothAnswered(), secrets: ordinary, streaming: createStreaming() }),
      );

      expect(ordinary.asked).toEqual([]);
      expect(run.recovered).toEqual(["channel=#releases", "token="]);
    });

    it("streamed-into-the-record: a chunk under the right request is still the producer's job", function* () {
      const { run } = firstRun();
      const chunk = {
        id: "x-01",
        seq: 1,
        at: 1,
        kind: "outcome.recorded",
        entry: "entry-1",
        scope: ["document", "draft"],
        request: "entry-1/document/draft",
        label: "Rele",
      };

      // Under a request nobody asked for, alignment turns it away.
      const foreign = resume({
        script: SCRIPT,
        prior: [{ ...chunk, request: "entry-1/document/elsewhere" }],
        streaming: createStreaming(),
        secrets: noSecrets(),
      });
      expect(foreign.ok).toBe(false);

      // Under the *right* request it aligns, and nothing downstream can tell
      // a chunk from the result: both are text under one durable name. That
      // is why admission discards the buffer at the producer instead of a
      // reader guessing whether the label looks finished.
      expect(parseJournal([chunk]).ok).toBe(true);
      expect(JSON.stringify(run.records)).not.toContain('"Rele"');
      expect(run.consumed).toEqual([]);
    });

    it("draft-as-a-visit: pushing on every keystroke buries where the person came from", function* () {
      const session = yield* open("xmd://repl/e3/bindings", bothAnswered());
      const pushed: string[] = [session.semantic().url];
      for (const draft of ["g", "gi", "git"]) {
        yield* session.type(draft);
        pushed.push(session.semantic().url);
      }

      expect(pushed.length).toBe(4);
      expect(session.visits()).toEqual(["xmd://repl/e3/bindings?draft=git"]);
    });
  });
});
