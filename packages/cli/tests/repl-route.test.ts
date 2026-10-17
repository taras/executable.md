/**
 * Where the REPL is, decoded and resolved (#848 R1, R2, M3).
 *
 * Two halves and they are tested as two. The codec is pure, so its tests need no
 * journal at all: equivalent spellings have to decode to one route, one canonical
 * spelling has to come back out, and every illegal combination has to refuse.
 * Resolution is where a Journal comes in, and what it must return is the *exact*
 * objects the projection holds — not copies, and never a `DurableEvent`.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useTempFileCompiler } from "@executablemd/core";
import { parseDurableEvent, serializeDurableEvent } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

import { projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { decodeLocation, encodeLocation, NO_LIVE, resolveLocation } from "../src/repl/route.ts";
import type {
  ReplDrawerRef,
  ReplLiveAvailability,
  ReplRoute,
  ReplSelection,
} from "../src/repl/route.ts";
import { initialState, NO_AGENT, reduceRepl } from "../src/repl/application.ts";
import type { ReplLive } from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { agentReferenceEvents, referenceEvents } from "./fixtures/repl/reference.ts";

function decoded(location: string): ReplRoute {
  const result = decodeLocation(location);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refused(location: string): string {
  const result = decodeLocation(location);
  if (result.ok) {
    throw new Error(`${location} decoded, and this grammar must refuse it`);
  }
  return result.error.message;
}

function projected(events: readonly DurableEvent[], selection?: string): ReplModel {
  const result = projectRepl(events, selection);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** What a process holding some live state would say, from the parts named. */
function holding(availability: Partial<ReplLiveAvailability>): ReplLiveAvailability {
  return { ...NO_LIVE, ...availability };
}

function resolved(
  model: ReplModel,
  location: string,
  availability: ReplLiveAvailability = NO_LIVE,
): ReplSelection {
  const result = resolveLocation(model, decoded(location), availability);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function unresolved(
  model: ReplModel,
  location: string,
  availability: ReplLiveAvailability = NO_LIVE,
): string {
  const result = resolveLocation(model, decoded(location), availability);
  if (result.ok) {
    throw new Error(`${location} resolved, and this model cannot answer it`);
  }
  return result.error.message;
}

/** The journal through its own text form, so no first reading is reused. */
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
 * Whether anything reachable from a value is shaped like a journal record.
 *
 * Structural rather than nominal on purpose: what must not escape the model is
 * the *event*, and an event is recognizable by carrying a coroutine and a
 * description together however it was constructed.
 */
function holdsARecord(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if ("coroutineId" in value && ("description" in value || "result" in value)) {
    return true;
  }
  for (const member of Object.values(value)) {
    if (holdsARecord(member, seen)) {
      return true;
    }
  }
  return false;
}

/** A process holding nothing live, which is what a reduction over a route needs. */
const QUIET: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

const EXECUTION = "kf39sla2";

describe("REPL route: the grammar", () => {
  it("R1: decodes equivalent spellings and query orders into one route", function* () {
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/entries/entry-1/+elicit:yield:root:6?at=yield:root:6&inspect`,
    );

    expect(canonical).toEqual(
      decoded(
        `xmd://repl/${EXECUTION}/entries/entry%2D1/+elicit:yield%3Aroot%3A6?inspect&at=yield%3Aroot%3A6`,
      ),
    );
    expect(canonical.execution).toBe(EXECUTION);
    expect(canonical.surface).toBe("entries");
    expect(canonical.scopes).toEqual(["entry-1"]);
    expect(canonical.drawers).toEqual([{ kind: "recorded-elicit", marker: "yield:root:6" }]);
    expect(canonical.at).toBe("yield:root:6");
    expect(canonical.inspect).toBe(true);
    expect(canonical.draft).toBe(undefined);
  });

  it("R1: round-trips every valid surface through one canonical spelling", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions`,
      `xmd://repl/${EXECUTION}/entries`,
      `xmd://repl/${EXECUTION}/entries/entry-1`,
      `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-1`,
      `xmd://repl/${EXECUTION}/entries/entry-1/generated-1`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+history`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+binding:plan`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+elicit`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+history/+binding:plan`,
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1`,
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1&inspect`,
      `xmd://repl/${EXECUTION}/entries?draft=one%20more%20line`,
    ];

    for (const location of locations) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(encodeLocation(decoded(location)))).toEqual(decoded(location));
    }
  });

  it("R1: refuses what the grammar cannot say", function* () {
    expect(refused("https://example.com/repl")).toContain("begins with");
    expect(refused(`xmd://repl/${EXECUTION}`)).toContain("names an execution and a surface");
    expect(refused("xmd://repl/")).toContain("names an execution and a surface");
    expect(refused(`xmd://repl/${EXECUTION}/notes`)).toContain("surface");
    expect(refused(`xmd://repl/${EXECUTION}/entries/%zz`)).toContain("escapes");
    expect(refused(`xmd://repl/${EXECUTION}/entries//entry-1`)).toContain("empty path segment");
    expect(refused(`xmd://repl/${EXECUTION}/entries/entry-1?inspect`)).toContain(
      "needs the position",
    );
    expect(refused(`xmd://repl/${EXECUTION}/entries/entry-1/+history/Checklist-1`)).toContain(
      "scopes precede its drawers",
    );
    expect(refused(`xmd://repl/${EXECUTION}/entries/entry-1/+notes`)).toContain("names a drawer");
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+binding:plan`)).toContain("Sessions surface");
    expect(refused(`xmd://repl/${EXECUTION}/entries?pause=1`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/entries#top`)).toContain("no fragment");
    expect(refused("xmd://repl/../entries")).toContain("opaque identifier");
    expect(refused("xmd://repl/%2E%2E/repl")).toContain("opaque identifier");
  });

  it("R1: cannot spell a route the grammar would refuse", function* () {
    const route = decoded(`xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1&inspect`);

    expect(() => encodeLocation({ ...route, at: undefined })).toThrow();
    expect(() => encodeLocation({ ...route, execution: "../escape" })).toThrow();
    // Superseded: a selected entry beside the Sessions surface used to be
    // unspellable. Which surface is being read and which entry is selected are
    // independent members of one location (#827 Slice C), so what cannot be
    // spelled on Sessions is a drawer that opens over a scope.
    // Declared, so the drawer this spells is the one the grammar defines rather
    // than a shape this row asserts into place.
    const binding: ReplDrawerRef = { kind: "binding", name: "plan" };
    expect(() =>
      encodeLocation({ ...route, surface: "sessions", drawers: Object.freeze([binding]) }),
    ).toThrow();
  });

  it("ER1: one location carries entry, scope, draft, surface, drawer, filter and position", function* () {
    // Everything at once, through one canonical spelling and back. The draft is
    // the *next* entry's text, so it accompanies a selected entry, a scope
    // beneath it, a drawer stack, a conversation filter and a frozen position
    // rather than being a state an execution can only be in before its first
    // entry.
    const location =
      `xmd://repl/${EXECUTION}/entries/entry-2/Checklist-1/+binding:plan` +
      `?at=yield:root:6&inspect&draft=another%20entry&session=stub:planner`;
    const route = decoded(location);

    expect(route.scopes).toEqual(["entry-2", "Checklist-1"]);
    expect(route.drawers).toEqual([{ kind: "binding", name: "plan" }]);
    expect(route.at).toBe("yield:root:6");
    expect(route.inspect).toBe(true);
    expect(route.draft).toBe("another entry");
    expect(route.session).toBe("stub:planner");
    expect(route.surface).toBe("entries");

    // One canonical spelling, and reading it again is the same route.
    expect(encodeLocation(route)).toBe(location);
    expect(decoded(encodeLocation(route))).toEqual(route);

    // And the same on the Sessions surface, which holds no entry but the same
    // execution-wide draft and position.
    const sessions =
      `xmd://repl/${EXECUTION}/sessions/+permission` +
      `?at=yield:root:6&inspect&draft=more&session=stub:planner`;
    expect(encodeLocation(decoded(sessions))).toBe(sessions);
  });
});

