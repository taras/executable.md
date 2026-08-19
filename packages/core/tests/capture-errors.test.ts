import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { Operation } from "effection";
import { StaleInputError } from "@executablemd/durable-streams";
import { expandSegments } from "../src/expand.ts";
import { Component, content } from "../src/component-api.ts";
import { printErrors } from "../src/component-failures.ts";
import { useContent } from "../src/content-context.ts";
import { scanSegments } from "../src/scanner.ts";
import { renderSegments } from "../src/render.ts";
import { ContentError, DocumentationError, ErrorMode } from "../src/errors.ts";
import type {
  ComponentDefinition,
  ErrorSegment,
  FunctionComponentDefinition,
  Segment,
} from "../src/types.ts";

/**
 * What one run observed. The arrays are the only evidence these tests accept
 * that a component resumed: rendered text says what was produced, not what was
 * executed, and a short-circuited component produces no text either way.
 */
interface Trace {
  /** Post-content effects entered because the component resumed. */
  effects: string[];
  /** Recovery effects entered from a catch around `content()`. */
  recoveries: string[];
  /** Projection-owned work that unwound, in the order it did. */
  torn: string[];
  /** What `torn` held at the moment a failure was reported. */
  tornAtRaise: string[][];
  /** What `torn` held at the moment a recovery catch was entered. */
  tornAtRecovery: string[][];
  /** Every ErrorSegment that passed through `Component.raise`, in order. */
  raised: ErrorSegment[];
  /** Every DocumentationError the observation chain constructed. */
  failures: DocumentationError[];
  /** What a recovering component caught at `yield* content()`. */
  caught: unknown[];
}

function trace(): Trace {
  return {
    effects: [],
    recoveries: [],
    torn: [],
    tornAtRaise: [],
    tornAtRecovery: [],
    raised: [],
    failures: [],
    caught: [],
  };
}

interface CaptureRun {
  segments: Segment[];
  output: string;
  trace: Trace;
}

const OPEN_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

function component(name: string, body: string): ComponentDefinition {
  return {
    kind: "markdown",
    name,
    path: `${name}.md`,
    meta: {},
    props: OPEN_SCHEMA,
    bodySegments: scanSegments(body),
  };
}

/**
 * A genuinely yielded operation: the push happens only when control reaches the
 * `yield*` and the operation runs to completion, so an entry in the array is
 * evidence the component resumed rather than evidence of what it rendered.
 */
function* recordEntry(entries: string[], name: string): Operation<void> {
  yield* sleep(0);
  entries.push(name);
}

interface ProbeOptions {
  /** Ask for a named slot instead of the default content. */
  slot?: string;
  /** Reach content through the `useContent()` compatibility alias. */
  alias?: boolean;
}

/**
 * The WebForm shape: validate the content, then perform the effect that must
 * not happen when the content is invalid.
 */
function probe(name: string, log: Trace, options: ProbeOptions = {}): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: OPEN_SCHEMA,
    *fn(_props) {
      const rendered = options.alias
        ? yield* useContent(options.slot)
        : yield* content(options.slot);
      yield* recordEntry(log.effects, name);
      return `wrapped:${rendered}`;
    },
  };
}

interface RecoveryOptions {
  /** Hand the caught ContentError back to the boundary instead of recovering. */
  rethrow?: boolean;
  /** Throw an unrelated error from the try block after content succeeds. */
  boom?: boolean;
}

/**
 * One source text run under both error modes: a `try/catch` directly around
 * `yield* content()` that recognizes `ContentError` and nothing else.
 */
function recovering(
  name: string,
  log: Trace,
  options: RecoveryOptions = {},
): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: OPEN_SCHEMA,
    // Prints: these assert what a recovered — or unrecovered — failure looks
    // like once it is a printed error the capture can see.
    fn: printErrors(function* () {
      try {
        const rendered = yield* content();
        if (options.boom) {
          throw new Error("unrelated");
        }
        yield* recordEntry(log.effects, name);
        return `wrapped:${rendered}`;
      } catch (error) {
        log.caught.push(error);
        if (error instanceof ContentError) {
          if (options.rethrow) {
            throw error;
          }
          log.tornAtRecovery.push([...log.torn]);
          yield* recordEntry(log.recoveries, name);
          return "fallback";
        }
        throw error;
      }
    }),
  };
}

