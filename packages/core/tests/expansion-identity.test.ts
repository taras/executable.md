/**
 * Tier XP — expansion identity (spec §5.6).
 *
 * An expansion identifier is derived from the root document and the structural
 * expansion path. These drive `expandSegments` directly, so what they assert is
 * the engine's own derivation rather than a component's report of it — and they
 * run with no execution, no journal and no workflow middleware, which is itself
 * one of the claims.
 *
 * Each test names the derivation it would kill: substituting the block counter,
 * dropping an iteration frame, anchoring a projection to the callee, and so on.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { all, createContext, ensure, scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { Component, content } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { inlineSource } from "../src/root-source.ts";
import { registerComponents } from "../src/components/registration.ts";
import { getExpansion } from "../src/expansion.ts";
import type { Expansion } from "../src/expansion.ts";
import { expandSegments } from "../src/expand.ts";
import { scanSegments } from "../src/scanner.ts";
import type {
  ComponentDefinition,
  EvalEnv,
  FunctionComponentDefinition,
  Json,
  Segment,
} from "../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false };

type Definition = ComponentDefinition | FunctionComponentDefinition;

function fn(name: string, body: () => Operation<Json>): FunctionComponentDefinition {
  return { kind: "function", name, props: NO_PROPS, fn: body };
}

/** A markdown component whose body is scanned as if it were its own file. */
function markdown(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `components/${name}.md`,
    meta: {},
    props: NO_PROPS,
    bodySegments: scanSegments(body, {
      path: `components/${name}.md`,
      baseOffset: 0,
      baseLine: 1,
    }),
  };
}

/** `<Probe />` — records the identifier of every expansion it runs in. */
function probe(into: string[], name = "Probe"): FunctionComponentDefinition {
  return fn(name, function* () {
    into.push((yield* getExpansion()).id);
    return "";
  });
}

function expand(
  source: string,
  definitions: Record<string, Definition>,
  path?: string,
  values: Record<string, unknown> = {},
): Operation<Segment[]> {
  return scoped(function* () {
    const env: EvalEnv = { values: { ...values } };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          const definition = definitions[name];
          if (!definition) {
            throw new Error(`no component ${name}`);
          }
          return definition;
        },
      },
      { at: "min" },
    );
    return yield* expandSegments(
      scanSegments(source, path === undefined ? undefined : { path, baseOffset: 0, baseLine: 1 }),
      {},
      {},
      new Set(),
    );
  });
}

/** Expand `source` and hand back the identifiers `<Probe />` saw, in order. */
function* identifiers(
  source: string,
  extra: Record<string, Definition> = {},
  path = "doc.md",
  values: Record<string, unknown> = {},
): Operation<string[]> {
  const seen: string[] = [];
  yield* expand(source, { Probe: probe(seen), ...extra }, path, values);
  return seen;
}

/**
 * Two documents on disk with the same body, so a root identity is the only
 * thing that differs between them.
 */
function* useDocuments(names: string[], body: string): Operation<string[]> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-xp-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  const paths: string[] = [];
  for (const name of names) {
    const target = join(root, name);
    yield* writeTextFile(target, body);
    paths.push(target);
  }
  return paths;
}

/** Execute one document, collecting the identifiers `<Probe />` saw. */
function* executed(path: string, stream = new InMemoryStream()): Operation<string[]> {
  const seen: string[] = [];
  yield* scoped(function* () {
    yield* registerComponents([
      {
        name: "Probe",
        origin: "tier-xp",
        props: NO_PROPS,
        *fn() {
          seen.push((yield* getExpansion()).id);
          return "";
        },
      },
    ]);
    yield* collect(yield* execute({ path, stream }));
  });
  return seen;
}

/** A positionless element, the shape nothing scanned ever produces. */
function element(name: string, children: Segment[] = []): Segment {
  return {
    type: "component",
    name,
    props: {},
    expressions: {},
    children,
    selfClosing: children.length === 0,
  };
}

/** An `<Output>` region holding one positionless `<Probe />`. */
function outputRegion(): Segment {
  return element("Output", [element("Probe")]);
}

/** Expand hand-built segments, collecting what `<Probe />` saw. */
function* collectFrom(segments: Segment[]): Operation<string[]> {
  const seen: string[] = [];
  yield* scoped(function* () {
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent() {
          return probe(seen);
        },
      },
      { at: "min" },
    );
    return yield* expandSegments(segments, {}, {}, new Set());
  });
  return seen;
}

