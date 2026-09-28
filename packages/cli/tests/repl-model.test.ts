/**
 * What the REPL knows, and where it learned it (#848 M1, M2).
 *
 * Every journal here is produced by really executing the reference entry, so
 * what is under test is the projector against the vocabulary the current runtime
 * writes. The negative controls doctor that real journal one member at a time:
 * a history this slice forbids, a payload that will not read, and an owning
 * source position removed or pointed somewhere else. Each has to come back as
 * `Err` with no model at all, because a model built from a guess would show a
 * binding in a scope that never published it.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempFileCompiler } from "@executablemd/core";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";

import { ENTRY_SCOPE, projectRepl } from "../src/repl/model.ts";
import type { ReplModel, ReplScope } from "../src/repl/model.ts";
import {
  agentReferenceEvents,
  answering,
  REFERENCE_ANSWER,
  referenceEvents,
  runReference,
} from "./fixtures/repl/reference.ts";

/** The projected model, or a failure the test reports instead of asserting past. */
function projected(events: readonly DurableEvent[], selection?: string): ReplModel {
  const result = projectRepl(events, selection);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** The refusal a doctored journal produced, or a failure naming what passed. */
function refusal(events: readonly DurableEvent[], selection?: string): string {
  const result = projectRepl(events, selection);
  if (result.ok) {
    throw new Error("the projection accepted a journal it must refuse");
  }
  return result.error.message;
}

/** The same journal, through the protocol's own text form. */
function copied(events: readonly DurableEvent[]): DurableEvent[] {
  return events.map((event) => {
    const parsed = parseDurableEvent(serializeDurableEvent(event));
    if (!parsed.ok) {
      throw parsed.error;
    }
    return parsed.value;
  });
}

/**
 * Every object and array reachable from a value, itself included.
 *
 * The whole graph rather than the top level, because the value a projection is
 * tempted to freeze in place is nested several members down inside a recorded
 * result.
 */
function reachable(value: unknown, seen: Set<object> = new Set()): object[] {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const found: object[] = [value];
  for (const member of Object.values(value)) {
    found.push(...reachable(member, seen));
  }
  return found;
}

/** The mutable `plan` object one recorded evaluation published. */
function publishedPlan(events: readonly DurableEvent[]): { [key: string]: Json } {
  const event = events[indexOfType(events, "eval")];
  if (event.type !== "yield" || event.result.status !== "ok") {
    throw new Error("the reference journal records one successful evaluation");
  }
  const holder = asObject(event.result.value);
  return asObject(asObject(holder["value"])["plan"]);
}

function asObject(value: Json | undefined): { [key: string]: Json } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the reference journal records this member as an object");
  }
  return value;
}

/** One scope's child by key, or a failure naming what the scope holds instead. */
function child(scope: ReplScope, key: string): ReplScope {
  const found = scope.scopes.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`${scope.key} holds ${scope.scopes.map((one) => one.key).join(", ")}`);
  }
  return found;
}

function binding(scope: ReplScope, name: string): Json {
  const found = scope.bindings.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`${scope.key} publishes ${scope.bindings.map((one) => one.name).join(", ")}`);
  }
  return found.value;
}

/** Every event's marker, in append order, as the projector derives them. */
function markers(events: readonly DurableEvent[]): string[] {
  const ordinals = new Map<string, number>();
  return events.map((event) => {
    if (event.type === "close") {
      return `close:${event.coroutineId}`;
    }
    const ordinal = ordinals.get(event.coroutineId) ?? 0;
    ordinals.set(event.coroutineId, ordinal + 1);
    return `yield:${event.coroutineId}:${ordinal}`;
  });
}

/** The index of the first event whose description has this type. */
function indexOfType(events: readonly DurableEvent[], type: string): number {
  const at = events.findIndex((event) => event.type === "yield" && event.description.type === type);
  if (at === -1) {
    throw new Error(`the reference journal records no ${type}`);
  }
  return at;
}