/**
 * An author who constructs and throws the public `ContentError` themselves.
 *
 * The segment it carries was never reported, so it is not transport: the effect
 * recorded before the throw is what shows the function body ran and fabricated
 * it rather than receiving it from a content failure.
 */
function forging(name: string, log: Trace, fabricated: ErrorSegment): FunctionComponentDefinition {
  return {
    kind: "function",
    name,
    props: OPEN_SCHEMA,
    // Prints, because what this asserts is how a fabricated content failure
    // is treated once it becomes a printed error.
    fn: printErrors(function* () {
      yield* recordEntry(log.effects, name);
      throw new ContentError([fabricated]);
    }),
  };
}

/**
 * An unresolvable component is the cheapest way to plant an ErrorSegment
 * inside a captured subtree: the import failure is reported by the body's own
 * consumer boundary, so it reaches the capture as a segment.
 */
const BAD = "<Missing />";

/**
 * `<Broken />` — a component that fails, numbering each failure so source order
 * and object identity are both checkable.
 *
 * It fails rather than returning anything: the ErrorSegment these assert on is
 * the printed error the engine builds for a failed invocation, which is a real
 * reported segment and not prose a component chose to render. That is what keeps
 * the identity assertions meaning something — the object a capture refuses, or
 * that replaces an invocation, is the one `Component.raise` returned.
 *
 * One instance per run, so the numbering restarts with the sequence the
 * assertions read.
 */
function brokenComponent(): FunctionComponentDefinition {
  let seq = 0;
  return {
    kind: "function",
    name: "Broken",
    props: OPEN_SCHEMA,
    // deno-lint-ignore require-yield
    fn: printErrors(function* () {
      seq += 1;
      throw new Error(`broken ${seq}`);
    }),
  };
}

/** What the engine's printed error for the nth failed `<Broken />` reads. */
function broke(n: number): string {
  return `Function component Broken error: broken ${n}`;
}

/**
 * Claims `<Stale />` and fails its expansion with the planted durability
 * failure. The journal no longer describes this run, so nothing between the
 * projection and the document may translate it into a printed error or present it
 * as a content failure.
 */
function useStale(planted: StaleInputError): Operation<void> {
  return Component.around({
    // deno-lint-ignore require-yield
    *importComponent([name], next) {
      if (name !== "Stale") {
        return yield* next(name);
      }
      // Thrown from resolution: what reaches the caller must be the planted
      // failure itself, not a printed error built from it.
      throw planted;
    },
  });
}

/**
 * Spawns ordinary suspended work from a `spawn` modifier, which runs on the
 * task expanding the block — the projection's own, when the block is written in
 * projected content. Nothing retains it, so it belongs to that task and must
 * unwind when it does.
 *
 * A modifier rather than a component: a component's work is owned by its
 * invocation, which returns as soon as the body does. Such a task unwinds at
 * the end of `<Spawner />` rather than at the end of the projection, and every
 * ordering downstream of it would then hold for the wrong reason.
 */
function useSpawner(log: Trace): Operation<void> {
  return Component.around({
    *applyModifiers([modifiers, block], next) {
      if (!modifiers.some((modifier) => modifier.name === "spawn")) {
        return yield* next(modifiers, block);
      }
      const started = withResolvers<void>();
      yield* spawn(function* () {
        yield* ensure(() => {
          log.torn.push("spawner");
        });
        started.resolve();
        yield* suspend();
      });
      // Wait for it to reach its suspension: a task halted before its first
      // step registers no teardown and would prove nothing.
      yield* started.operation;
      return { output: "", exitCode: 0, stderr: "" };
    },
  });
}

/** Spawns projection-owned work where it is written. */
const SPAWN_BLOCK = "```sh spawn exec\nspawner\n```";

interface RunOptions {
  throwing?: boolean;
  components?: Record<string, string>;
  functions?: Record<string, FunctionComponentDefinition>;
  values?: Record<string, unknown>;
  trace?: Trace;
  /** Fail `<Stale />` expansion with this durability failure. */
  stale?: StaleInputError;
}

