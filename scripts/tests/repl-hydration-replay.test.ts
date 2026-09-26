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
import { answered, elicitation, resume, SCRIPT } from "../repl-hydration/replay.ts";
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
    expect(second.performed).toEqual([]);
    expect(second.frontier).toEqual({
      kind: "awaiting",
      wait: "token",
      prompt: SECRET.prompt,
      secret: true,
    });
  });

  it("runs to completion once every answer is recorded, performing nothing twice", function* () {
    const secrets = scriptedSecrets({ token: TOKEN });
    const finished = ran(
      resume({ script: SCRIPT, prior: bothAnswered(), secrets, streaming: createStreaming() }),
    );

    expect(finished.frontier).toEqual({ kind: "complete" });
    expect(finished.performed).toEqual([]);
    expect(finished.consumed).toEqual(["agent entry-1/document/draft", "publish notes"]);

    // The document finished, and the journal it finished on projects.
    const events = parseJournal(finished.records);
    if (!events.ok) {
      throw events.error;
    }
    const model = projectPrefix(EXECUTION, events.value, undefined);
    if (!model.ok) {
      throw model.error;
    }
    expect(model.value.entries[0].outcome).toEqual({ status: "settled" });
    expect(model.value.bindings.map((one) => one.name)).toEqual(["notes"]);
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
      expect(honest.consumed).toEqual(ignoring.performed);
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

    it("streamed-into-the-record: partial chunks in the journal survive a restart that never saw them", function* () {
      const { run } = firstRun();
      const smuggled = [
        ...run.records,
        {
          id: "x-01",
          seq: run.records.length + 1,
          at: 99,
          kind: "outcome.recorded",
          entry: "entry-1",
          scope: ["document", "draft"],
          label: "Rele",
        },
      ];

      // It parses, which is exactly why the discipline is at the producer:
      // nothing downstream can tell a chunk from an admitted result.
      expect(parseJournal(smuggled).ok).toBe(true);
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
