/**
 * A fork stands on its own, and points at where it came from.
 *
 * Slice 4 of #842. Two things have to be true at once and they pull in
 * opposite directions: the fork must reconstruct with the parent gone, and it
 * must still show what it was taken from. They are reconciled by recording
 * the parent's *name* and not its values — the environment is published into
 * the fork's own Journal, and the pointer is a label that needs the parent
 * only when someone follows it.
 *
 * The second half of this file is the refusal matrix: every layer that reads
 * untrusted input — the record parser, the projection, the URL codec, the URL
 * resolver and hydration — asked for a malformed, a truncated and an
 * inconsistent input, and required to answer with a refusal rather than a
 * plausible partial view.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import {
  EXECUTION,
  FORK_EXECUTION,
  FORK_INHERITED,
  FORK_JOURNAL,
  FORK_SOURCE,
  forkChanging,
  forkWith,
  JOURNAL,
  journalChanging,
  journalDropping,
  journalMissing,
  journalWith,
  journalWithout,
  positionOf,
  truncatedAfter,
} from "../repl-hydration/fixture.ts";
import { inherit } from "../repl-hydration/fork.ts";
import { JournalParseError, parseJournal } from "../repl-hydration/journal.ts";
import { decodeRoute, resolveLocation, RouteRefusal } from "../repl-hydration/location.ts";
import type { SemanticModel } from "../repl-hydration/model.ts";
import { ProjectionError, projectPrefix, UnknownMarkerError } from "../repl-hydration/project.ts";
import { alone, library, provenanceLink } from "../repl-hydration/provenance.ts";
import { foreignValues } from "../repl-hydration/purity.ts";
import { hydrate } from "../repl-hydration/store.ts";
import type { ReplSession } from "../repl-hydration/store.ts";

const AT_FORK = "xmd://repl/e1-fork/transcript/entry-1/document";

function forked(records: readonly unknown[] = FORK_JOURNAL): SemanticModel {
  const events = parseJournal(records);
  if (!events.ok) {
    throw events.error;
  }
  const model = projectPrefix(FORK_EXECUTION, events.value, undefined);
  if (!model.ok) {
    throw model.error;
  }
  return model.value;
}

function* open(
  execution: string,
  url: string,
  records: readonly unknown[],
): Operation<ReplSession> {
  const session = yield* hydrate(execution, url, records);
  if (!session.ok) {
    throw session.error;
  }
  return session.value;
}

/** Every journal this process can reach when the parent is still there. */
const WITH_PARENT = library({ [EXECUTION]: JOURNAL, [FORK_EXECUTION]: FORK_JOURNAL });

