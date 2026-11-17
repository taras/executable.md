/**
 * Tier RC — the root a run executes, after `Document` and `RootMetadata`.
 *
 * Two guarantees, and they pull against each other. A run with no Plugin
 * middleware must be the run it always was — same body, same props, same
 * `returns`, same `<Output>` selection, same source positions, same expansion
 * identity — and a run with middleware must execute the envelope that
 * middleware composed, with the original document projected into it unchanged.
 *
 * Every row that wraps the document therefore also says what would still be
 * true without the wrapper, because the defect these exist to catch is a
 * composition that quietly changes a document nobody asked to change.
 */

import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { registerComponents } from "../src/components/registration.ts";
import { getExpansion } from "../src/expansion.ts";
import { Document, RootMetadata } from "../api.ts";
import { journalBeforeEach, useJournalStream } from "@executablemd/test-support/failure-journal";

const OWNER = "packages/core/tests/root-composition.test.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

/** Render one inline root, with whatever this scope installed around it. */
function* render(
  stream: InMemoryStream | undefined,
  source: string,
  props?: Record<string, Json>,
): Operation<string> {
  const value = yield* collect(
    yield* execute({
      ...inlineSource(source),
      stream: stream ?? (yield* useJournalStream("<eval>")),
      ...(props === undefined ? {} : { props }),
    }),
  );
  return String(value);
}

/** The value one inline root settles on, or the message it failed with. */
function* settled(
  stream: InMemoryStream | undefined,
  source: string,
  props?: Record<string, Json>,
): Operation<Json> {
  const execution = yield* execute({
    ...inlineSource(source),
    stream: stream ?? (yield* useJournalStream("<eval>")),
    ...(props === undefined ? {} : { props }),
  });
  yield* collect(execution);
  const outcome = yield* execution;
  return outcome.ok ? outcome.value : outcome.error.message;
}

