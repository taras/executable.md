/**
 * Tier SYN — a protected implementation from a second loaded copy answers for
 * nothing.
 *
 * A component can be loaded from disk beside its own copy of core: that is what
 * `--include` does, and what a middleware package holding its own copy is. So
 * "another loaded copy cannot answer for `<Syntax />`" is a claim about ordinary
 * arrangements rather than a hypothetical, and it has two halves.
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
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { DurableContext, InMemoryStream } from "@executablemd/durable-streams";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import {
  boundedEvaluation,
  evaluationFailureKind,
  EvaluationLimitError,
  executeInstalled,
  fileReadEntry,
} from "@executablemd/core/host";
import type { ExecutionInstallation, EvaluationBounds, IdentityClaimant } from "../host.ts";
import type { EvaluationCaptureOperation } from "../host.ts";
import { recordedFiles } from "./support/fragment-files.ts";
import { retainedSource } from "../src/root-source.ts";
import { SYNTAX_COMPONENT, props as syntaxProps } from "../src/components/Syntax.ts";
import type { FunctionComponentDefinition } from "../src/types.ts";

const PROTECTION_MODULE = fileURLToPath(
  new URL("./fixtures/evaluation-composition/loaded-host.ts", import.meta.url),
);
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

/** What the bundled copy exposes: its own installation, with its own tables. */
interface LoadedCopy {
  boundedEvaluation(claim: IdentityClaimant, bounds: EvaluationBounds): EvaluationCaptureOperation;
  evaluationFailureKind(value: unknown): string | undefined;
  EvaluationLimitError: new (limit: "duration" | "result-bytes") => Error;
  installIdentities(
    components: readonly unknown[],
    privateComponents: readonly unknown[],
    protectedComponents: readonly unknown[],
  ): {
    protected: ReadonlyMap<string, { fn: unknown }>;
    protectedBodies: {
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
  it("routes the public composition helper across copies without minting a claim or replacing the durable child owner", function* () {
    const copy = yield* useSeparateCopy();
    expect(copy.boundedEvaluation).not.toBe(boundedEvaluation);
    expect(copy.EvaluationLimitError).not.toBe(EvaluationLimitError);
    expect(copy.evaluationFailureKind(new EvaluationLimitError("duration"))).toBe("limit");
    expect(evaluationFailureKind(new copy.EvaluationLimitError("result-bytes"))).toBe("limit");
    expect(copy.evaluationFailureKind(new Error("EvaluationLimitError"))).toBeUndefined();
    const files = recordedFiles({ x: "captured" });
    let classified: string | undefined;
    const output = yield* runRoot(
      [
        {
          evaluation: { read: [fileReadEntry()], files },
          components: [
            {
              name: "Capture",
              origin: "test://loaded",
              props: { type: "object" },
              factory(claim) {
                const capture = copy.boundedEvaluation(
                  claim,
                  Object.freeze({ durationMs: 1000, outputBytes: 65536 }),
                );
                return function* (_props, invocation) {
                  let forged: unknown;
                  try {
                    yield* capture({ hasContent: () => true });
                  } catch (error) {
                    forged = error;
                  }
                  expect(forged).toBeInstanceOf(Error);
                  const context = yield* DurableContext.get();
                  if (context === undefined) {
                    throw new Error("missing durable context");
                  }
                  yield* DurableContext.set({
                    ...context,
                    coroutineId: "forged",
                    childCounter: 999,
                  });
                  const result = yield* capture(invocation);
                  if (!result.ok) {
                    classified = copy.evaluationFailureKind(result.error);
                    return "refused";
                  }
                  return result.value;
                };
              },
            },
          ],
        },
      ],
      "<Capture><Evaluate text={'<File path=\"x\" />'} /></Capture>",
    );
    expect(output).toBe("captured");
    expect(classified).toBeUndefined();
    expect(files.performed).toEqual(["read x"]);
    const foreign = copy.installIdentities(
      [
        {
          name: "Capture",
          origin: "test://foreign",
          props: { type: "object" },
          factory(claim: IdentityClaimant) {
            return copy.boundedEvaluation(
              claim,
              Object.freeze({ durationMs: 1000, outputBytes: 65536 }),
            );
          },
        },
      ],
      [],
      [],
    );
    yield* ensure(() => foreign.identities.revoke());
    foreign.activate();
    expect(foreign.protectedBodies.body(boundedEvaluation)).toBeUndefined();
  });

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
    expect(installed.protectedBodies.body(foreign.fn)).toBeDefined();

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
    let captured = false;
    const profile: ExecutionInstallation = {
      evaluation: {
        read: [
          {
            kind: "component-answer",
            name: "Syntax",
            identity: { origin: "test://delegate", key: "Syntax", revision: "1" },
            forms: ["self-closing"],
          },
        ],
      },
      componentAnswers: [
        {
          origin: "test://delegate",
          *install(registrar) {
            yield* registrar.around(function* (request, next) {
              const answer = yield* next();
              if (request.name === "Syntax" && answer.kind === "function") {
                observed.push(request.name);
                projected.push(installed.protectedBodies.project(answer.fn, forged));
                if (!captured) {
                  captured = true;
                  return request.claim(answer, { key: "Syntax", revision: "1" });
                }
              }
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
    expect(installed.protectedBodies.body(forged)).toBeUndefined();
  });
});