/** The same, through a component body so `buildBody()` chunking runs. */
function* expandedBody(bodySegments: Segment[]): Operation<string[]> {
  const seen: string[] = [];
  yield* scoped(function* () {
    const env: EvalEnv = { values: {} };
    yield* Component.around({ env: () => env }, { at: "min" });
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name]) {
          if (name === "Host") {
            return {
              kind: "markdown" as const,
              name,
              path: "Host.md",
              meta: {},
              props: NO_PROPS,
              bodySegments,
            };
          }
          return probe(seen);
        },
      },
      { at: "min" },
    );
    return yield* expandSegments([element("Host")], {}, {}, new Set());
  });
  return seen;
}

describe("Tier XP — expansion identity", () => {
  it("XP1: two elements written at different offsets get different identifiers", function* () {
    const seen = yield* identifiers("<Probe />\n\n<Probe />\n");

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("XP2: expanding the same source twice in one process reproduces the identifiers", function* () {
    const first = yield* identifiers("<Probe />\n\n<Probe />\n");
    const second = yield* identifiers("<Probe />\n\n<Probe />\n");

    expect(second).toEqual(first);
  });

  // The counter killer. A `blockId`-style counter advances with however much ran
  // before an element, so the trailing probe's identifier would move with the
  // branch. One source, two runtime values: the only thing that differs between
  // the runs is how much expanded, which a structural derivation cannot see.
  it("XP3: an element's identifier does not depend on how much ran before it", function* () {
    const source = "<Probe />\n\n<If condition={flag}>\n<Probe />\n</If>\n\n<Probe />\n";
    const taken = yield* identifiers(source, {}, "doc.md", { flag: true });
    const skipped = yield* identifiers(source, {}, "doc.md", { flag: false });

    expect(taken).toHaveLength(3);
    expect(skipped).toHaveLength(2);
    // The first and last probes are the same authored elements in both runs.
    expect(skipped[0]).toBe(taken[0]);
    expect(skipped[1]).toBe(taken[2]);
  });

  it("XP4: <Loop> iterations differ, and re-expansion reproduces the same ordered pair", function* () {
    const first = yield* identifiers("<Loop max={2}>\n<Probe />\n</Loop>\n");
    const second = yield* identifiers("<Loop max={2}>\n<Probe />\n</Loop>\n");

    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(second).toEqual(first);
  });

  it("XP5: <Each> items differ, and re-expansion reproduces the same ordered pair", function* () {
    const source = '<Each in={[1, 2]} let="n">\n<Probe />\n</Each>\n';
    const first = yield* identifiers(source);
    const second = yield* identifiers(source);

    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(second).toEqual(first);
  });

  it("XP6: one component invoked from two sites gives its body two identifiers", function* () {
    const seen = yield* identifiers("<Wrap />\n\n<Wrap />\n", {
      Wrap: markdown("Wrap", "<Probe />\n"),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("XP7: elements carrying no position at all are still told apart", function* () {
    const seen: string[] = [];
    const element = (): Segment => ({
      type: "component",
      name: "Probe",
      props: {},
      expressions: {},
      children: [],
      selfClosing: true,
    });

    yield* scoped(function* () {
      const env: EvalEnv = { values: {} };
      yield* Component.around({ env: () => env }, { at: "min" });
      yield* Component.around(
        {
          // deno-lint-ignore require-yield
          *importComponent() {
            return probe(seen);
          },
        },
        { at: "min" },
      );
      return yield* expandSegments([element(), element()], {}, {}, new Set());
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("XP8: the identifier is opaque — the authored name is not recoverable from it", function* () {
    const seen = yield* identifiers("<Probe />\n");

    expect(seen[0]).not.toContain("Probe");
    expect(seen[0]).not.toContain("doc.md");
  });

  it("XP9: it reports the authored tag name, not the name of the definition that resolved it", function* () {
    let observed: Expansion | undefined;
    const definition = fn("SomethingElse", function* () {
      observed = yield* getExpansion();
      return "";
    });

    yield* expand("<Alias />\n", { Alias: definition }, "doc.md");

    expect(observed?.name).toBe("Alias");
  });

  it("XP10: one live expansion answers with one frozen object", function* () {
    let first: Expansion | undefined;
    let second: Expansion | undefined;
    const definition = fn("Probe", function* () {
      first = yield* getExpansion();
      second = yield* getExpansion();
      return "";
    });

    yield* expand("<Probe />\n", { Probe: definition }, "doc.md");

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.position)).toBe(true);
    expect([...Object.keys(first ?? {})].sort()).toEqual(["id", "name", "position"]);
  });

  it("XP11: it is not available outside an executable element expansion", function* () {
    let message = "";
    yield* scoped(function* () {
      try {
        yield* getExpansion();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    });

    expect(message).toContain("getExpansion()");
  });

  // An Effection context is identified by its name, so a descriptor built
  // independently addresses the same context. That is what a second instance of
  // core is — a repository `.ts` component importing it from disk while the
  // compiled binary carries its own copy — and branding the value with anything
  // instance-local rejects exactly this read. That is how the compiled binary
  // broke while every Deno test stayed green.
  it("XP12: a descriptor of the same name built elsewhere reads the engine's expansion", function* () {
    const elsewhere = createContext<Expansion | undefined>("expand.current", undefined);
    let observed: Expansion | undefined;
    let own: Expansion | undefined;

    const definition = fn("Probe", function* () {
      own = yield* getExpansion();
      observed = yield* elsewhere.get();
      return "";
    });

    yield* expand("<Probe />\n", { Probe: definition }, "doc.md");

    expect(own).toBeDefined();
    expect(observed).toBe(own);
  });
  it("XP13: two <Content /> elements in one body project the same children under different identifiers", function* () {
    const seen = yield* identifiers("<Twice>\n<Probe />\n</Twice>\n", {
      Twice: markdown("Twice", "<Content />\n\n<Content />\n"),
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("XP14: a component projecting the same slot twice gets two identifiers", function* () {
    const seen: string[] = [];
    const twice = fn("Twice", function* () {
      const first = yield* content();
      const second = yield* content();
      return `${first}${second}`;
    });

    yield* expand("<Twice>\n<Probe />\n</Twice>\n", { Twice: twice, Probe: probe(seen) }, "doc.md");

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  // A projection is identified by the invocation that performed it, so the same
  // authored content projected through two different components is two
  // expansions. What the content is made of still comes from where the caller
  // wrote it, which is the second half: two probes inside one wrapper differ by
  // their own source positions.
  it("XP15: a projection is identified by the invocation that made it, its content by where it was written", function* () {
    const echo = (name: string) => fn(name, () => content());

    const throughA: string[] = [];
    yield* expand(
      "<WrapA>\n<Probe />\n</WrapA>\n",
      {
        WrapA: echo("WrapA"),
        Probe: probe(throughA),
      },
      "doc.md",
    );

    const throughB: string[] = [];
    yield* expand(
      "<WrapB>\n<Probe />\n</WrapB>\n",
      {
        WrapB: echo("WrapB"),
        Probe: probe(throughB),
      },
      "doc.md",
    );

    expect(throughA[0]).not.toBe(throughB[0]);

    const twoProbes: string[] = [];
    yield* expand(
      "<WrapA>\n<Probe />\n\n<Probe />\n</WrapA>\n",
      {
        WrapA: echo("WrapA"),
        Probe: probe(twoProbes),
      },
      "doc.md",
    );

    expect(twoProbes).toHaveLength(2);
    expect(twoProbes[0]).not.toBe(twoProbes[1]);
  });

  // A projection written inside an iterating construct is one authored
  // `<Content />` expanded once per item, so its identity has to come from the
  // path it expands under rather than from the element. `<Each>` adds its item
  // frame before the projection point is reached; dropping that frame, or
  // deriving the projection from the element that carries it, is what this
  // kills — both would report one identifier twice.
  it("XP26: a projection nested in <Each> differs per iteration and reproduces itself", function* () {
    const source = "<EachHost>\n<Probe />\n</EachHost>\n";
    const definitions = {
      EachHost: markdown("EachHost", '<Each in={[1, 2]} let="n">\n<Content />\n</Each>\n'),
    };

    const first = yield* identifiers(source, definitions);
    const second = yield* identifiers(source, definitions);

    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(second).toEqual(first);
  });

  // The projection ordinal is the one discriminator that is not read off the
  // source, so it has to follow the component's own program order rather than
  // the order projections finish in. Two runs of one component, with the
  // completion schedule reversed between them.
  it("XP16: concurrent projections of one slot keep their identifiers when completion order reverses", function* () {
    function* runWith(delays: number[]): Operation<{ entered: string[]; finished: string[] }> {
      const entered: string[] = [];
      const finished: string[] = [];
      const slow = fn("Probe", function* () {
        // Reserved synchronously, before the first suspension: reading the
        // length and writing it back around a `yield*` would let both probes
        // claim the same position and hide the very interleaving under test.
        const seq = entered.length;
        entered.push("");
        const id = (yield* getExpansion()).id;
        entered[seq] = id;
        yield* sleep(delays[seq] ?? 0);
        finished.push(id);
        return "";
      });
      const twice = fn("Twice", function* () {
        const [first, second] = yield* all([content(), content()]);
        return `${first}${second}`;
      });

      yield* expand("<Twice>\n<Probe />\n</Twice>\n", { Twice: twice, Probe: slow }, "doc.md");
      return { entered, finished };
    }

    const slowFirst = yield* runWith([40, 5]);
    const fastFirst = yield* runWith([5, 40]);

    // The schedule really did reverse: what finished first swapped over.
    expect(slowFirst.finished[0]).toBe(slowFirst.entered[1]);
    expect(fastFirst.finished[0]).toBe(fastFirst.entered[0]);

    // ...and the identifiers did not move with it.
    expect(fastFirst.entered).toEqual(slowFirst.entered);
  });

  // An Effection operation does nothing when it is constructed. A projection
  // that is built and never yielded must therefore take no ordinal, or the
  // identifiers of the projections that do run would depend on dead code.
  it("XP17: a projection operation that is never interpreted consumes no ordinal", function* () {
    const plain: string[] = [];
    const once = fn("Once", function* () {
      return yield* content();
    });
    yield* expand("<Once>\n<Probe />\n</Once>\n", { Once: once, Probe: probe(plain) }, "doc.md");

    const afterDeadCode: string[] = [];
    const built = fn("Once", function* () {
      const never = content();
      void never;
      return yield* content();
    });
    yield* expand(
      "<Once>\n<Probe />\n</Once>\n",
      { Once: built, Probe: probe(afterDeadCode) },
      "doc.md",
    );

    expect(afterDeadCode).toEqual(plain);
  });
  // A structural construct expands descendants without being one itself. If it
  // contributes no frame, `@index` separates siblings in one list but not
  // children at the same local index under different parents — which is a
  // collision, not a near miss.
  it("XP18: elements at the same index under different structural parents differ", function* () {
    const probeElement = (): Segment => ({
      type: "component",
      name: "Probe",
      props: {},
      expressions: {},
      children: [],
      selfClosing: true,
    });
    const branch = (): Segment => ({
      type: "component",
      name: "If",
      props: { condition: true },
      expressions: {},
      children: [probeElement()],
      selfClosing: false,
    });

    function* run(): Operation<string[]> {
      const seen: string[] = [];
      yield* scoped(function* () {
        const env: EvalEnv = { values: {} };
        yield* Component.around({ env: () => env }, { at: "min" });
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *importComponent() {
              return probe(seen);
            },
          },
          { at: "min" },
        );
        return yield* expandSegments([branch(), branch()], {}, {}, new Set());
      });
      return seen;
    }

    const first = yield* run();
    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);

    // ...and the derivation is still structural, not a counter that happens to
    // separate them.
    const second = yield* run();
    expect(second).toEqual(first);
  });

  // The root document seeds the path, and only `execute()` supplies that seed —
  // the cases above drive `expandSegments` directly and cannot see it.
  // `<Else>` is consumed by `<If>` and never reaches expansion's dispatch, so it
  // contributes no frame unless `<If>` adds it — and both arms of one `<If>`
  // expand under one path.
  it("XP22: the two arms of one <If> expand under different identities", function* () {
    const probeElement = (): Segment => ({
      type: "component",
      name: "Probe",
      props: {},
      expressions: {},
      children: [],
      selfClosing: true,
    });
    const branch = (condition: boolean): Segment => ({
      type: "component",
      name: "If",
      props: { condition },
      expressions: {},
      children: [
        probeElement(),
        {
          type: "component",
          name: "Else",
          props: {},
          expressions: {},
          children: [probeElement()],
          selfClosing: false,
        },
      ],
      selfClosing: false,
    });

    function* taken(condition: boolean): Operation<string[]> {
      const seen: string[] = [];
      yield* scoped(function* () {
        const env: EvalEnv = { values: {} };
        yield* Component.around({ env: () => env }, { at: "min" });
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *importComponent() {
              return probe(seen);
            },
          },
          { at: "min" },
        );
        return yield* expandSegments([branch(condition)], {}, {}, new Set());
      });
      return seen;
    }

    const whenTrue = yield* taken(true);
    const whenFalse = yield* taken(false);

    expect(whenTrue).toHaveLength(1);
    expect(whenFalse).toHaveLength(1);
    expect(whenTrue[0]).not.toBe(whenFalse[0]);

    // Structural, not incidental: each arm reproduces its own identifier.
    expect(yield* taken(true)).toEqual(whenTrue);
    expect(yield* taken(false)).toEqual(whenFalse);
  });

  // `<Answer>` is consumed by `<Answers>` and never reaches expansion's
  // dispatch, so without its own frame both answers' template children expand
  // under one path. Hand-built and positionless throughout: scanned markup would
  // carry source offsets that hide the missing frame.
  it("XP23: template children under different <Answer> elements differ", function* () {
    const seen: string[] = [];
    const answer = (value: string, template: string): Segment => ({
      type: "component",
      name: "Answer",
      props: { value },
      expressions: {},
      children: [element("Template")],
      selfClosing: false,
    });
    const region = (): Segment => ({
      type: "component",
      name: "Answers",
      props: {},
      expressions: {},
      children: [
        answer('"approve"', "Approve?"),
        answer('"reject"', "Reject?"),
        { type: "text", content: "body" },
      ],
      selfClosing: false,
    });

    // Each template child records where it expanded and renders the text that
    // makes its answer parse.
    let rendered = 0;
    const templates = ["Approve?", "Reject?"];
    function* run(): Operation<string[]> {
      const ids: string[] = [];
      rendered = 0;
      yield* scoped(function* () {
        const env: EvalEnv = { values: {} };
        yield* Component.around({ env: () => env }, { at: "min" });
        yield* Component.around(
          {
            // deno-lint-ignore require-yield
            *importComponent() {
              return {
                kind: "function" as const,
                name: "Template",
                props: NO_PROPS,
                *fn() {
                  ids.push((yield* getExpansion()).id);
                  const text = templates[rendered] ?? "Other?";
                  rendered += 1;
                  return text;
                },
              };
            },
          },
          { at: "min" },
        );
        return yield* expandSegments([region()], {}, {}, new Set());
      });
      return ids;
    }

    const first = yield* run();

    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(yield* run()).toEqual(first);
    expect(seen).toHaveLength(0);
  });

  it("XP24: positionless elements in different body chunks differ", function* () {
    // Two documentation segments: each becomes its own chunk, and each holds a
    // positionless element that is index 0 of that chunk.
    // The `<Output>` is what makes the body chunk at all; it carries a probe of
    // its own, so three fire and all three must be told apart.
    const body = [element("Probe"), element("Probe"), outputRegion()];
    const first = yield* expandedBody(body);

    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(yield* expandedBody(body)).toEqual(first);
  });

  it("XP25: an <Output> region and documentation at the same index differ", function* () {
    // The `<Output>` element is consumed by chunking, so without its frame its
    // first child collides with the documentation segment at index 0.
    const first = yield* expandedBody([element("Probe"), outputRegion()]);

    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(yield* expandedBody([element("Probe"), outputRegion()])).toEqual(first);
  });

  it("XP19: the same element structure under two root documents differs", function* () {
    const [here, there] = yield* useDocuments(["a.md", "b.md"], "<Probe />\n");
    const first = yield* executed(here!);
    const second = yield* executed(there!);

    expect(first).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it("XP20: one root document reproduces its identifiers", function* () {
    const [only] = yield* useDocuments(["a.md"], "<Probe />\n\n<Probe />\n");

    expect(yield* executed(only!)).toEqual(yield* executed(only!));
  });

  it("XP21: a truncated replay derives the identifiers already recorded", function* () {
    const [only] = yield* useDocuments(["a.md"], "<Probe />\n\n<Probe />\n");
    const stream = new InMemoryStream();
    const live = yield* executed(only!, stream);

    // Everything the live run journaled except the root close, so the document
    // expands again against its own record rather than from nothing.
    const truncated = new InMemoryStream(
      stream.snapshot().filter((event: DurableEvent) => event.type !== "close"),
    );

    expect(live).toHaveLength(2);
    expect(yield* executed(only!, truncated)).toEqual(live);
  });
});
