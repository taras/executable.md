/**
 * Tier FAIL — `<Fail>` (spec §6.8.2).
 *
 * The component ships in core, so every case here drives the real definition
 * the way a document reaches it: a file on disk, the real scanner, ordinary
 * selection against core's registry, and `execute()` as the root. Nothing calls
 * the implementation directly, because what this tier owns is what an authored
 * invocation does — where the failure is positioned, what stops after it, and
 * which enclosing region can recover it.
 *
 * Absence of output is never the evidence. A sibling that must not run is a
 * registered `<Ran>` recording its own mark, a projected child that must not
 * expand is the same component written inside the element, and an invocation
 * that must be refused before the authored message is raised is proved by the
 * sentinel message being nowhere in the failure.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { rm, writeTextFile } from "@effectionx/fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { Component } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { ComponentFailure, ErrorSegment, Json } from "../src/types.ts";

/**
 * The message a valid invocation would raise, in every case that must never
 * reach one.
 *
 * Distinctive on purpose: a refusal that happened after the body decided to
 * raise would carry this string, so its absence from the whole failure is what
 * proves the order.
 */
const SENTINEL = "SENTINEL: this document decided to stop";

interface Run {
  outcome: Result<Json>;
  /** Text the consumer received, which is where a printed error appears. */
  output: string;
  /** Every mark a `<Ran>` sibling or projected child recorded, in order. */
  ran: string[];
  /** Every failure offered to `handleFailure`, observed outside the document. */
  offered: ComponentFailure[];
  /** Every error segment printed, so "reported once" is countable. */
  observed: ErrorSegment[];
  events: DurableEvent[];
}

function useDir(): Operation<string> {
  return resource<string>(function* (provide) {
    const dir = yield* until(mkdtemp(join(tmpdir(), "xmd-fail-")));
    yield* ensure(function* () {
      yield* rm(dir, { recursive: true, force: true });
    });
    yield* provide(dir);
  });
}

/** A component that records that it ran, so a skipped sibling is observable. */
function useTripwire(ran: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Ran",
      origin: "tier-fail",
      props: {
        type: "object",
        properties: { mark: { type: "string" } },
        required: ["mark"],
        additionalProperties: false,
      },
      // deno-lint-ignore require-yield
      *fn(props) {
        ran.push(String(props.mark));
        return "";
      },
    },
  ]);
}

/**
 * Run one document, reporting the outcome rather than unwrapping it.
 *
 * The stream is a parameter so a case about replay can hand the same one to two
 * runs; every other case gets a fresh one.
 */
function run(
  dir: string,
  source: string,
  options: { stream?: InMemoryStream; files?: Record<string, string> } = {},
): Operation<Run> {
  return scoped(function* () {
    const path = join(dir, "doc.md");
    yield* writeTextFile(path, source);
    for (const [name, content] of Object.entries(options.files ?? {})) {
      yield* writeTextFile(join(dir, name), content);
    }
    const stream = options.stream ?? new InMemoryStream();
    const offered: ComponentFailure[] = [];
    const observed: ErrorSegment[] = [];
    const ran: string[] = [];
    yield* Component.around({
      *handleFailure([failure], next) {
        offered.push(failure);
        return yield* next(failure);
      },
      *raise([segment], next) {
        observed.push(segment);
        return yield* next(segment);
      },
    });
    yield* useTripwire(ran);
    const execution = yield* execute({ path, stream, includes: [dir] });
    const outcome = yield* execution;
    const output = yield* forEach(function* (_chunk: string) {}, execution.output);
    return { outcome, output, ran, offered, observed, events: yield* stream.readAll() };
  });
}

/** The failure a run ended with, failing the test if it completed instead. */
function failureOf(result: Run): Error {
  if (result.outcome.ok) {
    throw new Error(`expected the document to fail, but it completed: ${result.outcome.value}`);
  }
  return result.outcome.error;
}

/** Whether `target` is reachable from `error` by identity. */
function reaches(error: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (error === target) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some((e) => reaches(e, target, seen))) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? reaches(error.cause, target, seen)
    : false;
}

/** Every sentence a run produced, so a sentinel's absence covers all of them. */
function everythingSaid(result: Run): string {
  return [
    result.outcome.ok ? String(result.outcome.value) : result.outcome.error.message,
    result.output,
    ...result.observed.map((segment) => segment.message),
    ...result.offered.map((failure) => failure.error.message),
  ].join("\n");
}

/** The one failure `<Fail>` offered, failing the test if it offered none. */
function offeredByFail(result: Run): ComponentFailure {
  const failures = result.offered.filter((failure) => failure.name === "Fail");
  if (failures.length !== 1) {
    throw new Error(`expected exactly one <Fail> failure, got ${failures.length}`);
  }
  return failures[0];
}