describe("a fork owns its own past", () => {
  it("publishes what it inherited into its own Journal", function* () {
    const model = forked();

    expect(model.provenance).toEqual({
      kind: "forked",
      parent: "e1",
      source: FORK_SOURCE,
      entry: "entry-0",
    });
    // The environment the parent had at r-07, republished here. Not a
    // reference to the parent's record: a record of this execution's own.
    expect(model.entries[0].id).toBe("entry-0");
    expect(model.entries[0].outcome).toEqual({ status: "settled" });
    expect(model.bindings.map((one) => `${one.name}=${one.value}`)).toEqual([
      "project=executable.md",
      "release=0.13.1",
    ]);
    expect(model.bindings[0].entry).toBe("entry-0");

    // The fork's own entry inherits what the inherited entry published.
    const mine = model.entries.find((entry) => entry.id === "entry-1");
    expect(mine?.inherited.map((one) => one.name)).toEqual(["project"]);
  });

  it("carries the whole inherited environment in its first record", function* () {
    // One record in, and the environment is already complete. There is no
    // prefix of a fork that has the entry and only part of what it inherited.
    const events = parseJournal(FORK_INHERITED);
    if (!events.ok) {
      throw events.error;
    }
    expect(events.value.length).toBe(1);

    const model = projectPrefix(FORK_EXECUTION, events.value, undefined);
    if (!model.ok) {
      throw model.error;
    }
    expect(model.value.bindings.map((one) => `${one.name}=${one.value}`)).toEqual([
      "project=executable.md",
    ]);
    // The synthetic entry has not settled yet, and that changes nothing
    // about the environment it brought with it.
    expect(model.value.entries[0].outcome).toEqual({ status: "running" });
    expect(model.value.entries[0].inherited).toEqual([]);
    expect(model.value.bindings[0].marker).toBe(model.value.entries[0].marker);
  });

  it("takes that payload from the parent at the source marker, never from its head", function* () {
    const built = inherit(parsedParent(), {
      parent: EXECUTION,
      source: FORK_SOURCE,
      entry: "entry-0",
      title: "Forked from the README run",
      id: "f-01",
    });
    if (!built.ok) {
      throw built.error;
    }
    // The fixture's first record *is* this, rather than a hand-written copy
    // that could agree with nothing but itself.
    expect(built.value).toEqual(FORK_JOURNAL[0]);

    const atHead = inherit(parsedParent(), {
      parent: EXECUTION,
      source: "r-23",
      entry: "entry-0",
      title: "Forked from the head",
      id: "f-01",
    });
    if (!atHead.ok) {
      throw atHead.error;
    }
    const names = (record: unknown) =>
      (Object(record).bindings as readonly { name: string }[]).map((one) => one.name);
    expect(names(built.value)).toEqual(["project"]);
    expect(names(atHead.value)).toEqual(["project", "release", "changelog"]);

    // A marker the parent never minted has no environment to inherit.
    expect(
      inherit(parsedParent(), {
        parent: EXECUTION,
        source: "r-99",
        entry: "entry-0",
        title: "Nowhere",
        id: "f-01",
      }).ok,
    ).toBe(false);
  });

  it("settles and carries on with the parent absent", function* () {
    const session = yield* open(FORK_EXECUTION, AT_FORK, FORK_JOURNAL);
    const model = session.semantic().model;

    expect(provenanceLink(model, alone()).kind).toBe("unavailable");
    expect(model.entries.map((entry) => `${entry.id}:${entry.outcome.status}`)).toEqual([
      "entry-0:settled",
      "entry-1:running",
    ]);
    // The work it did after settling inherited what the fork brought over.
    expect(model.entries[1].inherited.map((one) => one.name)).toEqual(["project"]);
    expect(model.suspensions.map((one) => one.wait)).toEqual(["confirm"]);
    expect(model.bindings.map((one) => `${one.name}=${one.value}`)).toEqual([
      "project=executable.md",
      "release=0.13.1",
    ]);
  });

  it("refuses an environment that names one binding twice or holds a malformed member", function* () {
    const cases: readonly (readonly [string, unknown])[] = [
      [
        "a repeated name",
        [
          { name: "project", value: "one" },
          { name: "project", value: "two" },
        ],
      ],
      ["a member that is not a binding", [{ name: "project", value: "one" }, "project=two"]],
      ["a member with no name", [{ name: "", value: "one" }]],
      ["a member with no text value", [{ name: "project", value: 1 }]],
      ["a member carrying more", [{ name: "project", value: "one", secret: true }]],
      ["an environment that is not a list", { project: "one" }],
    ];

    for (const [what, bindings] of cases) {
      const refused = parseJournal(forkChanging(0, { bindings }));
      expect(`${what}:${refused.ok}`).toBe(`${what}:false`);
      if (refused.ok) {
        continue;
      }
      expect(refused.error).toBeInstanceOf(JournalParseError);
      expect((refused.error as JournalParseError).field).toBe("bindings");
    }

    // An empty environment is a fork of an execution that had published
    // nothing, which is a thing that happens.
    expect(parseJournal(forkChanging(0, { bindings: [] })).ok).toBe(true);
  });

  it("inherits the parent's environment as of the source marker and no later", function* () {
    const parent = projectPrefix(EXECUTION, parsedParent(), FORK_SOURCE);
    if (!parent.ok) {
      throw parent.error;
    }

    expect(parent.value.bindings.map((one) => `${one.name}=${one.value}`)).toEqual([
      "project=executable.md",
    ]);
    // Everything the parent published after r-07 is absent here, which is
    // what makes this an inheritance rather than a copy of the head.
    const inheritedAtFork = forked().entries[0];
    expect(inheritedAtFork.inherited).toEqual([]);
    expect(JSON.stringify(forked())).not.toContain("changelog");
    expect(JSON.stringify(forked())).not.toContain("0.13.0");
  });

  it("reconstructs the same fork whether or not the parent is there", function* () {
    // Hydration takes records and a URL. There is no argument a parent
    // journal would go in, so "with the parent" and "without it" differ only
    // in what the surrounding process can reach — and that is the link.
    const beside = yield* open(FORK_EXECUTION, AT_FORK, FORK_JOURNAL);
    const withParent = beside.semantic();
    expect(provenanceLink(withParent.model, WITH_PARENT).kind).toBe("resolvable");

    const orphan = yield* open(FORK_EXECUTION, AT_FORK, FORK_JOURNAL);
    const withoutParent = orphan.semantic();
    expect(provenanceLink(withoutParent.model, alone()).kind).toBe("unavailable");

    expect(withoutParent).toEqual(withParent);
    expect(withoutParent.model.provenance).toEqual(forked().provenance);
    expect(withoutParent.model.bindings.map((one) => one.name)).toEqual(["project", "release"]);
    // Nothing of the parent's later execution is in here.
    expect(JSON.stringify(orphan.state())).not.toContain("r-22");
    expect(foreignValues(orphan.state(), "state")).toEqual([]);
  });

  it("points at the parent only while the parent is reachable", function* () {
    const model = forked();

    const reachable = provenanceLink(model, WITH_PARENT);
    expect(reachable).toEqual({
      kind: "resolvable",
      parent: "e1",
      source: FORK_SOURCE,
      url: "xmd://repl/e1/transcript?at=r-07",
    });

    // The one canonical spelling, and it resolves against the parent.
    if (reachable.kind === "resolvable") {
      const route = decodeRoute(reachable.url);
      if (!route.ok) {
        throw route.error;
      }
      const where = resolveLocation(route.value, EXECUTION, parsedParent());
      expect(where.ok).toBe(true);
    }

    const gone = provenanceLink(model, alone());
    expect(gone.kind).toBe("unavailable");
    if (gone.kind === "unavailable") {
      // It still names what it came from. Only following it is impossible.
      expect(gone.parent).toBe("e1");
      expect(gone.source).toBe(FORK_SOURCE);
      expect(gone.why).toContain("not available");
    }
  });

  it("says nothing about provenance for an execution that was not forked", function* () {
    const root = projectPrefix(EXECUTION, parsedParent(), undefined);
    if (!root.ok) {
      throw root.error;
    }
    expect(root.value.provenance).toEqual({ kind: "root" });
    expect(provenanceLink(root.value, WITH_PARENT)).toEqual({ kind: "none" });
  });

  it("makes the link unavailable rather than failing when the parent is unusable", function* () {
    const model = forked();

    const corrupt = library({ [EXECUTION]: [...JOURNAL, { id: "bad" }] });
    expect(provenanceLink(model, corrupt).kind).toBe("unavailable");

    const shortened = library({ [EXECUTION]: truncatedAfter(3) });
    const missing = provenanceLink(model, shortened);
    expect(missing.kind).toBe("unavailable");
    if (missing.kind === "unavailable") {
      expect(missing.why).toContain("no marker r-07");
    }

    // A parent that reads but cannot have happened, at or before the marker
    // this fork points at, has nothing to open there.
    const impossible = library({
      [EXECUTION]: journalChanging(positionOf("r-04"), { entry: "entry-9" }),
    });
    const unreconstructable = provenanceLink(model, impossible);
    expect(unreconstructable.kind).toBe("unavailable");
    if (unreconstructable.kind === "unavailable") {
      expect(unreconstructable.why).toContain("cannot be reconstructed");
    }

    // An inconsistency the parent only reaches *after* the source marker
    // leaves the link alone: the moment this fork points at is still there.
    const laterTrouble = library({ [EXECUTION]: journalWithout(positionOf("r-08")) });
    expect(provenanceLink(model, laterTrouble).kind).toBe("resolvable");

    // The fork itself is unaffected by any of it.
    expect(forked()).toEqual(model);
  });

  it("copies no secret and no process-local state", function* () {
    // The inherited payload first, since that is the one record that reads
    // the parent, and then the whole Journal.
    const payload = JSON.stringify(FORK_JOURNAL[0]);
    expect(payload).not.toContain("secret");
    expect(payload).not.toContain("prompt");
    expect(payload).not.toContain("canContinue");

    const serialized = JSON.stringify(FORK_JOURNAL);
    for (const word of ["secret", "token", "pauseMarker", "canContinue", "EXPANSION PAUSED"]) {
      if (word === "secret") {
        // `secret: false` is a property of a request, not a value.
        expect(serialized).not.toContain('"secret":true');
        continue;
      }
      expect(serialized).not.toContain(word);
    }
  });

  it("refuses a second inheritance and one taken mid-execution", function* () {
    const twice = forkWith({
      id: "f-07",
      seq: 7,
      at: 20,
      kind: "entry.inherited",
      entry: "entry-2",
      title: "Forked again",
      parent: "e1",
      source: "r-03",
      bindings: [],
    });
    const again = projectPrefix(FORK_EXECUTION, parsedFork(twice), undefined);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.message).toContain("already forked");
    }

    // The same inheritance, written after this execution had already begun.
    const late = [
      { ...Object(FORK_JOURNAL[2]), seq: 1, id: "g-01" },
      { ...Object(FORK_JOURNAL[0]), seq: 2, id: "g-02" },
    ];
    const afterwards = projectPrefix(FORK_EXECUTION, parsedFork(late), undefined);
    expect(afterwards.ok).toBe(false);
    if (!afterwards.ok) {
      expect(afterwards.error.message).toContain("already began");
    }
  });

  describe("negative controls", () => {
    it("multi-record-inheritance: a copy spread over records can stop halfway", function* () {
      // What the previous representation looked like: the entry, then the
      // environment published one record at a time.
      const spread: readonly unknown[] = [
        {
          id: "m-01",
          seq: 1,
          at: 0,
          kind: "entry.inherited",
          entry: "entry-0",
          title: "Forked from the README run",
          parent: "e1",
          source: FORK_SOURCE,
          bindings: [],
        },
        {
          id: "m-02",
          seq: 2,
          at: 1,
          kind: "binding.published",
          entry: "entry-0",
          name: "project",
          value: "executable.md",
        },
        {
          id: "m-03",
          seq: 3,
          at: 2,
          kind: "binding.published",
          entry: "entry-0",
          name: "team",
          value: "frontside",
        },
      ];

      const halfway = parseJournal(spread.slice(0, 2));
      if (!halfway.ok) {
        throw halfway.error;
      }
      const partial = projectPrefix(FORK_EXECUTION, halfway.value, undefined);
      if (!partial.ok) {
        throw partial.error;
      }
      // It hydrates, and it is wrong in a way nothing downstream can see:
      // an environment that existed at no point in either execution.
      expect(partial.value.bindings.map((one) => one.name)).toEqual(["project"]);
      expect(partial.value.provenance.kind).toBe("forked");

      // One record cannot be half-read, so the real representation has no
      // prefix that answers anything but the whole environment.
      const atomic = parseJournal(FORK_INHERITED);
      if (!atomic.ok) {
        throw atomic.error;
      }
      const whole = projectPrefix(FORK_EXECUTION, atomic.value, undefined);
      if (!whole.ok) {
        throw whole.error;
      }
      expect(whole.value.bindings.map((one) => one.name)).toEqual(["project"]);
      expect(FORK_INHERITED.length).toBe(1);
    });

    it("parent-backed-fork: reading the environment from the parent loses it with the parent", function* () {
      // What a fork that referenced its parent would have to do: go and read
      // the parent's bindings at the source marker.
      const borrowed = (reach: ReturnType<typeof library>) => {
        const found = reach.journalOf("e1");
        if (!found.found) {
          return [];
        }
        const events = parseJournal(found.records);
        if (!events.ok) {
          return [];
        }
        const at = projectPrefix(EXECUTION, events.value, FORK_SOURCE);
        return at.ok ? at.value.bindings.map((one) => one.name) : [];
      };

      expect(borrowed(WITH_PARENT)).toEqual(["project"]);
      expect(borrowed(alone())).toEqual([]);
      // The fork's own answer does not move.
      expect(forked().bindings.map((one) => one.name)).toEqual(["project", "release"]);
    });

    it("provenance-at-hydration: resolving the link while hydrating makes the parent a dependency", function* () {
      const model = forked();
      const link = provenanceLink(model, alone());

      // A hydration that insisted on a resolvable link would have refused
      // here. Hydration never asks, so it cannot.
      expect(link.kind).toBe("unavailable");
      const session = yield* open(FORK_EXECUTION, AT_FORK, FORK_JOURNAL);
      expect(session.semantic().model.provenance.kind).toBe("forked");
    });
  });
});

