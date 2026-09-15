/**
 * Tier PA — the three contextual APIs a Plugin composes a run through.
 *
 * Each is a value-returning Api, so what these rows hold is the composition
 * itself: the terminal every chain ends at, the order wrappers run in, and the
 * fact that a wrapper may delegate more than once. Nothing here executes a
 * document — what the composed values *do* is Tier RC's.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  ActivePlugins,
  activePlugins,
  Document,
  document,
  DOCUMENT_PLACEHOLDER,
  Plugin,
  RootMetadata,
  rootMetadata,
} from "../api.ts";
import {
  installInvalidDocument,
  installInvalidRootMetadata,
} from "./invalid-plugin-api.fixture.js";

describe("PA1 — Document composes an envelope around one terminal", () => {
  it("answers with the placeholder when nothing wraps it", function* () {
    expect(yield* document).toBe(DOCUMENT_PLACEHOLDER);
    expect(DOCUMENT_PLACEHOLDER).toBe("<Document />");
  });

  it("runs the first wrapper outermost and the terminal innermost", function* () {
    const composed = yield* scoped(function* (): Operation<string> {
      yield* Document.around({ document: (_args, next) => `[first ${next()} first]` });
      yield* Document.around({ document: (_args, next) => `(second ${next()} second)` });
      return yield* document;
    });
    expect(composed).toBe("[first (second <Document /> second) first]");
  });

  it("lets a wrapper delegate more than once", function* () {
    const composed = yield* scoped(function* (): Operation<string> {
      yield* Document.around({ document: (_args, next) => `${next()}\n\n${next()}` });
      return yield* document;
    });
    expect(composed).toBe("<Document />\n\n<Document />");
  });

  it("refuses an answer that is not Markdown text", function* () {
    const refusal = yield* scoped(function* (): Operation<string> {
      // A Plugin loaded from an untyped module can answer with anything, and
      // the reader is where that is caught rather than the scanner.
      yield* installInvalidDocument(7);
      try {
        yield* document;
        return "composed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(refusal).toContain("Document middleware answers with Markdown text");
  });
});

describe("PA2 — RootMetadata composes the root's own record", () => {
  it("answers with an empty record when no execution seeded one", function* () {
    expect(yield* rootMetadata).toEqual({});
  });

  it("wraps whatever the nearest terminal answers with", function* () {
    const composed = yield* scoped(function* () {
      yield* RootMetadata.around({
        metadata: (_args, next) => ({ ...next(), added: true }),
      });
      yield* RootMetadata.around({ metadata: () => ({ title: "root" }) }, { at: "min" });
      return yield* rootMetadata;
    });
    expect(composed).toEqual({ title: "root", added: true });
  });

  it("hands back a frozen record rather than the one a wrapper kept", function* () {
    const held = { title: "root" };
    const composed = yield* scoped(function* () {
      yield* RootMetadata.around({ metadata: () => held }, { at: "min" });
      return yield* rootMetadata;
    });
    expect(Object.isFrozen(composed)).toBe(true);
    expect(composed).not.toBe(held);
  });

  it("refuses an answer that is not a record", function* () {
    for (const answer of [null, "meta", 7, ["a"]]) {
      const refusal = yield* scoped(function* (): Operation<string> {
        yield* installInvalidRootMetadata(answer);
        try {
          yield* rootMetadata;
          return "composed";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
      expect(refusal).toContain("RootMetadata middleware answers with a metadata record");
    }
  });
});

describe("PA3 — ActivePlugins is an ordered immutable snapshot", () => {
  it("is empty where nothing installed a list", function* () {
    expect(yield* activePlugins).toEqual([]);
  });

  it("reports the installed list in installation order", function* () {
    const first = Plugin({ name: "first" });
    const second = Plugin({ name: "second" });
    const listed = yield* scoped(function* () {
      yield* ActivePlugins.around({ plugins: () => [first, second] });
      return (yield* activePlugins).map((plugin) => plugin.name);
    });
    expect(listed).toEqual(["first", "second"]);
  });

  it("snapshots the list rather than handing back the installed array", function* () {
    const installed = [Plugin({ name: "first" })];
    const snapshot = yield* scoped(function* () {
      yield* ActivePlugins.around({ plugins: () => installed });
      return yield* activePlugins;
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).not.toBe(installed);
  });
});
