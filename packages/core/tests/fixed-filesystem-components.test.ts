/**
 * Tier FX — `<File>`, `<File.Delete>` and `<Dir>` are canonical core's
 * (spec §§5.3, 6.13, 6.13.1, 6.13.2).
 *
 * These three names reach the author's own filesystem, so what they mean is not
 * a repository's, a host's or a bundle's to decide. This tier owns that
 * boundary, and it has two halves which fail in different places:
 *
 * **Selection.** A repository `File.md`, a registration, a reserved
 * registration, a declared Markdown component and a bundle declaration all
 * lose the name — before any of their implementations is read, let alone run.
 *
 * **The final answer.** `Component.importComponent` middleware still composes
 * around the import. It may observe it, delegate it and refuse it by throwing;
 * what it cannot do is answer one. A replacement, a rebuilt descriptor, another
 * name's answer and a separately constructed dispatcher are each refused
 * against the copy canonical execution retained, and core's copy is what runs.
 *
 * Underneath both, the components are *ordinary*: each body performs its
 * operations through contextual `API.Files`, which middleware still answers,
 * transforms, delegates and refuses. Fixing the name says nothing about which
 * filesystem it reaches, which is what FX1b proves by changing what a write
 * stores and watching the later read return it.
 *
 * What is deliberately not here: the three components' own surfaces — forms,
 * printed errors, containment, replay — belong to Tiers FL, FD and HF, and the
 * repository and workflow integrations belong to the Git and Workflow suites.
 * This file runs under every supported runtime, so the second-copy question is
 * asked with a separately constructed dispatcher rather than an actual bundled
 * copy of core, which is Deno-only and lives in `syntax-loaded-copy.test.ts`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, suspend, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API, cwd, Files, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { execute } from "../src/execute.ts";
import { collect } from "../src/collect.ts";
import { Component } from "../src/component-api.ts";
import { registerComponents } from "../src/components/registration.ts";
import { selectComponent } from "../src/components/select.ts";
import { fixedFilesystemDefinition } from "../src/components/fixed-filesystem.ts";
import { formDispatcher } from "../src/invocation-identity.ts";
import { form as fileForm } from "../src/components/File.ts";
import { PROTECTED_COMPONENT_NAMES } from "../src/components/protected.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";
import type { ComponentRegistry, FunctionComponentDefinition } from "../src/types.ts";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The registry visible in the current scope. */
function currentRegistry(): Operation<ComponentRegistry> {
  return Component.operations.registry;
}

/** `properties.path` of a props schema, when it has one. */
function pathSchema(props: unknown): object | undefined {
  if (typeof props !== "object" || props === null) {
    return undefined;
  }
  const properties = Reflect.get(props, "properties");
  if (typeof properties !== "object" || properties === null) {
    return undefined;
  }
  const path = Reflect.get(properties, "path");
  return typeof path === "object" && path !== null ? path : undefined;
}

/** The declared type of `path`, read rather than asserted. */
function pathType(props: unknown): string | undefined {
  const path = pathSchema(props);
  if (path === undefined) {
    return undefined;
  }
  const type = Reflect.get(path, "type");
  return typeof type === "string" ? type : undefined;
}

/** The three names this tier is about, in the order the spec introduces them. */
const FIXED = ["File", "File.Delete", "Dir"] as const;

interface Fixture {
  root: string;
  workspace: string;
}

function useFixture(): Operation<Fixture> {
  return resource(function* (provide) {
    const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "fx-test-")))));
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    yield* ensureDir(workspace);
    yield* provide({ root, workspace });
  });
}

/**
 * The workspace as the contextual working directory, with the host provider
 * beneath it and no Git Plugin anywhere.
 *
 * `API.Files` has no host default, so a suite driving `execute()` installs the
 * provider the way an entrypoint does — and nothing else. That absence is the
 * point of FX1: a document that enters a directory, writes, reads and deletes
 * needs core and a Files provider, and no repository vocabulary at all.
 */