describe("REPL route: resolving against one model", () => {
  beforeAll(() => useTempFileCompiler());

  it("M3: returns the exact objects the model holds", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const entry = model.entries[0]?.scope;
    if (entry === undefined) {
      throw new Error("the reference journal admits an entry");
    }
    const nested = entry.scopes.find((scope) => scope.key === "Checklist-1");
    const plan = entry.bindings.find((candidate) => candidate.name === "plan");

    const head = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1`);
    expect(head.entry).toBe(entry);
    expect(head.scope).toBe(entry);
    expect(head.ancestry).toEqual([entry]);

    const inner = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-1`);
    expect(inner.scope).toBe(nested);
    expect(inner.ancestry.length).toBe(2);
    expect(inner.ancestry[0]).toBe(entry);

    const drawer = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/+binding:plan`);
    expect(drawer.drawers).toHaveLength(1);
    const opened = drawer.drawers[0];
    if (opened.kind !== "binding") {
      throw new Error("the binding drawer opens a binding");
    }
    expect(opened.binding).toBe(plan);

    expect(holdsARecord(inner)).toBe(false);
    expect(holdsARecord(drawer)).toBe(false);
  });

  it("M3: the same view results from a journal read a second time", function* () {
    const events = yield* referenceEvents();
    const location = `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-1`;

    const first = resolved(projected(events), location);
    const second = resolved(projected(copied(events)), location);

    expect(second).toEqual(first);
    // The same reading, and not the same objects: two projections are two
    // readings of one file, which is what makes the model discardable.
    expect(second.scope).not.toBe(first.scope);
  });

  it("R2: resolves a historical prefix and refuses a live question inside it", function* () {
    const events = yield* referenceEvents();
    const head = projected(events);
    const answered = head.entries[0]?.scope.elicitations[0];
    if (answered === undefined) {
      throw new Error("the reference journal records one answered question");
    }
    const historical = projected(events, answered.marker);

    const inspecting = resolved(
      historical,
      `xmd://repl/${EXECUTION}/entries/entry-1/+elicit:${answered.marker}` +
        `?at=${answered.marker}&inspect`,
    );
    const drawer = inspecting.drawers[0];
    if (drawer.kind !== "recorded-elicit") {
      throw new Error("an inspected question opens its recorded answer");
    }
    expect(drawer.elicitation).toBe(historical.entries[0]?.scope.elicitations[0]);

    expect(
      unresolved(
        historical,
        `xmd://repl/${EXECUTION}/entries/entry-1/+elicit?at=${answered.marker}&inspect`,
      ),
    ).toContain("live question");
    // No reading of any history can mount a live question's drawer. A waiting
    // question is the one fact a Journal never holds: it records answers. So a
    // settled history, and an unsettled one that has already recorded this
    // answer and merely has its root left to close, are both consistent with no
    // question ever arriving — and `settled` cannot tell them apart from one
    // that is really asking.
    const live = `xmd://repl/${EXECUTION}/entries/entry-1/+elicit`;
    expect(head.settled).toBe(true);
    expect(unresolved(head, live)).toContain("nothing is being asked");

    const unclosed = projected(events.slice(0, -1));
    expect(unclosed.settled).toBe(false);
    // Already answered: reopening this shape asks nobody anything and only
    // finishes the root, so a route resolved here would replay and append
    // before discovering that no drawer can mount.
    expect(unclosed.entries[0]?.scope.elicitations[0].answer).toEqual({ decision: "approve" });
    expect(unresolved(unclosed, live)).toContain("nothing is being asked");

    // Only the process actually holding the question may open it, and it says so.
    expect(resolved(head, live, holding({ elicit: true })).drawers[0].kind).toBe("live-elicit");
  });

  it("R2: refuses a missing entry, scope, binding or incomplete path", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-2`)).toContain("no entry-2");
    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/Checklist-1`)).toContain(
      "no Checklist-1",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-2`)).toContain(
      "holds no Checklist-2",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/+binding:absent`)).toContain(
      "publishes no absent",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/+binding:plan`)).toContain(
      "scope that published the name",
    );
    expect(
      unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/+elicit:yield:root:1`),
    ).toContain("recorded no question at");
  });

  it("R2: a route selecting another prefix than the model refuses rather than answering", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1`)).toContain(
      "was not projected at",
    );
  });

  it("R2: a refused navigation leaves the resolved view it was asked from untouched", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const standing = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-1`);
    const before = { ...standing, ancestry: [...standing.ancestry] };

    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-9`)).toContain(
      "holds no Checklist-9",
    );

    expect(standing.scope).toBe(before.scope);
    expect([...standing.ancestry]).toEqual(before.ancestry);
    expect(Object.isFrozen(model)).toBe(true);
  });

  it("R2: the empty Sessions surface selects nothing at all", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    const sessions = resolved(model, `xmd://repl/${EXECUTION}/sessions`);
    expect(sessions.surface).toBe("sessions");
    expect(sessions.entry).toBe(undefined);
    expect(sessions.scope).toBe(undefined);
    expect(sessions.drawers).toEqual([]);
  });

  it("ER1: a draft resolves beside an admitted entry, its scope and a frozen position", function* () {
    // Superseded `R2: refuses a draft against an execution that has admitted
    // its entry`. An admitted entry is immutable, so a draft is never text that
    // could be editing it — it is the next entry's, and it coexists.
    const events = yield* referenceEvents();
    const model = projected(events);
    const entry = model.entries[0]?.scope;
    if (entry === undefined) {
      throw new Error("the reference journal admits an entry");
    }

    const beside = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1?draft=another%20entry`);
    expect(beside.entry).toBe(entry);
    expect(beside.route.draft).toBe("another entry");

    // The same beside a nested scope, and beside a conversation filter.
    const nested = resolved(
      model,
      `xmd://repl/${EXECUTION}/entries/entry-1/Checklist-1?draft=another%20entry`,
    );
    expect(nested.scope?.key).toBe("Checklist-1");
    expect(nested.route.draft).toBe("another entry");

    // And at a frozen position, where inspection freezes durable state and not
    // what is being typed.
    const marker = model.checkpoints[1]?.marker;
    if (marker === undefined) {
      throw new Error("the reference journal offers more than one position");
    }
    const frozen = projected(events, marker);
    const inspecting = resolved(
      frozen,
      `xmd://repl/${EXECUTION}/entries?at=${encodeURIComponent(marker)}&inspect&draft=typed`,
    );
    expect(inspecting.route.draft).toBe("typed");
    expect(inspecting.route.inspect).toBe(true);

    // An execution with no entry still resolves its own draft, as it always did.
    expect(
      resolved(projected([]), `xmd://repl/${EXECUTION}/entries?draft=first%20entry`).entry,
    ).toBe(undefined);
  });

  it("ER1: an entry absent from the selected prefix refuses, whole", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    // Nothing partial: the refusal carries no selection at all, so there is no
    // entry, ancestry or scope for a caller to read past it and no adjacent
    // entry guessed in the absent one's place.
    const attempt = resolveLocation(
      model,
      decoded(`xmd://repl/${EXECUTION}/entries/entry-2/Checklist-1`),
      NO_LIVE,
    );
    if (attempt.ok) {
      throw new Error("a prefix that admitted no entry-2 must refuse a location naming it");
    }
    expect(attempt.error.message).toContain("no entry-2");
    expect(Object.hasOwn(attempt, "value")).toBe(false);

    // The entry it does hold is still exactly the one it held before.
    expect(resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1`).entry).toBe(
      model.entries[0]?.scope,
    );
  });
});

/**
 * The conversation filter and the live permission drawer (#854 R1, R2).
 *
 * Two halves again. The grammar has to spell one more query member without
 * moving any of the ones that were canonical before it, and has to keep the new
 * drawer on the one surface that has it. Resolution has to answer a filter from
 * what the *selected prefix* retained, plus — only at the live head — what the
 * process says it has started, and has to refuse anything else rather than
 * showing an empty list.
 */
describe("REPL route: a live question's drawer belongs to one place", () => {
  beforeAll(() => useTempFileCompiler());

  it("UI4: resolution refuses what the grammar refuses, before anything adopts it", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const live = holding({ elicit: true });

    // The structural rule, enforced where a caller is deciding whether to adopt a
    // route rather than only where one is spelled. Resolution used to accept a
    // drawer this surface cannot hold: the reducer adopted it, and the next frame
    // raised out of `encodeLocation` and ended the command.
    const asking: readonly ReplDrawerRef[] = [{ kind: "live-elicit" }];
    const sessions = { ...decoded(`xmd://repl/${EXECUTION}/sessions`), drawers: asking };
    const refusal = resolveLocation(model, sessions, live);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) {
      throw new Error("the Sessions surface holds no live question");
    }
    expect(refusal.error.message).toContain("Sessions surface");
    // The same route cannot be spelled either, so the two cannot disagree.
    expect(() => encodeLocation(sessions)).toThrow();

    // A history position cannot answer the question this process is asking.
    expect(
      unresolved(
        projected(events, "yield:root:0"),
        `xmd://repl/${EXECUTION}/entries/entry-1/+elicit?at=yield:root:0&inspect`,
        live,
      ),
    ).toContain("frozen at an earlier position");

    // Cold, with no process holding a question: a Journal records answers, never a
    // question that is still waiting, so nothing retained can establish this.
    expect(unresolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/+elicit`)).toContain(
      "nothing is being asked",
    );

    // And on the surface it does belong to, while a question is held, it resolves.
    const opened = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1/+elicit`, live);
    expect(opened.drawers).toEqual([{ kind: "live-elicit" }]);
  });
});