/** The same journal with one yield's description changed. */
function withDescription(
  events: readonly DurableEvent[],
  at: number,
  change: (description: { [key: string]: Json }) => { [key: string]: Json },
): DurableEvent[] {
  return events.map((event, index) => {
    if (index !== at || event.type !== "yield") {
      return event;
    }
    const changed = change({ ...event.description });
    if (typeof changed.type !== "string" || typeof changed.name !== "string") {
      throw new Error("a doctored description keeps its identity");
    }
    return { ...event, description: { ...changed, type: changed.type, name: changed.name } };
  });
}

/** The same journal with one yield's recorded value replaced. */
function withValue(events: readonly DurableEvent[], at: number, value: Json): DurableEvent[] {
  return events.map((event, index) =>
    index === at && event.type === "yield" ? { ...event, result: { status: "ok", value } } : event,
  );
}

describe("REPL model: what one journal projects", () => {
  beforeAll(() => useTempFileCompiler());

  it("M1: projects an empty journal as an execution with no entry", function* () {
    const model = projected([]);

    expect(model.entry).toBe(undefined);
    expect(model.settled).toBe(false);
    expect(model.terminal).toBe(undefined);
    expect(model.transcript).toEqual([]);
    expect(model.checkpoints).toEqual([]);
    expect(model.head).toBe(true);
  });

  it("M2: projects the reference entry into the documented scopes", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const entry = model.entry;
    if (entry === undefined) {
      throw new Error("the reference journal admits an entry");
    }

    expect(entry.key).toBe(ENTRY_SCOPE);
    expect(entry.kind).toBe("entry");
    expect(entry.path).toBe("<eval>");
    expect(entry.source).toContain("<Elicit schema={responseSchema}");

    expect(binding(entry, "plan")).toEqual({ title: "Ship the REPL", steps: 2 });
    expect(binding(entry, "summarySource")).toBe(
      '<Json value={{"title":"Ship the REPL","steps":2}} />',
    );

    const nested = child(entry, "Checklist-1");
    expect(nested.kind).toBe("component");
    expect(nested.name).toBe("Checklist");
    expect(nested.path.endsWith("Checklist.md")).toBe(true);
    expect(nested.source).toContain("{props.steps} steps remain.");
    expect(nested.position?.line).toBe(12);

    const generated = child(entry, "generated-1");
    expect(generated.kind).toBe("generated");
    expect(generated.source).toBe('<Json value={{"title":"Ship the REPL","steps":2}} />');
    expect(generated.position?.line).toBe(16);

    expect(entry.generated).toHaveLength(1);
    expect(entry.generated[0].decision).toBe("admitted");

    expect(entry.elicitations).toHaveLength(1);
    expect(entry.elicitations[0].answer).toEqual(REFERENCE_ANSWER);
    expect(entry.elicitations[0].location).toBe("<eval>:18:1");
    expect(entry.elicitations[0].schema).toEqual({
      type: "object",
      properties: { decision: { type: "string", enum: ["approve", "decline"] } },
      required: ["decision"],
      additionalProperties: false,
    });

    expect(model.settled).toBe(true);
    expect(model.terminal?.status).toBe("ok");
    expect(model.terminal?.output).toContain("Decision: approve");
  });

  it("M1: deep-freezes the model and reprojects the same journal identically", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const entry = model.entry;
    if (entry === undefined) {
      throw new Error("the reference journal admits an entry");
    }

    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.bindings)).toBe(true);
    expect(Object.isFrozen(entry.scopes)).toBe(true);
    expect(Object.isFrozen(model.transcript)).toBe(true);
    expect(Object.isFrozen(binding(entry, "plan"))).toBe(true);
    expect(() => {
      Object.assign(entry, { source: "" });
    }).toThrow();

    // Reprojected from the journal's own text form, so nothing a first reading
    // computed can be what the second one is agreeing with.
    expect(projected(copied(events))).toEqual(model);
  });

  it("M3: holds only frozen copies, and leaves the events exactly as they were", function* () {
    const events = yield* referenceEvents();
    const written = events.map((event) => serializeDurableEvent(event));
    const graph = reachable(events);

    // The events start out ordinary mutable data, which is what makes the
    // assertions after the projection mean anything at all.
    expect(graph.length).toBeGreaterThan(20);
    expect(graph.filter((member) => Object.isFrozen(member))).toEqual([]);

    const model = projected(events);
    const entry = model.entry;
    if (entry === undefined) {
      throw new Error("the reference journal admits an entry");
    }

    // Everything the model reaches is frozen, all the way down — a component
    // that is handed a value cannot change what every other reader sees.
    const held = reachable(model);
    expect(held.length).toBeGreaterThan(20);
    expect(held.filter((member) => !Object.isFrozen(member))).toEqual([]);

    // And none of it is an object the events still hold. Sharing one would make
    // the two claims either side of this a single claim about one graph.
    const borrowed = new Set(graph);
    expect(held.filter((member) => borrowed.has(member))).toEqual([]);

    // Reading a history is not a way of changing it. Freezing a value in place
    // would make the caller's own events immutable as a side effect of having
    // been looked at.
    expect(graph.filter((member) => Object.isFrozen(member))).toEqual([]);
    expect(events.map((event) => serializeDurableEvent(event))).toEqual(written);

    // The copy is what the model retains, so what the caller does to its events
    // afterwards cannot change what a reader is looking at.
    const plan = publishedPlan(events);
    expect(binding(entry, "plan")).not.toBe(plan);
    plan.title = "Something else";
    expect(binding(entry, "plan")).toEqual({ title: "Ship the REPL", steps: 2 });
    expect(Object.isFrozen(plan)).toBe(false);
  });

  it("M1: a selected prefix shows only what that prefix admitted", function* () {
    const events = yield* referenceEvents();
    const spelling = markers(events);
    const admission = indexOfType(events, "generated_xmd");

    const before = projected(events, spelling[admission - 1]);
    const after = projected(events, spelling[admission]);
    const entryBefore = before.entry;
    const entryAfter = after.entry;
    if (entryBefore === undefined || entryAfter === undefined) {
      throw new Error("both prefixes admit the entry");
    }

    expect(before.head).toBe(false);
    expect(before.settled).toBe(false);
    expect(before.terminal).toBe(undefined);
    expect(entryBefore.generated).toEqual([]);
    expect(entryBefore.scopes.map((scope) => scope.key)).toEqual(["Checklist-1"]);
    expect(entryBefore.elicitations).toEqual([]);

    expect(entryAfter.scopes.map((scope) => scope.key)).toEqual(["Checklist-1", "generated-1"]);
    expect(entryAfter.elicitations).toEqual([]);
    expect(after.settled).toBe(false);

    // The head is still the head: selecting a prefix reads the file, it does not
    // shorten it.
    expect(projected(events).settled).toBe(true);
  });

  it("M1: offers a checkpoint for each selectable position, in append order", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    expect(model.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
      "entry",
      "binding",
      "scope",
      "generated",
      "elicit",
      "terminal",
    ]);
    for (const checkpoint of model.checkpoints) {
      expect(projected(events, checkpoint.marker).selection).toBe(checkpoint.marker);
    }
  });
});