const MISSING_RETURN = "The root document declares `returns` but produced no <Return> value.";
const VALUE_ROOT = ["---", "returns:", "  type: string", "---", ""].join("\n");

describe("Tier FAIL — stopping a document deliberately", () => {
  it("FAIL1: ends a plain root with the authored message and runs no later sibling", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        "before",
        "",
        '<Fail message="Review aborted; nothing was saved." />',
        "",
        '<Ran mark="after" />',
        "",
      ].join("\n"),
    );

    // The authored sentence is the outcome, unprefixed and unclassified.
    expect(failureOf(result).message).toBe("Review aborted; nothing was saved.");
    // Text before it had already streamed; the component itself rendered none.
    expect(result.output).toBe("before\n\n");
    expect(result.ran).toEqual([]);
    // Nothing printed it: an unmarked component leaves recovery to the region.
    expect(result.observed).toEqual([]);
  });

  it("FAIL2: fails a value root instead of reporting a missing <Return>", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        VALUE_ROOT,
        '<Fail message="No candidate was approvable." />',
        "",
        '<Return value={"late"} />',
        "",
      ].join("\n"),
    );

    const failure = failureOf(result);
    // The authored error itself, by identity, rather than a message that reads
    // like it.
    expect(reaches(failure, offeredByFail(result).error)).toBe(true);
    expect(failure.message).toBe("No candidate was approvable.");
    expect(failure.message).not.toBe(MISSING_RETURN);
    expect(everythingSaid(result)).not.toContain("produced no <Return> value");
  });

  it("FAIL3: does nothing beneath an unselected <If>, and the root returns", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        VALUE_ROOT,
        `<If condition={false}><Fail message=${JSON.stringify(SENTINEL)} /></If>`,
        "",
        '<Ran mark="after" />',
        "",
        '<Return value={"approved"} />',
        "",
      ].join("\n"),
    );

    expect(result.outcome).toEqual({ ok: true, value: "approved" });
    expect(result.ran).toEqual(["after"]);
    expect(everythingSaid(result)).not.toContain(SENTINEL);
    // An unselected branch imports nothing, so the component was never reached.
    expect(importedNames(result.events)).not.toContain("Fail");
  });

  it("FAIL4: names loop exhaustion after the loop reached its own max", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        VALUE_ROOT,
        '<Loop max={2}><Ran mark="attempt" /></Loop>',
        "",
        '<Fail message="No attempt produced an approvable candidate in 2 tries." />',
        "",
        '<Ran mark="after" />',
        "",
        '<Return value={"approved"} />',
        "",
      ].join("\n"),
    );

    // The loop finished normally; the failure is the sibling chosen after it.
    expect(result.ran).toEqual(["attempt", "attempt"]);
    expect(failureOf(result).message).toBe(
      "No attempt produced an approvable candidate in 2 tries.",
    );
    expect(result.ran).not.toContain("after");
    expect(everythingSaid(result)).not.toContain("produced no <Return> value");
  });

  it("FAIL5: is recovered by an authored <PrintErrors> in a text root, once", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        "<PrintErrors>",
        '<Fail message="This region was abandoned." />',
        "</PrintErrors>",
        "",
        '<Ran mark="after" />',
        "tail",
        "",
      ].join("\n"),
    );

    expect(result.outcome.ok).toBe(true);
    // Reported exactly once, as an ordinary function-component diagnostic.
    expect(result.observed.map((segment) => segment.message)).toEqual([
      "Function component Fail error: This region was abandoned.",
    ]);
    // Later siblings run, and the component contributed nothing but that one
    // printed error — the sentence appears exactly once in what the reader saw.
    expect(result.ran).toEqual(["after"]);
    expect(result.output).toContain("tail");
    expect(result.output.split("This region was abandoned.").length - 1).toBe(1);
  });

  it("FAIL6: is not recovered by <PrintErrors> in a value root", function* () {
    const dir = yield* useDir();
    const result = yield* run(
      dir,
      [
        VALUE_ROOT,
        "<PrintErrors>",
        '<Fail message="Nothing here is publishable." />',
        "</PrintErrors>",
        "",
        '<Return value={"late"} />',
        "",
      ].join("\n"),
    );

    const failure = failureOf(result);
    // `throw` is the mode a boundary does not replace, so the authored failure
    // is still what the root settled on — and the later <Return> never ran.
    expect(reaches(failure, offeredByFail(result).error)).toBe(true);
    expect(failure.message).toContain("Nothing here is publishable.");
    expect(everythingSaid(result)).not.toContain("produced no <Return> value");
  });
});