describe("REPL route: the conversation filter", () => {
  it("R1: encodes session last, after every member that was canonical before it", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/sessions/+permission?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/entries/entry-1?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+history?at=yield:root:1&inspect&session=one`,
      `xmd://repl/${EXECUTION}/entries?draft=one%20more%20line&session=one`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+binding:plan?at=yield:root:1&session=one`,
    ];

    for (const location of locations) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(encodeLocation(decoded(location)))).toEqual(decoded(location));
    }
  });

  it("R1: leaves every location that names no conversation byte-identical", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions`,
      `xmd://repl/${EXECUTION}/entries`,
      `xmd://repl/${EXECUTION}/entries/entry-1`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+history/+binding:plan`,
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1&inspect`,
      `xmd://repl/${EXECUTION}/entries?draft=one%20more%20line`,
    ];

    for (const location of locations) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(location).session).toBe(undefined);
    }
  });

  it("R1: reads query members by name, so order still does not matter", function* () {
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:6&inspect&session=xmd:v1:a`,
    );

    expect(canonical).toEqual(
      decoded(
        `xmd://repl/${EXECUTION}/entries/entry-1?session=xmd:v1:a&inspect&at=yield%3Aroot%3A6`,
      ),
    );
    expect(canonical.session).toBe("xmd:v1:a");
  });

  it("R1: refuses an empty, repeated or unspellable conversation", function* () {
    expect(refused(`xmd://repl/${EXECUTION}/sessions?session=`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/sessions?session=a&session=b`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/sessions?session`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/sessions?session=%zz`)).toContain("query");
    // Not a path segment. A conversation is a filter over what Sessions lists,
    // and a path segment is the entry a reader will come back to — so one URL
    // still means one thing, and spelling a key there selects no conversation.
    const segmented = decoded(`xmd://repl/${EXECUTION}/sessions/xmd:v1:a`);
    expect(segmented.session).toBe(undefined);
    expect(segmented.scopes).toEqual(["xmd:v1:a"]);

    const route = decoded(`xmd://repl/${EXECUTION}/sessions?session=one`);
    expect(() => encodeLocation({ ...route, session: "" })).toThrow();
  });

  it("R1: the permission drawer belongs to Sessions, carries nothing, and is one word", function* () {
    const location = `xmd://repl/${EXECUTION}/sessions/+permission`;
    expect(encodeLocation(decoded(location))).toBe(location);
    expect(decoded(location).drawers).toEqual([{ kind: "live-permission" }]);

    // It names no request. The one being answered belongs to this process, and
    // a key for it in a URL would publish an identity nothing else can use.
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+permission:turn-3`)).toContain(
      "names a drawer",
    );
    expect(refused(`xmd://repl/${EXECUTION}/entries/entry-1/+permission`)).toContain(
      "Sessions surface",
    );
    // And Sessions still holds nothing else.
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+history`)).toContain("Sessions surface");
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+elicit`)).toContain("Sessions surface");

    const sessions = decoded(`xmd://repl/${EXECUTION}/sessions`);
    expect(() =>
      encodeLocation({ ...sessions, surface: "entries", drawers: [{ kind: "live-permission" }] }),
    ).toThrow();
  });
});