describe("REPL model: the histories it refuses", () => {
  beforeAll(() => useTempFileCompiler());

  it("M1: refuses a marker this journal does not hold, rather than showing the head", function* () {
    const events = yield* referenceEvents();

    expect(refusal(events, "yield:root:99")).toContain("not in this journal");
    expect(refusal(events, "close:child")).toContain("not in this journal");
    expect(refusal(events, "")).toContain("not in this journal");
    expect(refusal([], "yield:root:0")).toContain("not in this journal");
  });

  it("M1: refuses a second entry, work after settlement, and a repeated close", function* () {
    const events = yield* referenceEvents();

    expect(refusal([...events, events[0]])).toContain("after the entry settled");
    expect(refusal([events[0], ...events])).toContain("a second entry");
    expect(refusal([...events, events[events.length - 1]])).toContain("records");
    expect(refusal(events.slice(1))).toContain("before it admitted its entry");
  });

  it("M1: refuses a payload it cannot read, and exposes no partial model", function* () {
    const events = yield* referenceEvents();

    expect(refusal(withValue(events, 0, "not a selection"))).toContain(
      "entry's recorded source cannot be read",
    );
    expect(refusal(withValue(events, indexOfType(events, "eval"), { value: 3 }))).toContain(
      "published values cannot be read",
    );
    expect(
      refusal(withValue(events, indexOfType(events, "generated_xmd"), { decision: "maybe" })),
    ).toContain("generated fragment cannot be read");
    expect(
      refusal(
        events.map((event) =>
          event.type === "close" && event.coroutineId === "root"
            ? { ...event, result: { status: "ok", value: { status: "ok" } } }
            : event,
        ),
      ),
    ).toContain("recorded outcome of this entry cannot be read");

    const projection = projectRepl(withValue(events, 0, "not a selection"));
    expect(projection.ok).toBe(false);
    expect("value" in projection).toBe(false);
  });

  it("M2: refuses an owning source position that was removed or points elsewhere", function* () {
    const events = yield* referenceEvents();

    for (const type of ["eval", "import_component", "generated_xmd", "elicit"]) {
      const at =
        type === "import_component"
          ? indexOfType(events.slice(1), type) + 1
          : indexOfType(events, type);
      const removed = withDescription(events, at, (description) => {
        delete description["executablemd.source-position"];
        return description;
      });
      expect(refusal(removed)).toContain("recorded without the source position");

      const elsewhere = withDescription(events, at, (description) => ({
        ...description,
        "executablemd.source-position": {
          path: "somewhere-else.md",
          offset: 0,
          line: 1,
          column: 1,
        },
      }));
      expect(refusal(elsewhere)).toContain("never admitted");
    }
  });

  it("M2: refuses a source position that will not read at all", function* () {
    const events = yield* referenceEvents();
    const at = indexOfType(events, "elicit");

    const corrupted = withDescription(events, at, (description) => ({
      ...description,
      "executablemd.source-position": { path: "<eval>", offset: -1, line: 0, column: 0 },
    }));

    expect(refusal(corrupted)).toContain("cannot read");
  });

  it("E1: refuses an answered question that retains no schema", function* () {
    const events = yield* referenceEvents();
    const at = indexOfType(events, "elicit");

    const stripped = withDescription(events, at, (description) => {
      delete description["executablemd.elicitation-schema"];
      return description;
    });

    expect(refusal(stripped)).toContain("does not retain the schema");
  });

  it("E1: a refused answer leaves no answered question in the projection", function* () {
    const run = yield* runReference(answering({ decision: "maybe" }));
    const model = projected(run.events);

    expect(run.asked).toHaveLength(1);
    expect(model.entry?.elicitations).toEqual([]);
    expect(model.transcript.some((row) => row.kind === "elicit")).toBe(false);
  });
});