function run(source: string, opts: RunOptions = {}): Operation<CaptureRun> {
  return scoped(function* () {
    const markdown = opts.components ?? {};
    const functions: Record<string, FunctionComponentDefinition> = {
      Broken: brokenComponent(),
      ...(opts.functions ?? {}),
    };
    const log = opts.trace ?? trace();
    yield* Component.around({
      *raise([error], next) {
        log.raised.push(error);
        log.tornAtRaise.push([...log.torn]);
        try {
          return yield* next(error);
        } catch (failure) {
          // The chain constructs the DocumentationError a throwing error mode
          // propagates; capturing it here is what lets a test assert the object
          // that leaves the boundary is that same one.
          if (failure instanceof DocumentationError) {
            log.failures.push(failure);
          }
          throw failure;
        }
      },
    });
    yield* useSpawner(log);
    const planted = opts.stale;
    if (planted) {
      yield* useStale(planted);
    }
    yield* Component.around(
      {
        // deno-lint-ignore require-yield
        *importComponent([name], _next) {
          const fn = functions[name];
          if (fn) {
            return fn;
          }
          if (name in markdown) {
            return component(name, markdown[name]);
          }
          throw new Error(`Component not found: ${name}`);
        },
        // deno-lint-ignore require-yield
        *applyModifiers(_args, _next) {
          return { output: "mock output\n", exitCode: 0, stderr: "" };
        },
      },
      { at: "min" },
    );
    const values: Record<string, unknown> = opts.values ?? {};
    yield* Component.around({ env: () => ({ values }) }, { at: "min" });
    if (opts.throwing) {
      yield* ErrorMode.set("throw");
    }
    const segments = yield* expandSegments(
      scanSegments(source),
      {},
      {},
      new Set(),
      undefined,
      undefined,
    );
    return { segments, output: renderSegments(segments), trace: log };
  });
}

function isError(segment: Segment): segment is ErrorSegment {
  return segment.type === "error";
}

function errors(segments: Segment[]): ErrorSegment[] {
  return segments.filter(isError);
}