describe("REPL route: resolving a conversation", () => {
  beforeAll(() => useTempFileCompiler());

  it("R2: resolves a retained conversation to the exact group the model holds", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);

    const filtered = resolved(model, `xmd://repl/${EXECUTION}/sessions?session=stub%3Areview`);
    expect(filtered.session).toBe(model.sessions[0]);
    // The filter is orthogonal to everything else a location can say.
    const beside = resolved(model, `xmd://repl/${EXECUTION}/entries/entry-1?session=stub%3Abuild`);
    expect(beside.session).toBe(model.sessions[1]);
    expect(beside.scope).toBe(model.entries[0]?.scope);
    // And absent means every conversation rather than none.
    expect(resolved(model, `xmd://repl/${EXECUTION}/sessions`).session).toBe(undefined);
  });

  it("R2: resolves a live key only at the head, and only when the process says so", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);
    const started = `xmd://repl/${EXECUTION}/sessions?session=stub%3Aplanning`;

    // Nothing has settled in it yet, so no history holds it and there is no
    // retained group to point at — but the process running it can say it exists.
    expect(unresolved(model, started)).toContain("no conversation stub:planning");
    const live = resolved(model, started, holding({ sessions: ["stub:planning"] }));
    expect(live.session).toBe(undefined);
    expect(live.route.session).toBe("stub:planning");

    // A key nobody claims is still refused rather than becoming an empty list.
    expect(unresolved(model, started, holding({ sessions: ["stub:other"] }))).toContain(
      "no conversation stub:planning",
    );
  });

  it("R2: a historical prefix answers from its own retained groups and ignores the head", function* () {
    const events = yield* agentReferenceEvents();
    const head = projected(events);
    const early = head.turns[0].marker;
    const historical = projected(events, early);

    const retained = resolved(
      historical,
      `xmd://repl/${EXECUTION}/sessions?at=${early}&session=stub%3Areview`,
    );
    expect(retained.session).toBe(historical.sessions[0]);

    // The build conversation had not started at this position. It is in the
    // head and in this process, and neither may answer for the past.
    const later = `xmd://repl/${EXECUTION}/sessions?at=${early}&session=stub%3Abuild`;
    expect(head.sessions.map((session) => session.sessionKey)).toContain("stub:build");
    expect(unresolved(historical, later)).toContain("had started at this history position");
    expect(
      unresolved(historical, later, holding({ sessions: ["stub:build", "stub:planning"] })),
    ).toContain("had started at this history position");
  });

  it("R2: a conversation no turn ever joined cannot be selected", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);

    // The refused turn is in the chronology and in no conversation, so there is
    // nothing for a filter to name — least of all the empty key itself.
    expect(model.turns.some((turn) => turn.sessionKey.length === 0)).toBe(true);
    expect(unresolved(model, `xmd://repl/${EXECUTION}/sessions?session=planner`)).toContain(
      "no conversation planner",
    );
    expect(
      unresolved(
        model,
        `xmd://repl/${EXECUTION}/sessions?session=prompt%3A%3Ceval%3E%3A19%3A1%230`,
      ),
    ).toContain("no conversation");
  });

  it("R2: a refused filter leaves the standing route and selection untouched", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);
    const standing = resolved(model, `xmd://repl/${EXECUTION}/sessions?session=stub%3Areview`);
    const before = standing.session;

    expect(unresolved(model, `xmd://repl/${EXECUTION}/sessions?session=stub%3Anowhere`)).toContain(
      "no conversation stub:nowhere",
    );

    expect(standing.session).toBe(before);
    expect(standing.route.session).toBe("stub:review");
    expect(Object.isFrozen(model)).toBe(true);
  });

  it("R2: a live permission drawer is live-only, and independent of a live question", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);
    const drawer = `xmd://repl/${EXECUTION}/sessions/+permission`;

    // No reading of any history can establish it: a request still waiting is
    // the one thing a Journal never holds.
    expect(unresolved(model, drawer)).toContain("nothing is asking for permission");
    // A live question is a different fact and does not stand in for it.
    expect(unresolved(model, drawer, holding({ elicit: true }))).toContain(
      "nothing is asking for permission",
    );
    expect(resolved(model, drawer, holding({ permission: true })).drawers).toEqual([
      { kind: "live-permission" },
    ]);

    // And a frozen view cannot answer what this process is being asked now.
    const early = model.turns[0].marker;
    const historical = projected(events, early);
    expect(
      unresolved(
        historical,
        `xmd://repl/${EXECUTION}/sessions/+permission?at=${early}`,
        holding({ permission: true }),
      ),
    ).toContain("frozen at an earlier position");
  });

  it("R2: the two live facts stay independent of each other", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const question = `xmd://repl/${EXECUTION}/entries/entry-1/+elicit`;

    // Holding a permission request says nothing about a waiting question.
    expect(unresolved(model, question, holding({ permission: true }))).toContain(
      "nothing is being asked",
    );
    expect(resolved(model, question, holding({ elicit: true })).drawers[0].kind).toBe(
      "live-elicit",
    );
  });
});