/**
 * The Agent conversations one journal projects (#854 M1, M2, M3).
 *
 * The journal comes from a real run of the Agent reference entry, so what these
 * assert is the projector against the Prompt records the current runtime
 * writes. The negative controls doctor that real journal one member at a time:
 * a sequence that disagrees with append order, a record that will not read, an
 * audit that will not read, and an owning position removed or pointed
 * elsewhere.
 */

/** The index of the nth `agent_prompt` yield, in append order. */
function promptAt(events: readonly DurableEvent[], ordinal: number): number {
  const found = events.flatMap((event, index) =>
    event.type === "yield" && event.description.type === "agent_prompt" ? [index] : [],
  );
  if (found[ordinal] === undefined) {
    throw new Error(`the Agent reference journal records ${found.length} prompts`);
  }
  return found[ordinal];
}

/** The durable record one `agent_prompt` yield holds. */
function promptValue(events: readonly DurableEvent[], at: number): { [key: string]: Json } {
  const event = events[at];
  if (event.type !== "yield" || event.result.status !== "ok") {
    throw new Error("this event records no successful prompt");
  }
  return asObject(event.result.value);
}

/** The same journal with one prompt record's members changed. */
function withPrompt(
  events: readonly DurableEvent[],
  ordinal: number,
  change: (record: { [key: string]: Json }) => { [key: string]: Json },
): DurableEvent[] {
  const at = promptAt(events, ordinal);
  return withValue(events, at, change({ ...promptValue(events, at) }));
}

