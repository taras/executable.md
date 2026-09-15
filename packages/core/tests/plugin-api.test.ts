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
import { createApi } from "@effectionx/context-api";
import type { Api } from "@effectionx/context-api";
import { scoped } from "effection";
import type { Operation } from "effection";
import {
  ActivePlugins,
  activePlugins,
  Document,
  document,
  Plugin,
  RootMetadata,
  rootMetadata,
} from "../api.ts";
import type { DocumentApi } from "../api.ts";
// The placeholder text is canonical core's own, not part of what a Plugin
// imports: a wrapper receives it from `next()` rather than naming it.
import { DOCUMENT_PLACEHOLDER } from "../src/plugin-apis.ts";
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
      yield* Document.around({
        *document(_args, next) {
          return `[first ${yield* next()} first]`;
        },
      });
      yield* Document.around({
        *document(_args, next) {
          return `(second ${yield* next()} second)`;
        },
      });
      return yield* document;
    });
    expect(composed).toBe("[first (second <Document /> second) first]");
  });

  it("lets a wrapper delegate more than once", function* () {
    const composed = yield* scoped(function* (): Operation<string> {
      yield* Document.around({
        *document(_args, next) {
          return `${yield* next()}\n\n${yield* next()}`;
        },
      });
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

describe("PA1b — the key is what two copies agree on, and it is namespaced", () => {
  /** An Api built under the bare public name, the way another package might. */
  function impostor(name: string): Api<DocumentApi> {
    return createApi<DocumentApi>(name, {
      // deno-lint-ignore require-yield
      *document(): Operation<string> {
        return "impostor terminal";
      },
    });
  }

  it("cannot be intercepted by an Api built with the bare public name", function* () {
    const composed = yield* scoped(function* (): Operation<string> {
      // Everything an interceptor could reach for: the public name of the Api,
      // the name of its one member, and middleware that never delegates.
      const intercept = {
        // deno-lint-ignore require-yield
        *document(): Operation<string> {
          return "intercepted";
        },
      };
      yield* impostor("Document").around(intercept);
      yield* impostor("document").around(intercept);
      return yield* document;
    });
    // The canonical answer, untouched. An Api keyed by the bare name addresses
    // a different context; it is not nearer, further, or ordered against this
    // one, because it is not this one.
    expect(composed).toBe(DOCUMENT_PLACEHOLDER);
  });

  it("composes with a second Api built under the canonical key", function* () {
    // The other half of the same claim: a Plugin that resolved its own copy of
    // this package builds an Api with the same key, and that one *does*
    // compose — which is what makes the key rather than the module instance the
    // thing the two copies share.
    const composed = yield* scoped(function* (): Operation<string> {
      const loadedCopy = createApi<DocumentApi>("executablemd.core.plugin.document", {
        // deno-lint-ignore require-yield
        *document(): Operation<string> {
          return "a second copy's terminal";
        },
      });
      yield* loadedCopy.around({
        *document(_args, next) {
          return `wrapped ${yield* next()}`;
        },
      });
      return yield* document;
    });
    expect(composed).toBe(`wrapped ${DOCUMENT_PLACEHOLDER}`);
  });

  it("keeps the same claim for RootMetadata and ActivePlugins", function* () {
    const metadata = yield* scoped(function* () {
      yield* createApi<{ readonly metadata: Record<string, unknown> }>("RootMetadata", {
        metadata: {},
      }).around({ metadata: () => ({ intercepted: true }) });
      yield* RootMetadata.around({ metadata: () => ({ real: true }) }, { at: "min" });
      return yield* rootMetadata;
    });
    expect(metadata).toEqual({ real: true });

    const listed = yield* scoped(function* () {
      yield* createApi<{ readonly plugins: readonly Plugin[] }>("ActivePlugins", {
        plugins: [],
      }).around({ plugins: () => [Plugin({ name: "impostor" })] });
      yield* ActivePlugins.around({ plugins: () => [Plugin({ name: "real" })] });
      return (yield* activePlugins).map((plugin) => plugin.name);
    });
    expect(listed).toEqual(["real"]);
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