function* useWorkspaceCwd(fixture: Fixture): Operation<void> {
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd() {
        return fixture.workspace;
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
}

/**
 * Run `source` and report the enclosing working directory **in the scope that
 * installed it**, after the execution has settled.
 *
 * Calling `run()` a second time cannot establish restoration: that helper opens
 * a new scope and installs the workspace cwd afresh, which is indistinguishable
 * from a stale one left behind. This reads `cwd()` in the original owner,
 * before any later installation exists.
 */
function observeEnclosingCwd(
  fixture: Fixture,
  source: string,
): Operation<{ failure: string; enclosing: string }> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* useWorkspaceCwd(fixture);
    let failure = "";
    try {
      yield* collect(
        yield* execute({ path, stream: new InMemoryStream(), includes: [fixture.workspace] }),
      );
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return { failure, enclosing: yield* cwd() };
  });
}

function run(fixture: Fixture, source: string, install?: () => Operation<void>): Operation<string> {
  return scoped(function* () {
    const path = join(fixture.workspace, "doc.md");
    yield* writeTextFile(path, source);
    yield* useWorkspaceCwd(fixture);
    if (install) {
      yield* install();
    }
    const output: Json = yield* collect(
      yield* execute({ path, stream: new InMemoryStream(), includes: [fixture.workspace] }),
    );
    return String(output);
  });
}

