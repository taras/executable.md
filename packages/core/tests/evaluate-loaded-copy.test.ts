/**
 * Tier FE — who answers for the name `Evaluate`, and what answering grants.
 *
 * Two separate guarantees, and they are proved separately here because one is
 * routinely mistaken for the other.
 *
 * *Ownership* is that canonical core decides which implementation runs. A
 * repository file, a registration, a declared Markdown component, an import
 * handler's substituted definition and a second loaded copy of core each fail
 * to replace it (FE24), including a replacement written specifically to ignore
 * `allow` (FE25).
 *
 * *Permission* is separate and is not conferred by ownership. Protection settles
 * which body runs and adds nothing to what that body may do: a profile with no
 * write table still cannot write, and a name in the enclosing symbols is still
 * not admitted (FE26). A component that is replaceable at an ordinary authored
 * site stays replaceable there, and that replaceability still does not let it
 * into a fragment (FE27) — shown with `<Glob>`, because `<File>` is a name
 * canonical core owns and a registration for it is refused outright (FE27b).
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { API, fileWriteSuccess } from "@executablemd/runtime";

import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { executeInstalled } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { useSelection } from "./support/generated-selection.ts";
import { registerComponents } from "../src/components/registration.ts";
import { savedSource } from "../src/root-source.ts";
import { recordedFiles, useRecordedFiles } from "./support/fragment-files.ts";
import type { RecordedFiles } from "./support/fragment-files.ts";

const ROOT_PATH = "evaluate.md";
const NOTE = "the saved note\n";

/** A read-only selection: core's `<File />` and no writing spelling at all. */
function reading(files: RecordedFiles): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection({ File: ["self-closing"] });
      yield* useRecordedFiles(files);
    },
  };
}

/** A selection whose spellings reach both classes. */
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
      yield* executeInstalled({ ...savedSource(ROOT_PATH, source), stream }, [...installations]),
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

function admissions(events: readonly DurableEvent[]): DurableEvent[] {
  return events.filter(
    (event) => event.type === "yield" && event.description.type === "generated_xmd",
  );
}

const READS =
  `<Evaluate text={'<File path="notes.md" />\\n'} as="answer" />\n\n` + `<Json value={answer} />\n`;

describe("Tier FE — nothing replaces the protected implementation", () => {
  it("FE24: the name cannot be registered at all", function* () {
    const reached: string[] = [];
    const failed = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "Evaluate",
            origin: "test://replacement",
            props: { type: "object", properties: {}, additionalProperties: true },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              reached.push("registration");
              return "the replacement answered";
            },
          },
        ]);
      }),
    );

    // Refused where the claim is made, rather than resolved against later: a
    // registry that accepted the name and lost selection would still be a
    // registry that had it to hand back somewhere else.
    expect(failed).toContain("canonical core owns that name");
    expect(reached).toEqual([]);
  });

  it("FE24: a live registration of the name does not exist to be selected", function* () {
    // The positive half of the row above: with the claim refused, an ordinary
    // document still resolves `<Evaluate>` to canonical core's implementation
    // and the fragment runs.
    const files = recordedFiles({ "notes.md": NOTE });
    const output = yield* run(READS, [reading(files)]);
    expect(String(output)).toContain("the saved note");
    expect(files.performed).toEqual(["read notes.md"]);
  });

  it("FE24: a middleware answer is refused, and honest delegation is not", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const substituted = yield* refusal(
      scoped(function* () {
        yield* Component.around({
          *importComponent([name], next) {
            const definition = yield* next(name);
            if (name !== "Evaluate" || definition.kind !== "function") {
              return definition;
            }
            // A wrapper that forwards everything and changes nothing. Refused
            // anyway: only canonical execution answers a protected import.
            return { ...definition };
          },
        });
        return yield* run(READS, [reading(files)]);
      }),
    );
    expect(substituted).toContain("canonical core owns");
    expect(files.performed).toEqual([]);

    // The same handler, delegating honestly, is still supported.
    const observed: string[] = [];
    const clean = recordedFiles({ "notes.md": NOTE });
    const output = yield* scoped(function* () {
      yield* Component.around({
        *importComponent([name], next) {
          const definition = yield* next(name);
          observed.push(name);
          return definition;
        },
      });
      return yield* run(READS, [reading(clean)]);
    });
    expect(observed).toContain("Evaluate");
    expect(String(output)).toContain("the saved note");
  });

  it("FE24: a deliberate middleware refusal stays a refusal", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const failed = yield* refusal(
      scoped(function* () {
        yield* Component.around({
          *importComponent([name], next) {
            if (name === "Evaluate") {
              throw new Error("this environment does not offer Evaluate");
            }
            return yield* next(name);
          },
        });
        return yield* run(READS, [reading(files)]);
      }),
    );

    // A handler may refuse an import. What it may not do is answer one.
    expect(failed).toContain("does not offer Evaluate");
    expect(files.performed).toEqual([]);
  });

  it("FE25: a replacement written to ignore `allow` is never invoked", function* () {
    // The replacement's body would write through the widest ambient permission
    // it can reach, under a read-only selection. It never runs, and canonical
    // `<Evaluate>` refuses the write before any provider call.
    const files = recordedFiles();
    const ambientWrites: string[] = [];
    const reached: string[] = [];

    const failed = yield* refusal(
      scoped(function* () {
        yield* API.Files.around(
          {
            // deno-lint-ignore require-yield
            *writeTextFile([input]) {
              ambientWrites.push(String(input.path));
              return Ok(fileWriteSuccess("host-committed"));
            },
          },
          { at: "min" },
        );
        // Registration is refused outright, so the only channel left for a
        // replacement is a handler answering the import. This one answers with
        // a body that writes through the widest ambient permission it can reach.
        yield* Component.around({
          *importComponent([name], next) {
            const definition = yield* next(name);
            if (name !== "Evaluate" || definition.kind !== "function") {
              return definition;
            }
            return {
              ...definition,
              *fn(): Operation<string> {
                reached.push("replacement");
                yield* API.Files.operations.writeTextFile({
                  cwd: "/",
                  path: "escaped.md",
                  content: "written by the replacement",
                });
                return "";
              },
            };
          },
        });
        return yield* run(
          `<Evaluate text={'<File path="out.md">x</File>\\n'} allow={["write"]} />\n`,
          [reading(files)],
        );
      }),
    );

    // The replacement was never entered and nothing was written anywhere: the
    // refusal happens at the import boundary, before the body could ignore
    // `allow`.
    expect(reached).toEqual([]);
    expect(ambientWrites).toEqual([]);
    expect(failed).toContain("canonical core owns");
    expect(files.performed).toEqual([]);
  });
});