describe("Tier FAIL — invocations that never raise the authored message", () => {
  const refusals: readonly [string, string, string][] = [
    [
      "FAIL7a: paired content is refused without expanding it",
      [`<Fail message=${JSON.stringify(SENTINEL)}>`, '<Ran mark="child" />', "</Fail>", ""].join(
        "\n",
      ),
      '<Fail> is self-closing and has no content: write <Fail message="…" /> instead.',
    ],
    [
      "FAIL7b: an empty paired spelling is paired content too",
      `<Fail message=${JSON.stringify(SENTINEL)}></Fail>\n`,
      '<Fail> is self-closing and has no content: write <Fail message="…" /> instead.',
    ],
    [
      "FAIL7c: `as` is refused, because there is nothing to bind",
      `<Fail message=${JSON.stringify(SENTINEL)} as="stopped" />\n`,
      "<Fail> raises its message and binds nothing, so `as` is not accepted.",
    ],
    [
      "FAIL7d: a missing message is refused by the schema",
      "<Fail />\n",
      "must have required property 'message'",
    ],
    [
      "FAIL7e: an empty message is refused by the schema",
      '<Fail message="" />\n',
      "must NOT have fewer than 1 characters",
    ],
    [
      "FAIL7f: a non-string message is refused by the schema",
      "<Fail message={42} />\n",
      "must be string",
    ],
    [
      "FAIL7g: an unknown prop is refused by the closed schema",
      `<Fail message=${JSON.stringify(SENTINEL)} reason="why" />\n`,
      "must NOT have additional properties",
    ],
  ];

  for (const [title, source, expected] of refusals) {
    it(title, function* () {
      const dir = yield* useDir();
      const result = yield* run(dir, source);

      expect(failureOf(result).message).toContain(expected);
      // The refusal happened first: nothing anywhere carries the message a
      // valid invocation would have raised.
      expect(everythingSaid(result)).not.toContain(SENTINEL);
      // A refused paired invocation never expands its children.
      expect(result.ran).toEqual([]);
      expect(result.output).toBe("");
    });
  }
});

describe("Tier FAIL — position, durability and precedence", () => {
  it("FAIL8: positions the failure at the opening tag it was written on", function* () {
    const dir = yield* useDir();
    const lines = [
      "# Review",
      "",
      "some prose",
      "",
      '<Fail message="Stopped at line five." />',
      "",
    ];
    const source = lines.join("\n");
    const result = yield* run(dir, source);

    const failure = offeredByFail(result);
    expect(failure.name).toBe("Fail");
    expect(failure.error.message).toBe("Stopped at line five.");
    expect(failure.position).toEqual({
      path: join(dir, "doc.md"),
      offset: source.indexOf("<Fail"),
      line: 5,
      column: 1,
    });
  });

  it("FAIL9: journals no effect of its own, and a completed root replays", function* () {
    const dir = yield* useDir();
    const stream = new InMemoryStream();
    const source = [
      '<Ran mark="before" />',
      "",
      '<Fail message="Stop, and stay stopped." />',
      "",
    ].join("\n");

    const first = yield* run(dir, source, { stream });

    expect(failureOf(first).message).toBe("Stop, and stay stopped.");
    // Ordinary execution's own records, and nothing else: the root's import,
    // each authored component's import, and the root outcome.
    expect(first.events.map((event) => event.type)).toEqual(["yield", "yield", "yield", "close"]);
    expect(importedNames(first.events)).toEqual(["__root__", "Ran", "Fail"]);

    const second = yield* run(dir, source, { stream });

    // The retained outcome, restored without expanding the root again — the
    // tripwire before the failure would have recorded a second run.
    expect(failureOf(second).message).toBe("Stop, and stay stopped.");
    expect(second.ran).toEqual([]);
    expect(second.events.length).toBe(first.events.length);
  });

  it("FAIL10: a repository Fail.md is chosen ahead of core's", function* () {
    const dir = yield* useDir();
    const result = yield* run(dir, `<Fail message=${JSON.stringify(SENTINEL)} />\n`, {
      files: {
        "Fail.md": [
          "---",
          "props:",
          "  message:",
          "    type: string",
          "---",
          "noted: {props.message}",
          "",
        ].join("\n"),
      },
    });

    expect(result.outcome.ok).toBe(true);
    expect(result.output).toContain(`noted: ${SENTINEL}`);
    expect(result.offered).toEqual([]);
  });
});

/** The components a run imported, in the order it imported them. */
function importedNames(events: DurableEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "yield" && event.description.type === "import_component"
      ? [String(event.description.name)]
      : [],
  );
}
