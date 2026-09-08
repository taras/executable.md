/**
 * Tier FE31–FE33 — ordinary composition inside a generated fragment.
 *
 * A generated fragment is ordinary XMD. What that means concretely is what
 * these rows are about: a component written with `as` binds and renders
 * nothing, one written without `as` renders, and a fragment that wants its
 * caller to receive a structured value renders it explicitly through `<Json>`.
 * Nothing is collected on the fragment's behalf, so every one of these rows
 * fails against an implementation that still built a result envelope.
 *
 * The expression grammar is the other half. A generated fragment's props are
 * data over its own bindings, read by Acorn and interpreted — never compiled —
 * so each refusal row here is a form that would have *run* under the ordinary
 * trusted-document evaluator. Each of them proves the refusal happened in
 * whole-fragment preflight by showing the recorder performed nothing at all:
 * an implementation that refused the expression at the consuming component
 * would have let the read before it through.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";

import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import { fileDeleteEntry, fileReadEntry, fileWriteEntry } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import type { RecordedFiles } from "./support/fragment-files.ts";
import { answerProvider } from "./support/answer-provider.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";

const ROOT_PATH = "workflows/agent.md";
const NOTE = "the retained note\n";
const OTHER = "the other note\n";

function reading(files: RecordedFiles): ExecutionInstallation {
  return { evaluation: { read: [fileReadEntry()], files } };
}

function writing(files: RecordedFiles): ExecutionInstallation {
  return { evaluation: { read: [], write: [fileWriteEntry(), fileDeleteEntry()], files } };
}

function both(files: RecordedFiles): ExecutionInstallation {
  return {
    evaluation: {
      read: [fileReadEntry()],
      write: [fileWriteEntry(), fileDeleteEntry()],
      files,
    },
  };
}

function run(
  source: string,
  installations: readonly ExecutionInstallation[],
  stream: InMemoryStream = new InMemoryStream(),
): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled({ ...retainedSource(ROOT_PATH, source), stream }, [...installations]),
    );
  });
}

function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the operation to be refused");
}

/** One `<Evaluate>` over a fragment written as a JavaScript string literal. */
function evaluating(fragment: string, allow?: readonly string[]): string {
  const selection = allow === undefined ? "" : ` allow={${JSON.stringify([...allow])}}`;
  return `<Evaluate text={${JSON.stringify(fragment)}}${selection} />\n`;
}

