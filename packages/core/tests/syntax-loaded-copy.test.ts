/**
 * Tier SYN — a protected implementation from a second loaded copy answers for
 * nothing.
 *
 * A component can be loaded from disk beside its own copy of core: that is
 * what `--include` does, and what a middleware package holding its own copy
 * is. So "another loaded copy cannot answer for `<Syntax />`" is a guarantee
 * for ordinary arrangements rather than a hypothetical, and it has two halves.
 *
 * **The answer is refused.** Canonical execution issues a witness for the
 * definition it produced and verifies it where the component is invoked, keyed
 * by the object itself. A definition another copy built is not that object,
 * whatever it looks like.
 *
 * **And a body is unreachable anyway.** The table a protected body lives in
 * belongs to the execution that built the implementation, inside the copy that
 * built it, so this execution holds no body for a function another copy's
 * installation created. That half is what makes the refusal above a boundary
 * rather than a single check.
 *
 * The separate copy is built with `deno bundle`, which is Deno's, so this file
 * runs under Deno alone and is registered in the runtime exclusions. What it is
 * about — the witness comparison and the private body table — is proved under
 * all three runtimes by `syntax-component.test.ts` against handler-built
 * answers; what is only provable here is that a *real* second copy is one of
 * those answers.
 *
 * Tier FE14 in the middle asks the positive form of the same question about
 * *provider* code: a module loaded with no access to canonical core at all
 * receives the registrar and the request this execution minted, publishes its
 * own definition through `answer(definition)`, and a generated fragment runs
 * exactly that answer. The refusals above say what a second copy cannot do;
 * that row says what one can.
 *
 * Tier FX at the end of this file asks the same question of the *other* shape
 * in the protected tier. `<File>`, `<File.Delete>` and `<Dir>` are answered
 * with one ordinary definition built once per loaded copy rather than a body
 * this execution built, so a second copy of that module supplies a complete,
 * structurally identical definition — no identity authenticator, no private
 * table, nothing missing. That makes it the sharpest form of the question, and
 * the only one a locally rebuilt definition cannot stand in for.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { useSelection } from "./support/generated-selection.ts";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { API, Files, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { executeInstalled } from "../host.ts";
import type { ComponentAnswerInstallation, ExecutionInstallation } from "../host.ts";
import { retainedSource } from "../src/root-source.ts";
import { SYNTAX_COMPONENT, props as syntaxProps } from "../src/components/Syntax.ts";
import { fixedFilesystemDefinition } from "../src/components/fixed-filesystem.ts";
import { form as fileForm, props as fileProps } from "../src/components/File.ts";
import { parseJsonObject } from "../src/json.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";

const PROTECTION_MODULE = fileURLToPath(new URL("../src/invocation-identity.ts", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

/** What the bundled copy exposes: its own installation, with its own tables. */
interface LoadedCopy {
  formDispatcher(declaration: unknown): unknown;
  installIdentities(
    components: readonly unknown[],
    privateComponents: readonly unknown[],
    protectedComponents: readonly unknown[],
  ): {
    protected: ReadonlyMap<string, { fn: unknown }>;
    componentRouting: {
      body(fn: unknown): unknown;
      project(source: unknown, wrapper: unknown): unknown;
    };
    identities: { revoke(): void };
    activate(): void;
  };
}

function isLoadedCopy(value: unknown): value is LoadedCopy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "installIdentities") === "function"
  );
}

/**
 * `packages/core/src/invocation-identity.ts`, bundled and evaluated as its own
 * module.
 *
 * The bundle is what makes the copy separate: importing the source path again
 * would resolve to the module this test already holds, and share the private
 * body table with it. The declaration handed to it below is this test's, because
 * the component module itself does not bundle; what is genuinely the second
 * copy's is what decides — the implementation wrapper it built and the table its
 * body lives in.
 */
function useSeparateCopy(): Operation<LoadedCopy> {
  return resource(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "sl-syntax-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const bundle = join(directory, "protection.js");

    // `process.execPath` under Deno is the deno binary, so the driver stays
    // typed against node:process rather than a runtime global.
    const built = yield* exec(process.execPath, {
      arguments: [
        "bundle",
        "--frozen",
        "--node-modules-dir=none",
        PROTECTION_MODULE,
        "--output",
        bundle,
      ],
      cwd: REPOSITORY,
    }).join();
    if (built.code !== 0) {
      throw new Error(`could not bundle the identity module:\n${built.stdout}${built.stderr}`);
    }

    const loaded: unknown = yield* until(import(`file://${bundle}`));
    if (!isLoadedCopy(loaded)) {
      throw new Error("the bundled copy does not expose the protection surface");
    }
    yield* provide(loaded);
  });
}

/**
 * A provider module loaded with no access to canonical core.
 *
 * Written out and imported from a temporary directory, so the only things it
 * can reach are the ones this execution hands it: the registrar its
 * installation receives, and the request minted for each of its handler's
 * invocations. It imports nothing — not core, not Effection — because
 * publishing is one synchronous call on the request and delegation is one
 * `yield*` of the operation it was given.
 *
 * The definition is the module's own object, built where the module is
 * evaluated, and the identity it offers its self-closing spelling under is the
 * module's own declaration. So what a fragment runs here is a provider's answer
 * from outside this copy of core, admitted on the terms the declaration states.
 */
