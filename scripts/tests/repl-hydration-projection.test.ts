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
  TERMINAL_EXECUTION,
  FORK_JOURNAL,
  TERMINAL_JOURNAL,
  TERMINAL_MARKERS,
  BEFORE_FAILURE,
  truncatedAfter,
} from "../repl-hydration/fixture.ts";
import {
  JournalParseError,
  MARKER_KINDS,
  MARKER_POLICY,
  markerWeight,
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
import type { Entry, Outcome, Scope, SemanticModel } from "../repl-hydration/model.ts";
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

const TERMINAL = read(TERMINAL_JOURNAL);
const TERMINAL_MARKER_IDS = markersOf(TERMINAL);

function ended(marker?: string): SemanticModel {
  const projected = projectPrefix(TERMINAL_EXECUTION, TERMINAL, marker);
  if (!projected.ok) {
    throw projected.error;
  }
  return projected.value;
}

function entryOf(model: SemanticModel, id: string): Entry {
  const entry = model.entries.find((one) => one.id === id);
  if (entry === undefined) {
    throw new Error(`no ${id} at ${model.marker}`);
  }
  return entry;
}

function statuses(scopes: readonly Scope[]): readonly string[] {
  return scopes.flatMap((scope) => [
    `${scope.name}:${scope.outcome.status}`,
    ...statuses(scope.children),
  ]);
}

function reasonOf(outcome: Outcome): string {
  return outcome.status === "failed" || outcome.status === "interrupted" ? outcome.reason : "";
}

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
  it("reads every journal into one closed set of kinds", function* () {
    expect(EVENTS.length).toBe(23);
    expect(TERMINAL.length).toBe(18);
    const forked = read(FORK_JOURNAL);
    const used = new Set([...EVENTS, ...TERMINAL, ...forked].map((event) => event.kind));
    expect([...used].every((kind) => SEMANTIC_KINDS.some((one) => one === kind))).toBe(true);
    expect(used.size).toBe(SEMANTIC_KINDS.length);
    expect(SEMANTIC_KINDS.length).toBe(11);
  });

  it("mints a marker for every record but a closing one, at the policy's weight", function* () {
    expect(MARKER_POLICY).toEqual({
      "entry.submitted": "boundary",
      "entry.inherited": "boundary",
      "entry.settled": "terminal",
      "entry.failed": "terminal",
      "entry.interrupted": "terminal",
      "scope.opened": "opening",
      "suspension.opened": "opening",
      "binding.published": "checkpoint",
      "outcome.recorded": "checkpoint",
      "scope.completed": "none",
      "suspension.answered": "none",
    });
    for (const kind of SEMANTIC_KINDS) {
      expect(mintsMarker(kind)).toBe(markerWeight(kind) !== "none");
      expect(mintsMarker(kind)).toBe(MARKER_KINDS.includes(kind));
    }

    expect(MARKERS.length).toBe(20);
    expect(MARKERS).toContain("r-09");
    expect(MARKERS).toContain("r-14");
    expect(MARKERS).toContain("r-22");
    expect(MARKERS).toContain("r-23");

    // Only the two closing kinds mint nothing.
    for (const id of ["r-05", "r-06", "r-08"]) {
      expect(MARKERS).not.toContain(id);
    }
    for (const id of ["t-04", "t-05", "t-10"]) {
      expect(TERMINAL_MARKER_IDS).not.toContain(id);
    }
    expect(TERMINAL_MARKER_IDS.length).toBe(15);
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

    const terminal = foldMarkers(TERMINAL_EXECUTION, TERMINAL);
    if (!terminal.ok) {
      throw terminal.error;
    }
    expect([...terminal.value.keys()]).toEqual([...TERMINAL_MARKER_IDS]);
    for (const marker of TERMINAL_MARKER_IDS) {
      expect(ended(marker)).toEqual(terminal.value.get(marker));
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

  it("keeps a binding published before a later failure, and interrupts what it left open", function* () {
    const head = at();
    const release = head.bindings.find((binding) => binding.name === "release");

    expect(release?.value).toBe("0.13.0");
    expect(release?.entry).toBe("entry-2");

    const failed = head.entries.find((entry) => entry.id === "entry-2");
    expect(failed?.outcome).toEqual({
      status: "failed",
      reason: "tag 0.13.0 already exists on the remote",
    });
    // Interrupted, never settled and never independently failed: the Journal
    // recorded one ending, and the scopes carry its reason rather than each
    // inventing a failure of its own.
    expect(scopeOf(head, "entry-2", ["document"]).outcome).toEqual({
      status: "interrupted",
      reason: "tag 0.13.0 already exists on the remote",
    });
    expect(scopeOf(head, "entry-2", ["document", "tag"]).outcome.status).toBe("interrupted");
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

describe("how an entry ends", () => {
  function terminalInside(url: string): EntryLocation {
    const route = decodeRoute(url);
    if (!route.ok) {
      throw route.error;
    }
    const answer = resolveLocation(route.value, TERMINAL_EXECUTION, TERMINAL);
    if (!answer.ok) {
      throw answer.error;
    }
    if (answer.value.kind !== "entry") {
      throw new Error(`${url} named a surface, not an entry`);
    }
    return answer.value;
  }

  it("fails the entry and interrupts only what was still open", function* () {
    const model = ended(TERMINAL_MARKERS.failed);
    const entry = entryOf(model, "entry-2");
    const reason = "the registry rejected the tarball";

    expect(entry.outcome).toEqual({ status: "failed", reason });
    // `verify` completed before the failure and stays completed; `upload` and
    // the `document` around it were open, and carry the entry's reason.
    expect(statuses(entry.scopes)).toEqual([
      "document:interrupted",
      "verify:settled",
      "upload:interrupted",
    ]);
    expect(reasonOf(scopeOf(model, "entry-2", ["document", "upload"]).outcome)).toBe(reason);
    expect(reasonOf(scopeOf(model, "entry-2", ["document", "verify"]).outcome)).toBe("");
  });

  it("interrupts the entry itself when the run was stopped rather than failing", function* () {
    const model = ended(TERMINAL_MARKERS.interrupted);
    const entry = entryOf(model, "entry-3");
    const reason = "the operator stopped the run";

    expect(entry.outcome).toEqual({ status: "interrupted", reason });
    expect(statuses(entry.scopes)).toEqual(["document:interrupted", "watch:interrupted"]);
    // The wait it was holding closes with it.
    expect(model.suspensions).toEqual([]);
    expect(ended(BEFORE_FAILURE).suspensions).toEqual([]);
    expect(ended("t-17").suspensions.map((one) => one.wait)).toEqual(["approve"]);
  });

  it("keeps a binding published before the failure", function* () {
    expect(ended().bindings.map((binding) => `${binding.name}=${binding.value}`)).toEqual([
      "release=0.14.0",
    ]);
    expect(ended().bindings[0].entry).toBe("entry-2");
  });

  it("mints one terminal marker for each way an entry ends", function* () {
    for (const marker of Object.values(TERMINAL_MARKERS)) {
      expect(TERMINAL_MARKER_IDS).toContain(marker);
      const model = ended(marker);
      expect(model.markers[model.markers.length - 1].weight).toBe("terminal");
    }
    expect(markerWeight("entry.settled")).toBe("terminal");
    expect(markerWeight("entry.failed")).toBe("terminal");
    expect(markerWeight("entry.interrupted")).toBe("terminal");
    expect(markerWeight("entry.submitted")).toBe("boundary");
    expect(markerWeight("scope.completed")).toBe("none");
    expect(markerWeight("suspension.answered")).toBe("none");
  });

  it("resolves each terminal marker through the #840 grammar to its exact end state", function* () {
    const settled = terminalInside(
      `xmd://repl/e2/transcript/entry-1/document/check?at=${TERMINAL_MARKERS.settled}`,
    );
    expect(entryOf(settled.model, "entry-1").outcome).toEqual({ status: "settled" });
    expect(settled.scopes.map((scope) => scope.outcome.status)).toEqual(["settled", "settled"]);

    const failed = terminalInside(
      `xmd://repl/e2/transcript/entry-2/document/upload?at=${TERMINAL_MARKERS.failed}`,
    );
    expect(entryOf(failed.model, "entry-2").outcome.status).toBe("failed");
    expect(failed.scopes.map((scope) => scope.outcome.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);

    const stopped = terminalInside(
      `xmd://repl/e2/transcript/entry-3/document/watch?at=${TERMINAL_MARKERS.interrupted}`,
    );
    expect(entryOf(stopped.model, "entry-3").outcome.status).toBe("interrupted");
    expect(stopped.drawers).toEqual([]);

    // Each is the one spelling of that location.
    expect(encodeRoute(failed.route)).toBe(
      "xmd://repl/e2/transcript/entry-2/document/upload?at=t-13",
    );
  });

  it("shows no ending at all in a prefix before the failure", function* () {
    const before = ended(BEFORE_FAILURE);
    const outcomes = before.entries.map((entry) => entry.outcome.status);

    expect(outcomes).toEqual(["settled", "running"]);
    expect(statuses(entryOf(before, "entry-2").scopes)).toEqual([
      "document:running",
      "verify:settled",
      "upload:running",
    ]);
    expect(JSON.stringify(before)).not.toContain("interrupted");
    expect(JSON.stringify(before)).not.toContain("failed");
  });

  describe("negative controls", () => {
    it("restore-abandoned: a fifth status renames an interruption into something the model has no record of", function* () {
      const scope = scopeOf(ended(TERMINAL_MARKERS.failed), "entry-2", ["document", "upload"]);
      const restored = { ...scope.outcome, status: "abandoned" };

      expect(restored.status).toBe("abandoned");
      expect(scope.outcome.status).toBe("interrupted");
      expect(JSON.stringify(ended())).not.toContain("abandoned");
      expect(JSON.stringify(at())).not.toContain("abandoned");
      expect(SEMANTIC_KINDS.join(" ")).not.toContain("abandon");
    });

    it("omit-terminal-kinds: a policy without them cannot stand where the entry ended", function* () {
      const terminals = ["entry.settled", "entry.failed", "entry.interrupted"];
      const weaker = TERMINAL.filter(
        (event) => mintsMarker(event.kind) && !terminals.includes(event.kind),
      );

      expect(weaker.map((event) => event.id)).not.toContain(TERMINAL_MARKERS.failed);

      // The nearest position the weaker policy can offer is the scope opening
      // before it, where entry-2 is still running.
      const reachable = weaker.filter((event) => event.seq <= 13);
      const nearest = reachable[reachable.length - 1].id;
      expect(nearest).toBe("t-12");
      expect(entryOf(ended(nearest), "entry-2").outcome.status).toBe("running");
      expect(entryOf(ended(TERMINAL_MARKERS.failed), "entry-2").outcome.status).toBe("failed");
    });

    it("closing-marker: minting on completion gives one scope two positions", function* () {
      const closing = TERMINAL.filter(
        (event) => mintsMarker(event.kind) || event.kind === "scope.completed",
      ).map((event) => event.id);

      expect(closing.length).toBe(TERMINAL_MARKER_IDS.length + 3);
      expect(closing).toContain("t-04");
      // `check` opened at t-03 and completed at t-04. One marker, updated.
      expect(TERMINAL_MARKER_IDS).toContain("t-03");
      expect(TERMINAL_MARKER_IDS).not.toContain("t-04");
      expect(scopeOf(ended(), "entry-1", ["document", "check"]).marker).toBe("t-03");
    });

    it("interrupt-completed-scope: stamping the whole subtree rewrites a scope that finished", function* () {
      const entry = entryOf(ended(TERMINAL_MARKERS.failed), "entry-2");
      const stamped = (scopes: readonly Scope[]): readonly string[] =>
        scopes.flatMap((scope) => [`${scope.name}:interrupted`, ...stamped(scope.children)]);

      expect(stamped(entry.scopes)).toEqual([
        "document:interrupted",
        "verify:interrupted",
        "upload:interrupted",
      ]);
      expect(statuses(entry.scopes)).toEqual([
        "document:interrupted",
        "verify:settled",
        "upload:interrupted",
      ]);
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

  it("keeps process-local state out of everything that reads durable state", function* () {
    const durable = [
      "journal.ts",
      "model.ts",
      "project.ts",
      "purity.ts",
      "location.ts",
      "store.ts",
    ];
    for (const name of durable) {
      // The pause controller and the Agent stream are the two halves process
      // loss takes. Neither is reachable from anything that reads a record.
      expect(yield* importsOf(name)).not.toContain("./overlay.ts");
      expect(yield* importsOf(name)).not.toContain("./ephemeral.ts");
    }
    expect(yield* importsOf("overlay.ts")).toEqual([]);
    expect(yield* importsOf("ephemeral.ts")).toEqual([]);

    // Replay is where a live process and a record meet, so it may reach both
    // — and it reads the projection, because a journal that cannot have
    // happened is not one to resume from.
    expect(yield* importsOf("replay.ts")).toEqual([
      "./ephemeral.ts",
      "./journal.ts",
      "./project.ts",
      "effection",
    ]);
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