describe("Tier FE31 — a fragment binds locally and renders what it chose", () => {
  it("FE31: bound File output is suppressed and reaches the caller only through Json", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(
      evaluating(`<File path="notes.md" as="note" />\n\n<Json value={{ note }} />\n`),
      [reading(files)],
    );

    const rendered = String(output);
    // The read ran, and its own output never appeared: what reached the caller
    // is the object the fragment explicitly built.
    expect(files.performed).toEqual(["read notes.md"]);
    expect(rendered).toContain('"note"');
    expect(JSON.parse(rendered.trim())).toEqual({ note: NOTE });
  });

  it("FE31: the same read without `as` renders itself and builds no object", function* () {
    // The negative control for the row above. An implementation that collected
    // results implicitly would produce the same object either way, so this is
    // what says the binding — and only the binding — suppressed the output.
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(evaluating(`<File path="notes.md" />\n`), [reading(files)]);

    const rendered = String(output);
    expect(files.performed).toEqual(["read notes.md"]);
    expect(rendered).toContain("the retained note");
    expect(rendered).not.toContain('"note"');
    expect(rendered).not.toContain("observations");
  });

  it("FE31: nested literals, arrays and shorthand compose without executing", function* () {
    const files = recordedFiles({ "notes.md": NOTE, "other.md": OTHER });
    const output = yield* run(
      evaluating(
        `<File path="notes.md" as="one" />\n\n` +
          `<File path="other.md" as="two" />\n\n` +
          `<Json value={{ one, both: [one, two], nested: { two, kept: [1, true, null, "x"] } }} />\n`,
      ),
      [reading(files)],
    );

    expect(JSON.parse(String(output).trim())).toEqual({
      one: NOTE,
      both: [NOTE, OTHER],
      nested: { two: OTHER, kept: [1, true, null, "x"] },
    });
  });

  it("FE31: `__proto__` stays an ordinary data key and changes no prototype", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(
      evaluating(`<File path="notes.md" as="note" />\n\n<Json value={{ __proto__: note }} />\n`),
      [reading(files)],
    );

    // Rendered as a member, which is what proves it was defined rather than
    // assigned: an assignment would have reached the inherited setter, left the
    // object empty, and rendered `{}`.
    const rendered = String(output).trim();
    expect(rendered).toContain("__proto__");
    const parsed: unknown = JSON.parse(rendered);
    expect(Object.hasOwn(Object(parsed), "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(Object(parsed))).toBe(Object.prototype);
  });

  /**
   * Every form the grammar refuses, written so it reaches the grammar.
   *
   * A brace holding only JSON is resolved by the scanner into an ordinary prop
   * before an expression exists, so `{-1}` alone is scanned data rather than a
   * generated expression. The rows that would otherwise be pure literals name a
   * binding as well, which is what puts them on the expression path this
   * grammar governs — the one an ordinary document would have compiled.
   */
  const EXECUTABLE: Array<[string, string]> = [
    ["a call", `<Json value={read()} />`],
    ["a method call", `<Json value={note.trim()} />`],
    ["member access", `<Json value={note.length} />`],
    ["a computed property", `<Json value={{ [note]: 1 }} />`],
    ["spread", `<Json value={{ ...note }} />`],
    ["a binary operator", `<Json value={note + "x"} />`],
    ["a unary operator", `<Json value={[note, !note]} />`],
    ["a typeof operator", `<Json value={[note, typeof note]} />`],
    ["a sign on a binding", `<Json value={-note} />`],
    ["a leading plus, which JSON has no grammar for", `<Json value={+1} />`],
    ["a minus separated from its number by a space", `<Json value={- 1} />`],
    ["a minus separated from its number by a comment", `<Json value={-/*gap*/1} />`],
    ["a minus separated from its number by a line break", `<Json value={-\n1} />`],
    ["a detached minus inside an array", `<Json value={[note, - 1]} />`],
    ["a leading plus in an expression", `<Json value={[note, +1]} />`],
    ["a conditional", `<Json value={note ? 1 : 2} />`],
    ["an assignment", `<Json value={(note = 1)} />`],
    ["an update expression", `<Json value={[note++]} />`],
    ["a template literal", "<Json value={`${note}`} />"],
    ["a function", `<Json value={() => note} />`],
    ["a class", `<Json value={class {}} />`],
    ["a global reference", `<Json value={globalThis} />`],
    ["a non-finite number in an expression", `<Json value={[note, 1e999]} />`],
    ["a directly scanned non-finite number", `<Json value={1e999} />`],
    ["a non-finite number in a scanned array", `<Json value={[1e999]} />`],
    ["a non-finite number in a scanned object", `<Json value={{"number": 1e999}} />`],
    ["a negative non-finite number", `<Json value={-1e999} />`],
    ["trailing syntax after a value", `<Json value={{ note }, read()} />`],
    ["a getter", `<Json value={{ get a() { return 1; } }} />`],
    ["a tagged template", "<Json value={String`x`} />"],
  ];

  for (const [what, element] of EXECUTABLE) {
    it(`FE31: ${what} refuses before the read written ahead of it`, function* () {
      const files = recordedFiles({ "notes.md": NOTE });
      // The read is written *first*, so a refusal that happened at `<Json>`
      // rather than in whole-fragment preflight would leave it in the recorder.
      yield* refusal(
        run(evaluating(`<File path="notes.md" as="note" />\n\n${element}\n`), [reading(files)]),
      );
      expect([what, files.performed]).toEqual([what, []]);
    });
  }

  it("FE31: a directly scanned finite number is the positive control for the non-finite rows", function* () {
    // `-1` is a JSON number rather than an operator, and the scanner resolves it
    // to an inert `-1` before an expression exists. Without this row, the
    // non-finite rows above could be refusing because a scanned numeric literal
    // never reaches `<Json>` at all.
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(evaluating(`<File path="notes.md" />\n\n<Json value={-1} />\n`), [
      reading(files),
    ]);

    expect(files.performed).toEqual(["read notes.md"]);
    expect(String(output)).toContain("-1");
  });

  it("FE31: a scanned finite number composes inside an array and an object", function* () {
    const files = recordedFiles();
    const output = yield* run(evaluating(`<Json value={{ kept: [-1, 0, 1.5], number: -2 }} />\n`), [
      reading(files),
    ]);

    expect(JSON.parse(String(output).trim())).toEqual({ kept: [-1, 0, 1.5], number: -2 });
  });

  it("FE31: an admitted read is the positive control for those refusals", function* () {
    // Every row above shares this fragment's first element. Without this, each
    // of them could be refusing because the fragment never ran at all.
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(
      evaluating(`<File path="notes.md" as="note" />\n\n<Json value={note} />\n`),
      [reading(files)],
    );

    expect(files.performed).toEqual(["read notes.md"]);
    expect(JSON.parse(String(output).trim())).toBe(NOTE);
  });

  it("FE31: a binding is unavailable before the element that produces it", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    yield* refusal(
      run(evaluating(`<Json value={note} />\n\n<File path="notes.md" as="note" />\n`), [
        reading(files),
      ]),
    );
    expect(files.performed).toEqual([]);
  });

  it("FE31: a binding made inside content does not leak to a later sibling", function* () {
    // The paired write's children bind in their own scope, exactly as ordinary
    // expansion's environments do. A preflight that pooled every `as` it met
    // would admit this and fail only after the write had already run.
    const files = recordedFiles({ "notes.md": NOTE });
    yield* refusal(
      run(
        evaluating(
          `<File path="out.md">\n<File path="notes.md" as="inner" />\n</File>\n\n` +
            `<Json value={inner} />\n`,
          ["read", "write"],
        ),
        [both(files)],
      ),
    );
    expect(files.performed).toEqual([]);
  });
});

