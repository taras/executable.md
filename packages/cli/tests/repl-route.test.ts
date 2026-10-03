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

const EXECUTION = "kf39sla2";

describe("REPL route: the grammar", () => {
  it("R1: decodes equivalent spellings and query orders into one route", function* () {
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/repl/entry-1/+elicit:yield:root:6?at=yield:root:6&inspect`,
    );

    expect(canonical).toEqual(
      decoded(
        `xmd://repl/${EXECUTION}/repl/entry%2D1/+elicit:yield%3Aroot%3A6?inspect&at=yield%3Aroot%3A6`,
      ),
    );
    expect(canonical.execution).toBe(EXECUTION);
    expect(canonical.surface).toBe("repl");
    expect(canonical.scopes).toEqual(["entry-1"]);
    expect(canonical.drawers).toEqual([{ kind: "recorded-elicit", marker: "yield:root:6" }]);
    expect(canonical.at).toBe("yield:root:6");
    expect(canonical.inspect).toBe(true);
    expect(canonical.draft).toBe(undefined);
  });

  it("R1: round-trips every valid surface through one canonical spelling", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions`,
      `xmd://repl/${EXECUTION}/repl`,
      `xmd://repl/${EXECUTION}/repl/entry-1`,
      `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-1`,
      `xmd://repl/${EXECUTION}/repl/entry-1/generated-1`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+history`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+binding:plan`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+history/+binding:plan`,
      `xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1`,
      `xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1&inspect`,
      `xmd://repl/${EXECUTION}/repl?draft=one%20more%20line`,
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
    expect(refused(`xmd://repl/${EXECUTION}/repl/%zz`)).toContain("escapes");
    expect(refused(`xmd://repl/${EXECUTION}/repl//entry-1`)).toContain("empty path segment");
    expect(refused(`xmd://repl/${EXECUTION}/repl/entry-1?inspect`)).toContain("needs the position");
    expect(refused(`xmd://repl/${EXECUTION}/repl/entry-1/+history/Checklist-1`)).toContain(
      "scopes precede its drawers",
    );
    expect(refused(`xmd://repl/${EXECUTION}/repl/entry-1/+notes`)).toContain("names a drawer");
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+binding:plan`)).toContain("Sessions surface");
    expect(refused(`xmd://repl/${EXECUTION}/repl?pause=1`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/repl#top`)).toContain("no fragment");
    expect(refused("xmd://repl/../repl")).toContain("opaque identifier");
    expect(refused("xmd://repl/%2E%2E/repl")).toContain("opaque identifier");
  });

  it("R1: cannot spell a route the grammar would refuse", function* () {
    const route = decoded(`xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1&inspect`);

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
      `xmd://repl/${EXECUTION}/repl/entry-2/Checklist-1/+binding:plan` +
      `?at=yield:root:6&inspect&draft=another%20entry&session=stub:planner`;
    const route = decoded(location);

    expect(route.scopes).toEqual(["entry-2", "Checklist-1"]);
    expect(route.drawers).toEqual([{ kind: "binding", name: "plan" }]);
    expect(route.at).toBe("yield:root:6");
    expect(route.inspect).toBe(true);
    expect(route.draft).toBe("another entry");
    expect(route.session).toBe("stub:planner");
    expect(route.surface).toBe("repl");

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

    const head = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1`);
    expect(head.entry).toBe(entry);
    expect(head.scope).toBe(entry);
    expect(head.ancestry).toEqual([entry]);

    const inner = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-1`);
    expect(inner.scope).toBe(nested);
    expect(inner.ancestry.length).toBe(2);
    expect(inner.ancestry[0]).toBe(entry);

    const drawer = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/+binding:plan`);
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
    const location = `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-1`;

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
      `xmd://repl/${EXECUTION}/repl/entry-1/+elicit:${answered.marker}` +
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
        `xmd://repl/${EXECUTION}/repl/entry-1/+elicit?at=${answered.marker}&inspect`,
      ),
    ).toContain("live question");
    // No reading of any history can mount a live question's drawer. A waiting
    // question is the one fact a Journal never holds: it records answers. So a
    // settled history, and an unsettled one that has already recorded this
    // answer and merely has its root left to close, are both consistent with no
    // question ever arriving — and `settled` cannot tell them apart from one
    // that is really asking.
    const live = `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`;
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

    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-2`)).toContain("no entry-2");
    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/Checklist-1`)).toContain(
      "no Checklist-1",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-2`)).toContain(
      "holds no Checklist-2",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/+binding:absent`)).toContain(
      "publishes no absent",
    );
    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/+binding:plan`)).toContain(
      "scope that published the name",
    );
    expect(
      unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/+elicit:yield:root:1`),
    ).toContain("recorded no question at");
  });

  it("R2: a route selecting another prefix than the model refuses rather than answering", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1`)).toContain(
      "was not projected at",
    );
  });

  it("R2: a refused navigation leaves the resolved view it was asked from untouched", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const standing = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-1`);
    const before = { ...standing, ancestry: [...standing.ancestry] };

    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-9`)).toContain(
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

    const beside = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1?draft=another%20entry`);
    expect(beside.entry).toBe(entry);
    expect(beside.route.draft).toBe("another entry");

    // The same beside a nested scope, and beside a conversation filter.
    const nested = resolved(
      model,
      `xmd://repl/${EXECUTION}/repl/entry-1/Checklist-1?draft=another%20entry`,
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
      `xmd://repl/${EXECUTION}/repl?at=${encodeURIComponent(marker)}&inspect&draft=typed`,
    );
    expect(inspecting.route.draft).toBe("typed");
    expect(inspecting.route.inspect).toBe(true);

    // An execution with no entry still resolves its own draft, as it always did.
    expect(resolved(projected([]), `xmd://repl/${EXECUTION}/repl?draft=first%20entry`).entry).toBe(
      undefined,
    );
  });

  it("ER1: an entry absent from the selected prefix refuses, whole", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    // Nothing partial: the refusal carries no selection at all, so there is no
    // entry, ancestry or scope for a caller to read past it and no adjacent
    // entry guessed in the absent one's place.
    const attempt = resolveLocation(
      model,
      decoded(`xmd://repl/${EXECUTION}/repl/entry-2/Checklist-1`),
      NO_LIVE,
    );
    if (attempt.ok) {
      throw new Error("a prefix that admitted no entry-2 must refuse a location naming it");
    }
    expect(attempt.error.message).toContain("no entry-2");
    expect(Object.hasOwn(attempt, "value")).toBe(false);

    // The entry it does hold is still exactly the one it held before.
    expect(resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1`).entry).toBe(
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
        `xmd://repl/${EXECUTION}/repl/entry-1/+elicit?at=yield:root:0&inspect`,
        live,
      ),
    ).toContain("frozen at an earlier position");

    // Cold, with no process holding a question: a Journal records answers, never a
    // question that is still waiting, so nothing retained can establish this.
    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`)).toContain(
      "nothing is being asked",
    );

    // And on the surface it does belong to, while a question is held, it resolves.
    const opened = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`, live);
    expect(opened.drawers).toEqual([{ kind: "live-elicit" }]);
  });
});