describe("Tier FE — ownership is not permission", () => {
  it("FE26: owning the name adds no class and no identity", function* () {
    const files = recordedFiles();
    // A host offering only reads. Canonical `<Evaluate>` cannot add a write
    // table, and no spelling of `allow` conjures one.
    expect(
      yield* refusal(
        run(`<Evaluate text={'<File path="a.md">x</File>\\n'} allow={["write"]} />\n`, [
          reading(files),
        ]),
      ),
    ).toContain("installed no write table");

    // And with a write table, the read table is still not part of `write`:
    // selecting a class reaches that class's own entries and no others.
    const mixed = recordedFiles({ "notes.md": NOTE });
    expect(
      yield* refusal(
        run(`<Evaluate text={'<File path="notes.md" />\\n'} allow={["write"]} />\n`, [both(mixed)]),
      ),
    ).toContain("admitted only in its paired form");
    expect(mixed.performed).toEqual([]);
  });

  it("FE27: a replaceable ordinary component still wins at an authored site", function* () {
    const files = recordedFiles({ "notes.md": NOTE });
    const stream = new InMemoryStream();
    const reached: string[] = [];
    const output = yield* scoped(function* () {
      // `<Glob>` is an ordinary registration, so a repository or host component
      // of that name replaces it at an authored site. That is unchanged.
      //
      // It is `<Glob>` rather than `<File>` because canonical core now owns
      // `<File>` and a registration for it is refused outright (FE27b). The
      // claim here is about a *replaceable* component, so it needs one.
      yield* registerComponents([
        {
          name: "Glob",
          origin: "test://repository",
          props: {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
            additionalProperties: false,
          },
          // deno-lint-ignore require-yield
          *fn(): Operation<string> {
            reached.push("repository");
            return "the repository component answered";
          },
        },
      ]);
      return yield* run(`<Glob pattern="*.md" />\n\n${READS}`, [reading(files)], stream);
    });

    const rendered = String(output);
    // The authored site got the replacement...
    expect(rendered).toContain("the repository component answered");
    expect(reached).toEqual(["repository"]);
    // ...and the fragment did not: it reached the pinned identity the profile
    // admitted, through the captured operation.
    expect(rendered).toContain("the saved note");
    expect(files.performed).toEqual(["read notes.md"]);
    expect(admissions(yield* stream.readAll())).toHaveLength(1);
  });

  it("FE27b: an admitted name canonical core owns cannot be registered at all", function* () {
    const files = recordedFiles({ "notes.md": NOTE });

    // Where this used to prove that a *live* registration for `<File>` could
    // not enter a fragment, the registration itself is now refused: canonical
    // core owns the name, so the protection happens a layer earlier than this
    // tier used to observe it. The fragment half is unchanged.
    const failed = yield* refusal(
      scoped(function* () {
        yield* registerComponents([
          {
            name: "File",
            origin: "test://repository",
            props: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "replaced";
            },
          },
        ]);
      }),
    );
    expect(failed).toContain("canonical core owns that name");

    const output = yield* scoped(function* () {
      return yield* run(READS, [reading(files)]);
    });
    expect(String(output)).toContain("the saved note");
    expect(files.performed).toEqual(["read notes.md"]);
  });
});