describe("REPL route: the Sidekick's two choices", () => {
  beforeAll(() => useTempFileCompiler());

  it("R1: encodes view and right last, and leaves every older location byte-identical", function* () {
    // Beside everything that was canonical before them, in the fixed order the
    // codec appends them in.
    const carrying = [
      `xmd://repl/${EXECUTION}/entries?view=sidekick&right=sidekick`,
      `xmd://repl/${EXECUTION}/entries?right=bindings`,
      `xmd://repl/${EXECUTION}/sessions?view=sidekick`,
      `xmd://repl/${EXECUTION}/entries/entry-1?draft=another%20entry&view=sidekick&right=sidekick`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+binding:plan` +
        `?at=yield:root:6&inspect&draft=typed&session=stub:planner&view=sidekick&right=sidekick`,
    ];
    for (const location of carrying) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(encodeLocation(decoded(location)))).toEqual(decoded(location));
    }

    // And a location written before either member existed still comes back
    // exactly as it went in, naming neither.
    const older = [
      `xmd://repl/${EXECUTION}/entries`,
      `xmd://repl/${EXECUTION}/sessions/+permission?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1&inspect&draft=one`,
    ];
    for (const location of older) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect([decoded(location).view, decoded(location).right]).toEqual([undefined, undefined]);
    }
  });

  it("R1: reads both by name, and refuses an unknown, empty or repeated value", function* () {
    // Order still does not matter: query members are read by name.
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/entries?draft=typed&view=sidekick&right=bindings`,
    );
    expect(canonical).toEqual(
      decoded(`xmd://repl/${EXECUTION}/entries?right=bindings&view=sidekick&draft=typed`),
    );
    expect([canonical.view, canonical.right]).toEqual(["sidekick", "bindings"]);

    // Each names one of a closed set, so anything else is refused by the same
    // grammar that refuses a member nothing defines.
    for (const location of [
      `xmd://repl/${EXECUTION}/entries?view=entries`,
      `xmd://repl/${EXECUTION}/entries?view=`,
      `xmd://repl/${EXECUTION}/entries?view`,
      `xmd://repl/${EXECUTION}/entries?view=sidekick&view=sidekick`,
      `xmd://repl/${EXECUTION}/entries?right=transcript`,
      `xmd://repl/${EXECUTION}/entries?right=`,
      `xmd://repl/${EXECUTION}/entries?right`,
      `xmd://repl/${EXECUTION}/entries?right=bindings&right=sidekick`,
    ]) {
      expect([location, refused(location)]).toEqual([location, expect.stringContaining("query")]);
    }
  });

  it("R1: both resolve against a model, and neither is a surface or a drawer", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    // The surface underneath an explicit Sidekick reading is still the one the
    // path names, and the entry it selected is still selected: a reading is
    // what somebody comes back from.
    const reading = resolved(
      model,
      `xmd://repl/${EXECUTION}/entries/entry-1?view=sidekick&right=sidekick`,
    );
    expect(reading.surface).toBe("entries");
    expect(reading.entry).toBe(model.entries[0]?.scope);
    expect([reading.route.view, reading.route.right]).toEqual(["sidekick", "sidekick"]);

    // Neither is a path segment: spelling one there selects a scope, which is
    // the entry a reader comes back to, so one URL still means one thing.
    const segmented = decoded(`xmd://repl/${EXECUTION}/entries/sidekick`);
    expect([segmented.view, segmented.right]).toEqual([undefined, undefined]);
    expect(segmented.scopes).toEqual(["sidekick"]);

    // And neither is a drawer: the Sidekick's own question and Configure
    // drawers are this process's, so the grammar has no word for them.
    expect(refused(`xmd://repl/${EXECUTION}/entries/+sidekick`)).toContain("drawer");
    expect(refused(`xmd://repl/${EXECUTION}/entries/+configure`)).toContain("drawer");
  });
});