describe("Tier FE31 — Json is composition, not an effect", () => {
  const SELECTIONS: Array<
    [string, readonly string[], (files: RecordedFiles) => ExecutionInstallation]
  > = [
    ["read-only", ["read"], reading],
    ["write-only", ["write"], writing],
    ["read and write", ["read", "write"], both],
  ];

  for (const [what, allow, profile] of SELECTIONS) {
    it(`FE31: exact core Json is available under a ${what} selection`, function* () {
      const files = recordedFiles({ "notes.md": NOTE });
      const output = yield* run(
        evaluating(`<Json value={{ kept: [1, "two", true] }} />\n`, allow),
        [profile(files)],
      );

      expect(JSON.parse(String(output).trim())).toEqual({ kept: [1, "two", true] });
      // Composition performs nothing: no capability was reached to render it.
      expect(files.performed).toEqual([]);
    });
  }

  it("FE31: Json grants no read authority under a write-only selection", function* () {
    // The negative control for the availability rows: having Json does not make
    // an unselected class reachable, and the refusal costs the write beside it.
    const files = recordedFiles({ "notes.md": NOTE });
    yield* refusal(
      run(
        evaluating(
          `<File path="out.md">written</File>\n\n<File path="notes.md" as="note" />\n\n` +
            `<Json value={note} />\n`,
          ["write"],
        ),
        [writing(files)],
      ),
    );
    expect(files.performed).toEqual([]);
  });

  it("FE31: Json grants no write authority under a read-only selection", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    yield* refusal(
      run(
        evaluating(`<File path="notes.md" as="note" />\n\n<File path="out.md">x</File>\n`, [
          "read",
        ]),
        [reading(files)],
      ),
    );
    expect(files.performed).toEqual([]);
  });

  it("FE31: a host cannot give an effect to a composition name", function* () {
    // Closed-world conflict detection, at profile capture rather than at
    // evaluation: the host never gets to shadow core's own pure component.
    const files = recordedFiles();
    const message = yield* refusal(
      run(evaluating(`<Json value={1} />\n`), [
        {
          evaluation: {
            read: [{ ...fileReadEntry(), name: "Json" }],
            files,
          },
        },
      ]),
    );
    expect(message).toContain("Json");
  });
});