describe("REPL model: the Agent conversations it projects", () => {
  beforeAll(() => useTempFileCompiler());

  it("M1: projects each retained Prompt as one turn owned by its exact scope", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);

    expect(model.turns.map((turn) => turn.input)).toEqual([
      "draft the plan",
      "check the plan",
      "run the build",
      "refuse: nothing to do",
    ]);
    expect(model.turns.map((turn) => turn.sequence)).toEqual([0, 1, 2, 3]);
    expect(model.turns.map((turn) => turn.agent)).toEqual([
      "planner",
      "builder",
      "planner",
      "planner",
    ]);
    // Every turn belongs to the one scope whose source it was written in, at
    // the exact position the record retained.
    expect(model.turns.map((turn) => turn.scope)).toEqual([
      ENTRY_SCOPE,
      ENTRY_SCOPE,
      ENTRY_SCOPE,
      ENTRY_SCOPE,
    ]);
    expect(model.turns.map((turn) => turn.position.line)).toEqual([6, 10, 14, 19]);
    expect(model.turns.map((turn) => turn.position.path)).toEqual([
      "<eval>",
      "<eval>",
      "<eval>",
      "<eval>",
    ]);

    const [drafted, , built, refused] = model.turns;
    expect(drafted.status).toBe("completed");
    expect(drafted.text).toBe("[draft the plan]");
    expect(drafted.name).toBe("prompt:<eval>:6:1#0");
    expect(drafted.failure).toBe(undefined);
    expect(built.permissions).toEqual([
      {
        toolCallId: "call-build",
        title: "Run npm build",
        kind: "execute",
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        outcome: "selected",
        selected: "deny",
      },
    ]);
    // The agent's own argument text was never durable, so it is not here to be
    // shown either.
    expect(JSON.stringify(built)).not.toContain("npm run build");
    expect(refused.status).toBe("failed");
    expect(refused.failure).toBe("this provider has nothing to run that on");
    expect(refused.text).toBe("");
  });

  it("M1: groups conversations by session key and by nothing else", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);

    // Two different agents talking in one conversation are one conversation,
    // and one agent talking in two is two.
    expect(model.sessions.map((session) => session.sessionKey)).toEqual([
      "stub:review",
      "stub:build",
    ]);
    expect(model.sessions[0].turns.map((turn) => turn.agent)).toEqual(["planner", "builder"]);
    expect(model.sessions[1].turns.map((turn) => turn.agent)).toEqual(["planner"]);

    // The turn that reached no provider has no key, so it joins nothing — and
    // it is still in the chronology, which is where every turn is.
    const unassigned = model.turns.filter((turn) => turn.sessionKey.length === 0);
    expect(unassigned.map((turn) => turn.input)).toEqual(["refuse: nothing to do"]);
    expect(model.sessions.flatMap((session) => session.turns)).not.toContain(unassigned[0]);
  });

  it("M1: orders the chronology by sequence where append order disagrees", function* () {
    const events = yield* agentReferenceEvents();
    // The two turns swap the order they ran in, keeping the order they were
    // appended in. A projector reading append order cannot tell the difference.
    const swapped = withPrompt(
      withPrompt(events, 0, (record) => ({ ...record, sequence: 2 })),
      2,
      (record) => ({ ...record, sequence: 0 }),
    );
    const model = projected(swapped);

    expect(model.turns.map((turn) => turn.input)).toEqual([
      "run the build",
      "check the plan",
      "draft the plan",
      "refuse: nothing to do",
    ]);
    // A conversation appears where its earliest turn now appears, and its own
    // turns keep sequence order too.
    expect(model.sessions.map((session) => session.sessionKey)).toEqual([
      "stub:build",
      "stub:review",
    ]);
    expect(model.sessions[1].turns.map((turn) => turn.input)).toEqual([
      "check the plan",
      "draft the plan",
    ]);
    // Checkpoints are positions in the file, so they stay in append order.
    expect(model.checkpoints.filter((checkpoint) => checkpoint.kind === "agent")).toHaveLength(4);
  });

  it("M1: settlement contributes one semantic transcript row and checkpoint", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);

    expect(
      model.checkpoints.filter((checkpoint) => checkpoint.kind === "agent").map((one) => one.label),
    ).toEqual([
      "Agent prompt completed",
      "Agent prompt completed",
      "Agent prompt completed",
      "Agent prompt failed",
    ]);
    const rows = model.transcript.filter((row) => row.kind === "agent");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => (row.kind === "agent" ? row.scope : ""))).toEqual([
      ENTRY_SCOPE,
      ENTRY_SCOPE,
      ENTRY_SCOPE,
      ENTRY_SCOPE,
    ]);
    // A label, not a record dump: nothing a reader has to be shown is spelled
    // out twice, and the prompt's own text is not in it.
    for (const checkpoint of model.checkpoints) {
      expect(checkpoint.label).not.toContain("draft the plan");
    }
  });

  it("M3: one retained turn is one object, however it is reached", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);
    const built = model.turns[2];

    expect(model.sessions[1].turns[0]).toBe(built);
    const row = model.transcript.find((entry) => entry.kind === "agent" && entry.turn === built);
    expect(row).toBeDefined();
    // Not a clone that happens to be equal: two readings of one turn would let
    // one of them go stale while the other did not.
    expect(model.sessions[1].turns[0]).toBe(model.turns[2]);
  });

  it("M3: Agent values are frozen copies, and the events come out unchanged", function* () {
    const events = yield* agentReferenceEvents();
    const written = events.map((event) => serializeDurableEvent(event));
    const graph = reachable(events);
    expect(graph.filter((member) => Object.isFrozen(member))).toEqual([]);

    const model = projected(events);
    const built = model.turns[2];

    // Everything an Agent reading reaches is frozen, all the way down.
    const held = [...reachable(model.turns), ...reachable(model.sessions)];
    expect(held.length).toBeGreaterThan(10);
    expect(held.filter((member) => !Object.isFrozen(member))).toEqual([]);
    expect(() => {
      Object.assign(built, { agent: "someone else" });
    }).toThrow();

    // And none of it is an object the events still hold.
    const borrowed = new Set(graph);
    expect(held.filter((member) => borrowed.has(member))).toEqual([]);

    // Reading a history is not a way of changing it.
    expect(graph.filter((member) => Object.isFrozen(member))).toEqual([]);
    expect(events.map((event) => serializeDurableEvent(event))).toEqual(written);

    // The copy is what the model retains, so mutating the record's own audit
    // afterwards changes nothing a reader is looking at.
    const record = promptValue(events, promptAt(events, 2));
    const audits = record.permissions;
    if (!Array.isArray(audits)) {
      throw new Error("the build turn's record retains its audit");
    }
    asObject(audits[0]).toolCallId = "something else";
    expect(built.permissions[0].toolCallId).toBe("call-build");
  });
});

