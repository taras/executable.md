/**
 * Tier FE — canonical `<Evaluate>` against a host profile.
 *
 * `<Evaluate>` is public: any author may write it. What keeps that from being a
 * capability is that everything it can reach was stated by a trusted host at the
 * installation boundary, before a document existed — and that `allow` selects
 * among those tables rather than adding to them.
 *
 * The rows here drive the real component through a real execution against a real
 * captured profile. A stand-in for the profile would be a stand-in for the exact
 * thing being claimed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { scoped } from "effection";
import type { Operation } from "effection";

import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation, FragmentEntry } from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";

const ROOT_PATH = "evaluate.md";

/** A read entry a fragment may name, and the exact implementation it runs. */
function probeEntry(overrides: Partial<FragmentEntry> = {}): FragmentEntry {
  const definition: FunctionComponentDefinition = {
    kind: "function",
    name: "Probe",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      return "probed";
    },
  };
  return {
    name: "Probe",
    identity: { origin: "test://host", key: "Probe", revision: "1" },
    forms: ["self-closing"],
    props: definition.props,
    definition,
    ...overrides,
  };
}

/** A mutation entry, which contributes no observation. */
function markEntry(record: string[]): FragmentEntry {
  const definition: FunctionComponentDefinition = {
    kind: "function",
    name: "Mark",
    props: { type: "object", properties: {}, additionalProperties: false },
    // deno-lint-ignore require-yield
    *fn(): Operation<Json> {
      record.push("marked");
      return "";
    },
  };
  return {
    name: "Mark",
    identity: { origin: "test://host", key: "Mark", revision: "1" },
    forms: ["paired"],
    props: definition.props,
    definition,
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

/** What one execution refused with, as a string. */
function* refusal(operation: Operation<unknown>): Operation<string> {
  try {
    yield* operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the operation to be refused");
}

/** Every generated-XMD admission a run recorded. */
function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

/** The read-only profile every positive row here runs under. */
function readingProfile(): ExecutionInstallation {
  return { evaluation: { read: [probeEntry()] } };
}

describe("Tier FE — a program the document holds", () => {
  it("FE1: `text` runs, and its observations bind by name and order", function* () {
    const output = yield* run(
      `<Evaluate text={'<Probe />\\n\\n<Probe />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
      [readingProfile()],
    );

    const rendered = String(output);
    expect(rendered).toContain('"name": "Probe"');
    expect(rendered).toContain('"value": "probed"');
    // Two elements, two observations, in the order the fragment wrote them.
    expect(rendered.match(/"name": "Probe"/g)).toHaveLength(2);
  });

  it("FE1: an element with no program and no content is refused", function* () {
    expect(yield* refusal(run(`<Evaluate />\n`, [readingProfile()]))).toContain(
      "requires the program as a string",
    );
  });

  it("FE1: `text` beside content is refused rather than resolved by precedence", function* () {
    expect(
      yield* refusal(
        run(`<Evaluate text="<Probe />">\ncontent\n</Evaluate>\n`, [readingProfile()]),
      ),
    ).toContain("does not also carry `text`");
  });

  it("FE1: the released `source` spelling is refused where the host did not admit it", function* () {
    expect(yield* refusal(run(`<Evaluate source="<Probe />" />\n`, [readingProfile()]))).toContain(
      "this host did not admit it",
    );
  });

  it("FE1: a host that admitted the alias accepts it, silently", function* () {
    const output = yield* run(`<Evaluate source={'<Probe />\\n'} as="answer" />\n\nran\n`, [
      { evaluation: { read: [probeEntry()], deprecatedSourceAlias: true } },
    ]);

    expect(String(output)).toContain("ran");
    // Accepted without announcing anything about the spelling.
    expect(String(output)).not.toContain("earlier spelling");
  });
});

describe("Tier FE — the paired form produces its own program", () => {
  it("FE2: content renders once, and what it rendered is the program", function* () {
    const rendered: string[] = [];
    const output = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Producer",
          origin: "test://producer",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            rendered.push("produced");
            return `<Probe />\n`;
          },
        },
      ]);
      return yield* run(
        `<Evaluate as="answer">\n<Producer />\n</Evaluate>\n\n<Json value={answer} />\n`,
        [readingProfile()],
      );
    });

    // The producer ran exactly once, and the fragment it produced was admitted
    // and performed.
    expect(rendered).toEqual(["produced"]);
    expect(String(output)).toContain('"value": "probed"');
  });

  it("FE2: a producer that fails stops the evaluation before any fragment work", function* () {
    const stream = new InMemoryStream();
    const failed = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "Broken",
            origin: "test://producer",
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              throw new Error("the producer refused");
            },
          },
        ]);
        return yield* run(`<Evaluate>\n<Broken />\n</Evaluate>\n`, [readingProfile()], stream);
      }),
    );

    expect(failed).toContain("the producer refused");
    // Nothing was admitted: the program never existed to be decided about.
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
  });

  it("FE3: the producer is told the narrowed vocabulary, not the site's", function* () {
    // What `<Syntax />` said inside the producer, captured out of the content so
    // it does not become part of the program.
    const told: string[] = [];
    const output = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Peek",
          origin: "test://peek",
          props: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          // deno-lint-ignore require-yield
          *fn(props: Record<string, Json>): Operation<string> {
            told.push(String(props.text));
            return "";
          },
        },
        {
          name: "Program",
          origin: "test://producer",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return `<Probe />\n`;
          },
        },
      ]);
      return yield* run(
        `<Evaluate as="answer">\n<Syntax as="vocab" />\n\n<Peek text={vocab} />\n\n` +
          `<Program />\n</Evaluate>\n\n<Json value={answer} />\n`,
        [readingProfile()],
      );
    });

    expect(told).toHaveLength(1);
    const vocabulary = told[0] ?? "";
    // The admitted entry is described, because that is what a fragment may
    // write. Nothing else is: an agent told it had `<Loop>`, `<Evaluate>` or the
    // producer's own `<Program />` would write a fragment the evaluator refuses
    // whole, before its first effect.
    expect(vocabulary).toContain("Probe");
    expect(vocabulary).not.toContain("Loop");
    expect(vocabulary).not.toContain("Evaluate");
    expect(vocabulary).not.toContain("Program");
    // And the program it went on to produce was admitted and performed.
    expect(String(output)).toContain('"value": "probed"');
  });
});

describe("Tier FE — allow selects, and never adds", () => {
  it("FE4: omitting `allow` admits exactly the read table", function* () {
    const marks: string[] = [];
    const failed = yield* refusal(
      run(`<Evaluate text={'<Mark>x</Mark>\\n'} />\n`, [
        { evaluation: { read: [probeEntry()], write: [markEntry(marks)] } },
      ]),
    );

    expect(failed).toContain("did not admit");
    expect(marks).toEqual([]);
  });

  it("FE4: a class this host installed nothing for is refused before any program", function* () {
    const stream = new InMemoryStream();
    const failed = yield* refusal(
      run(`<Evaluate text={'<Probe />\\n'} allow={["write"]} />\n`, [readingProfile()], stream),
    );

    expect(failed).toContain("installed no write table");
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
  });

  it("FE4: an admitted write contributes nothing to the value", function* () {
    const marks: string[] = [];
    const output = yield* run(
      `<Evaluate text={'<Mark>x</Mark>\\n'} allow={["write"]} as="answer" />\n\n` +
        `<Json value={answer} />\n`,
      [{ evaluation: { read: [probeEntry()], write: [markEntry(marks)] } }],
    );

    expect(marks).toEqual(["marked"]);
    expect(String(output)).toContain('"observations": []');
  });

  it("FE4: a selection this component does not have is refused", function* () {
    expect(
      yield* refusal(run(`<Evaluate text="<Probe />" allow={["exec"]} />\n`, [readingProfile()])),
    ).toMatch(/allow|enum/i);
  });
});

describe("Tier FE — an execution with no ceiling has no evaluation", () => {
  it("FE5: a host that stated no profile refuses at the element, not at startup", function* () {
    // The execution itself is fine: a document that never writes `<Evaluate>`
    // is not asking for a ceiling, and this one runs to completion.
    expect(String(yield* run(`nothing asked for\n`, []))).toContain("nothing asked for");

    expect(yield* refusal(run(`<Evaluate text="<Probe />" />\n`, []))).toContain(
      "this host stated none",
    );
  });

  it("FE5: two installations stating a profile is refused before anything installs", function* () {
    expect(
      yield* refusal(run(`nothing asked for\n`, [readingProfile(), readingProfile()])),
    ).toContain("one maximum authority");
  });
});