/** The error `body` raised, as a message, or the empty string when it raised none. */
function* raised(body: () => Operation<unknown>): Operation<string> {
  try {
    yield* body();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Everything in a directory except the document each test writes there. */
function* entries(directory: string): Operation<string[]> {
  return (yield* until(readdir(directory))).filter((entry) => entry !== "doc.md").sort();
}

/**
 * Repository candidates for all three names, each one recognizable in output.
 *
 * `File.Delete` is probed at `File/Delete.md`, so the layout is a directory and
 * a file rather than three flat ones. Written as `.md` so there is nothing to
 * import: if one of these ever won selection, its marker text appears in the
 * output instead of the component's effect.
 */
function* writeMarkers(fixture: Fixture): Operation<void> {
  yield* writeTextFile(join(fixture.workspace, "File.md"), "MARKER-FILE\n");
  yield* writeTextFile(join(fixture.workspace, "Dir.md"), "MARKER-DIR\n");
  yield* ensureDir(join(fixture.workspace, "File"));
  yield* writeTextFile(join(fixture.workspace, "File", "Delete.md"), "MARKER-DELETE\n");
}

/** A wrapper that answers an import of `name` with `replacement`. */
function answerImport(
  name: string,
  replacement: (definition: FunctionComponentDefinition) => FunctionComponentDefinition,
): () => Operation<void> {
  return function* () {
    yield* Component.around({
      *importComponent([requested, position], next) {
        const definition = yield* next(requested, position);
        if (requested !== name || definition.kind !== "function") {
          return definition;
        }
        return replacement(definition);
      },
    });
  };
}

describe("Tier FX — the complete journey, with no repository vocabulary", () => {
  it("FX1: core and a Files provider enter, write, read and delete; markers never run", function* () {
    const fixture = yield* useFixture();
    yield* writeMarkers(fixture);

    const output = yield* run(
      fixture,
      [
        '<Dir path="notes">',
        '<File path="message.md">first</File>',
        '<File path="message.md" as="message" />',
        "{message}",
        '<File.Delete path="message.md" />',
        "</Dir>",
      ].join("\n"),
    );

    // The read text, and none of the three markers: selection answered with
    // core's components even though a candidate for each name was on disk.
    expect(output).toContain("first");
    expect(output).not.toContain("MARKER");

    // The directory the document entered is still there, and the file it
    // deleted is gone. A restored working directory removes nothing.
    expect(yield* exists(join(fixture.workspace, "notes"))).toBe(true);
    expect(yield* entries(join(fixture.workspace, "notes"))).toEqual([]);
  });

  it("FX1b: Files middleware transforms the write, and the later read returns it", function* () {
    const fixture = yield* useFixture();

    const output = yield* run(
      fixture,
      [
        '<Dir path="notes">',
        '<File path="message.md">first</File>',
        '<File path="message.md" as="message" />',
        "{message}",
        "</Dir>",
      ].join("\n"),
      function* () {
        yield* Files.around({
          *writeTextFile([input], next) {
            return yield* next({ ...input, content: `${input.content}-transformed` });
          },
        });
      },
    );

    // A fixed name is not a fixed provider. The body still performs its write
    // through contextual Files, so what the handler stored is what the read
    // finds — and what the document renders.
    expect(output).toContain("first-transformed");
    expect(yield* readTextFile(join(fixture.workspace, "notes", "message.md"))).toBe(
      "first-transformed",
    );
  });

  it("FX1c: the enclosing working directory is restored for a later sibling", function* () {
    const fixture = yield* useFixture();

    const output = yield* run(
      fixture,
      [
        '<Dir path="notes">',
        '<File path="inside.md">in</File>',
        "</Dir>",
        '<File path="outside.md">out</File>',
        '<File path="outside.md" as="seen" />',
        "{seen}",
      ].join("\n"),
    );

    expect(output).toContain("out");
    expect(yield* exists(join(fixture.workspace, "notes", "inside.md"))).toBe(true);
    expect(yield* exists(join(fixture.workspace, "outside.md"))).toBe(true);
    expect(yield* exists(join(fixture.workspace, "notes", "outside.md"))).toBe(false);
  });
});

describe("Tier FX — nothing else may claim the names", () => {
  it("FX2: a registration and a reserved registration are both refused", function* () {
    for (const name of FIXED) {
      const refused = yield* raised(() =>
        scoped(function* () {
          yield* registerComponents([
            {
              name,
              origin: "@executablemd/test",
              props: { type: "object", properties: {}, additionalProperties: false },
              // deno-lint-ignore require-yield
              *fn(): Operation<string> {
                return "replaced";
              },
            },
          ]);
        }),
      );
      expect(refused).toContain("canonical core owns that name");

      const reserved = yield* raised(() =>
        scoped(function* () {
          yield* registerComponents([
            {
              name,
              origin: "@executablemd/test",
              reserved: true,
              props: { type: "object", properties: {}, additionalProperties: false },
              // deno-lint-ignore require-yield
              *fn(): Operation<string> {
                return "replaced";
              },
            },
          ]);
        }),
      );
      expect(reserved).toContain("canonical core owns that name");
    }
  });

  it("FX2b: a batch holding one fixed name installs nothing, in its own live scope", function* () {
    const adjacent = {
      name: "Adjacent",
      origin: "@executablemd/test",
      props: { type: "object", properties: {}, additionalProperties: false },
      // deno-lint-ignore require-yield
      *fn(): Operation<string> {
        return "adjacent";
      },
    };

    yield* scoped(function* () {
      const refused = yield* raised(() =>
        registerComponents([
          adjacent,
          {
            name: "Dir",
            origin: "@executablemd/test",
            props: { type: "object", properties: {}, additionalProperties: false },
            // deno-lint-ignore require-yield
            *fn(): Operation<string> {
              return "replaced";
            },
          },
        ]),
      );
      expect(refused).toContain("canonical core owns that name");

      // Inspected here, while the registration scope is still live. Leaving the
      // scope first would remove a partially installed registration too, so the
      // assertion could not tell an atomic refusal from one that installed and
      // was then torn down.
      const refusedSelection = yield* selectComponent("Adjacent", {
        includes: [],
        registry: yield* currentRegistry(),
      });
      expect(refusedSelection.kind).toBe("unresolved");

      // And the collision index did not record it either, so the ordinary name
      // still registers cleanly in this same scope afterwards.
      yield* registerComponents([adjacent]);
      const afterSelection = yield* selectComponent("Adjacent", {
        includes: [],
        registry: yield* currentRegistry(),
      });
      expect(afterSelection.kind).toBe("registered");
    });
  });

  it("FX2c: a same-name local implementation is never loaded, and open names still win", function* () {
    const fixture = yield* useFixture();

    // A candidate that would be fatal if it were ever imported. Selection
    // refuses it by name, so its top level never runs — which is the difference
    // between losing selection and being loaded and then ignored.
    yield* writeTextFile(
      join(fixture.workspace, "Dir.ts"),
      'throw new Error("the local Dir implementation was loaded");\n',
    );
    // An open name beside it, to show the include itself is live.
    yield* writeTextFile(join(fixture.workspace, "Kept.md"), "kept by the repository\n");

    const output = yield* run(fixture, ['<Dir path="notes">', "<Kept />", "</Dir>"].join("\n"));

    expect(output).toContain("kept by the repository");
    expect(yield* exists(join(fixture.workspace, "notes"))).toBe(true);
  });
});

describe("Tier FX — the final import answer is verified", () => {
  it("FX3: middleware may observe and delegate every fixed import", function* () {
    const fixture = yield* useFixture();
    const seen: string[] = [];

    const output = yield* run(
      fixture,
      [
        '<Dir path="notes">',
        '<File path="message.md">first</File>',
        '<File.Delete path="message.md" />',
        "</Dir>",
      ].join("\n"),
      function* () {
        yield* Component.around({
          *importComponent([name, position], next) {
            seen.push(name);
            return yield* next(name, position);
          },
        });
      },
    );

    expect(output).not.toContain("MARKER");
    for (const name of FIXED) {
      expect(seen).toContain(name);
    }
  });

  it("FX3b: a replacement is refused before the body or any provider call", function* () {
    for (const name of FIXED) {
      const fixture = yield* useFixture();
      const reached: string[] = [];

      const refused = yield* raised(() =>
        run(
          fixture,
          [
            '<Dir path="notes">',
            '<File path="message.md">first</File>',
            '<File.Delete path="message.md" />',
            "</Dir>",
          ].join("\n"),
          function* () {
            yield* Files.around({
              *ensureDirectory([input], next) {
                reached.push("ensureDirectory");
                return yield* next(input);
              },
              *writeTextFile([input], next) {
                reached.push("writeTextFile");
                return yield* next(input);
              },
              *deleteFile([input], next) {
                reached.push("deleteFile");
                return yield* next(input);
              },
            });
            yield* answerImport(name, () => ({
              kind: "function",
              name,
              props: { type: "object", properties: {}, additionalProperties: false },
              // deno-lint-ignore require-yield
              *fn(): Operation<string> {
                reached.push("replacement");
                return "replaced";
              },
            }))();
          },
        ),
      );

      expect(refused).toContain("canonical execution did not produce");
      expect(reached).not.toContain("replacement");
      // `<Dir>` is refused at the first element, so nothing inside it runs. The
      // other two are refused after the directory exists, which is the element
      // before them succeeding rather than this one partly succeeding.
      if (name === "Dir") {
        expect(reached).toEqual([]);
      }
    }
  });

  it("FX3c: an in-place change to a fixed definition cannot run, now or later", function* () {
    const fixture = yield* useFixture();
    const definition = fixedFilesystemDefinition("File");
    if (definition === undefined) {
      throw new Error("core supplies no File definition");
    }
    const original = definition.fn;
    const originalPathType = pathType(definition.props);
    expect(originalPathType).toBe("string");

    let attempts = 0;
    const accepted: boolean[] = [];
    let replacementCalls = 0;

    // The dangerous shape is not a replacement object — it is a change to the
    // object canonical execution handed out, which every execution in the
    // process shares. Two members are attempted, because both decide what runs:
    // the implementation, and the schema that says which authored values reach
    // it.
    const output = yield* run(
      fixture,
      [
        "<PrintErrors>",
        "",
        '<File path="one.md">one</File>',
        "",
        '<File path="two.md">two</File>',
        "",
        '<File path="two.md" as="two" />',
        "",
        "LATER {two}",
        "",
        "</PrintErrors>",
      ].join("\n"),
      function* () {
        yield* Component.around({
          *importComponent([name, position], next) {
            const answer = yield* next(name, position);
            if (name !== "File" || attempts > 0) {
              return answer;
            }
            attempts += 1;
            accepted.push(
              Reflect.set(answer, "fn", function* (): Operation<string> {
                replacementCalls += 1;
                return "POISONED-FILE-BODY";
              }),
            );
            const path = pathSchema(answer.props);
            if (path !== undefined) {
              accepted.push(Reflect.set(path, "type", "number"));
            }
            return answer;
          },
        });
      },
    );

    // Both attempts were made and both were rejected where they were made,
    // rather than the handler quietly doing nothing.
    expect(attempts).toBe(1);
    expect(accepted).toEqual([false, false]);

    // No replacement body and no replacement I/O, on this import or any later
    // one: the writes are the document's own text and the read returns it.
    expect(replacementCalls).toBe(0);
    expect(output).not.toContain("POISONED");
    expect(output).toContain("LATER two");
    expect(yield* readTextFile(join(fixture.workspace, "one.md"))).toBe("one");
    expect(yield* readTextFile(join(fixture.workspace, "two.md"))).toBe("two");

    // The owning definition and its whole schema are what they were.
    expect(fixedFilesystemDefinition("File")?.fn).toBe(original);
    expect(pathType(fixedFilesystemDefinition("File")?.props)).toBe("string");

    // And the contract a *fresh* execution validates against is unchanged. This
    // is the half a single execution cannot establish: the first-issued
    // baseline refuses a change inside the execution that made it, and what
    // keeps the next execution from taking its first copy of a changed object
    // is that there is nothing to change.
    const later = yield* useFixture();
    const second = yield* run(
      later,
      [
        '<File path="valid.md">still a string path</File>',
        '<File path="valid.md" as="seen" />',
        "{seen}",
      ].join("\n"),
    );
    expect(second).toContain("still a string path");
    expect(yield* readTextFile(join(later.workspace, "valid.md"))).toBe("still a string path");
  });

  it("FX3c2: another name's issued definition is refused", function* () {
    const fixture = yield* useFixture();

    const swapped = yield* raised(() =>
      run(
        fixture,
        // `<File>` first, so its definition has been issued by the time the
        // `<Dir>` import is answered with it. An answer holding a definition
        // this execution never issued is the other refusal, below.
        '<File path="earlier.md">x</File>\n<Dir path="notes">\n<File path="m.md">first</File>\n</Dir>',
        function* () {
          const other = fixedFilesystemDefinition("File");
          if (other === undefined) {
            throw new Error("core supplies no File definition");
          }
          yield* answerImport("Dir", () => other)();
        },
      ),
    );
    expect(swapped).toContain("produced for another component");
  });

  it("FX3d: a rebuilt definition is refused, however exactly it matches", function* () {
    const fixture = yield* useFixture();

    // A dispatcher built from the same declaration, so every field matches and
    // the function is not the one this execution retained. A definition from an
    // actual second loaded copy of core is the same class of answer and is
    // proven against a real bundled copy in `syntax-loaded-copy.test.ts`, which
    // is Deno-only; this file runs under every supported runtime.
    const rebuilt: FunctionComponentDefinition = {
      kind: "function",
      name: "File",
      props: { type: "object", properties: { path: { type: "string" } } },
      fn: formDispatcher(fileForm),
    };

    const refused = yield* raised(() =>
      run(
        fixture,
        '<File path="message.md">first</File>',
        answerImport("File", () => rebuilt),
      ),
    );

    expect(refused).toContain("canonical execution did not produce");
    expect(yield* exists(join(fixture.workspace, "message.md"))).toBe(false);
  });

  it("FX3e: middleware may still refuse a fixed import by throwing", function* () {
    const fixture = yield* useFixture();

    const refused = yield* raised(() =>
      run(fixture, '<File path="message.md">first</File>', function* () {
        yield* Component.around({
          *importComponent([name, position], next) {
            if (name === "File") {
              throw new Error("this host refuses File");
            }
            return yield* next(name, position);
          },
        });
      }),
    );

    expect(refused).toContain("this host refuses File");
    expect(yield* exists(join(fixture.workspace, "message.md"))).toBe(false);
  });

  it("FX3f: every fixed name is claimed by the tier that verifies it", function* () {
    for (const name of FIXED) {
      expect(PROTECTED_COMPONENT_NAMES.has(name)).toBe(true);
    }
  });
});

describe("Tier FX — the dispatcher authenticates its own invocation", () => {
  it("FX4: a fixed dispatcher refuses an invocation the engine did not issue", function* () {
    // Reached directly, with no import to intercept: this is the defense
    // underneath canonical verification, and it is the one that would decide
    // the outcome if an answer ever did get through. A forged invocation has
    // the whole public shape — the right method, taking nothing, returning a
    // boolean — and `true` is the dangerous answer, because for `<File>` it
    // selects the write branch.
    const forged: ComponentInvocation = {
      hasContent() {
        return true;
      },
    };

    for (const name of FIXED) {
      const definition = fixedFilesystemDefinition(name);
      const dispatcher = definition?.fn;
      if (typeof dispatcher !== "function") {
        throw new Error(`core supplies no ${name} definition`);
      }
      const refused = yield* raised(() => scoped(() => dispatcher({ path: "message.md" }, forged)));
      expect(refused).toContain("without the invocation the engine issued");
    }
  });
});

describe("Tier FX — Dir's ordering, ownership and cancellation", () => {
  it("FX5: the enclosing directory is restored in its owner after the body fails", function* () {
    const fixture = yield* useFixture();

    // `<Fail>` rather than a filesystem refusal: a File failure is a printed
    // error this component owns, and what this case is about is the directory
    // ownership surviving a body that ends the run.
    const { failure, enclosing } = yield* observeEnclosingCwd(
      fixture,
      [
        '<Dir path="notes">',
        '<File path="inside.md">in</File>',
        '<Fail message="stop inside the directory" />',
        "</Dir>",
      ].join("\n"),
    );

    expect(failure).toContain("stop inside the directory");
    // Read in the owner that installed it, so a stale cwd would show here.
    expect(enclosing).toBe(fixture.workspace);

    // The directory the failed body ran in survives. There is no teardown
    // deletion and no rollback.
    expect(yield* exists(join(fixture.workspace, "notes"))).toBe(true);
    expect(yield* exists(join(fixture.workspace, "notes", "inside.md"))).toBe(true);
  });

  it("FX5b: a refused ensure begins no content and binds no directory", function* () {
    const fixture = yield* useFixture();
    // A file where the directory would go, so the ensure is refused rather than
    // failing for a reason of the test's own making.
    yield* writeTextFile(join(fixture.workspace, "notes"), "not a directory\n");
    const reached: string[] = [];

    const refused = yield* raised(() =>
      run(
        fixture,
        ['<Dir path="notes">', '<File path="inside.md">in</File>', "</Dir>"].join("\n"),
        function* () {
          yield* Files.around({
            *writeTextFile([input], next) {
              reached.push(`write:${input.path}`);
              return yield* next(input);
            },
          });
        },
      ),
    );

    expect(refused).toContain("could not be used");
    expect(reached).toEqual([]);
    expect(yield* readTextFile(join(fixture.workspace, "notes"))).toBe("not a directory\n");
  });

  it("FX5c: a directory that is already there keeps what is in it", function* () {
    const fixture = yield* useFixture();
    yield* ensureDir(join(fixture.workspace, "notes"));
    yield* writeTextFile(join(fixture.workspace, "notes", "kept.md"), "kept\n");

    yield* run(
      fixture,
      ['<Dir path="notes">', '<File path="added.md">added</File>', "</Dir>"].join("\n"),
    );

    expect(yield* entries(join(fixture.workspace, "notes"))).toEqual(["added.md", "kept.md"]);
    expect(yield* readTextFile(join(fixture.workspace, "notes", "kept.md"))).toBe("kept\n");
  });

  it("FX5d: joined cancellation restores the directory in its owner", function* () {
    const fixture = yield* useFixture();
    const inside = withResolvers<void>();
    const outcome: string[] = [];
    let enclosing = "";

    yield* scoped(function* () {
      const path = join(fixture.workspace, "doc.md");
      yield* writeTextFile(
        path,
        ['<Dir path="notes">', '<File path="held.md">held</File>', "</Dir>"].join("\n"),
      );
      // Installed by *this* scope, which is the owner restoration has to be
      // observed in. The execution runs in a child task, so halting it unwinds
      // the Dir invocation while this scope is still live to be read.
      yield* useWorkspaceCwd(fixture);
      yield* Files.around({
        *writeTextFile([input], next) {
          const result = yield* next(input);
          inside.resolve();
          yield* suspend();
          return result;
        },
      });

      const task = yield* spawn(function* () {
        const output = yield* collect(
          yield* execute({ path, stream: new InMemoryStream(), includes: [fixture.workspace] }),
        );
        outcome.push(String(output));
      });

      // Halted exactly here: the directory exists, the working directory is
      // installed and the write inside it has completed. Synchronized through
      // the operation rather than timed, and joined before anything is read.
      yield* inside.operation;
      yield* task.halt();
      enclosing = yield* cwd();
    });

    // Nothing settled, and the enclosing directory is the one this scope
    // installed rather than the directory the cancelled body entered.
    expect(outcome).toEqual([]);
    expect(enclosing).toBe(fixture.workspace);

    // The directory the cancelled body entered is still there: a restored
    // working directory is not a deletion.
    expect(yield* exists(join(fixture.workspace, "notes"))).toBe(true);
  });
});