const LOADED_PROVIDER = `
const invoked = [];
const definition = {
  kind: "function",
  name: "Loaded",
  props: { type: "object", properties: {}, additionalProperties: false },
  forms: ["self-closing"],
  generated: {
    "self-closing": { identity: "https://executable.md/components/loaded/read", effect: "read" },
  },
  *fn() {
    invoked.push("loaded answer ran");
    return "LOADED ANSWER RAN";
  },
};

let settled = false;

export function installation(origin) {
  return {
    origin,
    *install(registrar) {
      yield* registrar.around(function* (request, next) {
        // It answers the capture and settles, which is what a provider is for:
        // the profile resolves its name once, before any document code, and a
        // fragment then runs the sealed snapshot.
        if (request.name !== "Loaded" || settled) {
          return yield* next();
        }
        settled = true;
        // The handed request, used for the one thing it is for. Nothing here
        // holds a core module, a context, a symbol or a registry.
        return request.answer(definition);
      });
    },
  };
}

export function invocations() {
  return [...invoked];
}

export function identity() {
  return definition.generated["self-closing"].identity;
}
`;

/** What that module exposes once it has been loaded. */
interface LoadedProvider {
  installation(origin: string): ComponentAnswerInstallation;
  invocations(): readonly string[];
  identity(): string;
}

function isLoadedProvider(value: unknown): value is LoadedProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "installation") === "function" &&
    typeof Reflect.get(value, "invocations") === "function"
  );
}

function useLoadedProvider(): Operation<LoadedProvider> {
  return resource(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "sl-provider-")));
    yield* ensure(() => rm(directory, { recursive: true, force: true }));
    const module = join(directory, "provider.js");
    yield* writeTextFile(module, LOADED_PROVIDER);
    const loaded: unknown = yield* until(import(`file://${module}`));
    if (!isLoadedProvider(loaded)) {
      throw new Error("the loaded module does not expose a provider installation");
    }
    yield* provide(loaded);
  });
}

/**
 * A handler that delegates the protected import and then answers with something
 * else.
 *
 * Delegating first is the strongest form: this is a handler that saw canonical
 * execution's own answer, not one that skipped the chain.
 */
function answering(definition: unknown): ExecutionInstallation {
  return {
    *install() {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            if (name !== SYNTAX_COMPONENT) {
              return yield* next(name, position);
            }
            yield* next(name, position);
            return definition as FunctionComponentDefinition;
          },
        },
        { at: "max" },
      );
    },
  };
}

function runRoot(
  installations: readonly ExecutionInstallation[],
  source = "<Syntax />\n",
): Operation<unknown> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource("documents/root.md", source),
          stream: new InMemoryStream(),
          includes: [],
        },
        [...installations],
      ),
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

describe("Tier SYN — a separately loaded protected implementation", () => {
  it("SYN26: an implementation another copy built answers for nothing here", function* () {
    const copy = yield* useSeparateCopy();

    // An installation the other copy performed: it minted the domain, built the
    // implementation and kept the body in its own table. Nothing here is a fake
    // — this is that copy's real protected-component path.
    const installed = copy.installIdentities(
      [],
      [],
      [
        {
          name: SYNTAX_COMPONENT,
          origin: "@executablemd/core",
          props: syntaxProps,
          forms: ["self-closing"],
          // deno-lint-ignore require-yield
          build: () =>
            // deno-lint-ignore require-yield
            function* (): Operation<string> {
              return "a foreign catalog";
            },
        },
      ],
    );
    yield* ensure(() => installed.identities.revoke());
    installed.activate();
    const foreign = installed.protected.get(SYNTAX_COMPONENT);
    if (foreign === undefined) {
      throw new Error("the bundled copy built no protected implementation");
    }
    // The premise, stated as a fact rather than assumed: that copy holds a body
    // for its own implementation.
    expect(installed.componentRouting.body(foreign.fn)).toBeDefined();

    const refused = yield* refusal(runRoot([answering(foreign)]));
    expect(refused).toContain("canonical core owns");

    // The positive control, in the same shape: a handler that delegates and
    // answers with what came back runs the canonical component.
    const output = yield* runRoot([
      {
        *install() {
          yield* Component.around(
            {
              *importComponent([name, position], next) {
                return yield* next(name, position);
              },
            },
            { at: "max" },
          );
        },
      },
    ]);
    expect(String(output)).toContain("### `<Syntax>`");
    expect(String(output)).not.toContain("a foreign catalog");

    const forged = function* (): Operation<string> {
      return "foreign projection";
    };
    const projected: unknown[] = [];
    const observed: string[] = [];
    const profile: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* useSelection({ Syntax: ["self-closing"] });
      },
      componentAnswers: [
        {
          origin: "test://delegate",
          *install(registrar) {
            yield* registrar.around(function* (request, next) {
              const answer = yield* next();
              if (request.name === "Syntax" && answer.kind === "function") {
                observed.push(request.name);
                projected.push(installed.componentRouting.project(answer.fn, forged));
              }
              // Delegated unchanged, so canonical core's own publication of the
              // protected answer travels with it. A separately loaded copy may
              // answer an import it was handed; what it cannot do is route a
              // body of its own into the one the fragment reaches.
              return answer;
            });
          },
        },
      ],
    };
    const generated = yield* runRoot(
      [profile],
      `<Evaluate text={'<Syntax />'} as="answer" />\n<Json value={answer} />`,
    );
    expect(String(generated)).toContain("### `<Syntax>`");
    expect(String(generated)).not.toContain("foreign projection");
    expect(observed).toEqual(["Syntax", "Syntax"]);
    expect(projected).toEqual([undefined, undefined]);
    expect(installed.componentRouting.body(forged)).toBeUndefined();
  });
});

