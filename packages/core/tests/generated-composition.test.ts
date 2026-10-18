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
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { ensure, scoped } from "effection";
import type { Operation } from "effection";

import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import { useSelection } from "./support/generated-selection.ts";
import type { ExecutionInstallation } from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles, useRecordedFiles } from "./support/fragment-files.ts";
import type { RecordedFiles } from "./support/fragment-files.ts";
import { answerProvider } from "./support/answer-provider.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";

const ROOT_PATH = "workflows/agent.md";
const NOTE = "the retained note\n";
const OTHER = "the other note\n";

function reading(files: RecordedFiles): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection({ File: ["self-closing"] });
      yield* useRecordedFiles(files);
    },
  };
}

/**
 * A selection whose spellings all write.
 *
 * Which class a spelling reaches is the owner's answer rather than the
 * selection's, so "no read table" is now exactly "no spelling whose owner
 * offers it as a read": `<File>` paired and `<File.Delete />` are both writes
 * by their own declarations.
 */
function writing(files: RecordedFiles): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection({ File: ["paired"], "File.Delete": ["self-closing"] });
      yield* useRecordedFiles(files);
    },
  };
}

function both(files: RecordedFiles): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection({
        File: ["self-closing", "paired"],
        "File.Delete": ["self-closing"],
      });
      yield* useRecordedFiles(files);
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

  it("FE31: Json grants no read permission under a write-only selection", function* () {
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

  it("FE31: Json grants no write permission under a read-only selection", function* () {
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
    // Closed-world conflict detection, at capture rather than at evaluation:
    // the host never gets to shadow core's own pure component.
    const files = recordedFiles();
    const message = yield* refusal(
      run(evaluating(`<Json value={1} />\n`), [
        {
          *install(): Operation<void> {
            yield* useSelection({ Json: ["self-closing"] });
            yield* useRecordedFiles(files);
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
 * the order of that one array is the whole ordering check: whether the
 * projection's structured teardown finished before the parent's next element
 * began.
 */
function unwinding(log: string[]): FunctionComponentDefinition {
  return {
    kind: "function",
    name: "Held",
    props: { type: "object", properties: {}, additionalProperties: false },
    forms: ["self-closing"],
    generated: {
      "self-closing": { identity: "https://executable.md/components/held/read", effect: "read" },
    },
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

/** A selection offering that one name, which a provider answers for. */
function holding(definition: FunctionComponentDefinition): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection({ Held: ["self-closing"] });
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

/**
 * Tier FE31 — Yaml is composition beside Json, and an old grant stays old.
 *
 * Adding a pure component widens what *new* source may write and must widen no
 * grant anybody already holds. Core's always-on table is a fact about the
 * build rather than about the policy a host stated, so a record written before
 * a pure component existed holds no row for it — and that record is what its
 * own continuation is held to.
 */
describe("Tier FE31 — Yaml is composition, and a retained grant is historical", () => {
  it("FE31: exact core Yaml renders under a read-only selection", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(
      evaluating(`<Yaml value={{ kept: [1, "two", true] }} />\n`, ["read"]),
      [reading(files)],
    );

    expect(String(output)).toContain("kept:");
    expect(String(output)).toContain("- two");
    // Composition performs nothing: no capability was reached to render it.
    expect(files.performed).toEqual([]);
  });

  it("FE31: the admission retains Yaml's own identity", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    yield* run(evaluating(`<Yaml value={{ a: 1 }} />\n`, ["read"]), [reading(files)], stream);

    const rows = admittedRows(stream);
    // Its own URL, not Json's: an admission that reused one would say a
    // fragment had been granted the other component.
    expect(rows.find((row) => row.name === "Yaml")?.identity).toBe(
      "https://executable.md/components/yaml",
    );
    expect(rows.find((row) => row.name === "Json")?.identity).toBe(
      "https://executable.md/components/json",
    );
    expect(rows.filter((row) => row.effect === "composition").map((row) => row.name)).toEqual([
      "Json",
      "Yaml",
    ]);
  });

  it("FE31: a Json-only admission reopens without gaining Yaml", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const fragment = `<Json value={{ a: 1 }} />\n`;
    const live = new InMemoryStream();
    yield* run(evaluating(fragment, ["read"]), [reading(files)], live);

    // The same history with Yaml's composition row removed, which is exactly
    // what a record written before Yaml existed holds.
    const retained = new InMemoryStream(withoutYaml(live.snapshot()));
    const again = yield* run(
      evaluating(fragment, ["read"]),
      [recordedFiles({ "notes.md": NOTE })].map((held) => reading(held)),
      retained,
    );

    // Readable, and continued: the continuation is compared against the rows
    // its own admission recorded rather than against today's table, so it is
    // neither refused for a row it never named nor widened to include one.
    expect(JSON.parse(String(again).trim())).toEqual({ a: 1 });
  });

  it("FE31: reopening a Json-only admission adds no Yaml row to it", function* () {
    const fragment = `<Json value={{ a: 1 }} />\n`;
    const live = new InMemoryStream();
    yield* run(
      evaluating(fragment, ["read"]),
      [reading(recordedFiles({ "notes.md": NOTE }))],
      live,
    );

    const historical = withoutYaml(live.snapshot());
    const retained = new InMemoryStream(historical);
    yield* run(
      evaluating(fragment, ["read"]),
      [reading(recordedFiles({ "notes.md": NOTE }))],
      retained,
    );

    // The grant this continuation ran under is the one its own record holds:
    // still Json alone, and still one admission. A route that reconciled
    // against today's table would have had to either refuse this history or
    // write Yaml into it.
    expect(admittedRows(retained).filter((row) => row.effect === "composition")).toEqual([
      { name: "Json", identity: "https://executable.md/components/json", effect: "composition" },
    ]);
    const admissions = retained
      .snapshot()
      .filter((event) => event.type === "yield" && event.description.type === "generated_xmd");
    expect(admissions.length).toBe(1);
  });

  it("FE31: a repository cannot offer its own Yaml for the admitted name", function* () {
    // The replacement row. What a fragment is admitted to write is core's own
    // pure definition, and `Yaml` is a name a repository may not take over:
    // the conflict is detected at capture, so the host's offering never
    // becomes the definition an admission then records.
    const files = recordedFiles();
    const message = yield* refusal(
      run(evaluating(`<Yaml value={1} />\n`), [
        {
          *install(): Operation<void> {
            yield* useSelection({ Yaml: ["self-closing"] });
            yield* useRecordedFiles(files);
          },
        },
      ]),
    );

    expect(message).toContain("Yaml");
    expect(files.performed).toEqual([]);
  });

  it("FE31: an answered replacement never renders, and never runs", function* () {
    // The same refusal where the replacement is a provider's answer rather
    // than a selection row — a definition that would have rendered something
    // else entirely. Its body is the evidence: a route that preferred the
    // answer would have run it before anybody could read the output.
    const ran: string[] = [];
    const replacement: FunctionComponentDefinition = {
      kind: "function",
      name: "Yaml",
      props: { type: "object", properties: {}, additionalProperties: true },
      forms: ["self-closing"],
      // A repository declares "read" or "write" and nothing else: composition is
      // core's own classification, so the strongest claim a replacement can
      // make for this name is an effect — which is the claim refused here.
      generated: {
        "self-closing": { identity: "https://executable.md/components/yaml", effect: "read" },
      },
      // deno-lint-ignore require-yield
      *fn(): Operation<unknown> {
        ran.push("replacement");
        return "replaced:\n";
      },
    };

    const message = yield* refusal(
      run(evaluating(`<Yaml value={{ a: 1 }} />\n`, ["read"]), [
        {
          *install(): Operation<void> {
            yield* useSelection({ Yaml: ["self-closing"] });
          },
          componentAnswers: [answerProvider("Yaml", replacement)],
        },
      ]),
    );

    // Refused as the conflict it is — one admitted name cannot stand for two
    // definitions — and refused before the answer could render anything.
    expect(message).toContain("two definitions");
    expect(ran).toEqual([]);
  });
});

/** The admitted rows one retained admission holds. */
function admittedRows(
  stream: InMemoryStream,
): { name: string; identity: string; effect: string }[] {
  for (const event of stream.snapshot()) {
    if (event.type !== "yield" || event.description.type !== "generated_xmd") {
      continue;
    }
    const result = event.result;
    if (result.status !== "ok") {
      continue;
    }
    const value = result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const policy = (value as { policy?: unknown }).policy;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      continue;
    }
    const allowed = (policy as { allowed?: unknown }).allowed;
    if (!Array.isArray(allowed)) {
      continue;
    }
    return allowed.map((row) => ({
      name: String((row as { name?: unknown }).name),
      identity: String((row as { identity?: unknown }).identity),
      effect: String((row as { effect?: unknown }).effect),
    }));
  }
  throw new Error("this history retained no generated admission");
}

/**
 * The same events with Yaml's composition row removed from the admission.
 *
 * Read back out of JSON rather than edited in place, so what the continuation
 * is given is ordinary journal data of exactly the shape an older build wrote.
 */
function withoutYaml(events: readonly DurableEvent[]): DurableEvent[] {
  return events.map((event) => {
    if (event.type !== "yield" || event.description.type !== "generated_xmd") {
      return event;
    }
    if (event.result.status !== "ok") {
      return event;
    }
    const held: Json = JSON.parse(JSON.stringify(event.result.value ?? null));
    if (held === null || typeof held !== "object" || Array.isArray(held)) {
      return event;
    }
    const policy = held.policy;
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      return event;
    }
    const allowed = policy.allowed;
    if (!Array.isArray(allowed)) {
      return event;
    }
    const kept = allowed.filter(
      (row) => row === null || typeof row !== "object" || Array.isArray(row) || row.name !== "Yaml",
    );
    const value: Json = { ...held, policy: { ...policy, allowed: kept } };
    return { ...event, result: { status: "ok", value } };
  });
}
