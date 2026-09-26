/**
 * One Journal, one URL, one semantic answer — and nothing else in the answer.
 *
 * Slice 1 of #842 establishes the pure boundary before StarFX exists, so every
 * case here is about what a *record* can produce and what it cannot reach. The
 * claims that matter are the negative ones: a historical prefix that cannot
 * see a later fact, a projector that cannot be handed a cached snapshot, a
 * durable record that cannot carry a continuation, and a model that cannot
 * hold anything but frozen plain data.
 *
 * Each structural claim carries a named control — a weaker implementation
 * written here — that *accepts* what the real one refuses, or produces the
 * answer the weaker one would have produced. A refusal nothing else would have
 * accepted is a refusal nobody is checking.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

import {
  EXECUTION,
  JOURNAL,
  journalChanging,
  journalDropping,
  journalMissing,
  journalWith,
  journalWithout,
  LIVE_HEAD,
  PAUSE_MARKER,
  positionOf,
  truncatedAfter,
} from "../repl-hydration/fixture.ts";
import {
  JournalParseError,
  MARKER_KINDS,
  mintsMarker,
  parseJournal,
  SEMANTIC_KINDS,
} from "../repl-hydration/journal.ts";
import type { SemanticEvent } from "../repl-hydration/journal.ts";
import {
  decodeRoute,
  encodeRoute,
  resolveLocation,
  RouteRefusal,
} from "../repl-hydration/location.ts";
import type { EntryLocation, SemanticLocation } from "../repl-hydration/location.ts";
import type { Scope, SemanticModel } from "../repl-hydration/model.ts";
import * as overlay from "../repl-hydration/overlay.ts";
import {
  foldMarkers,
  markersOf,
  ProjectionError,
  projectPrefix,
  UnknownMarkerError,
} from "../repl-hydration/project.ts";
import { foreignValues } from "../repl-hydration/purity.ts";

function read(records: readonly unknown[]): readonly SemanticEvent[] {
  const parsed = parseJournal(records);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function refusedRead(records: readonly unknown[]): JournalParseError {
  const parsed = parseJournal(records);
  if (parsed.ok) {
    throw new Error("the journal was read, and should not have been");
  }
  if (!(parsed.error instanceof JournalParseError)) {
    throw parsed.error;
  }
  return parsed.error;
}

const EVENTS = read(JOURNAL);
const MARKERS = markersOf(EVENTS);

function at(marker?: string, events: readonly SemanticEvent[] = EVENTS): SemanticModel {
  const projected = projectPrefix(EXECUTION, events, marker);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function refusedProjection(events: readonly SemanticEvent[], marker?: string): ProjectionError {
  const projected = projectPrefix(EXECUTION, events, marker);
  if (projected.ok) {
    throw new Error("the journal projected, and should not have");
  }
  if (!(projected.error instanceof ProjectionError)) {
    throw projected.error;
  }
  return projected.error;
}

function located(url: string, events: readonly SemanticEvent[] = EVENTS): SemanticLocation {
  const route = decodeRoute(url);
  if (!route.ok) {
    throw route.error;
  }
  const answer = resolveLocation(route.value, EXECUTION, events);
  if (!answer.ok) {
    throw answer.error;
  }
  return answer.value;
}

function inside(url: string, events: readonly SemanticEvent[] = EVENTS): EntryLocation {
  const where = located(url, events);
  if (where.kind !== "entry") {
    throw new Error(`${url} named a surface, not an entry`);
  }
  return where;
}

function refusedLocation(url: string, events: readonly SemanticEvent[] = EVENTS): RouteRefusal {
  const route = decodeRoute(url);
  if (!route.ok) {
    throw route.error;
  }
  const answer = resolveLocation(route.value, EXECUTION, events);
  if (answer.ok) {
    throw new Error(`${url} resolved, and should not have`);
  }
  if (!(answer.error instanceof RouteRefusal)) {
    throw answer.error;
  }
  return answer.error;
}

function names(scopes: readonly Scope[]): readonly string[] {
  return scopes.map((scope) => scope.name);
}

function scopeOf(model: SemanticModel, entry: string, path: readonly string[]): Scope {
  let level = model.entries.find((one) => one.id === entry)?.scopes ?? [];
  let found: Scope | undefined;
  for (const name of path) {
    found = level.find((scope) => scope.name === name);
    if (found === undefined) {
      throw new Error(`no ${path.join("/")} in ${entry} at ${model.marker}`);
    }
    level = found.children;
  }
  if (found === undefined) {
    throw new Error(`no scope path given for ${entry}`);
  }
  return found;
}

describe("the durable vocabulary", () => {
  it("reads the representative journal into a closed set of kinds", function* () {
    expect(EVENTS.length).toBe(23);
    const used = new Set(EVENTS.map((event) => event.kind));
    expect([...used].every((kind) => SEMANTIC_KINDS.some((one) => one === kind))).toBe(true);
    expect(used.size).toBe(SEMANTIC_KINDS.length);
  });

  it("mints a marker for an opening and updates one for a completion", function* () {
    expect(MARKERS.length).toBe(18);
    expect(MARKERS).toContain("r-22");
    expect(MARKERS).toContain("r-23");

    // The completions and settlements in the fixture mint nothing.
    for (const id of ["r-05", "r-06", "r-08", "r-09", "r-14"]) {
      expect(MARKERS).not.toContain(id);
    }
    for (const kind of SEMANTIC_KINDS) {
      expect(mintsMarker(kind)).toBe(MARKER_KINDS.includes(kind));
    }
  });

  it("refuses a record naming the pause controller", function* () {
    const refused = refusedRead(journalChanging(positionOf("r-22"), { kind: "pause.held" }));
    expect(refused.field).toBe("kind");
    expect(refused.message).toContain("is not a semantic kind");
  });

  it("refuses a record carrying a continuation it never declared", function* () {
    const refused = refusedRead(journalChanging(positionOf("r-22"), { continuation: "held" }));
    expect(refused.field).toBe("continuation");
    expect(refused.message).toContain("is not part of a suspension.opened record");
  });

  it("refuses a field holding something that is not durable data", function* () {
    const refused = refusedRead(
      journalChanging(positionOf("r-22"), { prompt: () => "ask the user" }),
    );
    expect(refused.field).toBe("prompt");
  });

  it("refuses a truncated record, naming the field it is missing", function* () {
    const refused = refusedRead(journalDropping(positionOf("r-07"), "value"));
    expect(refused.index).toBe(6);
    expect(refused.field).toBe("value");
  });

  it("refuses a journal whose append positions do not run in order", function* () {
    expect(refusedRead(journalChanging(positionOf("r-07"), { seq: 99 })).field).toBe("seq");

    // A record lifted out of the middle leaves a gap, and the gap is what
    // says the stream is short rather than merely different.
    const gap = refusedRead(journalMissing(positionOf("r-07")));
    expect(gap.field).toBe("seq");
    expect(gap.index).toBe(6);
  });

  it("refuses a record recorded twice under one identity", function* () {
    expect(refusedRead(journalChanging(positionOf("r-08"), { id: "r-07" })).field).toBe("id");
  });

  it("refuses a record that is not a record", function* () {
    expect(refusedRead(journalWith(3, ["r-04"])).field).toBe("record");
    expect(refusedRead(journalWith(3, null)).field).toBe("record");
    expect(refusedRead(journalWith(3, "r-04")).field).toBe("record");
  });

  it("reads a journal that simply stops, because stopping is not corruption", function* () {
    const cut = parseJournal(truncatedAfter(8));
    expect(cut.ok).toBe(true);
  });

  describe("negative controls", () => {
    it("open-vocabulary: a reader that passes an unknown kind through accepts the pause record", function* () {
      const records = journalChanging(positionOf("r-22"), { kind: "pause.held" });
      const permissive = records.filter(
        (record) => record !== null && typeof record === "object" && "kind" in record,
      );

      expect(permissive.length).toBe(records.length);
      expect(refusedRead(records).field).toBe("kind");
    });

    it("skip-malformed: a reader that drops what it cannot read answers a plausible journal", function* () {
      const records = journalDropping(positionOf("r-07"), "value");
      const skipping = records.filter((_, index) => index !== positionOf("r-07"));

      // The weaker reader answers 22 readable records and a transcript that is
      // wrong in exactly one invisible way: `project` was never published.
      expect(skipping.length).toBe(22);
      expect(refusedRead(records).field).toBe("value");
    });
  });
});

describe("the semantic projection", () => {
  it("folds incrementally to the same model a prefix projects from scratch", function* () {
    const accumulated = foldMarkers(EXECUTION, EVENTS);
    if (!accumulated.ok) {
      throw accumulated.error;
    }
    expect([...accumulated.value.keys()]).toEqual([...MARKERS]);
    for (const marker of MARKERS) {
      expect(at(marker)).toEqual(accumulated.value.get(marker));
    }
  });

  it("ends the prefix at the selected record, so the live head is the newest marker", function* () {
    expect(at().marker).toBe(LIVE_HEAD);
    // The journal's last record mints a marker, so these two selections name
    // one prefix. The count is what says so rather than the assumption.
    expect(at()).toEqual(at(LIVE_HEAD));
    expect(at().records).toBe(JOURNAL.length);
  });

  it("excludes a background outcome at the expansion pause point and includes it at the head", function* () {
    const held = at(PAUSE_MARKER);
    const head = at(LIVE_HEAD);

    expect(held.outcomes).toEqual([]);
    expect(head.outcomes.map((outcome) => outcome.label)).toEqual(["remote tags fetched"]);
    expect(head.records).toBe(held.records + 1);

    // The two positions are independent: the pause point moved nowhere while
    // the durable head advanced, and the drawers at both are the same stack.
    expect(held.suspensions.map((one) => one.wait)).toEqual(["source", "confirm"]);
    expect(head.suspensions.map((one) => one.wait)).toEqual(["source", "confirm"]);
  });

  it("cannot observe a later binding, outcome, drawer or settlement from an earlier marker", function* () {
    const early = at("r-03");
    const head = at();

    expect(early.bindings).toEqual([]);
    expect(head.bindings.length).toBe(3);

    expect(early.outcomes).toEqual([]);
    expect(early.suspensions).toEqual([]);
    expect(head.suspensions.length).toBe(2);

    expect(scopeOf(early, "entry-1", ["document"]).outcome).toEqual({ status: "running" });
    expect(scopeOf(early, "entry-1", ["document", "plan"]).outcome).toEqual({ status: "running" });
    expect(scopeOf(head, "entry-1", ["document", "plan"]).outcome).toEqual({ status: "settled" });

    expect(early.entries.map((entry) => entry.id)).toEqual(["entry-1"]);
    expect(early.markers.map((marker) => marker.id)).toEqual(["r-01", "r-02", "r-03"]);
  });

  it("reconstructs the version of a rebound name that the selected marker knew", function* () {
    const before = at("r-16").bindings.find((binding) => binding.name === "project");
    const after = at().bindings.find((binding) => binding.name === "project");

    expect(before?.value).toBe("executable.md");
    expect(before?.marker).toBe("r-07");
    expect(after?.value).toBe("executable.md@0.13.1");
    expect(after?.marker).toBe("r-20");
  });

  it("inherits the latest published root bindings into each serial entry", function* () {
    const head = at();
    const inherited = (id: string) =>
      head.entries
        .find((entry) => entry.id === id)
        ?.inherited.map((one) => `${one.name}=${one.value}`);

    expect(inherited("entry-1")).toEqual([]);
    expect(inherited("entry-2")).toEqual(["project=executable.md"]);
    expect(inherited("entry-3")).toEqual(["project=executable.md", "release=0.13.0"]);
    // What entry-3 published itself is not what it inherited.
    expect(inherited("entry-3")).not.toContain("changelog=CHANGELOG.md");
  });

  it("keeps a binding published before a later failure, and abandons what the failure left open", function* () {
    const head = at();
    const release = head.bindings.find((binding) => binding.name === "release");

    expect(release?.value).toBe("0.13.0");
    expect(release?.entry).toBe("entry-2");

    const failed = head.entries.find((entry) => entry.id === "entry-2");
    expect(failed?.outcome).toEqual({
      status: "failed",
      reason: "tag 0.13.0 already exists on the remote",
    });
    // Abandoned, never settled: the scopes did not complete, and recording
    // that they did would claim an outcome the execution never reached.
    expect(scopeOf(head, "entry-2", ["document"]).outcome.status).toBe("abandoned");
    expect(scopeOf(head, "entry-2", ["document", "tag"]).outcome.status).toBe("abandoned");
  });

  it("orders concurrent sibling scopes by source, not by the order they opened", function* () {
    const head = at();
    expect(names(scopeOf(head, "entry-3", ["document"]).children)).toEqual(["write", "publish"]);

    const opened = EVENTS.filter(
      (event) =>
        event.kind === "scope.opened" && event.entry === "entry-3" && event.scope.length === 1,
    ).map((event) => event.id);
    expect(opened).toEqual(["r-17", "r-18"]);
  });

  it("holds nothing but frozen plain data", function* () {
    for (const marker of MARKERS) {
      expect(foreignValues(at(marker))).toEqual([]);
    }
    expect(Object.isFrozen(at())).toBe(true);
    expect(Object.isFrozen(at().entries)).toBe(true);
    expect(foreignValues(at())).toEqual([]);
  });

  it("refuses a marker no record minted", function* () {
    const missing = projectPrefix(EXECUTION, EVENTS, "r-99");
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      return;
    }
    expect(missing.error).toBeInstanceOf(UnknownMarkerError);
    expect(missing.error.message).toContain("names no semantic marker");

    // A record that exists and mints nothing is not a marker either.
    const completion = projectPrefix(EXECUTION, EVENTS, "r-06");
    expect(completion.ok).toBe(false);
  });

  describe("negative controls", () => {
    it("leaky-prefix: hiding later entries from the head still shows later facts", function* () {
      const head = at();
      const leaked = {
        ...head,
        entries: head.entries.filter((entry) => entry.marker <= "r-03"),
      };

      // A "historical view" built by filtering the head keeps every binding,
      // drawer, outcome and settlement that happened afterwards.
      expect(leaked.bindings.length).toBe(3);
      expect(leaked.suspensions.length).toBe(2);
      expect(leaked.outcomes.length).toBe(1);
      expect(at("r-03").bindings).toEqual([]);
      expect(at("r-03").outcomes).toEqual([]);
    });

    it("pause-truncates-head: stopping the fold at the pause marker loses the background outcome", function* () {
      const stopped = at(PAUSE_MARKER);

      expect(stopped.outcomes).toEqual([]);
      expect(at().outcomes.length).toBe(1);
      expect(at().marker).not.toBe(PAUSE_MARKER);
    });

    it("append-order-siblings: keeping the order the coroutines opened in reverses the document", function* () {
      const appended = EVENTS.filter(
        (event) =>
          event.kind === "scope.opened" && event.entry === "entry-3" && event.scope.length === 1,
      ).map((event) => (event.kind === "scope.opened" ? event.name : ""));

      expect(appended).toEqual(["publish", "write"]);
      expect(names(scopeOf(at(), "entry-3", ["document"]).children)).toEqual(["write", "publish"]);
    });

    it("decorated-model: one renderer handle on the model is found and named", function* () {
      const decorated = Object.freeze({
        ...at(),
        renderer: Object.freeze({ draw: () => "" }),
      });

      expect(foreignValues(decorated)).toEqual(["model.renderer.draw: a function"]);
      expect(foreignValues(Object.freeze({ ...at(), cells: new Uint8Array(4) }))).toEqual([
        "model.cells: a Uint8Array",
      ]);
      expect(foreignValues(Object.freeze({ ...at(), scroll: { top: 4 } }))).toEqual([
        "model.scroll: an unfrozen object",
      ]);
      expect(foreignValues(at())).toEqual([]);
    });

    it("snapshot-dependent: a projector that needs its cache answers nothing without one", function* () {
      const accumulated = foldMarkers(EXECUTION, EVENTS);
      if (!accumulated.ok) {
        throw accumulated.error;
      }
      const cached = (table: ReadonlyMap<string, SemanticModel>, marker: string) =>
        table.get(marker);

      expect(cached(accumulated.value, PAUSE_MARKER)).toBeDefined();
      expect(cached(new Map(), PAUSE_MARKER)).toBeUndefined();
      // The real projector takes records and a marker. There is no argument a
      // cache would go in, so discarding one changes nothing.
      expect(at(PAUSE_MARKER)).toEqual(at(PAUSE_MARKER, read(JOURNAL)));
    });
  });
});

describe("a journal that reads but cannot have happened", () => {
  it("refuses overlapping top-level entries", function* () {
    const refused = refusedProjection(read(journalWithout(positionOf("r-09"))));
    expect(refused.record).toBe("r-10");
    expect(refused.message).toContain("overlaps entry-1, which is still running");
  });

  it("refuses an entry that settles while a scope it opened has not completed", function* () {
    const refused = refusedProjection(read(journalWithout(positionOf("r-08"))));
    expect(refused.record).toBe("r-09");
    expect(refused.message).toContain("has not completed");
  });

  it("refuses a scope completed twice, and one completed around a live child", function* () {
    const twice = refusedProjection(
      read(
        journalWith(positionOf("r-07"), {
          id: "r-07",
          seq: 7,
          at: 21,
          kind: "scope.completed",
          entry: "entry-1",
          scope: ["document"],
          name: "plan",
        }),
      ),
    );
    expect(twice.message).toContain("which is already settled");

    const around = refusedProjection(read(journalWithout(positionOf("r-06"))));
    expect(around.message).toContain("still open inside it");
  });

  it("refuses malformed ownership", function* () {
    const stranger = refusedProjection(
      read(journalChanging(positionOf("r-04"), { entry: "entry-9" })),
    );
    expect(stranger.message).toContain("names an entry no record submitted");

    const unowned = refusedProjection(
      read(journalChanging(positionOf("r-05"), { scope: ["document"] })),
    );
    expect(unowned.message).toContain("answers no wait this entry has open there");

    const nowhere = refusedProjection(
      read(journalChanging(positionOf("r-03"), { scope: ["report"] })),
    );
    expect(nowhere.message).toContain("names a scope path no record opened");
  });

  it("refuses two siblings claiming one source position", function* () {
    const refused = refusedProjection(read(journalChanging(positionOf("r-18"), { source: 1 })));
    expect(refused.message).toContain("claims source position 1, which publish holds");
  });

  describe("negative controls", () => {
    it("permissive-ownership: a fold without the serial rule describes two live entries", function* () {
      const events = read(journalWithout(positionOf("r-09")));
      const live = events
        .filter((event) => event.kind === "entry.submitted")
        .map((one) => one.entry);

      // Nothing in the records prevents this: the refusal is the projection's.
      expect(live).toEqual(["entry-1", "entry-2", "entry-3"]);
      expect(events.some((event) => event.kind === "entry.settled")).toBe(false);
      expect(refusedProjection(events).record).toBe("r-10");
    });

    it("permissive-closure: accepting a settlement over an open scope keeps a false live tree", function* () {
      const events = read(journalWithout(positionOf("r-08")));
      const completed = events.filter(
        (event) => event.kind === "scope.completed" && event.entry === "entry-1",
      );

      expect(completed.map((event) => event.id)).toEqual(["r-06"]);
      expect(refusedProjection(events).record).toBe("r-09");
    });
  });
});

describe("the #840 grammar, resolved against a prefix", () => {
  it("decodes and re-encodes one location in one spelling", function* () {
    const url =
      "xmd://repl/e1/transcript/entry-3/document/publish/+source/+confirm?at=r-22&inspect";
    const where = inside(url);

    expect(encodeRoute(where.route)).toBe(url);
    expect(where.surface).toBe("transcript");
    expect(where.inspecting).toBe(true);
    expect(where.model.marker).toBe(PAUSE_MARKER);
    expect(names(where.scopes)).toEqual(["document", "publish"]);
    expect(where.drawers.map((drawer) => drawer.wait)).toEqual(["source", "confirm"]);
  });

  it("accepts an equivalent spelling and answers the same structure", function* () {
    const canonical = "xmd://repl/e1/transcript/entry-3/document?at=r-22&draft=tag%20it";
    const equivalent = "xmd://repl/e1/transcript/entry-3/%64ocument?draft=tag%20it&at=r-22";

    expect(encodeRoute(inside(equivalent).route)).toBe(canonical);
    expect(inside(equivalent).draft).toBe("tag it");
  });

  it("hands back the model's own values rather than a second projection", function* () {
    const where = inside("xmd://repl/e1/transcript/entry-3/document/write?at=r-22");
    const entry = where.model.entries.find((one) => one.id === "entry-3");

    expect(where.entry).toBe(entry);
    expect(where.scopes[0]).toBe(entry?.scopes[0]);
    expect(where.scopes[1]).toBe(entry?.scopes[0].children[0]);
  });

  it("answers the same URL differently at two markers, and refuses where the execution had not been", function* () {
    const live = "xmd://repl/e1/transcript/entry-3/document";
    expect(inside(live).model.marker).toBe(LIVE_HEAD);
    expect(names(inside(live).scopes)).toEqual(["document"]);

    const early = refusedLocation("xmd://repl/e1/transcript/entry-3/document?at=r-03");
    expect(early.position).toBe("entry");
    expect(early.found).toEqual(["entry-1"]);

    const closed = refusedLocation("xmd://repl/e1/transcript/entry-3/document/+source?at=r-16");
    expect(closed.position).toBe("drawer[0]");
    expect(closed.found).toEqual([]);
  });

  it("refuses an unresolved segment, a marker nothing minted, and another execution", function* () {
    // `document` resolves and `plan` does not, so the refusal names the
    // segment that missed rather than the path that contains it.
    const scope = refusedLocation("xmd://repl/e1/transcript/entry-3/document/plan");
    expect(scope.position).toBe("scope[1]");
    expect(scope.found).toEqual(["write", "publish"]);

    const marker = refusedLocation("xmd://repl/e1/bindings?at=r-99");
    expect(marker.position).toBe("at");
    expect(marker.found).toContain(PAUSE_MARKER);

    const execution = refusedLocation("xmd://repl/e2/bindings");
    expect(execution.position).toBe("execution");
  });

  it("refuses a URL that is not spelled like a location before any journal is read", function* () {
    const syntax = decodeRoute("xmd://repl/e1/transcript/entry-1/+project/document");
    expect(syntax.ok).toBe(false);
  });
});

describe("the boundary", () => {
  /** Every module specifier one source file imports, deduplicated and sorted. */
  function* importsOf(name: string): Operation<string[]> {
    const source = yield* readTextFile(
      fileURLToPath(new URL(`../repl-hydration/${name}`, import.meta.url)),
    );
    const found = [...source.matchAll(/(?:^|\n)(?:import|export)[^\n]*?from\s+"([^"]+)"/g)];
    return [...new Set(found.map((one) => one[1]))].toSorted();
  }

  it("keeps the live overlay out of everything that reads durable state", function* () {
    for (const name of ["journal.ts", "model.ts", "project.ts", "purity.ts", "location.ts"]) {
      expect(yield* importsOf(name)).not.toContain("./overlay.ts");
    }
    expect(yield* importsOf("overlay.ts")).toEqual([]);
  });

  it("reaches the URL grammar through #840 rather than restating it", function* () {
    expect(yield* importsOf("location.ts")).toEqual([
      "../repl-compose/router.ts",
      "./journal.ts",
      "./model.ts",
      "./project.ts",
      "effection",
    ]);
    expect(yield* importsOf("journal.ts")).toEqual(["effection"]);
    expect(yield* importsOf("project.ts")).toEqual(["./journal.ts", "./model.ts", "effection"]);
  });

  it("leaves the pause controller nowhere but the live overlay", function* () {
    const held = overlay.live(PAUSE_MARKER);
    expect(held.canContinue).toBe(true);
    expect(overlay.released(held).canContinue).toBe(false);
    expect(overlay.cold().held).toBe(false);

    // Nothing durable and nothing addressable knows any of that.
    const serialized = JSON.stringify({ journal: JOURNAL, model: at(), markers: MARKERS });
    for (const word of ["pauseMarker", "canContinue", "continuation", "EXPANSION PAUSED"]) {
      expect(serialized).not.toContain(word);
    }
  });
});