function parsedParent() {
  const events = parseJournal(JOURNAL);
  if (!events.ok) {
    throw events.error;
  }
  return events.value;
}

function parsedFork(records: readonly unknown[]) {
  const events = parseJournal(records);
  if (!events.ok) {
    throw events.error;
  }
  return events.value;
}

describe("every reader refuses rather than guessing", () => {
  it("refuses malformed records at the durable boundary", function* () {
    const cases: readonly (readonly [string, readonly unknown[], string])[] = [
      ["not an object", journalWith(3, "r-04"), "record"],
      ["an array", journalWith(3, ["r-04"]), "record"],
      ["an unknown kind", journalChanging(positionOf("r-22"), { kind: "pause.held" }), "kind"],
      ["an undeclared field", journalChanging(positionOf("r-22"), { held: true }), "held"],
      [
        "a field of the wrong type",
        journalChanging(positionOf("r-22"), { secret: "yes" }),
        "secret",
      ],
      [
        "a path that is not one",
        journalChanging(positionOf("r-22"), { scope: "document" }),
        "scope",
      ],
      ["an empty name", journalChanging(positionOf("r-02"), { name: "" }), "name"],
      ["a repeated identity", journalChanging(positionOf("r-08"), { id: "r-07" }), "id"],
    ];

    for (const [what, records, field] of cases) {
      const refused = parseJournal(records);
      expect(refused.ok).toBe(false);
      if (refused.ok) {
        continue;
      }
      expect(refused.error).toBeInstanceOf(JournalParseError);
      expect(`${what}:${(refused.error as JournalParseError).field}`).toBe(`${what}:${field}`);
    }
  });

  it("refuses a truncated record and a truncated stream", function* () {
    const cut = parseJournal(journalDropping(positionOf("r-07"), "value"));
    expect(cut.ok).toBe(false);

    const gap = parseJournal(journalMissing(positionOf("r-07")));
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect((gap.error as JournalParseError).field).toBe("seq");
    }

    // A stream that simply stops is short, not corrupt, and reads.
    expect(parseJournal(truncatedAfter(8)).ok).toBe(true);
    expect(parseJournal([]).ok).toBe(true);
  });

  it("refuses an inconsistent journal at the projection", function* () {
    const cases: readonly (readonly [string, readonly unknown[]])[] = [
      ["overlapping entries", journalWithout(positionOf("r-09"))],
      ["settling over an open scope", journalWithout(positionOf("r-08"))],
      ["completing around a live child", journalWithout(positionOf("r-06"))],
      ["a stranger's entry", journalChanging(positionOf("r-04"), { entry: "entry-9" })],
      ["a scope path nothing opened", journalChanging(positionOf("r-03"), { scope: ["report"] })],
      ["two siblings at one source", journalChanging(positionOf("r-18"), { source: 1 })],
      ["an unowned answer", journalChanging(positionOf("r-05"), { scope: ["document"] })],
    ];

    for (const [what, records] of cases) {
      const events = parseJournal(records);
      expect(`${what}:${events.ok}`).toBe(`${what}:true`);
      if (!events.ok) {
        continue;
      }
      const projected = projectPrefix(EXECUTION, events.value, undefined);
      expect(`${what}:${projected.ok}`).toBe(`${what}:false`);
      if (!projected.ok) {
        expect(projected.error).toBeInstanceOf(ProjectionError);
      }
    }
  });

  it("refuses a fork whose inherited prefix is inconsistent", function* () {
    const orphaned = forkChanging(1, { entry: "entry-9" });
    const events = parseJournal(orphaned);
    expect(events.ok).toBe(true);
    if (!events.ok) {
      return;
    }
    const projected = projectPrefix(FORK_EXECUTION, events.value, undefined);
    expect(projected.ok).toBe(false);

    const unnamed = parseJournal(forkChanging(0, { parent: "" }));
    expect(unnamed.ok).toBe(false);
  });

  it("refuses a URL that is not spelled like a location", function* () {
    const urls = [
      "https://repl/e1/transcript",
      "xmd://repl/",
      "xmd://repl/e1",
      "xmd://repl/e1/nowhere",
      "xmd://repl/e1/transcript//document",
      "xmd://repl/e1/transcript/entry-1/+project/document",
      "xmd://repl/e1/+project",
      "xmd://repl/e1/transcript?at=",
      "xmd://repl/e1/transcript?inspect",
      "xmd://repl/e1/transcript?at=r-07&at=r-03",
      "xmd://repl/e1/transcript?nope=1",
      "xmd://repl/e1/transcript?inspect=yes",
      "xmd://repl/e1/transcript/%ZZ",
    ];
    for (const url of urls) {
      expect(`${url}:${decodeRoute(url).ok}`).toBe(`${url}:false`);
    }
  });

  it("refuses a well-spelled URL the execution never went to", function* () {
    const cases: readonly (readonly [string, string])[] = [
      ["xmd://repl/e9/transcript", "execution"],
      ["xmd://repl/e1/transcript?at=r-99", "at"],
      ["xmd://repl/e1/transcript?at=r-05", "at"],
      ["xmd://repl/e1/transcript/entry-9", "entry"],
      ["xmd://repl/e1/transcript/entry-3/plan", "scope[0]"],
      ["xmd://repl/e1/transcript/entry-3/document/plan", "scope[1]"],
      ["xmd://repl/e1/transcript/entry-3/document/+confirm/+source", "drawer[0]"],
      ["xmd://repl/e1/transcript/entry-1/document/+review", "drawer[0]"],
    ];

    for (const [url, position] of cases) {
      const route = decodeRoute(url);
      expect(`${url}:${route.ok}`).toBe(`${url}:true`);
      if (!route.ok) {
        continue;
      }
      const where = resolveLocation(route.value, EXECUTION, parsedParent());
      expect(`${url}:${where.ok}`).toBe(`${url}:false`);
      if (where.ok) {
        continue;
      }
      expect(where.error).toBeInstanceOf(RouteRefusal);
      expect(`${url}:${(where.error as RouteRefusal).position}`).toBe(`${url}:${position}`);
    }
  });

  it("refuses at hydration too, and builds no half-session", function* () {
    for (const [url, records] of [
      ["xmd://repl/e1/transcript", journalWith(3, "r-04")],
      ["xmd://repl/e1/transcript", journalWithout(positionOf("r-09"))],
      ["xmd://repl/e1/nowhere", JOURNAL],
      ["xmd://repl/e1/transcript/entry-9", JOURNAL],
    ] as const) {
      const refused = yield* hydrate(EXECUTION, url, records);
      expect(`${url}:${refused.ok}`).toBe(`${url}:false`);
    }

    // A live session refuses a bad move and keeps the state it had.
    const session = yield* open(EXECUTION, "xmd://repl/e1/transcript", JOURNAL);
    const before = session.semantic();
    for (const url of ["xmd://repl/e1/nowhere", "xmd://repl/e1/transcript/entry-9"]) {
      const moved = yield* session.navigate(url);
      expect(moved.ok).toBe(false);
    }
    expect(session.semantic()).toEqual(before);
    expect(session.visits()).toEqual([before.url]);
  });

  describe("negative controls", () => {
    it("plausible-partial: reading what parses and stopping produces a view nobody can tell is wrong", function* () {
      const damaged = journalDropping(positionOf("r-07"), "value");
      const upToIt = damaged.slice(0, positionOf("r-07"));

      // The prefix before the damaged record reads perfectly, and describes
      // an execution in which `project` was simply never published.
      const partial = parseJournal(upToIt);
      expect(partial.ok).toBe(true);
      if (!partial.ok) {
        return;
      }
      const model = projectPrefix(EXECUTION, partial.value, undefined);
      expect(model.ok).toBe(true);
      if (!model.ok) {
        return;
      }
      expect(model.value.bindings).toEqual([]);

      // The real reader is handed the whole thing and refuses all of it.
      expect(parseJournal(damaged).ok).toBe(false);
    });

    it("marker-without-a-record: naming a position nothing minted answers a moment that never was", function* () {
      const closing = projectPrefix(EXECUTION, parsedParent(), "r-05");
      expect(closing.ok).toBe(false);
      if (!closing.ok) {
        expect(closing.error).toBeInstanceOf(UnknownMarkerError);
      }

      // A reader that took "the prefix ending at record r-05" anyway would
      // have answered, and answered a position the History does not have.
      const events = parsedParent();
      const at = events.findIndex((event) => event.id === "r-05");
      const anyway = projectPrefix(EXECUTION, events.slice(0, at + 1), undefined);
      expect(anyway.ok).toBe(true);
      if (anyway.ok) {
        expect(anyway.value.marker).toBe("r-04");
      }
    });
  });
});