describe("REPL route: the conversation filter", () => {
  it("R1: encodes session last, after every member that was canonical before it", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/sessions/+permission?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/repl/entry-1?session=xmd:v1:a`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+history?at=yield:root:1&inspect&session=one`,
      `xmd://repl/${EXECUTION}/repl?draft=one%20more%20line&session=one`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+binding:plan?at=yield:root:1&session=one`,
    ];

    for (const location of locations) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(encodeLocation(decoded(location)))).toEqual(decoded(location));
    }
  });

  it("R1: leaves every location that names no conversation byte-identical", function* () {
    const locations = [
      `xmd://repl/${EXECUTION}/sessions`,
      `xmd://repl/${EXECUTION}/repl`,
      `xmd://repl/${EXECUTION}/repl/entry-1`,
      `xmd://repl/${EXECUTION}/repl/entry-1/+history/+binding:plan`,
      `xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1&inspect`,
      `xmd://repl/${EXECUTION}/repl?draft=one%20more%20line`,
    ];

    for (const location of locations) {
      expect(encodeLocation(decoded(location))).toBe(location);
      expect(decoded(location).session).toBe(undefined);
    }
  });

  it("R1: reads query members by name, so order still does not matter", function* () {
    const canonical = decoded(
      `xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:6&inspect&session=xmd:v1:a`,
    );

    expect(canonical).toEqual(
      decoded(`xmd://repl/${EXECUTION}/repl/entry-1?session=xmd:v1:a&inspect&at=yield%3Aroot%3A6`),
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
    expect(refused(`xmd://repl/${EXECUTION}/repl/entry-1/+permission`)).toContain(
      "Sessions surface",
    );
    // And Sessions still holds nothing else.
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+history`)).toContain("Sessions surface");
    expect(refused(`xmd://repl/${EXECUTION}/sessions/+elicit`)).toContain("Sessions surface");

    const sessions = decoded(`xmd://repl/${EXECUTION}/sessions`);
    expect(() =>
      encodeLocation({ ...sessions, surface: "repl", drawers: [{ kind: "live-permission" }] }),
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
    const beside = resolved(model, `xmd://repl/${EXECUTION}/repl/entry-1?session=stub%3Abuild`);
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
    const question = `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`;

    // Holding a permission request says nothing about a waiting question.
    expect(unresolved(model, question, holding({ permission: true }))).toContain(
      "nothing is being asked",
    );
    expect(resolved(model, question, holding({ elicit: true })).drawers[0].kind).toBe(
      "live-elicit",
    );
  });
});
