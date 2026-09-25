/**
 * One URL, one model, one answer.
 *
 * The reverted first #840 experiment could resolve a route, but its resolution
 * shared topology decisions with view projection, layout and mounting, so a
 * case that passed proved those representations agreed rather than that the
 * execution went anywhere. The cases here are chosen to be ones a router that
 * kept state, searched the tree, or treated drawers as a set could not satisfy:
 * the same URL answered twice against two models, a scope reached only through
 * its real parent, and a drawer stack that is an ordered prefix or nothing.
 *
 * Each claim carries a named control — a stand-in written here — that *accepts*
 * what the real router refuses, or produces the answer a weaker implementation
 * would have produced. A refusal nothing else would have accepted is a refusal
 * nobody is checking.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";

import { EXECUTION, HISTORY, historyThrough, projectModel } from "../repl-compose/history.ts";
import type { Checkpoint, ReplModel, Scope } from "../repl-compose/model.ts";
import { decodeRoute, encodeRoute, resolveRoute, RouteRefusal } from "../repl-compose/router.ts";
import type { ResolvedLocation, Route } from "../repl-compose/router.ts";

/** The whole recorded execution: head `cp-10`, two live suspensions. */
const MODEL = projectModel(EXECUTION);

/** The same execution one suspension earlier: head `cp-08`, stack `project`. */
const EARLY = projectModel(EXECUTION, historyThrough("cp-08"));

/** The same execution before `document` opened anything: head `cp-02`. */
const OPENING = projectModel(EXECUTION, historyThrough("cp-02"));

/** The same records, recorded by another execution. */
const OTHER = projectModel("e2");

/** The location #840 names, written the one way it is written. */
const REPRESENTATIVE =
  "xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect";

/** The same location, asked of whatever each model's head is. */
const AT_HEAD = "xmd://repl/e1/transcript/entry-1/document/+project/+confirm";