/** Render one inline root, or the failure it raised, as text. */
function* rendered(stream: InMemoryStream | undefined, source: string): Operation<string> {
  try {
    return yield* render(undefined, source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A component that reports where it was written and which expansion it is. */
function* useProbe(seen: { id: string; path?: string; line?: number }[]): Operation<void> {
  yield* registerComponents([
    {
      name: "Probe",
      origin: "tier-rc",
      props: NO_PROPS,
      *fn() {
        const expansion = yield* getExpansion();
        seen.push({
          id: expansion.id,
          ...(expansion.position?.path === undefined ? {} : { path: expansion.position.path }),
          ...(expansion.position?.line === undefined ? {} : { line: expansion.position.line }),
        });
        return "";
      },
    },
  ]);
}

/** Wrap every root this scope executes in the given envelope. */
function* useEnvelope(before: string, after: string): Operation<void> {
  yield* Document.around({
    *document(_args, next) {
      return `${before}${yield* next()}${after}`;
    },
  });
}

const ROOT = ["# Heading", "", "body text", ""].join("\n");

describe("RC1 — with no document middleware the root is the root", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("renders exactly what executing the document directly renders", function* () {
    expect(yield* render(undefined, ROOT)).toBe(yield* scoped(() => render(undefined, ROOT)));
    expect(yield* render(undefined, ROOT)).toContain("body text");
  });

  it("keeps the document's own props, returns and value", function* () {
    const source = [
      "---",
      "props:",
      "  who:",
      "    type: string",
      "required: [who]",
      "returns:",
      "  type: string",
      "---",
      "",
      "<Return value={props.who} />",
      "",
    ].join("\n");
    expect(yield* settled(undefined, source, { who: "caller" })).toBe("caller");
  });
});

describe("RC2 — a wrapper composes around the projected document", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("renders the envelope with the original document inside it", function* () {
    const output = yield* scoped(function* () {
      yield* useEnvelope("before\n\n", "\n\nafter");
      return yield* render(undefined, ROOT);
    });
    expect(output).toContain("before");
    expect(output).toContain("body text");
    expect(output).toContain("after");
    expect(output.indexOf("before")).toBeLessThan(output.indexOf("body text"));
    expect(output.indexOf("body text")).toBeLessThan(output.indexOf("after"));
  });

  it("nests two wrappers with the first one outermost", function* () {
    const output = yield* scoped(function* () {
      yield* useEnvelope("one open\n\n", "\n\none close");
      yield* useEnvelope("two open\n\n", "\n\ntwo close");
      return yield* render(undefined, ROOT);
    });
    const order = ["one open", "two open", "body text", "two close", "one close"];
    const positions = order.map((token) => output.indexOf(token));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("projects the document once for every placeholder a wrapper writes", function* () {
    const output = yield* scoped(function* () {
      yield* Document.around({
        *document(_args, next) {
          return `${yield* next()}\n\n${yield* next()}`;
        },
      });
      return yield* render(undefined, "once\n");
    });
    expect(output.split("once").length - 1).toBe(2);
  });
});

describe("RC3 — projection preserves the document's own identity", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("reports the authored source position, not a position in the envelope", function* () {
    const source = ["# Heading", "", "<Probe />", ""].join("\n");
    const plain: { id: string; path?: string; line?: number }[] = [];
    yield* scoped(function* () {
      yield* useProbe(plain);
      yield* render(undefined, source);
    });
    const wrapped: { id: string; path?: string; line?: number }[] = [];
    yield* scoped(function* () {
      yield* useProbe(wrapped);
      yield* useEnvelope("envelope line one\n\nenvelope line two\n\n", "\n\ntail\n");
      yield* render(undefined, source);
    });
    expect(plain).toHaveLength(1);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.path).toBe(plain[0]?.path);
    expect(wrapped[0]?.line).toBe(plain[0]?.line);
    // And with it the expansion identity: a wrapper that renumbered the
    // document would give every durable element inside it a new identity.
    expect(wrapped[0]?.id).toBe(plain[0]?.id);
  });

  it("leaves an authored <Document /> an ordinary unresolved component", function* () {
    // Nothing in the document's own segments is ever read for a placeholder:
    // only the envelope this engine scanned is. So an author who writes the
    // name reaches component resolution, and there is no component there.
    const output = yield* rendered(undefined, "<Document />\n");
    expect(output).not.toContain("<Document />\n<Document />");
    expect(output).toMatch(/Document/);
  });
});

describe("RC4 — the document's own contract survives a wrapper", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("keeps <Output> selecting what renders", function* () {
    const source = ["hidden", "", "<Output>", "", "selected", "", "</Output>", ""].join("\n");
    const plain = yield* render(undefined, source);
    const wrapped = yield* scoped(function* () {
      yield* useEnvelope("envelope\n\n", "");
      return yield* render(undefined, source);
    });
    expect(plain).toContain("selected");
    expect(plain).not.toContain("hidden");
    // A document that declares `<Output>` decides what renders, and a wrapper
    // does not overrule it: the envelope's own text sits outside the selected
    // region, exactly as the document's unselected body does.
    expect(wrapped).toBe(plain);
  });

  it("keeps a value root's <Return> settling the run's value", function* () {
    const source = [
      "---",
      "returns:",
      "  type: string",
      "---",
      "",
      '<Return value="settled" />',
      "",
    ].join("\n");
    const value = yield* scoped(function* () {
      yield* useEnvelope("envelope\n\n", "");
      return yield* settled(undefined, source);
    });
    expect(value).toBe("settled");
  });
});

describe("RC5 — RootMetadata changes the root's metadata and nothing else", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("composes the record the document's own interpolation reads", function* () {
    const source = ["---", "title: authored", "---", "", "title is {meta.title}", ""].join("\n");
    expect(yield* render(undefined, source)).toContain("title is authored");
    const composed = yield* scoped(function* () {
      yield* RootMetadata.around({
        metadata: (_args, next) => ({ ...next(), title: "composed" }),
      });
      return yield* render(undefined, source);
    });
    expect(composed).toContain("title is composed");
  });

  it("leaves an imported component's own metadata alone", function* () {
    const composed = yield* scoped(function* () {
      yield* RootMetadata.around({ metadata: () => ({ title: "composed" }) });
      yield* registerComponents([
        {
          name: "Inner",
          origin: "tier-rc",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn() {
            return "inner body";
          },
        },
      ]);
      return yield* render(undefined, ["root {meta.title}", "", "<Inner />", ""].join("\n"));
    });
    expect(composed).toContain("root composed");
    expect(composed).toContain("inner body");
    // The composed record is the root's own, so it never becomes a component's.
    expect(composed).not.toContain("inner composed");
  });
});

describe("RC6 — a wrapper is held to the same structure a document is", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("diagnoses an envelope whose own structure a document could not write", function* () {
    // `<Return>` in a text body is a structural violation wherever it is
    // written, and the composed body is what the preflight walks — so a wrapper
    // is refused on the terms the document would have been, and the document's
    // own body never runs.
    const failure = yield* scoped(function* () {
      yield* useEnvelope('<Return value="x" />\n\n', "");
      return yield* rendered(undefined, ROOT);
    });
    expect(failure).toContain("<Return>");
    expect(failure).not.toContain("body text");
  });
});
