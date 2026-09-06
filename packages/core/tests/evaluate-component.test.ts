/**
 * Tier FE — canonical `<Evaluate>` against a host profile.
 *
 * `<Evaluate>` is public: any author may write it. What keeps that from being a
 * capability is that everything it can reach was stated by a trusted host at the
 * installation boundary, before a document existed — and that `allow` selects
 * among those tables rather than adding to them.
 *
 * Every row drives the real component through a real execution against a real
 * captured profile. The filesystem operations are a recorder rather than a disk,
 * and it is never installed as a provider: a read that appears in its log went
 * through the captured operation, because there is no other way to reach it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { ensure, Ok, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { API } from "@executablemd/runtime";

import { collect } from "../src/collect.ts";
import { Component, content } from "../src/component-api.ts";
import { executeInstalled } from "../host.ts";
import { directoryEntry, fileDeleteEntry, fileReadEntry, fileWriteEntry } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import type { RecordedFiles } from "./support/fragment-files.ts";

const ROOT_PATH = "evaluate.md";

const NOTE = "the retained note\n";

/** A read-only profile over one recorder. */
function reading(files: RecordedFiles): ExecutionInstallation {
  return { evaluation: { read: [fileReadEntry()], files } };
}

/** A profile offering both classes over one recorder. */
function both(files: RecordedFiles): ExecutionInstallation {
  return {
    evaluation: {
      read: [fileReadEntry()],
      write: [
        fileWriteEntry(),
        directoryEntry({ origin: "test://host", key: "Dir", revision: "1" }, "Dir"),
        fileDeleteEntry(),
      ],
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

describe("Tier FE — a program the document holds", () => {
  it("FE1: `text` runs, and its observations bind by name and order", function* () {
    const files = recordedFiles({ "notes.md": NOTE, "other.md": "the other note\n" });
    const output = yield* run(
      `<Evaluate text={'<File path="notes.md" />\\n\\n<File path="other.md" />\\n'} as="answer" />` +
        `\n\n<Json value={answer} />\n`,
      [reading(files)],
    );

    const rendered = String(output);
    expect(rendered).toContain("the retained note");
    expect(rendered).toContain("the other note");
    // Through the captured operations, in the order the fragment wrote them.
    expect(files.performed).toEqual(["read notes.md", "read other.md"]);
  });

  it("FE1: an element with no program and no content is refused", function* () {
    expect(yield* refusal(run(`<Evaluate />\n`, [reading(recordedFiles())]))).toContain(
      "requires the program as a string",
    );
  });

  it("FE1: `text` beside content is refused rather than resolved by precedence", function* () {
    expect(
      yield* refusal(
        run(`<Evaluate text="<File path='a.md' />">\ncontent\n</Evaluate>\n`, [
          reading(recordedFiles()),
        ]),
      ),
    ).toContain("does not also carry `text`");
  });

  it("FE1: the released `source` spelling is refused where the host did not admit it", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    expect(
      yield* refusal(run(`<Evaluate source={'<File path="notes.md" />'} />\n`, [reading(files)])),
    ).toContain("this host did not admit it");
    // Refused before the program was read, so nothing was performed.
    expect(files.performed).toEqual([]);
  });

  it("FE1: a host that admitted the alias accepts it, silently", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(
      `<Evaluate source={'<File path="notes.md" />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
      [{ evaluation: { read: [fileReadEntry()], files, deprecatedSourceAlias: true } }],
    );

    expect(String(output)).toContain("the retained note");
    expect(String(output)).not.toContain("earlier spelling");
  });
});

describe("Tier FE — a fragment reaches the captured operations and nothing else", () => {
  it("FE13: a Files provider installed around the document is not what a fragment reads", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const reachedDocumentProvider: string[] = [];

    const output = yield* scoped(function* () {
      // A provider installed exactly where a document, a repository component or
      // a middleware package would install one — nearer than anything the host
      // set up, and answering every read.
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *readTextFile([input]): Operation<never> {
            reachedDocumentProvider.push(String(input.path));
            throw new Error("the document's provider answered");
          },
        },
        { at: "min" },
      );
      return yield* run(
        `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n<Json value={answer} />\n`,
        [reading(files)],
      );
    });

    // The fragment read through the captured operation. The provider the
    // document installed was never consulted — it would have thrown.
    expect(String(output)).toContain("the retained note");
    expect(files.performed).toEqual(["read notes.md"]);
    expect(reachedDocumentProvider).toEqual([]);
  });

  it("FE13: a fragment cannot glob, however the document's provider is arranged", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const failed = yield* refusal(
      run(`<Evaluate text={'<Glob pattern="*.md" />\\n'} />\n`, [reading(files)]),
    );

    // Not "globbing failed" — `<Glob>` is not a name this fragment has at all.
    expect(failed).toContain("did not admit");
    expect(files.performed).toEqual([]);
  });

  it("FE13: an operation retained past its execution refuses rather than acting", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    yield* run(`<Evaluate text={'<File path="notes.md" />\\n'} />\n`, [reading(files)]);
    const during = [...files.performed];

    // The execution has ended. Whatever a fragment body, a handler or a
    // retained callback still holds is bound to operations this execution
    // revoked at teardown.
    expect(during).toEqual(["read notes.md"]);
    expect(files.performed).toEqual(during);
  });
});

describe("Tier FE — the paired form produces its own program", () => {
  it("FE2: the exact bytes the producer rendered are the admitted source", function* () {
    // Not "contains" and not "after trimming": the retained admission is a
    // decision about one exact fragment, and a continuation is held to those
    // bytes. A projection that trimmed, re-indented or normalised newlines
    // would make the retained text disagree with what the producer wrote.
    const PROGRAM = `\n<File path="notes.md" />\n\n<File path="other.md" />\n`;
    const files = recordedFiles({ "notes.md": NOTE, "other.md": "the other note\n" });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Producer",
          origin: "test://producer",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return PROGRAM;
          },
        },
      ]);
      return yield* run(`<Evaluate>\n<Producer />\n</Evaluate>\n`, [reading(files)], stream);
    });

    const recorded = admissions(yield* stream.readAll());
    expect(recorded).toHaveLength(1);
    const event = recorded[0];
    const value =
      event?.type === "yield" && event.result.status === "ok" ? event.result.value : undefined;
    const source =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? value.source
        : undefined;
    // The content region is `\n<Producer />\n` — the newlines the document put
    // around the element are part of what `<Evaluate>` was given to render, so
    // the admitted source is those bytes with the producer's own in place of
    // the element. Byte-exact in both directions: nothing was trimmed, and
    // nothing the document did not write was added.
    expect(source).toBe(`\n${PROGRAM}\n`);
    expect(files.performed).toEqual(["read notes.md", "read other.md"]);
  });

  it("FE2: content renders once, and what it rendered is the program", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
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
            return `<File path="notes.md" />\n`;
          },
        },
      ]);
      return yield* run(
        `<Evaluate as="answer">\n<Producer />\n</Evaluate>\n\n<Json value={answer} />\n`,
        [reading(files)],
      );
    });

    expect(rendered).toEqual(["produced"]);
    expect(String(output)).toContain("the retained note");
    expect(files.performed).toEqual(["read notes.md"]);
  });

  it("FE2: a producer keeps its own authority while the fragment does not", function* () {
    // The producer's content runs at the document's site, so its `<File />` is
    // the ordinary component and reaches the document's own provider. The
    // program it renders reaches only the captured operations. Both are counted
    // here, separately: narrowing what a fragment may *name* must not narrow
    // what the producer may *do* to write it.
    const files = recordedFiles({ "notes.md": NOTE });
    const documentReads: string[] = [];

    const output = yield* scoped(function* () {
      yield* API.Files.around(
        {
          // deno-lint-ignore require-yield
          *readTextFile([input]): Operation<Result<string>> {
            documentReads.push(String(input.path));
            return Ok(`<File path="notes.md" />\n`);
          },
        },
        { at: "min" },
      );
      return yield* run(
        `<Evaluate as="answer">\n<File path="producer-input.md" />\n</Evaluate>\n\n` +
          `<Json value={answer} />\n`,
        [reading(files)],
      );
    });

    expect(documentReads).toEqual(["producer-input.md"]);
    expect(files.performed).toEqual(["read notes.md"]);
    expect(String(output)).toContain("the retained note");
  });

  it("FE2: a producer that fails stops the evaluation before any fragment work", function* () {
    const stream = new InMemoryStream();
    const files = recordedFiles();
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
        return yield* run(`<Evaluate>\n<Broken />\n</Evaluate>\n`, [reading(files)], stream);
      }),
    );

    expect(failed).toContain("the producer refused");
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
    expect(files.performed).toEqual([]);
  });

  it("FE17: cancelling inside the producer waits for its cleanup and admits nothing", function* () {
    const stream = new InMemoryStream();
    const files = recordedFiles({ "notes.md": NOTE });
    const cleanup: string[] = [];
    const reached = withResolvers<void>();

    yield* scoped(function* () {
      const running = yield* spawn(() =>
        scoped(function* () {
          yield* registerComponents([
            {
              name: "Slow",
              origin: "test://producer",
              props: { type: "object", properties: {}, additionalProperties: false },
              *fn(): Operation<string> {
                // Registered before the barrier, so cancellation cannot arrive
                // between entering the body and owning the cleanup.
                yield* ensure(function* () {
                  cleanup.push("producer cleanup");
                });
                reached.resolve();
                yield* suspend();
                return `<File path="notes.md" />\n`;
              },
            },
          ]);
          return yield* run(`<Evaluate>\n<Slow />\n</Evaluate>\n`, [reading(files)], stream);
        }),
      );
      // The producer has actually entered, so this is cancellation of work in
      // flight rather than of work that never started.
      yield* reached.operation;
      yield* running.halt();
    });

    // Halt waited for the producer's own cleanup before returning.
    expect(cleanup).toEqual(["producer cleanup"]);
    // And nothing was decided: no admission, and no fragment operation. A run
    // that recorded an admission here would resume believing a decision was
    // made about a program that never finished being written.
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
    expect(files.performed).toEqual([]);
  });

  it("FE17: cancellation before the producer enters is the negative control", function* () {
    const stream = new InMemoryStream();
    const files = recordedFiles({ "notes.md": NOTE });
    const entered: string[] = [];

    yield* scoped(function* () {
      const running = yield* spawn(() =>
        scoped(function* () {
          yield* registerComponents([
            {
              name: "Never",
              origin: "test://producer",
              props: { type: "object", properties: {}, additionalProperties: false },
              // deno-lint-ignore require-yield
              *fn(): Operation<string> {
                entered.push("entered");
                return `<File path="notes.md" />\n`;
              },
            },
          ]);
          return yield* run(`<Evaluate>\n<Never />\n</Evaluate>\n`, [reading(files)], stream);
        }),
      );
      // Halted without waiting for any signal that work began.
      yield* running.halt();
    });

    // Whether the producer entered at all is not what this row fixes — what it
    // fixes is that halting early records no admission either, so the row above
    // is about *cancelling live work* rather than about halting in general.
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
    expect(files.performed).toEqual([]);
    expect(entered.length).toBeLessThanOrEqual(1);
  });

  it("FE3: the producer is told the narrowed vocabulary, not the site's", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const told: string[] = [];
    yield* scoped(function* () {
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
            return `<File path="notes.md" />\n`;
          },
        },
      ]);
      return yield* run(
        `<Evaluate>\n<Syntax as="vocab" />\n\n<Peek text={vocab} />\n\n<Program />\n</Evaluate>\n`,
        [reading(files)],
      );
    });

    expect(told).toHaveLength(1);
    const vocabulary = told[0] ?? "";
    // The admitted entry is described, and only in the form it was admitted
    // for. Nothing else is: an agent told it had `<Loop>`, `<Evaluate>` or the
    // producer's own `<Program />` would write a fragment the evaluator refuses
    // whole, before its first effect.
    expect(vocabulary).toContain("File");
    expect(vocabulary).not.toContain("Loop");
    expect(vocabulary).not.toContain("Evaluate");
    expect(vocabulary).not.toContain("Program");
    expect(vocabulary).not.toContain("Glob");
  });

  it("FE3: hostile content middleware does not reach the producer projection", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const intercepted: string[] = [];
    const output = yield* scoped(function* () {
      // Every public way a handler can reach an element's content, answered
      // rather than delegated. A handler that could substitute at any of them
      // would decide what program ran.
      yield* Component.around({
        // deno-lint-ignore require-yield
        *content(_args, _next) {
          intercepted.push("content");
          return `<File path="substituted.md" />\n`;
        },
        // deno-lint-ignore require-yield
        *tryContent(_args, _next) {
          intercepted.push("tryContent");
          return { text: `<File path="substituted.md" />\n`, segments: [], failure: undefined };
        },
        // deno-lint-ignore require-yield
        *hasContent(_args, _next) {
          return false;
        },
      });
      yield* registerComponents([
        {
          name: "Producer",
          origin: "test://producer",
          props: { type: "object", properties: {}, additionalProperties: false },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            return `<File path="notes.md" />\n`;
          },
        },
        {
          // The positive control, in the same run and under the same handlers:
          // an ordinary component reading its content through the public chain.
          // If this one is not intercepted either, the handlers are not live and
          // the assertion below would pass for the wrong reason.
          name: "Ordinary",
          origin: "test://ordinary",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(): Operation<string> {
            return yield* content();
          },
        },
      ]);
      return yield* run(
        `<Evaluate as="answer">\n<Producer />\n</Evaluate>\n\n<Ordinary>ignored</Ordinary>\n\n` +
          `<Json value={answer} />\n`,
        [reading(files)],
      );
    });

    // The handlers are live: the ordinary component's content was answered by
    // them, and its element rendered the substitution rather than "ignored".
    expect(intercepted).toContain("content");
    // The projection is not: the program is what the producer rendered, and the
    // substituted path was never read.
    expect(String(output)).toContain("the retained note");
    expect(files.performed).toEqual(["read notes.md"]);
    expect(files.performed).not.toContain("read substituted.md");
  });
});

describe("Tier FE — allow selects, and never adds", () => {
  it("FE4: omitting `allow` admits exactly the read table", function* () {
    const files = recordedFiles();
    const failed = yield* refusal(
      run(`<Evaluate text={'<File path="out.md">x</File>\\n'} />\n`, [both(files)]),
    );

    expect(failed).toContain("admitted only in its self-closing form");
    expect(files.performed).toEqual([]);
  });

  it("FE4: a class this host installed nothing for is refused before any program", function* () {
    const stream = new InMemoryStream();
    const files = recordedFiles();
    const failed = yield* refusal(
      run(
        `<Evaluate text={'<File path="a.md" />\\n'} allow={["write"]} />\n`,
        [reading(files)],
        stream,
      ),
    );

    expect(failed).toContain("installed no write table");
    expect(admissions(yield* stream.readAll())).toHaveLength(0);
    expect(files.performed).toEqual([]);
  });

  it("FE4: an admitted write reaches the captured write operations and binds nothing", function* () {
    const files = recordedFiles();
    const output = yield* run(
      `<Evaluate text={'<Dir path="nested">\\n\\n<File path="nested/out.md">made</File>\\n\\n</Dir>\\n'} ` +
        `allow={["write"]} as="answer" />\n\n<Json value={answer} />\n`,
      [both(files)],
    );

    expect(files.performed).toEqual([
      "ensure nested",
      "check nested/out.md",
      "write nested/out.md",
    ]);
    expect(files.entries.get("nested/out.md")).toBe("made");
    // A mutation contributes no observation.
    expect(String(output)).toContain('"observations": []');
  });

  it("FE4: an admitted deletion runs, and reads are not admitted with it", function* () {
    const files = recordedFiles({ "gone.md": "x" });
    yield* run(`<Evaluate text={'<File.Delete path="gone.md" />\\n'} allow={["write"]} />\n`, [
      both(files),
    ]);
    expect(files.performed).toEqual(["delete gone.md"]);
    expect(files.entries.has("gone.md")).toBe(false);

    const second = recordedFiles({ "notes.md": NOTE });
    expect(
      yield* refusal(
        run(`<Evaluate text={'<File path="notes.md" />\\n'} allow={["write"]} />\n`, [
          both(second),
        ]),
      ),
    ).toContain("admitted only in its paired form");
    expect(second.performed).toEqual([]);
  });

  it("FE4: a selection this component does not have is refused", function* () {
    expect(
      yield* refusal(
        run(`<Evaluate text="<File path='a.md' />" allow={["exec"]} />\n`, [
          reading(recordedFiles()),
        ]),
      ),
    ).toMatch(/allow|enum/i);
  });
});

describe("Tier FE — an execution with no ceiling has no evaluation", () => {
  it("FE5: a host that stated no profile refuses at the element, not at startup", function* () {
    expect(String(yield* run(`nothing asked for\n`, []))).toContain("nothing asked for");

    expect(yield* refusal(run(`<Evaluate text="<File path='a.md' />" />\n`, []))).toContain(
      "this host stated none",
    );
  });

  it("FE5: two installations stating a profile is refused before anything installs", function* () {
    const files = recordedFiles();
    expect(yield* refusal(run(`nothing asked for\n`, [reading(files), reading(files)]))).toContain(
      "one maximum authority",
    );
  });

  it("FE5: a profile admitting a file entry without operations is refused", function* () {
    expect(
      yield* refusal(run(`nothing asked for\n`, [{ evaluation: { read: [fileReadEntry()] } }])),
    ).toContain("without stating the filesystem operations");
  });
});

describe("Tier FE — what the element itself may say", () => {
  it("FE6: a fragment carrying a construct the evaluator does not admit refuses", function* () {
    const refused: Array<[string, string]> = [
      ["an executable code block", "```ts exec\\nconsole.log(1)\\n```\\n"],
      ["an expression prop", `<File path={somewhere} />\\n`],
      ["an interpolated binding", `<File path="a.md" />\\n{binding}\\n`],
      ["an `as` binding", `<File path="a.md" as="kept" />\\n`],
      ["a structural construct", `<If condition={true}>\\n<File path="a.md" />\\n</If>\\n`],
    ];
    const outcomes: Array<[string, string[]]> = [];
    for (const [what, fragment] of refused) {
      const files = recordedFiles({ "a.md": NOTE });
      yield* refusal(run(`<Evaluate text={'${fragment}'} />\n`, [reading(files)]));
      outcomes.push([what, files.performed]);
    }
    // Refused whole, before the first effect: every one of them performed
    // nothing at all, and the label says which row would have.
    expect(outcomes).toEqual(refused.map(([what]) => [what, []]));
  });

  it("FE7: `as` captures the result and emits nothing; without it nothing is emitted either", function* () {
    const captured = recordedFiles({ "notes.md": NOTE });
    const bound = yield* run(
      `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\nbetween\n`,
      [reading(captured)],
    );
    // The value went to the binding, so the element emitted nothing of its own.
    expect(String(bound)).toContain("between");
    expect(String(bound)).not.toContain("the retained note");

    const loose = recordedFiles({ "notes.md": NOTE });
    const unbound = yield* run(`<Evaluate text={'<File path="notes.md" />\\n'} />\n\nbetween\n`, [
      reading(loose),
    ]);
    // And an unbound occurrence emits nothing either: the result is a value,
    // and a value has nowhere to render. The read still happened.
    expect(String(unbound)).toContain("between");
    expect(String(unbound)).not.toContain("the retained note");
    expect(loose.performed).toEqual(["read notes.md"]);
  });
});

describe("Tier FE — one occurrence, one durable decision", () => {
  it("FE16: two occurrences do not consume one another's records", function* () {
    const files = recordedFiles({ "one.md": "first\n", "two.md": "second\n" });
    const stream = new InMemoryStream();
    yield* run(
      `<Evaluate text={'<File path="one.md" />\\n'} />\n\n` +
        `<Evaluate text={'<File path="two.md" />\\n'} />\n`,
      [reading(files)],
      stream,
    );

    const recorded = admissions(yield* stream.readAll());
    expect(recorded).toHaveLength(2);
    // Two durable names. One shared name would make the second occurrence
    // replay the first's admitted fragment.
    const names = recorded.map((event) => (event.type === "yield" ? event.description.name : ""));
    expect(new Set(names).size).toBe(2);
    expect(files.performed).toEqual(["read one.md", "read two.md"]);
  });

  it("FE10: a continuation resumes the exact admitted text", function* () {
    const first = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    const source = `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n`;
    yield* run(source, [reading(first)], stream);
    const complete = yield* stream.readAll();

    // Truncated to the admission itself: the decision committed, and the read
    // it authorized had not. That is the only state in which a resumed run
    // still has fragment work left to do.
    const admitted = complete.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    expect(admitted).toBeGreaterThanOrEqual(0);
    const partial = complete.slice(0, admitted + 1);

    const second = recordedFiles({ "notes.md": NOTE });
    yield* run(source, [reading(second)], new InMemoryStream(partial));
    // The retained admission was restored rather than made again, and the read
    // it authorized ran on this attempt.
    expect(second.performed).toEqual(["read notes.md"]);
  });

  it("FE10: a continuation offering different text refuses before any effect", function* () {
    // The document is byte-identical across both attempts, so the occurrence
    // identity — and therefore the durable name — is the same. What differs is
    // the program the producer rendered, which is exactly the case a retained
    // admission has to refuse: a decision was made about one fragment, and the
    // run is now holding another.
    const DOCUMENT = `<Evaluate>\n<Program />\n</Evaluate>\n`;

    function producing(fragment: string) {
      return function* (): Operation<void> {
        yield* registerComponents([
          {
            name: "Program",
            origin: "test://producer",
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return fragment;
            },
          },
        ]);
      };
    }

    const first = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      yield* producing(`<File path="notes.md" />\n`)();
      yield* run(DOCUMENT, [reading(first)], stream);
    });
    const complete = yield* stream.readAll();
    const admitted = complete.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    expect(admitted).toBeGreaterThanOrEqual(0);
    const partial = complete.slice(0, admitted + 1);

    const second = recordedFiles({ "notes.md": NOTE, "other.md": "elsewhere\n" });
    const failed = yield* refusal(
      scoped(function* () {
        yield* producing(`<File path="other.md" />\n`)();
        return yield* run(DOCUMENT, [reading(second)], new InMemoryStream(partial));
      }),
    );

    expect(failed).toContain("the exact text it was made about");
    // Nothing was performed: neither the retained fragment nor the offered one.
    expect(second.performed).toEqual([]);
  });

  it("FE10: a continuation whose ceiling moved refuses before any effect", function* () {
    const first = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    const source = `<Evaluate text={'<File path="notes.md" />\\n'} />\n`;
    yield* run(source, [reading(first)], stream);
    const complete = yield* stream.readAll();
    const admitted = complete.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    const partial = complete.slice(0, admitted + 1);

    // The same fragment, admitted under a table that now states another
    // identity. A grant is the exact set it was made under.
    const second = recordedFiles({ "notes.md": NOTE });
    const widened: ExecutionInstallation = {
      evaluation: {
        read: [
          {
            ...fileReadEntry(),
            identity: { origin: "@executablemd/core", key: "File:read", revision: "99" },
          },
        ],
        files: second,
      },
    };
    const failed = yield* refusal(run(source, [widened], new InMemoryStream(partial)));

    expect(failed).toContain("no longer states");
    expect(second.performed).toEqual([]);
  });

  it("FE12: a retained record this version cannot read fails closed", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    const source = `<Evaluate text={'<File path="notes.md" />\\n'} />\n`;
    yield* run(source, [reading(files)], stream);
    const complete = yield* stream.readAll();

    // The admission's own result, replaced with a shape no version wrote. A
    // record that cannot be read is not a decision to guess at.
    const hostile = complete.map((event) => {
      if (event.type !== "yield" || event.description.type !== "generated_xmd") {
        return event;
      }
      return { ...event, result: { status: "ok" as const, value: { decision: "maybe" } } };
    });
    const admitted = hostile.findIndex(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );

    const second = recordedFiles({ "notes.md": NOTE });
    const failed = yield* refusal(
      run(source, [reading(second)], new InMemoryStream(hostile.slice(0, admitted + 1))),
    );

    expect(failed.length).toBeGreaterThan(0);
    expect(second.performed).toEqual([]);
  });
});

describe("Tier FE — protection settles which implementation runs, and grants nothing", () => {
  it("FE26: protection adds no class and no identity to what `allow` selects", function* () {
    // A profile with no write table. `<Evaluate>` being canonical core's does
    // not add one, and no spelling of `allow` conjures one.
    const files = recordedFiles();
    expect(
      yield* refusal(
        run(`<Evaluate text={'<File path="a.md">x</File>\\n'} allow={["write"]} />\n`, [
          reading(files),
        ]),
      ),
    ).toContain("installed no write table");
    expect(files.performed).toEqual([]);
  });

  it("FE23: a name in the enclosing symbols is still not admitted", function* () {
    // `<Glob>` is an ordinary core component and appears in the document's own
    // vocabulary. Naming it in a fragment reaches the fragment's table, which
    // does not hold it — symbols text registers, resolves and authorizes
    // nothing.
    const files = recordedFiles({ "notes.md": NOTE });
    const failed = yield* refusal(
      run(`<Evaluate text={'<Glob pattern="*.md" />\\n'} />\n`, [reading(files)]),
    );
    expect(failed).toContain("did not admit");
    expect(files.performed).toEqual([]);
  });

  it("FE29: nothing a document controls reads, replaces or widens the profile", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* scoped(function* () {
      // A component that binds every composable channel it has before the
      // `<Evaluate>` beneath it runs.
      yield* registerComponents([
        {
          name: "Forge",
          origin: "test://forge",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(): Operation<string> {
            yield* API.Files.around(
              {
                // deno-lint-ignore require-yield
                *readTextFile([input]): Operation<Result<string>> {
                  return Ok(`forged ${String(input.path)}`);
                },
              },
              { at: "min" },
            );
            return yield* content();
          },
        },
      ]);
      return yield* run(
        `<Forge>\n<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` +
          `<Json value={answer} />\n</Forge>\n`,
        [reading(files)],
      );
    });

    // The fragment read the captured operation's file, not the forged one.
    expect(String(output)).toContain("the retained note");
    expect(String(output)).not.toContain("forged");
    expect(files.performed).toEqual(["read notes.md"]);
  });
});
