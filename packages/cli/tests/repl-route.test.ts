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
import { decodeLocation, encodeLocation, resolveLocation } from "../src/repl/route.ts";
import type { ReplRoute, ReplSelection } from "../src/repl/route.ts";
import { referenceEvents } from "./fixtures/repl/reference.ts";

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

function resolved(model: ReplModel, location: string): ReplSelection {
  const result = resolveLocation(model, decoded(location));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function unresolved(model: ReplModel, location: string): string {
  const result = resolveLocation(model, decoded(location));
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
    expect(refused(`xmd://repl/${EXECUTION}/repl/entry-1?draft=text`)).toContain("a draft is text");
    expect(refused(`xmd://repl/${EXECUTION}/repl?draft=text&at=yield:root:0`)).toContain(
      "a draft is text",
    );
    expect(refused(`xmd://repl/${EXECUTION}/sessions/entry-1`)).toContain("Sessions surface");
    expect(refused(`xmd://repl/${EXECUTION}/repl?pause=1`)).toContain("query");
    expect(refused(`xmd://repl/${EXECUTION}/repl#top`)).toContain("no fragment");
    expect(refused("xmd://repl/../repl")).toContain("opaque identifier");
    expect(refused("xmd://repl/%2E%2E/repl")).toContain("opaque identifier");
  });

  it("R1: cannot spell a route the grammar would refuse", function* () {
    const route = decoded(`xmd://repl/${EXECUTION}/repl/entry-1?at=yield:root:1&inspect`);

    expect(() => encodeLocation({ ...route, at: undefined })).toThrow();
    expect(() => encodeLocation({ ...route, execution: "../escape" })).toThrow();
    expect(() =>
      encodeLocation({ ...route, at: undefined, inspect: false, draft: "typing" }),
    ).toThrow();
    expect(() =>
      encodeLocation({ ...route, surface: "sessions", at: undefined, inspect: false }),
    ).toThrow();
  });
});

describe("REPL route: resolving against one model", () => {
  beforeAll(() => useTempFileCompiler());

  it("M3: returns the exact objects the model holds", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);
    const entry = model.entry;
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
    const answered = head.entry?.elicitations[0];
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
    expect(drawer.elicitation).toBe(historical.entry?.elicitations[0]);

    expect(
      unresolved(
        historical,
        `xmd://repl/${EXECUTION}/repl/entry-1/+elicit?at=${answered.marker}&inspect`,
      ),
    ).toContain("live question");
    expect(resolved(head, `xmd://repl/${EXECUTION}/repl/entry-1/+elicit`).drawers[0].kind).toBe(
      "live-elicit",
    );
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

  it("R2: refuses a draft against an execution that has admitted its entry", function* () {
    const events = yield* referenceEvents();
    const model = projected(events);

    expect(unresolved(model, `xmd://repl/${EXECUTION}/repl?draft=another%20entry`)).toContain(
      "already admitted its entry",
    );
    expect(resolved(projected([]), `xmd://repl/${EXECUTION}/repl?draft=first%20entry`).entry).toBe(
      undefined,
    );
  });
});