describe("Tier FE14 — a separately loaded provider publishes its own answer", () => {
  it("FE14/U4-7: loaded provider code publishes through the handed request, and the fragment runs it", function* () {
    const loaded = yield* useLoadedProvider();
    const stream = new InMemoryStream();

    // The selection states the name and the spelling; what offering it grants
    // comes from the loaded module's own declaration.
    const profile: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* useSelection({ Loaded: ["self-closing"] });
      },
      componentAnswers: [loaded.installation("test://loaded")],
    };

    const output = yield* scoped(function* () {
      return yield* collect(
        yield* executeInstalled(
          {
            ...retainedSource("documents/root.md", `<Evaluate text={'<Loaded />\\n'} />\n`),
            stream,
            includes: [],
          },
          [profile],
        ),
      );
    });

    // The loaded module's own body ran, once, and what it rendered is the
    // fragment's output: the publication travelled with the object the chain
    // returned, and canonical capture sealed that exact definition.
    expect(String(output)).toContain("LOADED ANSWER RAN");
    expect(loaded.invocations()).toEqual(["loaded answer ran"]);

    // And the admission retains the identity that module declared for the
    // spelling the fragment wrote — not a host-stated one, and not core's.
    const admission = (yield* stream.readAll()).find(
      (event) => event.type === "yield" && event.description.type === "generated_xmd",
    );
    const retained =
      admission?.type === "yield" && admission.result.status === "ok"
        ? admission.result.value
        : undefined;
    expect(JSON.stringify(retained)).toContain(loaded.identity());
    expect(loaded.identity()).toBe("https://executable.md/components/loaded/read");
  });
});

describe("Tier FX — a fixed definition from a separately loaded copy", () => {
  it("FX3g: another copy's File dispatcher answers for nothing, and reaches no I/O", function* () {
    const copy = yield* useSeparateCopy();

    // The other shape in the protected tier. `<File>` is answered with an
    // ordinary definition rather than a body this execution built, so the
    // dangerous foreign answer is a *complete* definition whose dispatcher the
    // other copy built — one that would not recognize this execution's
    // invocations, and must never be reached to find that out.
    //
    // Built the way SYN26 builds its foreign implementation: the declaration is
    // this test's, because the component module does not bundle, and what is
    // genuinely the second copy's is what decides — the dispatcher it produced
    // from its own issuance machinery.
    const foreign: FunctionComponentDefinition = {
      kind: "function",
      name: "File",
      props: parseJsonObject(fileProps),
      forms: ["self-closing", "paired"],
      fn: copy.formDispatcher(fileForm) as FunctionComponentDefinition["fn"],
    };

    const local = fixedFilesystemDefinition("File");
    if (local === undefined) {
      throw new Error("core supplies no File definition");
    }
    // The premise, stated rather than assumed: the same name and accepted
    // forms, and a different object with a different implementation.
    expect(foreign.name).toBe(local.name);
    expect(foreign.forms).toEqual(local.forms);
    expect(typeof foreign.fn).toBe("function");
    expect(foreign.fn).not.toBe(local.fn);

    const workspace = yield* until(mkdtemp(join(tmpdir(), "sl-fixed-ws-")));
    yield* ensure(() => rm(workspace, { recursive: true, force: true }));
    const reached: string[] = [];

    const refused = yield* refusal(
      runRoot(
        [
          {
            *install() {
              yield* API.Env.around(
                {
                  // deno-lint-ignore require-yield
                  *cwd() {
                    return workspace;
                  },
                },
                { at: "min" },
              );
              yield* useHostFiles();
              yield* Files.around({
                *writeTextFile([input], next) {
                  reached.push(`write:${input.path}`);
                  return yield* next(input);
                },
                *readTextFile([input], next) {
                  reached.push(`read:${input.path}`);
                  return yield* next(input);
                },
              });
            },
          },
          {
            *install() {
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    if (name !== "File") {
                      return yield* next(name, position);
                    }
                    // Delegating first is the strongest form: this handler saw
                    // canonical execution's own answer and replaced it.
                    yield* next(name, position);
                    return foreign;
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
        '<File path="written.md">one</File>\n',
      ),
    );

    expect(refused).toContain("canonical core owns");
    // Before its body and before any filesystem call.
    expect(reached).toEqual([]);
  });
});