describe("REPL model: the Agent histories it refuses", () => {
  beforeAll(() => useTempFileCompiler());

  it("M2: a prefix before a Prompt append holds no turn, and after it holds all of it", function* () {
    const events = yield* agentReferenceEvents();
    const spelling = markers(events);
    const built = promptAt(events, 2);

    const before = projected(events, spelling[built - 1]);
    const after = projected(events, spelling[built]);

    expect(before.turns.map((turn) => turn.input)).toEqual(["draft the plan", "check the plan"]);
    expect(before.sessions.map((session) => session.sessionKey)).toEqual(["stub:review"]);

    expect(after.turns.map((turn) => turn.input)).toEqual([
      "draft the plan",
      "check the plan",
      "run the build",
    ]);
    expect(after.sessions.map((session) => session.sessionKey)).toEqual([
      "stub:review",
      "stub:build",
    ]);
    // The complete terminal turn, audit included, the moment its record lands.
    expect(after.turns[2].status).toBe("completed");
    expect(after.turns[2].permissions.map((audit) => audit.toolCallId)).toEqual(["call-build"]);
  });

  it("M2: refuses a Prompt record it cannot read, and exposes no partial model", function* () {
    const events = yield* agentReferenceEvents();

    for (const change of [
      (record: { [key: string]: Json }) => ({ ...record, sequence: "second" }),
      (record: { [key: string]: Json }) => ({ ...record, status: "nearly" }),
      (record: { [key: string]: Json }) => ({ ...record, sessionKey: 7 }),
    ]) {
      expect(refusal(withPrompt(events, 0, change))).toContain("Agent prompt cannot be read");
    }

    const projection = projectRepl(
      withPrompt(events, 0, (record) => ({ ...record, sequence: "second" })),
    );
    expect(projection.ok).toBe(false);
    expect("value" in projection).toBe(false);
  });

  it("M2: refuses an audit it cannot read rather than reading it as none", function* () {
    const events = yield* agentReferenceEvents();
    const audited = promptValue(events, promptAt(events, 2)).permissions;
    if (!Array.isArray(audited)) {
      throw new Error("the build turn's record retains its audit");
    }
    const [audit] = audited.map((member) => asObject(member));

    for (const permissions of [
      "granted",
      [{ ...audit, outcome: { outcome: "granted" } }],
      [{ ...audit, options: [{ optionId: "allow", name: "Allow once", kind: "allow_maybe" }] }],
      // The one thing an audit may never carry, arriving as a member nothing
      // here defines: read past, it would be published to every reader.
      [{ ...audit, rawInput: { command: "rm -rf /" } }],
    ]) {
      expect(refusal(withPrompt(events, 2, (record) => ({ ...record, permissions })))).toContain(
        "Agent prompt cannot be read",
      );
    }
  });

  it("M2: refuses a Prompt whose owner cannot be decided, and never guesses one", function* () {
    const events = yield* agentReferenceEvents();
    const at = promptAt(events, 0);

    const removed = withDescription(events, at, (description) => {
      delete description["executablemd.source-position"];
      return description;
    });
    expect(refusal(removed)).toContain("recorded without the source position");

    const elsewhere = withDescription(events, at, (description) => ({
      ...description,
      "executablemd.source-position": { path: "somewhere-else.md", offset: 0, line: 1, column: 1 },
    }));
    expect(refusal(elsewhere)).toContain("never admitted");

    const corrupted = withDescription(events, at, (description) => ({
      ...description,
      "executablemd.source-position": { path: "<eval>", offset: -1, line: 0, column: 0 },
    }));
    expect(refusal(corrupted)).toContain("cannot read");

    const unnamed = withDescription(events, at, (description) => {
      delete description["input"];
      return { ...description, name: description.name };
    });
    expect(refusal(unnamed)).toContain("does not retain the text it asked");
  });

  it("M2: a marker this journal does not hold refuses rather than showing the head", function* () {
    const events = yield* agentReferenceEvents();

    expect(refusal(events, "yield:root:99")).toContain("not in this journal");
    expect(projected(events).turns).toHaveLength(4);
  });
});