function decoded(url: string): Route {
  const result = decodeRoute(url);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refusedDecoding(url: string): Error {
  const result = decodeRoute(url);
  if (result.ok) {
    throw new Error(`${JSON.stringify(url)} was accepted, and should not have been`);
  }
  return result.error;
}

function resolved(url: string, model: ReplModel): ResolvedLocation {
  const result = resolveRoute(decoded(url), model);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function refused(url: string, model: ReplModel): RouteRefusal {
  const result = resolveRoute(decoded(url), model);
  if (result.ok) {
    throw new Error(`${JSON.stringify(url)} resolved, and should have been refused`);
  }
  if (!(result.error instanceof RouteRefusal)) {
    throw result.error;
  }
  return result.error;
}

/** The checkpoint one marker names, read out of the model rather than resolved. */
function checkpoint(model: ReplModel, marker: string): Checkpoint {
  const found = model.checkpoints.find((candidate) => candidate.marker === marker);
  if (found === undefined) {
    throw new Error(`the model records no ${marker}`);
  }
  return found;
}

describe("REPL composition: routing", () => {
  describe("history projects into one immutable model", () => {
    it("records one checkpoint per history record, ending at the head", function* () {
      expect(MODEL.execution).toBe("e1");
      expect(MODEL.checkpoints.length).toBe(HISTORY.length);
      expect(MODEL.head).toBe("cp-10");
      expect(MODEL.checkpoints[MODEL.checkpoints.length - 1].marker).toBe("cp-10");
    });

    it("gives each checkpoint its own complete moment", function* () {
      const opened = checkpoint(MODEL, "cp-03");
      const head = checkpoint(MODEL, "cp-10");

      expect(opened.entries[0]).not.toBe(head.entries[0]);
      expect(opened.entries[0].scopes[0].children.map((scope) => scope.name)).toEqual(["plan"]);
      expect(head.entries[0].scopes[0].children.map((scope) => scope.name)).toEqual([
        "plan",
        "write",
        "publish",
      ]);

      // Leaving a scope settles it; it stays in the tree, so a URL can still
      // name it.
      expect(opened.entries[0].scopes[0].children[0].settled).toBe(false);
      expect(head.entries[0].scopes[0].children[0].settled).toBe(true);
    });

    it("records a two-drawer stack only where both suspensions are unanswered", function* () {
      expect(checkpoint(MODEL, "cp-04").suspensions.map((one) => one.kind)).toEqual(["review"]);
      expect(checkpoint(MODEL, "cp-05").suspensions.map((one) => one.kind)).toEqual([]);
      expect(checkpoint(MODEL, "cp-08").suspensions.map((one) => one.kind)).toEqual(["project"]);
      expect(checkpoint(MODEL, "cp-10").suspensions.map((one) => one.kind)).toEqual([
        "project",
        "confirm",
      ]);
    });

    it("names the scope that owns each suspension", function* () {
      expect(checkpoint(MODEL, "cp-10").suspensions.map((one) => one.scope)).toEqual([
        ["document", "write"],
        ["document", "publish"],
      ]);
    });

    it("freezes the model through every value it reaches", function* () {
      const scopes = MODEL.checkpoints[9].entries[0].scopes;
      expect(() => (MODEL.checkpoints as Checkpoint[]).push(MODEL.checkpoints[0])).toThrow();
      expect(() => (scopes as Scope[]).pop()).toThrow();
      expect(() => {
        (scopes[0] as { settled: boolean }).settled = true;
      }).toThrow();
    });
  });

  describe("decoding is structural and encoding is canonical", () => {
    it("round-trips every canonical spelling", function* () {
      const corpus = [
        "xmd://repl/e1/sessions",
        "xmd://repl/e1/transcript/entry-1",
        "xmd://repl/e1/transcript/entry-1/document/plan",
        "xmd://repl/e1/transcript/entry-1/document/+project",
        "xmd://repl/e1/history/entry-1?at=cp-04",
        "xmd://repl/e1/input/entry-1?at=cp-04&inspect&draft=%3CPlan%3E%20write%20it",
        REPRESENTATIVE,
      ];

      for (const url of corpus) {
        expect(encodeRoute(decoded(url))).toBe(url);
      }
    });

    it("keeps every part of the location it was given", function* () {
      const route = decoded(REPRESENTATIVE);

      expect(route.execution).toBe("e1");
      expect(route.surface).toBe("transcript");
      expect(route.entry).toBe("entry-1");
      expect(route.scopes).toEqual(["document"]);
      expect(route.drawers).toEqual(["project", "confirm"]);
      expect(route.at).toBe("cp-10");
      expect(route.inspect).toBe(true);
      expect(route.draft).toBe("");
    });

    it("carries a draft and a separator through the encoding", function* () {
      const route: Route = {
        execution: "e1",
        surface: "input",
        entry: "entry-1",
        scopes: ["a/b"],
        drawers: ["+odd"],
        at: "cp-04",
        inspect: true,
        draft: "<Plan> write it",
      };
      const url = encodeRoute(route);

      expect(url).toBe(
        "xmd://repl/e1/input/entry-1/a%2Fb/+%2Bodd?at=cp-04&inspect&draft=%3CPlan%3E%20write%20it",
      );
      expect(decoded(url)).toEqual(route);
    });

    it("refuses a URL that is malformed or names two locations at once", function* () {
      const cases: [string, string][] = [
        ["https://repl/e1/transcript", "a REPL route starts with"],
        ["xmd://repl/e1", "names no surface"],
        ["xmd://repl//transcript", "names no execution"],
        ["xmd://repl/e1/plan/entry-1", "is not a surface"],
        ["xmd://repl/e1/transcript/entry-1//document", "has an empty path segment"],
        ["xmd://repl/e1/transcript/entry-1/", "has an empty path segment"],
        ["xmd://repl/e1/transcript/entry-1/+project/document", "is a scope below a drawer"],
        ["xmd://repl/e1/transcript/+project", "a drawer is opened inside an entry"],
        ["xmd://repl/e1/transcript/entry-1?inspect=yes", "inspect takes no value"],
        ["xmd://repl/e1/transcript/entry-1?inspect", "inspect needs the marker"],
        ["xmd://repl/e1/transcript/entry-1?at=", "at= names no marker"],
        ["xmd://repl/e1/transcript/entry-1?at=cp-10&at=cp-04", "is written twice"],
        ["xmd://repl/e1/transcript/entry-1?when=cp-10", "is not part of a REPL route"],
      ];

      for (const [url, reason] of cases) {
        expect(refusedDecoding(url).message).toContain(reason);
      }
    });

    it("answers an equivalent spelling with the same location, canonically spelled", function* () {
      const equivalent: [string, string][] = [
        [
          "xmd://repl/e1/transcript/entry-1?inspect&at=cp-10",
          "xmd://repl/e1/transcript/entry-1?at=cp-10&inspect",
        ],
        ["xmd://repl/e1/transcript/%65ntry-1", "xmd://repl/e1/transcript/entry-1"],
        ["xmd://repl/%651/transcript/entry-1", "xmd://repl/e1/transcript/entry-1"],
        [
          "xmd://repl/e1/transcript/entry-1?draft=plain&at=cp-04",
          "xmd://repl/e1/transcript/entry-1?at=cp-04&draft=plain",
        ],
        ["xmd://repl/e1/transcript/entry-1?draft=", "xmd://repl/e1/transcript/entry-1"],
      ];

      for (const [written, canonical] of equivalent) {
        // Non-vacuous by construction: each spelling differs from the canonical
        // one, so an encoder that echoed its input would fail here.
        expect(written).not.toBe(canonical);
        expect(decoded(written)).toEqual(decoded(canonical));
        expect(encodeRoute(decoded(written))).toBe(canonical);
      }
    });
  });

  describe("resolving against a model", () => {
    it("answers the representative location with the exact values it resolved", function* () {
      const location = resolved(REPRESENTATIVE, MODEL);
      const head = checkpoint(MODEL, "cp-10");

      expect(location.checkpoint).toBe(head);
      expect(location.entry).toBe(head.entries[0]);
      expect(location.scopes).toEqual([head.entries[0].scopes[0]]);
      expect(location.scopes[0]).toBe(head.entries[0].scopes[0]);
      expect(location.drawers[0]).toBe(head.suspensions[0]);
      expect(location.drawers[1]).toBe(head.suspensions[1]);
      expect(location.surface).toBe("transcript");
      expect(location.inspecting).toBe(true);
    });

    it("resolves a drawer path that is a prefix of the stack", function* () {
      const location = resolved("xmd://repl/e1/transcript/entry-1/document/+project", MODEL);

      expect(location.drawers.map((one) => one.kind)).toEqual(["project"]);
      expect(location.drawers[0]).toBe(checkpoint(MODEL, "cp-10").suspensions[0]);
    });

    it("resolves a nested scope through its real parent, settled or not", function* () {
      const location = resolved("xmd://repl/e1/transcript/entry-1/document/plan", MODEL);

      expect(location.scopes.map((scope) => scope.name)).toEqual(["document", "plan"]);
      expect(location.scopes[1].settled).toBe(true);
    });

    it("selects the head when no marker is named", function* () {
      expect(resolved("xmd://repl/e1/sessions", MODEL).checkpoint.marker).toBe("cp-10");
      expect(resolved("xmd://repl/e1/sessions", EARLY).checkpoint.marker).toBe("cp-08");
    });

    it("answers one location differently against two models, changing neither", function* () {
      const before = [JSON.stringify(MODEL), JSON.stringify(EARLY)];
      const route = decoded(AT_HEAD);

      const against = resolveRoute(route, MODEL);
      const earlier = resolveRoute(route, EARLY);

      expect(against.ok).toBe(true);
      expect(earlier.ok).toBe(false);
      if (!earlier.ok && earlier.error instanceof RouteRefusal) {
        expect(earlier.error.position).toBe("drawer[1]");
        expect(earlier.error.found).toEqual(["project"]);
      }
      expect([JSON.stringify(MODEL), JSON.stringify(EARLY)]).toEqual(before);
      expect(decoded(AT_HEAD)).toEqual(route);
    });

    it("refuses a location recorded by another execution", function* () {
      const refusal = refused(REPRESENTATIVE, OTHER);

      expect(refusal.position).toBe("execution");
      expect(refusal.segment).toBe("e1");
      expect(refusal.found).toEqual(["e2"]);
    });
  });

  describe("a refusal names the first segment that did not resolve", () => {
    it("refuses a flattened scope path at the segment that skipped a parent", function* () {
      const refusal = refused("xmd://repl/e1/transcript/entry-1/plan", MODEL);

      expect(refusal.position).toBe("scope[0]");
      expect(refusal.segment).toBe("plan");
      expect(refusal.found).toEqual(["document"]);
      expect(refusal.message).toContain("is not a scope of entry-1 at cp-10");
    });

    it("refuses a fabricated scope and says what is there instead", function* () {
      const refusal = refused("xmd://repl/e1/transcript/entry-1/document/review", MODEL);

      expect(refusal.position).toBe("scope[1]");
      expect(refusal.found).toEqual(["plan", "write", "publish"]);
    });

    it("refuses a scope the execution had not yet entered", function* () {
      const refusal = refused("xmd://repl/e1/transcript/entry-1/document/plan", OPENING);

      expect(refusal.position).toBe("scope[1]");
      expect(refusal.found).toEqual([]);
      expect(refusal.message).toContain("the scopes there are none");
    });

    it("refuses a reordered drawer stack at the first drawer", function* () {
      const refusal = refused("xmd://repl/e1/transcript/entry-1/document/+confirm/+project", MODEL);

      expect(refusal.position).toBe("drawer[0]");
      expect(refusal.segment).toBe("confirm");
      expect(refusal.found).toEqual(["project"]);
    });

    it("refuses a drawer path that skips its real parent", function* () {
      const refusal = refused("xmd://repl/e1/transcript/entry-1/document/+confirm", MODEL);

      expect(refusal.position).toBe("drawer[0]");
      expect(refusal.found).toEqual(["project"]);
    });

    it("refuses an extra drawer beyond the recorded stack", function* () {
      const refusal = refused(
        "xmd://repl/e1/transcript/entry-1/document/+project/+confirm/+review",
        MODEL,
      );

      expect(refusal.position).toBe("drawer[2]");
      expect(refusal.found).toEqual(["project", "confirm"]);
      expect(refusal.message).toContain("there is no drawer 3 at cp-10");
    });

    it("refuses a drawer that belongs to another checkpoint", function* () {
      const refusal = refused(
        "xmd://repl/e1/transcript/entry-1/document/+project?at=cp-04&inspect",
        MODEL,
      );

      expect(refusal.position).toBe("drawer[0]");
      expect(refusal.found).toEqual(["review"]);
      expect(refusal.message).toContain("the suspension stack there is review");
    });

    it("refuses an entry and a marker nothing recorded", function* () {
      const entry = refused("xmd://repl/e1/transcript/entry-9", MODEL);
      expect(entry.position).toBe("entry");
      expect(entry.found).toEqual(["entry-1"]);

      const marker = refused("xmd://repl/e1/transcript/entry-1?at=cp-99", MODEL);
      expect(marker.position).toBe("at");
      expect(marker.found).toContain("cp-10");
    });
  });

  describe("negative controls", () => {
    it("partial-resolution: a resolver that stops after the entry accepts a fabricated scope", function* () {
      const url = "xmd://repl/e1/transcript/entry-1/document/review";
      const route = decoded(url);
      const head = checkpoint(MODEL, "cp-10");

      const partial = head.entries.some((entry) => entry.id === route.entry);

      expect(partial).toBe(true);
      expect(refused(url, MODEL).position).toBe("scope[1]");
    });

    it("flattened-scopes: a resolver that searches the whole tree accepts a skipped parent", function* () {
      const url = "xmd://repl/e1/transcript/entry-1/plan";
      const route = decoded(url);

      const anywhere = (scopes: readonly Scope[], name: string): boolean =>
        scopes.some((scope) => scope.name === name || anywhere(scope.children, name));

      expect(anywhere(checkpoint(MODEL, "cp-10").entries[0].scopes, route.scopes[0])).toBe(true);
      expect(refused(url, MODEL).position).toBe("scope[0]");
    });

    it("drawers-as-a-set: membership accepts a reordered stack the prefix rule refuses", function* () {
      const url = "xmd://repl/e1/transcript/entry-1/document/+confirm/+project";
      const route = decoded(url);
      const open = checkpoint(MODEL, "cp-10").suspensions.map((one) => one.kind);

      const asSet = route.drawers.every((drawer) => open.includes(drawer));

      expect(asSet).toBe(true);
      expect(refused(url, MODEL).position).toBe("drawer[0]");
    });

    it("last-wins-decoding: resolving a repeated key would pick one of two locations", function* () {
      const url = "xmd://repl/e1/transcript/entry-1?at=cp-10&at=cp-04";

      // A decoder that took the last value would have answered a location, and
      // a decoder that took the first would have answered a different one. Both
      // are spellings of an ask nobody made.
      const [first, last] = ["cp-10", "cp-04"].map((at) =>
        encodeRoute({
          execution: "e1",
          surface: "transcript",
          entry: "entry-1",
          scopes: [],
          drawers: [],
          at,
          inspect: false,
          draft: "",
        }),
      );

      expect(first).not.toBe(last);
      expect(refusedDecoding(url).message).toContain("is written twice");
    });

    it("structural-normalizing: accepting a spelling is not accepting a structure", function* () {
      // Equivalence is about how a location is written. A scope below a drawer
      // and a drawer outside an entry are different structures, not different
      // spellings, so relaxing the first must not relax the second.
      expect(
        refusedDecoding("xmd://repl/e1/transcript/entry-1/+project/document").message,
      ).toContain("is a scope below a drawer");
      expect(refusedDecoding("xmd://repl/e1/transcript/+project").message).toContain(
        "a drawer is opened inside an entry",
      );
    });
  });

  describe("the router's own boundary", () => {
    /** Every module specifier one source file imports, deduplicated and sorted. */
    function* importsOf(name: string): Operation<string[]> {
      const source = yield* readTextFile(
        fileURLToPath(new URL(`../repl-compose/${name}`, import.meta.url)),
      );
      const specifiers = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map(
        (match) => match[1],
      );
      return [...new Set(specifiers)].sort();
    }

    it("imports the result type and the model's types, and nothing else", function* () {
      const specifiers = yield* importsOf("router.ts");

      expect(specifiers.length).toBeGreaterThan(0);
      expect(specifiers).toEqual(["./model.ts", "effection"]);
    });

    it("reaches no further, because the model it imports imports nothing", function* () {
      // Routing cannot read a history record. Holding only `router.ts` to its own
      // import list would leave that true by one hop and unchecked by two.
      expect(yield* importsOf("model.ts")).toEqual([]);
    });

    it("keeps history records on the other side of the projection", function* () {
      // The projection is the only place a record and a model meet.
      expect(yield* importsOf("history.ts")).toEqual(["./model.ts"]);
    });
  });
});