describe("REPL route: selecting a reading and a pane", () => {
  beforeAll(() => useTempFileCompiler());

  it("R1: a fresh execution has selected neither, so a narrow frame opens on its surface", function* () {
    const fresh = initialState(EXECUTION);
    expect([fresh.route.view, fresh.route.right]).toEqual([undefined, undefined]);
    expect(fresh.route.surface).toBe("entries");
    expect(encodeLocation(fresh.route)).toBe(`xmd://repl/${EXECUTION}/entries`);
  });

  it("R1: the Sidekick is selected without losing the entry, the position or the draft", function* () {
    const events = yield* referenceEvents();
    // The last retained position, where the nested scope this row selects has
    // been admitted: an earlier one holds the entry and not yet its children.
    const marker = projected(events).checkpoints.at(-1)?.marker;
    if (marker === undefined) {
      throw new Error("the reference journal retains a position");
    }
    const model = projected(events, marker);

    // Everything a person had: a selected entry, a nested scope, a frozen
    // position they are inspecting, and text they are part way through typing.
    const standing = Object.freeze({
      ...initialState(EXECUTION),
      draft: "part way through",
      route: Object.freeze({
        ...initialState(EXECUTION).route,
        surface: "sessions" as const,
        scopes: Object.freeze(["entry-1", "Checklist-1"]),
        at: marker,
        inspect: true,
      }),
    });

    const sidekick = reduceRepl(standing, { kind: "select-pane", pane: "sidekick" }, model, QUIET);
    expect(sidekick.state.refusal).toBe(undefined);
    expect(sidekick.intent).toEqual({ kind: "none" });
    expect([sidekick.state.route.view, sidekick.state.route.right]).toEqual([
      "sidekick",
      "sidekick",
    ]);
    // The saved surface and everything beneath it, exactly as they were.
    expect(sidekick.state.route.surface).toBe("sessions");
    expect(sidekick.state.route.scopes).toEqual(["entry-1", "Checklist-1"]);
    expect([sidekick.state.route.at, sidekick.state.route.inspect]).toEqual([marker, true]);
    expect(sidekick.state.draft).toBe("part way through");

    // Bindings is a pane and not a reading, so selecting it puts the saved
    // surface back in front of whoever was reading the Sidekick.
    const bindings = reduceRepl(
      sidekick.state,
      { kind: "select-pane", pane: "bindings" },
      model,
      QUIET,
    );
    expect([bindings.state.route.view, bindings.state.route.right]).toEqual([
      undefined,
      "bindings",
    ]);
    expect(bindings.state.route.surface).toBe("sessions");
    expect(bindings.state.route.scopes).toEqual(["entry-1", "Checklist-1"]);
    expect(bindings.state.draft).toBe("part way through");
  });

  it("R1: selecting Entries or Sessions clears an explicit Sidekick reading", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const reading = reduceRepl(
      Object.freeze({
        ...initialState(EXECUTION),
        draft: "still typing",
        route: Object.freeze({
          ...initialState(EXECUTION).route,
          scopes: Object.freeze(["entry-1"]),
        }),
      }),
      { kind: "select-pane", pane: "sidekick" },
      model,
      QUIET,
    );
    expect(reading.state.route.view).toBe("sidekick");

    for (const surface of ["entries", "sessions"] as const) {
      const selected = reduceRepl(reading.state, { kind: "select-surface", surface }, model, QUIET);
      // Asking for a surface is asking to read it: the alternative is somebody
      // activating Entries and staying where they were.
      expect([surface, selected.state.route.view]).toEqual([surface, undefined]);
      expect([surface, selected.state.route.surface]).toEqual([surface, surface]);
      // The right-hand pane is a separate choice and is not disturbed, and
      // neither is the entry or the draft.
      expect([surface, selected.state.route.right]).toEqual([surface, "sidekick"]);
      expect([surface, selected.state.route.scopes]).toEqual([surface, ["entry-1"]]);
      expect([surface, selected.state.draft]).toEqual([surface, "still typing"]);
    }
  });
});