describe("capture error propagation", () => {
  it("CE1: a captured <Each> preserves body errors under a printing error mode", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run(`<Each in={[1, 2]} let="n" as="cap">${BAD}</Each>`, { values });

    expect(errors(result.segments)).toHaveLength(2);
    expect(result.output).toContain("ERROR");
    expect("cap" in values).toBe(false);
  });

  it("CE2: a throwing error mode aborts a captured <Each> before storing the binding", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run(`<Each in={[1]} let="n" as="cap">${BAD}</Each>`, { throwing: true, values });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE3: a successful <Each> capture is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Each in={[1, 2]} let="n" as="cap">n={n};</Each>INLINE', {
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("n=1;n=2;");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE4: a captured component preserves body errors under a printing error mode", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Bad as="cap" />', { components: { Bad: BAD }, values });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("ERROR");
    expect("cap" in values).toBe(false);
  });

  it("CE5: a throwing error mode aborts a captured component before storing the binding", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run('<Bad as="cap" />', { components: { Bad: BAD }, throwing: true, values });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE6: a successful component capture is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Good as="cap" />INLINE', {
      components: { Good: "hello" },
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("hello");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE7: a captured function component preserves content errors and skips its post-content effect", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run('<Probe as="cap"><Broken /></Probe>AFTER', {
      functions: { Probe: probe("Probe", log) },
      trace: log,
      values,
    });

    expect(errors(result.segments)).toHaveLength(1);
    expect(errors(result.segments)[0]).toBe(log.raised[0]);
    expect(result.output).toContain(broke(1));
    expect(result.output).toContain("AFTER");
    expect(result.output).not.toContain("wrapped:");
    expect(log.effects).toEqual([]);
    expect("cap" in values).toBe(false);
  });

  it("CE8: a throwing error mode aborts a captured function component with the original DocumentationError", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run('<Probe as="cap"><Broken /><Broken /></Probe>', {
        functions: { Probe: probe("Probe", log) },
        throwing: true,
        trace: log,
        values,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(log.failures).toHaveLength(1);
    expect(thrown).toBe(log.failures[0]);
    expect(log.raised).toHaveLength(1);
    expect(log.effects).toEqual([]);
    expect("cap" in values).toBe(false);
  });

  it("CE9: successful content resumes the function", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run('<Probe as="cap">body</Probe>INLINE', {
      functions: { Probe: probe("Probe", log) },
      trace: log,
      values,
    });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("wrapped:body");
    expect(log.effects).toEqual(["Probe"]);
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE10: an uncaptured function component is replaced by the original content errors", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run("<Probe>before<Broken />after</Probe>TAIL", {
      functions: { Probe: probe("Probe", log) },
      trace: log,
      values,
    });

    expect(errors(result.segments)).toHaveLength(1);
    expect(errors(result.segments)[0]).toBe(log.raised[0]);
    expect(result.output).toBe(`<!-- ERROR: ${broke(1)} -->TAIL`);
    expect(result.output).not.toContain("before");
    expect(result.output).not.toContain("after");
    expect(result.output).not.toContain("wrapped:");
    expect(log.effects).toEqual([]);
  });

  it("CE11: a requested named slot fails the same way", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run('<Card as="cap"><Broken slot="header" /></Card>AFTER', {
      functions: { Card: probe("Card", log, { slot: "header" }) },
      trace: log,
      values,
    });

    expect(errors(result.segments)).toHaveLength(1);
    expect(errors(result.segments)[0]).toBe(log.raised[0]);
    expect(result.output).toContain(broke(1));
    expect(result.output).toContain("AFTER");
    expect(result.output).not.toContain("wrapped:");
    expect(log.effects).toEqual([]);
    expect("cap" in values).toBe(false);
  });

  it("CE12: a native <Capture> preserves child errors under a printing error mode", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run(`<Capture as="cap">${BAD}</Capture>AFTER`, { values });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("ERROR");
    expect(result.output).toContain("AFTER");
    expect("cap" in values).toBe(false);
  });

  it("CE13: a throwing error mode aborts a native <Capture> before storing the binding", function* () {
    const values: Record<string, unknown> = {};
    let thrown: unknown;
    try {
      yield* run(`<Capture as="cap">${BAD}</Capture>`, { throwing: true, values });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect("cap" in values).toBe(false);
  });

  it("CE14: a successful native <Capture> is unchanged", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run('<Capture as="cap">hello</Capture>INLINE', { values });

    expect(result.output).toBe("INLINE");
    expect(values.cap).toBe("hello");
    expect(errors(result.segments)).toHaveLength(0);
  });

  it("CE15: a <Capture> validation printed error is still a single error", function* () {
    const values: Record<string, unknown> = {};
    const result = yield* run("<Capture>no binding</Capture>", { values });

    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("requires an");
  });

  it("CE16: a throwing error mode aborts an uncaptured function component with the original DocumentationError", function* () {
    const log = trace();
    let thrown: unknown;
    try {
      yield* run("<Probe>before<Broken /><Broken />after</Probe>TAIL", {
        functions: { Probe: probe("Probe", log) },
        throwing: true,
        trace: log,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(log.failures).toHaveLength(1);
    expect(thrown).toBe(log.failures[0]);
    expect(log.raised).toHaveLength(1);
    expect(log.failures[0].segment).toBe(log.raised[0]);
    expect(log.effects).toEqual([]);
  });

  it("CE17: a catch at yield* content() sees ContentError, not DocumentationError", function* () {
    const log = trace();
    const result = yield* run("<Recover><Broken /></Recover>", {
      functions: { Recover: recovering("Recover", log) },
      throwing: true,
      trace: log,
    });

    expect(log.caught).toHaveLength(1);
    const caught = log.caught[0];
    expect(caught).toBeInstanceOf(ContentError);
    expect(caught).not.toBeInstanceOf(DocumentationError);
    if (!(caught instanceof ContentError)) {
      throw new Error("expected a ContentError at the content() call");
    }
    expect(caught.errors[0]).toBe(log.raised[0]);
    expect(result.output).toBe("fallback");
  });

  it("CE18: recovery under a printing error mode returns fallback and reasserts nothing", function* () {
    const log = trace();
    const result = yield* run("<Recover><Broken /><Broken /></Recover>TAIL", {
      functions: { Recover: recovering("Recover", log) },
      trace: log,
    });

    expect(result.output).toBe("fallbackTAIL");
    expect(errors(result.segments)).toHaveLength(0);
    expect(result.output).not.toContain("ERROR");
    expect(log.recoveries).toEqual(["Recover"]);
    expect(log.effects).toEqual([]);
    expect(log.raised).toHaveLength(2);

    const caught = log.caught[0];
    if (!(caught instanceof ContentError)) {
      throw new Error("expected a ContentError at the content() call");
    }
    expect(caught.errors).toHaveLength(2);
    expect(caught.errors[0]).toBe(log.raised[0]);
    expect(caught.errors[1]).toBe(log.raised[1]);
    expect(caught.errors.map((error) => error.message)).toEqual([broke(1), broke(2)]);
  });

  it("CE19: the same recovery source recovers identically under a throwing error mode", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run('<Recover as="cap"><Broken /><Broken /></Recover>TAIL', {
      functions: { Recover: recovering("Recover", log) },
      throwing: true,
      trace: log,
      values,
    });

    expect(result.output).toBe("TAIL");
    expect(values.cap).toBe("fallback");
    expect(errors(result.segments)).toHaveLength(0);
    expect(log.recoveries).toEqual(["Recover"]);
    expect(log.effects).toEqual([]);

    // Fail-fast inside the projection: the first error ends it, so recovery sees
    // one segment where the printing run saw both.
    expect(log.raised).toHaveLength(1);
    const caught = log.caught[0];
    if (!(caught instanceof ContentError)) {
      throw new Error("expected a ContentError at the content() call");
    }
    expect(caught.errors).toHaveLength(1);
    expect(caught.errors[0]).toBe(log.raised[0]);
  });

  it("CE20: rethrowing the caught ContentError restores the original DocumentationError", function* () {
    const log = trace();
    let thrown: unknown;
    try {
      yield* run("<Rethrow><Broken /></Rethrow>", {
        functions: { Rethrow: recovering("Rethrow", log, { rethrow: true }) },
        throwing: true,
        trace: log,
      });
    } catch (error) {
      thrown = error;
    }

    expect(log.caught[0]).toBeInstanceOf(ContentError);
    expect(thrown).toBeInstanceOf(DocumentationError);
    expect(log.failures).toHaveLength(1);
    expect(thrown).toBe(log.failures[0]);
    expect(log.recoveries).toEqual([]);
  });

  it("CE21: an unrelated error is not mistaken for a content failure", function* () {
    const log = trace();
    const result = yield* run("<Boom>body</Boom>", {
      functions: { Boom: recovering("Boom", log, { boom: true }) },
      trace: log,
    });

    expect(log.caught).toHaveLength(1);
    expect(log.caught[0]).not.toBeInstanceOf(ContentError);
    expect(log.recoveries).toEqual([]);
    expect(errors(result.segments)).toHaveLength(1);
    expect(result.output).toContain("Function component Boom error: unrelated");
  });

  it("CE22: projection-owned work unwinds between the failure and the recovery effect", function* () {
    const log = trace();
    const result = yield* run(`<Recover>\n${SPAWN_BLOCK}\n<Broken />\n</Recover>`, {
      functions: { Recover: recovering("Recover", log) },
      trace: log,
    });

    // Both sides of the ordering, because either alone is satisfied by work with
    // the wrong owner. Still live where the failure is reported rules out a task
    // that unwound with whatever produced it; already torn down at the catch
    // rules out one that outlives the projection.
    expect(log.tornAtRaise).toEqual([[]]);
    expect(log.tornAtRecovery).toEqual([["spawner"]]);
    expect(log.torn).toEqual(["spawner"]);
    expect(log.recoveries).toEqual(["Recover"]);
    expect(result.output).toBe("fallback");
  });

  it("CE23: the same work written outside the projection outlives the recovery", function* () {
    const log = trace();
    const result = yield* run(`${SPAWN_BLOCK}\n<Recover><Broken /></Recover>`, {
      functions: { Recover: recovering("Recover", log) },
      trace: log,
    });

    // The contrast CE22 rests on. Identical work, one level out: the projection
    // unwinding does not reach it, so it is still live at the catch and unwinds
    // only when the run itself ends.
    expect(log.tornAtRaise).toEqual([[]]);
    expect(log.tornAtRecovery).toEqual([[]]);
    expect(log.torn).toEqual(["spawner"]);
    expect(log.recoveries).toEqual(["Recover"]);
    expect(result.output).toBe("fallback");
  });

  it("CE24: the useContent() alias is the same failure boundary", function* () {
    const log = trace();
    const values: Record<string, unknown> = {};
    const result = yield* run('<Alias as="cap"><Broken /></Alias>AFTER', {
      functions: { Alias: probe("Alias", log, { alias: true }) },
      trace: log,
      values,
    });

    expect(errors(result.segments)).toHaveLength(1);
    expect(errors(result.segments)[0]).toBe(log.raised[0]);
    expect(result.output).toContain(broke(1));
    expect(result.output).toContain("AFTER");
    expect(log.effects).toEqual([]);
    expect("cap" in values).toBe(false);
  });

  it("CE25: an author-thrown ContentError is an ordinary function-component error", function* () {
    const log = trace();
    const fabricated: ErrorSegment = {
      type: "error",
      message: "author fabricated",
      source: "Forge",
    };
    const result = yield* run("<Forge>body</Forge>TAIL", {
      functions: { Forge: forging("Forge", log, fabricated) },
      trace: log,
    });

    // The body ran and threw its own ContentError, so the transport path was
    // never entered — the engine reports the component's failure instead.
    expect(log.effects).toEqual(["Forge"]);
    const reported = errors(result.segments);
    expect(reported).toHaveLength(1);
    expect(reported[0]).not.toBe(fabricated);
    expect(reported[0].source).toBe("Forge");
    expect(reported[0].message).toBe("Function component Forge error: author fabricated");
    // The fabricated segment is reported by nothing and reaches nothing: the one
    // observation is the engine's own printed error, and the document renders only
    // that, with the author's message quoted inside it.
    expect(log.raised).toHaveLength(1);
    expect(log.raised[0]).toBe(reported[0]);
    expect(log.raised.includes(fabricated)).toBe(false);
    expect(result.segments.includes(fabricated)).toBe(false);
    expect(result.output).toBe(
      "<!-- ERROR: Function component Forge error: author fabricated -->TAIL",
    );
  });

  it("CE26: a durability failure crossing content() is neither a ContentError nor a printed error", function* () {
    const log = trace();
    const planted = new StaleInputError("PLANTED_DURABILITY_FAILURE");
    let thrown: unknown;
    try {
      yield* run("<Recover><Stale /></Recover>TAIL", {
        functions: { Recover: recovering("Recover", log) },
        stale: planted,
        trace: log,
      });
    } catch (error) {
      thrown = error;
    }

    // The catch at `yield* content()` saw the durability failure itself, so the
    // `instanceof ContentError` branch could not match and rethrew it.
    expect(log.caught).toHaveLength(1);
    expect(log.caught[0]).toBe(planted);
    expect(log.caught[0]).not.toBeInstanceOf(ContentError);
    expect(log.recoveries).toEqual([]);
    // It left expansion by identity rather than becoming an ErrorSegment: a
    // printing error mode renders whatever was reported, and nothing was.
    expect(thrown).toBe(planted);
    expect(log.raised).toEqual([]);
    expect(log.failures).toEqual([]);
  });

  it("CE27: a durability failure at the content boundary outranks the throwing error mode", function* () {
    const log = trace();
    const planted = new StaleInputError("PLANTED_DURABILITY_FAILURE");
    let thrown: unknown;
    try {
      yield* run("<Recover><Stale /></Recover>TAIL", {
        functions: { Recover: recovering("Recover", log) },
        stale: planted,
        throwing: true,
        trace: log,
      });
    } catch (error) {
      thrown = error;
    }

    // Same source, opposite error mode: the object that escapes is still the planted
    // failure, and no DocumentationError was constructed for it to outrank.
    expect(thrown).toBe(planted);
    expect(thrown).not.toBeInstanceOf(DocumentationError);
    expect(thrown).not.toBeInstanceOf(ContentError);
    expect(log.caught).toHaveLength(1);
    expect(log.caught[0]).toBe(planted);
    expect(log.recoveries).toEqual([]);
    expect(log.raised).toEqual([]);
    expect(log.failures).toEqual([]);
  });
});