/**
 * A component whose invocation registers teardown before it returns.
 *
 * The cleanup pushes to the same log the fragment and the document push to, so
 * the order of that one array is the whole claim: whether the projection's
 * structured teardown finished before the parent's next element began.
 */
function unwinding(log: string[]): FunctionComponentDefinition {
  return {
    kind: "function",
    name: "Held",
    props: { type: "object", properties: {}, additionalProperties: false },
    *fn() {
      // Registered before anything the invocation could fail at, so the cleanup
      // is established rather than merely queued behind a success.
      yield* ensure(function* () {
        log.push("fragment teardown");
      });
      log.push("fragment body");
      return "held";
    },
  };
}

/** A profile admitting that one component as a trusted component answer. */
function holding(definition: FunctionComponentDefinition): ExecutionInstallation {
  return {
    evaluation: {
      read: [
        {
          kind: "component-answer",
          name: "Held",
          identity: { origin: "test://provider", key: "Held", revision: "1" },
          forms: ["self-closing"],
        },
      ],
    },
    componentAnswers: [answerProvider("Held", definition)],
  };
}

/** Register a parent component that records when the document reaches it. */
function marking(log: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Mark",
      origin: "test://mark",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn() {
        log.push("parent after");
        return "";
      },
    },
  ]);
}

describe("Tier FE33 — the projection settles before its parent continues", () => {
  it("FE33: projected teardown completes before later parent work begins", function* () {
    const log: string[] = [];
    yield* scoped(function* () {
      yield* marking(log);
      yield* run(evaluating(`<Held />\n`) + `\n<Mark />\n`, [holding(unwinding(log))]);
    });

    // The whole claim is this order. An implementation that let the projection's
    // teardown drift past the element — detaching it, or unwinding it with the
    // document rather than with the invocation — would put "parent after"
    // second, and an implementation that never registered the cleanup at all
    // would omit the middle entry.
    expect(log).toEqual(["fragment body", "fragment teardown", "parent after"]);
  });

  it("FE33: the parent marker alone is the negative control for that order", function* () {
    // Without this, the row above could pass because the fragment never ran.
    const log: string[] = [];
    yield* scoped(function* () {
      yield* marking(log);
      yield* run(`<Mark />\n`, []);
    });
    expect(log).toEqual(["parent after"]);
  });
});

describe("Tier FE33 — occurrences do not share generated history", () => {
  it("FE33: two occurrences each perform their own read", function* () {
    const files = recordedFiles({ "one.md": "first\n", "two.md": "second\n" });
    const stream = new InMemoryStream();
    const output = yield* run(
      evaluating(`<File path="one.md" />\n`) + "\n" + evaluating(`<File path="two.md" />\n`),
      [reading(files)],
      stream,
    );

    // Neither consumed the other's history: both reads happened, in order, and
    // both texts reached the document.
    expect(files.performed).toEqual(["read one.md", "read two.md"]);
    expect(String(output)).toContain("first");
    expect(String(output)).toContain("second");

    const events = yield* stream.readAll();
    const admitted = events.filter(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    expect(admitted).toHaveLength(2);
  });
});