/**
 * What a Sidekick history says, as a location may name it.
 *
 * Built from the parts a case states, because the two questions this member
 * answers are different: which chats exist, and which provider conversations
 * the applicable facts establish. A legacy execution passes none of this at
 * all, which is what `undefined` is for.
 */
function chats(
  known: Partial<{
    chats: readonly string[];
    sessions: readonly string[];
    refusal: string | undefined;
  }>,
): ReplLiveAvailability {
  return holding({
    sidekick: {
      chats: Object.freeze(known.chats ?? []),
      sessions: Object.freeze(known.sessions ?? []),
      refusal: known.refusal,
    },
  });
}

describe("REPL route: the saved chat a location reads", () => {
  beforeAll(() => useTempFileCompiler());

  it("SS2: encodes sidekick last, and leaves every older location byte-identical", function* () {
    // After every member that was canonical before it, in the one order the
    // codec appends them in — and percent-encoded, because a conversation
    // identifier is a name rather than a word of this grammar.
    const carrying = [
      `xmd://repl/${EXECUTION}/entries?sidekick=chat-1`,
      `xmd://repl/${EXECUTION}/sessions?view=sidekick&right=sidekick&sidekick=chat-7`,
      `xmd://repl/${EXECUTION}/entries/entry-1/+binding:plan` +
        `?at=yield:root:6&inspect&draft=typed&session=stub:planner` +
        `&view=sidekick&right=sidekick&sidekick=a%20chat/b`,
    ];
    for (const location of carrying) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(encodeLocation(decoded(location)))).toEqual(decoded(location));
    }
    // Through the codec's own query-value encoder, which is the one `session`
    // and `draft` already use: everything a value may not hold literally is
    // escaped, and a separator this grammar has no structure for is not.
    expect(decoded(`xmd://repl/${EXECUTION}/entries?sidekick=a%20chat%2Fb`).sidekick).toBe(
      "a chat/b",
    );

    // And every location written before this member existed comes back exactly
    // as it went in, naming no chat at all.
    const older = [
      `xmd://repl/${EXECUTION}/entries`,
      `xmd://repl/${EXECUTION}/sessions/+permission?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/entries/entry-1?at=yield:root:1&inspect&draft=one`,
      `xmd://repl/${EXECUTION}/entries?session=stub:planner&view=sidekick&right=bindings`,
    ];
    for (const location of older) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(location).sidekick).toBeUndefined();
    }
  });

  it("SS2: reads it by name, and refuses an empty, bare, repeated or aliased value", function* () {
    // Order still does not matter, and the filter beside it is a different
    // member answering a different question.
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/entries?sidekick=chat-2&session=stub:planner`,
    );
    expect(canonical).toEqual(
      decoded(`xmd://repl/${EXECUTION}/entries?session=stub:planner&sidekick=chat-2`),
    );
    expect([canonical.sidekick, canonical.session]).toEqual(["chat-2", "stub:planner"]);

    for (const location of [
      `xmd://repl/${EXECUTION}/entries?sidekick=`,
      `xmd://repl/${EXECUTION}/entries?sidekick`,
      `xmd://repl/${EXECUTION}/entries?sidekick=chat-1&sidekick=chat-1`,
      `xmd://repl/${EXECUTION}/entries?sidekick=chat-1&sidekick=chat-2`,
      `xmd://repl/${EXECUTION}/entries?sidekick=%ZZ`,
      // There is no second spelling of this member: one query member means one
      // name, and `chat=` is a member nothing defines.
      `xmd://repl/${EXECUTION}/entries?chat=chat-1`,
    ]) {
      expect([location, refused(location)]).toEqual([location, expect.stringContaining("query")]);
    }
    // And a route this codec cannot spell raises rather than emitting something
    // decoding would then refuse.
    expect(() =>
      encodeLocation({ ...decoded(`xmd://repl/${EXECUTION}/entries`), sidekick: "" }),
    ).toThrow();
  });

  it("SS2: resolves an exact saved chat, and refuses everything else", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const location = `xmd://repl/${EXECUTION}/entries/entry-1?view=sidekick&sidekick=chat-2`;

    // An exact association this history holds, including one whose setup was
    // only prepared or failed and which therefore has no provider conversation
    // at all: it is a chat this execution really held, and reading it is not a
    // claim that anything may be sent to it.
    const held = resolved(model, location, chats({ chats: ["chat-1", "chat-2"] }));
    expect(held.sidekick).toBe("chat-2");
    // And it changed nothing else: the surface, the entry and the reading are
    // exactly what the rest of the location named.
    expect([held.surface, held.entry]).toEqual(["entries", model.entries[0]?.scope]);
    expect(held.route.view).toBe("sidekick");

    // An identifier this history does not hold refuses rather than falling back
    // to the current chat or creating one.
    expect(unresolved(model, location, chats({ chats: ["chat-1"] }))).toContain("chat-2");

    // A chat history this version cannot read keeps its own refusal: showing
    // somebody an empty conversation for a file that holds one is the single
    // answer that cannot be corrected later.
    expect(
      unresolved(model, location, chats({ chats: [], refusal: "this pair is incomplete." })),
    ).toContain("this pair is incomplete.");

    // And an execution still held in the older single file has no saved chat to
    // select at all. Reading one does not upgrade it.
    expect(unresolved(model, location, NO_LIVE)).toContain("no Sidekick history");

    // Omission is the current chat, which is what every older location means.
    expect(
      resolved(model, `xmd://repl/${EXECUTION}/entries`, chats({ chats: ["chat-1"] })).sidekick,
    ).toBeUndefined();
  });

  it("SS3: a Sidekick conversation filters beside a frozen entry prefix", function* () {
    const events = yield* agentReferenceEvents();
    const model = projected(events);
    const first = model.checkpoints[0]?.marker;
    if (first === undefined) {
      throw new Error("this reference history retained no checkpoint to freeze at");
    }
    const frozen = projected(events, first);

    // A key the Sidekick's own complete reading establishes. It is applicable
    // beside a checkpoint that precedes the conversation entirely, because
    // freezing a prefix freezes *entry* facts and a chat has no position in
    // this history.
    expect(
      resolved(
        frozen,
        `xmd://repl/${EXECUTION}/sessions?at=${first}&inspect&session=sk:chat`,
        chats({ chats: ["chat-1"], sessions: ["sk:chat"] }),
      ).session,
    ).toBeUndefined();

    // An entry-only key absent from that prefix still refuses: nothing here
    // widens what the selected prefix retained.
    const entryKeys = model.sessions.map((one) => one.sessionKey);
    expect(entryKeys.length).toBeGreaterThan(0);
    for (const key of entryKeys) {
      if (frozen.sessions.some((one) => one.sessionKey === key)) {
        continue;
      }
      expect(
        unresolved(
          frozen,
          `xmd://repl/${EXECUTION}/sessions?at=${first}&inspect&session=${key}`,
          chats({ chats: ["chat-1"], sessions: ["sk:chat"] }),
        ),
      ).toContain(key);
    }

    // A key absent from every applicable fact refuses rather than silently
    // producing an apparently empty conversation.
    expect(
      unresolved(
        model,
        `xmd://repl/${EXECUTION}/sessions?session=sk:nothing`,
        chats({ chats: ["chat-1"], sessions: ["sk:chat"] }),
      ),
    ).toContain("sk:nothing");

    // And a key the entry history itself retains is still answered with the
    // exact group that history holds, beside all of this.
    const retained = model.sessions[0];
    if (retained === undefined) {
      throw new Error("this reference history retained no conversation");
    }
    expect(
      resolved(
        model,
        `xmd://repl/${EXECUTION}/sessions?session=${retained.sessionKey}`,
        chats({ chats: ["chat-1"], sessions: ["sk:chat"] }),
      ).session,
    ).toBe(retained);
  });
});
