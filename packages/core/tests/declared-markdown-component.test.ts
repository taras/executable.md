/**
 * Tier DM — exact Markdown a trusted host declares to one execution.
 *
 * A host may ship first-party Markdown, name it, and hand it to an execution as
 * plain immutable data. Three things follow, and everything here is about one
 * of them.
 *
 * **The declaration is held to its own bytes.** The host states the origin, the
 * digest, and — when it wants to — the schemas and forms. Canonical core parses
 * the source and refuses the declaration when what the host said is not what
 * the bytes say. A build that ships different bytes under the same name never
 * reaches a document.
 *
 * **The name is claimed, not offered.** A declared component answers ahead of a
 * repository file, a workflow bundle and every registration, and
 * `Component.importComponent` middleware may observe, delegate and refuse an
 * import without being able to answer one. What a document expands is the
 * definition canonical execution produced from the declared bytes.
 *
 * **The private closure is lexical.** A declaration may carry components only
 * its own bytes may write. They resolve while canonical core is expanding that
 * declaration's body and nowhere else: not from the caller's root, not from the
 * content the caller projected through it, not from a sibling declaration, not
 * from an imported component, and not from middleware.
 *
 * The declarations are values on an `ExecutionInstallation`, so an ordinary
 * `execute()` has none and behaves exactly as it always did.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createContext, ensure, scoped, until } from "effection";
import type { Operation } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { Component } from "../src/component-api.ts";
import { collect } from "../src/collect.ts";
import { execute } from "../src/execute.ts";
import { executeInstalled, Markdown, sourceDigest } from "../host.ts";
import type {
  ExecutionDeclaration,
  ExecutionInstallation,
  ExpansionRequest,
  IdentityClaimant,
  IdentityComponent,
  MarkdownComponent,
  MarkdownComponentInput,
  Structural,
} from "../host.ts";
import { admitDeclaredMarkdown } from "../src/components/declared-markdown.ts";
import { admitExecutionDeclarations } from "../src/execution-declarations.ts";
import { selectComponent } from "../src/components/select.ts";
import { installedBundle } from "../src/components/bundle.ts";
import { inspectComponent, inspectSyntax } from "../src/inspect.ts";
import { validateDocument, validateDocumentStructure } from "../src/document-validation.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import { DocumentOutput } from "../src/api.ts";
import { useNormalizedOutput } from "../src/output/normalize.ts";
import { useTerminalOutput } from "../src/output/terminal.ts";
import { createExactSource, isExactSource } from "../src/output/exact-source.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";
import type { ImportedDefinition } from "../src/components/import-authority.ts";
import type { PropsSchema, Segment } from "../src/types.ts";

const ROOT_PATH = "documents/root.md";
const ORIGIN = "@executablemd/test/Policy.md";
const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** The declared Markdown this tier runs against, with its digest computed. */
function declared(
  source: string,
  overrides: Partial<MarkdownComponentInput> = {},
): MarkdownComponent {
  return Markdown({
    name: "Policy",
    origin: ORIGIN,
    source,
    digest: sourceDigest(source),
    ...overrides,
  });
}

const POLICY_SOURCE = ["The policy ran.", ""].join("\n");

/** The same policy, written so that only its own bytes could run it. */
const WITH_PRIVATE = ['<Secret as="answer" />', "", "policy says {answer}", ""].join("\n");

/**
 * A private component, as a declaration carries it: an ordinary identity
 * component whose implementation is built from the claimant this execution
 * minted, and which nothing registers.
 */
function secret(name = "Secret", answer = "the private answer"): IdentityComponent {
  return {
    name,
    origin: `${ORIGIN}#${name}`,
    props: NO_PROPS,
    returns: { type: "string" },
    forms: ["self-closing"],
    // deno-lint-ignore require-yield
    factory: (_claim: IdentityClaimant) =>
      function* Secret(): Operation<string> {
        return answer;
      },
  };
}

/**
 * A private component that records each entry into its body.
 *
 * A tripwire rather than a fake: what a case about the closure has to show is
 * that the implementation did not run, and rendered output cannot show that on
 * its own. It deliberately never calls its claimant — core promises the closure
 * to a private component whether or not one names durable work.
 */
function watching(entered: string[], name = "Secret"): IdentityComponent {
  return {
    name,
    origin: `${ORIGIN}#${name}`,
    props: NO_PROPS,
    returns: { type: "string" },
    forms: ["self-closing"],
    // deno-lint-ignore require-yield
    factory: () =>
      function* Secret(): Operation<string> {
        entered.push("policy");
        return "the private answer";
      },
  };
}

/**
 * A handler that keeps the private answer and returns it under `Virtual`.
 *
 * `Virtual` is an ordinary open name — nothing declares it, so answering it is
 * the supported thing DM37 protects. What is not supported is answering it with
 * something the private closure produced.
 */
function aliasing(
  through: (kept: ImportedDefinition) => ImportedDefinition = (kept) => kept,
): ExecutionInstallation {
  return {
    *install() {
      let kept: ImportedDefinition | undefined;
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            if (name === "Secret") {
              kept = yield* next(name, position);
              return kept;
            }
            if (name === "Virtual" && kept !== undefined) {
              return through(kept);
            }
            return yield* next(name, position);
          },
        },
        { at: "max" },
      );
    },
  };
}

/** Somewhere a handler can put what it kept, and read it back in a later run. */
interface Kept {
  definition?: ImportedDefinition;
}

/** A handler that delegates the private import and keeps exactly what came back. */
function retaining(kept: Kept): ExecutionInstallation {
  return {
    *install() {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            const answer = yield* next(name, position);
            if (name === "Secret") {
              kept.definition = answer;
            }
            return answer;
          },
        },
        { at: "max" },
      );
    },
  };
}

/** The same handler, later, answering an open name with what it kept. */
function answering(
  kept: Kept,
  through: (definition: ImportedDefinition) => ImportedDefinition = (definition) => definition,
): ExecutionInstallation {
  return {
    *install() {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            const stale = kept.definition;
            if (name === "Virtual" && stale !== undefined) {
              return through(stale);
            }
            return yield* next(name, position);
          },
        },
        { at: "max" },
      );
    },
  };
}

/** A private component that names its own durable work, to prove the claimant works. */
function claiming(seen: string[], name = "Claiming"): IdentityComponent {
  return {
    name,
    origin: `${ORIGIN}#${name}`,
    props: NO_PROPS,
    factory: (claim: IdentityClaimant) =>
      function* Claiming(
        _props: Record<string, Json>,
        invocation: ComponentInvocation,
      ): Operation<string> {
        seen.push(yield* claim(invocation));
        return "claimed";
      },
  };
}

function installation(declarations: readonly MarkdownComponent[]): ExecutionInstallation {
  return { declarations };
}

/** Run one root against a set of declarations, with no component search path. */
function run(
  source: string,
  declarations: readonly MarkdownComponent[] = [declared(POLICY_SOURCE)],
  extra: readonly ExecutionInstallation[] = [],
  stream: InMemoryStream = new InMemoryStream(),
  includes: readonly string[] = [],
): Operation<Json> {
  return scoped(function* () {
    return yield* collect(
      yield* executeInstalled(
        { ...retainedSource(ROOT_PATH, source), stream, includes: [...includes] },
        [installation(declarations), ...extra],
      ),
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

/** Whether one retained event is a component import. */
function isImport(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === "import_component";
}

/**
 * One run's history as a *partial* continuation: every event it recorded except
 * the terminals.
 *
 * A completed journal never enters the durable body at all — its recorded
 * result is returned whole — so a test that replayed one would prove nothing
 * about how a recorded import is read.
 */
function* continuing(stream: InMemoryStream): Operation<InMemoryStream> {
  const partial = new InMemoryStream();
  for (const event of yield* stream.readAll()) {
    if (event.type === "close") {
      continue;
    }
    yield* partial.append(event);
  }
  return partial;
}

/**
 * A directory this test owns, holding repository components.
 *
 * Named as an absolute include rather than by rebinding the working directory:
 * component lookup stats through the host filesystem, so an include is what
 * actually decides where a repository component is looked for.
 */
function* workspace(files: Record<string, string>): Operation<string> {
  const root = yield* until(realpath(yield* until(mkdtemp(join(tmpdir(), "dm-")))));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    yield* until(mkdir(join(target, ".."), { recursive: true }));
    yield* writeTextFile(target, content);
  }
  return root;
}

describe("Tier DM — a declaration is held to its own bytes", () => {
  it("DM1: a declared name resolves to the declared source with no search path", function* () {
    expect(yield* run("<Policy />\n")).toContain("The policy ran.");
  });

  it("DM2: a digest the source does not have refuses before the root is imported", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE, { digest: sourceDigest("something else") })]),
    );

    expect(message).toContain("states a digest its source does not have");
  });

  it("DM3: a props schema the source does not declare refuses", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [
        declared(POLICY_SOURCE, {
          props: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
        }),
      ]),
    );

    expect(message).toContain("states a props schema its source does not declare");
  });

  it("DM3b: a props schema the source does declare is accepted whatever order it wrote it in", function* () {
    const source = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    who: { type: string }",
      "  required: [who]",
      "  additionalProperties: false",
      "---",
      "",
      "Hello {props.who}.",
      "",
    ].join("\n");

    const output = yield* run('<Policy who="reader" />\n', [
      declared(source, {
        props: {
          additionalProperties: false,
          required: ["who"],
          properties: { who: { type: "string" } },
          type: "object",
        },
      }),
    ]);

    expect(output).toContain("Hello reader.");
  });

  it("DM4: a return the source does not declare refuses", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE, { returns: { type: "string" } })]),
    );

    expect(message).toContain("states a return its source does not declare");
  });

  it("DM5: a name that is not a component name refuses without printing it", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE, { name: "policy" })]),
    );

    expect(message).toContain("a name that is not a component name");
    expect(message).not.toContain("policy");
  });

  it("DM6: a structural name refuses", function* () {
    const message = yield* refusal(run("<Policy />\n", [declared(POLICY_SOURCE, { name: "If" })]));

    expect(message).toContain("structural syntax the engine owns");
  });

  it("DM7: one name declared twice refuses", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE), declared("Another.\n")]),
    );

    expect(message).toContain("declared as Markdown twice");
  });

  it("DM8: a name a host reserved refuses, whichever installed it", function* () {
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(POLICY_SOURCE)],
        [
          {
            *install() {
              yield* registerComponents([
                {
                  name: "Policy",
                  origin: "test://reserved",
                  props: NO_PROPS,
                  reserved: true,
                  // deno-lint-ignore require-yield
                  *fn() {
                    return "reserved";
                  },
                },
              ]);
            },
          },
        ],
      ),
    );

    expect(message).toContain("both a declared Markdown component and a reserved registration");
  });
});

describe("Tier DM — the name is claimed rather than offered", () => {
  it("DM9: a repository file of the same name cannot answer for it", function* () {
    const root = yield* workspace({ "Policy.md": "The repository file ran.\n" });

    const output = yield* run("<Policy />\n", [declared(POLICY_SOURCE)], [], new InMemoryStream(), [
      root,
    ]);

    expect(output).toContain("The policy ran.");
    expect(output).not.toContain("The repository file ran.");
  });

  it("DM9b: a repository file the declaration does not claim still answers", function* () {
    const root = yield* workspace({ "Helper.md": "The repository file ran.\n" });

    const output = yield* run("<Helper />\n", [declared(POLICY_SOURCE)], [], new InMemoryStream(), [
      root,
    ]);

    expect(output).toContain("The repository file ran.");
  });

  it("DM10: an ordinary registration cannot answer for it", function* () {
    const output = yield* run(
      "<Policy />\n",
      [declared(POLICY_SOURCE)],
      [
        {
          *install() {
            yield* registerComponents([
              {
                name: "Policy",
                origin: "test://default",
                props: NO_PROPS,
                // deno-lint-ignore require-yield
                *fn() {
                  return "the registration ran.";
                },
              },
            ]);
          },
        },
      ],
    );

    expect(output).toContain("The policy ran.");
    expect(output).not.toContain("the registration ran.");
  });

  it("DM11: a workflow component bundle cannot answer for it", function* () {
    const output = yield* run(
      "<Policy />\n",
      [declared(POLICY_SOURCE)],
      [
        {
          bundle: {
            components: [
              {
                name: "Policy",
                path: "workflows/Policy.md",
                sourceHash: "aa".padEnd(40, "0"),
                content: "The bundled component ran.\n",
              },
            ],
          },
        },
      ],
    );

    expect(output).toContain("The policy ran.");
    expect(output).not.toContain("The bundled component ran.");
  });

  it("DM12: middleware that answers an import without delegating is refused", function* () {
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(POLICY_SOURCE)],
        [
          {
            *install() {
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    if (name !== "Policy") {
                      return yield* next(name, position);
                    }
                    return {
                      kind: "markdown",
                      name: "Policy",
                      path: ORIGIN,
                      meta: {},
                      props: NO_PROPS,
                      bodySegments: [{ type: "text", content: "substituted" }],
                    };
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
      ),
    );

    expect(message).toContain("canonical execution did not produce");
  });

  it("DM13: middleware that changes the answer before it is invoked is refused", function* () {
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(POLICY_SOURCE)],
        [
          {
            *install() {
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    const answer = yield* next(name, position);
                    if (name === "Policy") {
                      Reflect.set(answer, "bodySegments", [
                        { type: "text", content: "substituted" },
                      ]);
                    }
                    return answer;
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
      ),
    );

    expect(message).toContain("changed the definition canonical execution produced");
  });

  it("DM37: an unrelated name is answered exactly as it is with nothing declared", function* () {
    // The whole point of the case: `Virtual` is a name no declaration mentions,
    // so a handler answering it is doing the ordinary supported thing. If
    // declaring an unused `Policy` changed that, every host shipping one asset
    // would have taken component substitution away from every document it runs.
    const substitute: ExecutionInstallation = {
      *install() {
        yield* Component.around(
          {
            *importComponent([name, position], next) {
              if (name !== "Virtual") {
                return yield* next(name, position);
              }
              return {
                kind: "markdown",
                name: "Virtual",
                path: "middleware://virtual",
                meta: {},
                props: NO_PROPS,
                bodySegments: [{ type: "text", content: "the handler answered." }],
              };
            },
          },
          { at: "max" },
        );
      },
    };

    const undeclared = yield* run("<Virtual />\n", [], [substitute]);
    const declaring = yield* run("<Virtual />\n", [declared(POLICY_SOURCE)], [substitute]);

    expect(undeclared).toContain("the handler answered.");
    expect(declaring).toEqual(undeclared);

    // And the declared name is still not one a handler may answer.
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(POLICY_SOURCE)],
        [
          {
            *install() {
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    if (name !== "Policy") {
                      return yield* next(name, position);
                    }
                    return {
                      kind: "markdown",
                      name: "Policy",
                      path: ORIGIN,
                      meta: {},
                      props: NO_PROPS,
                      bodySegments: [{ type: "text", content: "substituted" }],
                    };
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
      ),
    );

    expect(message).toContain("canonical execution did not produce");
  });

  it("DM14: middleware that observes and delegates sees the declared origin", function* () {
    const seen: string[] = [];
    const output = yield* run(
      "<Policy />\n",
      [declared(POLICY_SOURCE)],
      [
        {
          *install() {
            yield* Component.around(
              {
                *importComponent([name, position], next) {
                  const answer = yield* next(name, position);
                  if (answer.kind === "markdown") {
                    seen.push(`${name}:${answer.path}`);
                  }
                  return answer;
                },
              },
              { at: "max" },
            );
          },
        },
      ],
    );

    expect(output).toContain("The policy ran.");
    expect(seen).toContain(`Policy:${ORIGIN}`);
  });
});

describe("Tier DM — the private closure is lexical", () => {
  it("DM15: the declaration's own body resolves a private name", function* () {
    const output = yield* run("<Policy />\n", [declared(WITH_PRIVATE, { privates: [secret()] })]);

    expect(output).toContain("policy says the private answer");
  });

  it("DM15b: a private component names durable work through the claimant it was built with", function* () {
    const seen: string[] = [];
    const output = yield* run("<Policy />\n", [
      declared("<Claiming />\n", { privates: [claiming(seen)] }),
    ]);

    expect(output).toContain("claimed");
    expect(seen).toHaveLength(1);
  });

  it("DM16: the caller's root cannot write a private name", function* () {
    const message = yield* refusal(
      run('<Secret as="answer" />\n', [declared(WITH_PRIVATE, { privates: [secret()] })]),
    );

    expect(message).toContain("Cannot resolve component: Secret");
  });

  it("DM17: content the caller projects through the declaration cannot write one", function* () {
    const message = yield* refusal(
      run('<Policy><Secret as="answer" /></Policy>\n', [
        declared(["<Content />", ""].join("\n"), { privates: [secret()] }),
      ]),
    );

    expect(message).toContain("Cannot resolve component: Secret");
  });

  it("DM18: a sibling declaration cannot write another declaration's private name", function* () {
    const message = yield* refusal(
      run("<Other />\n", [
        declared(WITH_PRIVATE, { privates: [secret()] }),
        declared('<Secret as="answer" />\n', {
          name: "Other",
          origin: "@executablemd/test/Other.md",
        }),
      ]),
    );

    expect(message).toContain("Cannot resolve component: Secret");
  });

  it("DM19: a repository component the declaration imports cannot write one", function* () {
    const root = yield* workspace({ "Helper.md": '<Secret as="answer" />\n' });

    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared("<Helper />\n", { privates: [secret()] })],
        [],
        new InMemoryStream(),
        [root],
      ),
    );

    expect(message).toContain("Cannot resolve component: Secret");
  });

  it("DM20: middleware cannot substitute a private declaration it observed", function* () {
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(WITH_PRIVATE, { privates: [secret()] })],
        [
          {
            *install() {
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    const answer = yield* next(name, position);
                    if (name !== "Secret") {
                      return answer;
                    }
                    return { ...answer };
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
      ),
    );

    // A private import words its own refusal: what it is about is not that
    // canonical execution produced some other answer, but that this ask
    // produced this one and no answer from anywhere else authorizes it.
    expect(message).toContain("did not produce");
    expect(message).toContain("an answer kept from another import authorizes nothing here");
  });

  it("DM38: a factory replaced after capture does not become what runs", function* () {
    // The declaration object is the host's, and an installation runs after the
    // invocation captured it. Reading the factory then rather than now would
    // let a hook installed by the same host — or by anything that reached the
    // object — decide what a private name executes.
    const original = secret();
    const replaced: IdentityComponent = {
      ...original,
      // deno-lint-ignore require-yield
      factory: () =>
        function* Replacement(): Operation<string> {
          return "the replacement answer";
        },
    };
    const declaration = declared(WITH_PRIVATE, { privates: [original] });

    const output = yield* run(
      "<Policy />\n",
      [declaration],
      [
        {
          // deno-lint-ignore require-yield
          *install() {
            Reflect.set(original, "factory", replaced.factory);
          },
        },
      ],
    );

    expect(output).toContain("policy says the private answer");
    expect(String(output)).not.toContain("the replacement answer");
  });

  it("DM39: a schema mutated after capture is not the contract an invocation is held to", function* () {
    // The schema is the one member of a declaration that is a whole object
    // graph, so holding the caller's object rather than a copy of it would let
    // a hook loosen the contract after the invocation captured the declaration
    // and before admission compiled it.
    const entered: string[] = [];
    const strict: PropsSchema = { type: "object", properties: {}, additionalProperties: false };
    const original: IdentityComponent = {
      name: "Secret",
      origin: `${ORIGIN}#Secret`,
      props: strict,
      returns: { type: "string" },
      forms: ["self-closing"],
      // deno-lint-ignore require-yield
      factory: () =>
        function* Secret(): Operation<string> {
          entered.push("body");
          return "the private answer";
        },
    };
    const source = ['<Secret extra="x" as="answer" />', "", "policy says {answer}", ""].join("\n");

    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(source, { privates: [original] })],
        [
          {
            // deno-lint-ignore require-yield
            *install() {
              Reflect.set(strict, "additionalProperties", true);
            },
          },
        ],
      ),
    );

    expect(message).toContain("Secret");
    // The refusal is the contract's, so the body it guards never ran.
    expect(entered).toHaveLength(0);
  });

  it("DM40: middleware cannot reuse a delegated private answer at another site", function* () {
    // The hole this closes: a handler delegates a legitimate private import from
    // inside the declaration, keeps the exact definition canonical execution
    // produced, and hands it back when the caller's root writes the same name.
    // Authorizing by name would let the private implementation run for an
    // element the declaration never authored — which is the whole of what the
    // closure is for.
    const entered: string[] = [];
    const message = yield* refusal(
      run(
        ["<Policy />", '<Secret as="stolen" />', ""].join("\n"),
        [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
        [
          {
            *install() {
              let kept: unknown;
              yield* Component.around(
                {
                  *importComponent([name, position], next) {
                    if (name !== "Secret") {
                      return yield* next(name, position);
                    }
                    if (kept === undefined) {
                      // Inside the declaration: an ordinary delegated import,
                      // and the answer is retained rather than altered.
                      kept = yield* next(name, position);
                      return kept as never;
                    }
                    // At the caller's root: answered from what was kept.
                    return kept as never;
                  },
                },
                { at: "max" },
              );
            },
          },
        ],
      ),
    );

    expect(message).toContain("Secret");
    // The declaration's own invocation ran once. The root's did not run at all.
    expect(entered).toEqual(["policy"]);
  });

  it("DM41: a repository component cannot answer for a private name", function* () {
    const root = yield* workspace({ "Secret.md": "the repository file ran.\n" });
    const entered: string[] = [];

    const message = yield* refusal(
      run(
        ['<Secret as="answer" />', ""].join("\n"),
        [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
        [],
        new InMemoryStream(),
        [root],
      ),
    );

    // Unresolved before any tier could answer, so the file beside the caller is
    // never read and never runs.
    expect(message).toContain("Cannot resolve component: Secret");
    expect(message).not.toContain("the repository file ran.");
    expect(entered).toEqual([]);
  });

  it("DM42: describing and validating agree that the outside occurrence resolves nothing", function* () {
    const root = yield* workspace({ "Secret.md": "the repository file ran.\n" });
    const declarations = [declared(WITH_PRIVATE, { privates: [secret()] })];

    // A repository candidate exists, and it still answers for nothing: the
    // decision is `selectComponent()`'s, so execution, inspection and validation
    // cannot come to different conclusions about it.
    const info = yield* inspectComponent({ name: "Secret", includes: [root], declarations });
    expect(info.kind).toBe("unresolved");

    const catalog = yield* inspectSyntax({ includes: [root], declarations });
    for (const category of catalog.categories) {
      expect(category.entries.map((entry) => entry.name)).not.toContain("Secret");
    }

    const validation = yield* validateDocument({
      ...retainedSource(ROOT_PATH, '<Secret as="answer" />\n'),
      includes: [root],
      declarations,
    });
    expect(validation.outcome).toBe("invalid");
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component-unresolved",
    );
  });

  it("DM43: a private implementation cannot run under an unrelated open name", function* () {
    // The name is the wrong thing to check. A handler delegates a legitimate
    // private import from inside the declaration, keeps the definition, and
    // hands it back as the answer for `Virtual` — a name nothing declares, which
    // is exactly the open import DM37 protects. Restricting by name lets the
    // private implementation run under it.
    const entered: string[] = [];
    const message = yield* refusal(
      run(
        ["<Policy />", '<Virtual as="aliased" />', ""].join("\n"),
        [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
        [aliasing()],
      ),
    );

    expect(message).toContain("Virtual");
    // The declaration's own invocation ran once. The alias ran not at all.
    expect(entered).toEqual(["policy"]);
  });

  it("DM44: a copy of the private definition grants no authority either", function* () {
    // The same reach, through a definition of the handler's own making that
    // carries the implementation it kept. What is restricted is the
    // implementation, not the object it arrives in.
    const entered: string[] = [];
    const message = yield* refusal(
      run(
        ["<Policy />", '<Virtual as="aliased" />', ""].join("\n"),
        [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
        [aliasing((kept) => ({ ...kept, name: "Virtual" }))],
      ),
    );

    expect(message).toContain("Virtual");
    expect(entered).toEqual(["policy"]);
  });

  it("DM45: an answer kept past the declaration's teardown grants none", function* () {
    // The declaration has finished expanding and its closure is gone. What the
    // handler is holding is an answer from an invocation that is over, and an
    // invocation that is over authorizes nothing — under its own name or any
    // other.
    const entered: string[] = [];
    const message = yield* refusal(
      run(
        ["<Policy />", "", "the declaration is done", "", '<Virtual as="aliased" />', ""].join(
          "\n",
        ),
        [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
        [aliasing()],
      ),
    );

    expect(message).toContain("Virtual");
    expect(entered).toEqual(["policy"]);
  });

  it("DM46: a private implementation cannot be presented in a later execution", function* () {
    // The reach this closes outlives the execution that opened it. A reusable
    // installation delegates and keeps `Secret` while the declaration is being
    // expanded; that execution then ends completely. A second execution — one
    // that declares no Markdown at all, and so has no closure to consult —
    // answers the open name `Virtual` with exactly what was kept.
    const entered: string[] = [];
    const kept: Kept = {};

    const first = yield* run(
      "<Policy />\n",
      [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
      [retaining(kept)],
    );
    expect(String(first)).toContain("policy says the private answer");
    expect(entered).toEqual(["policy"]);
    expect(kept.definition).toBeDefined();

    // The first execution is over: `run()` leaves its scope, so every provider,
    // domain and closure it had is gone. What the handler is holding is an
    // answer from a run that has ended, and a run that has ended authorizes
    // nothing.
    const message = yield* refusal(run('<Virtual as="aliased" />\n', [], [answering(kept)]));

    expect(message).toContain("Virtual");
    expect(entered).toEqual(["policy"]);
  });

  it("DM47: nor can a copy of it made after that execution ended", function* () {
    const entered: string[] = [];
    const kept: Kept = {};

    yield* run(
      "<Policy />\n",
      [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
      [retaining(kept)],
    );
    expect(entered).toEqual(["policy"]);

    const message = yield* refusal(
      run(
        '<Virtual as="aliased" />\n',
        [],
        [answering(kept, (definition) => ({ ...definition, name: "Virtual" }))],
      ),
    );

    expect(message).toContain("Virtual");
    expect(entered).toEqual(["policy"]);
  });

  it("DM48: the later execution still resolves the private name to nothing", function* () {
    // The other half of the same run: a document in an execution that declares
    // nothing cannot reach the name either, and describing and validating that
    // document agree with running it.
    const entered: string[] = [];
    const kept: Kept = {};
    yield* run(
      "<Policy />\n",
      [declared(WITH_PRIVATE, { privates: [watching(entered)] })],
      [retaining(kept)],
    );

    const message = yield* refusal(run('<Secret as="answer" />\n', [], [answering(kept)]));
    expect(message).toContain("Cannot resolve component: Secret");

    const info = yield* inspectComponent({ name: "Secret", includes: [] });
    expect(info.kind).toBe("unresolved");

    const validation = yield* validateDocument({
      ...retainedSource(ROOT_PATH, '<Secret as="answer" />\n'),
      includes: [],
    });
    expect(validation.outcome).toBe("invalid");
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component-unresolved",
    );
    expect(entered).toEqual(["policy"]);
  });

  it("DM21: a private name a registration also claims refuses the declaration", function* () {
    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(WITH_PRIVATE, { privates: [secret()] })],
        [
          {
            *install() {
              yield* registerComponents([
                {
                  name: "Secret",
                  origin: "test://default",
                  props: NO_PROPS,
                  // deno-lint-ignore require-yield
                  *fn() {
                    return "registered";
                  },
                },
              ]);
            },
          },
        ],
      ),
    );

    expect(message).toContain("both a private declaration and a registration");
  });

  it("DM22: one private name declared by two declarations refuses", function* () {
    const message = yield* refusal(
      run("<Policy />\n", [
        declared(WITH_PRIVATE, { privates: [secret()] }),
        declared(WITH_PRIVATE, {
          name: "Other",
          origin: "@executablemd/test/Other.md",
          privates: [secret()],
        }),
      ]),
    );

    expect(message).toContain("is declared twice");
  });
});

describe("Tier DM — selection is journaled and replays", () => {
  it("DM23: a declared import records its origin, digest and bytes", function* () {
    const stream = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE)], [], stream);

    const selection = (yield* stream.readAll())
      .filter(isImport)
      .find((event) => event.type === "yield" && event.description.name === "Policy");

    expect(selection?.type === "yield" && selection.result).toEqual({
      status: "ok",
      value: {
        kind: "declared-markdown",
        origin: ORIGIN,
        digest: sourceDigest(POLICY_SOURCE),
        content: POLICY_SOURCE,
      },
    });
  });

  it("DM24: a partial continuation restores the import and the private one with it", function* () {
    const declarations = [declared(WITH_PRIVATE, { privates: [secret()] })];
    const first = new InMemoryStream();
    expect(yield* run("<Policy />\n", declarations, [], first)).toContain("policy says");

    const output = yield* run("<Policy />\n", declarations, [], yield* continuing(first));

    expect(output).toContain("policy says the private answer");
  });

  it("DM25: a continuation whose host no longer declares the name refuses", function* () {
    const first = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE)], [], first);

    const message = yield* refusal(
      run(
        "<Policy />\n",
        [declared(POLICY_SOURCE, { name: "Other" })],
        [],
        yield* continuing(first),
      ),
    );

    expect(message).toContain("recorded as the declared Markdown");
  });

  it("DM26: a continuation whose declared bytes changed refuses", function* () {
    const first = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE)], [], first);

    const replaced = "The policy was rewritten.\n";
    const message = yield* refusal(
      run("<Policy />\n", [declared(replaced)], [], yield* continuing(first)),
    );

    expect(message).toContain("recorded as the declared Markdown");
  });

  it("DM26b: the record carries the exact-source disposition when the host declares one", function* () {
    const stream = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE, { exact: true })], [], stream);

    const selection = (yield* stream.readAll())
      .filter(isImport)
      .find((event) => event.type === "yield" && event.description.name === "Policy");

    // Closed: `exact: true` beside the four members an ordinary record has.
    expect(selection?.type === "yield" && selection.result).toEqual({
      status: "ok",
      value: {
        kind: "declared-markdown",
        origin: ORIGIN,
        digest: sourceDigest(POLICY_SOURCE),
        content: POLICY_SOURCE,
        exact: true,
      },
    });
  });

  it("DM26c: a continuation that dropped the exact disposition refuses", function* () {
    const first = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE, { exact: true })], [], first);

    // The same name, the same origin, the same digest and the same bytes. Only
    // how they are published changed, which is enough: prose is not what this
    // run recorded producing.
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE)], [], yield* continuing(first)),
    );

    expect(message).toContain("recorded as the declared Markdown");
  });

  it("DM26d: a continuation that added the exact disposition refuses", function* () {
    const first = new InMemoryStream();
    yield* run("<Policy />\n", [declared(POLICY_SOURCE)], [], first);

    // The other direction, which absence has to be compared for rather than
    // defaulted: a host that started calling these bytes source is answering
    // differently from the run being continued.
    const message = yield* refusal(
      run("<Policy />\n", [declared(POLICY_SOURCE, { exact: true })], [], yield* continuing(first)),
    );

    expect(message).toContain("recorded as the declared Markdown");
  });

  it("DM27: an ordinary execute() declares nothing and resolves no declared name", function* () {
    const message = yield* refusal(
      scoped(function* () {
        return yield* collect(
          yield* execute({
            ...retainedSource(ROOT_PATH, "<Policy />\n"),
            stream: new InMemoryStream(),
            includes: [],
          }),
        );
      }),
    );

    expect(message).toContain("Cannot resolve component: Policy");
  });
});

describe("Tier DM — describing the environment agrees with running in it", () => {
  const declarations = [declared(WITH_PRIVATE, { privates: [secret()] })];

  it("DM28: the catalog carries the declared component and not its private names", function* () {
    const catalog = yield* inspectSyntax({ includes: [], declarations });
    const builtIn = catalog.categories[1].entries;
    const entry = builtIn.find((candidate) => candidate.name === "Policy");

    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBe("declared-markdown");
    expect(entry?.origin).toEqual({
      kind: "declared-markdown",
      origin: ORIGIN,
      digest: sourceDigest(WITH_PRIVATE),
    });
    for (const category of catalog.categories) {
      expect(category.entries.map((candidate) => candidate.name)).not.toContain("Secret");
    }
  });

  it("DM29: inspecting the name describes the declared contract without running it", function* () {
    const info = yield* inspectComponent({ name: "Policy", includes: [], declarations });

    expect(info.kind).toBe("markdown");
    expect(info.kind === "markdown" ? info.origin : undefined).toEqual({
      kind: "declared-markdown",
      origin: ORIGIN,
      digest: sourceDigest(WITH_PRIVATE),
    });
  });

  it("DM30: inspecting a private name resolves nothing", function* () {
    const info = yield* inspectComponent({ name: "Secret", includes: [], declarations });

    expect(info.kind).toBe("unresolved");
  });

  it("DM31: validation records the declared origin and checks its contract", function* () {
    const validation = yield* validateDocument({
      ...retainedSource(ROOT_PATH, "<Policy />\n"),
      includes: [],
      declarations,
    });

    expect(validation.outcome).toBe("valid");
    expect(validation.invocations.map((invocation) => invocation.origin)).toContainEqual({
      kind: "declared-markdown",
      origin: ORIGIN,
      digest: sourceDigest(WITH_PRIVATE),
    });
  });

  it("DM32: validation refuses an invocation the declared contract does not accept", function* () {
    const source = [
      "---",
      "props:",
      "  type: object",
      "  properties:",
      "    who: { type: string }",
      "  required: [who]",
      "  additionalProperties: false",
      "---",
      "",
      "Hello {props.who}.",
      "",
    ].join("\n");

    const validation = yield* validateDocument({
      ...retainedSource(ROOT_PATH, "<Policy />\n"),
      includes: [],
      declarations: [declared(source)],
    });

    expect(validation.outcome).toBe("invalid");
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain("props-invalid");
  });

  it("DM33: a private name written outside its declaration is an unresolved component", function* () {
    const validation = yield* validateDocument({
      ...retainedSource(ROOT_PATH, '<Secret as="answer" />\n'),
      includes: [],
      declarations,
    });

    expect(validation.outcome).toBe("invalid");
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "component-unresolved",
    );
  });
});

describe("Tier DM — structural validation is the same walk without the run's values", () => {
  const REQUIRING_PROPS = [
    "---",
    "props:",
    "  type: object",
    "  properties:",
    "    who: { type: string }",
    "  required: [who]",
    "  additionalProperties: false",
    "---",
    "",
    "Hello {props.who}.",
    "",
  ].join("\n");

  it("DM34: a root declaring required props is structurally valid with no values", function* () {
    const source = { ...retainedSource(ROOT_PATH, REQUIRING_PROPS), includes: [] };

    expect((yield* validateDocumentStructure(source)).outcome).toBe("valid");
    expect((yield* validateDocument(source)).outcome).toBe("invalid");
  });

  it("DM35: structural validation still reports everything else the walk decides", function* () {
    const source = {
      ...retainedSource(ROOT_PATH, `${REQUIRING_PROPS}<Missing />\n`),
      includes: [],
    };

    const validation = yield* validateDocumentStructure(source);

    expect(validation.outcome).toBe("invalid");
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "component-unresolved",
    ]);
  });

  it("DM36: structural validation answers the same version and shape", function* () {
    const source = { ...retainedSource(ROOT_PATH, "Nothing to resolve.\n"), includes: [] };

    expect(yield* validateDocumentStructure(source)).toEqual(yield* validateDocument(source));
  });
});

/**
 * Bytes that say whether they were presented or emitted.
 *
 * A line ending in spaces, a run of four newlines and an emphasis marker: the
 * whitespace middleware rewrites the first two and the terminal middleware
 * removes the third, so text that still carries all three was published as
 * source rather than as prose.
 */
const PRESENTABLE = "keep **these** markers   \n\n\n\nand this run\n";

/** Whether what a run published still carries every mark of being unpresented. */
function unpresented(published: string): boolean {
  return published.includes("**these**") && published.includes("markers   \n\n\n\n");
}

/**
 * One run, published through the presentation an ordinary `xmd run` installs.
 *
 * Both middlewares, in the order the CLI installs them, so a case here asks the
 * question a person's terminal asks: were these bytes presented, or emitted as
 * source?
 */
function* published(
  source: string,
  declarations: readonly MarkdownComponent[],
  extra: readonly ExecutionInstallation[],
): Operation<string> {
  const chunks: string[] = [];
  return yield* scoped(function* () {
    yield* useNormalizedOutput();
    yield* useTerminalOutput();
    yield* DocumentOutput.around({
      // deno-lint-ignore require-yield
      *output([text]) {
        chunks.push(text);
      },
    });
    yield* collect(
      yield* executeInstalled(
        {
          ...retainedSource(ROOT_PATH, source),
          stream: new InMemoryStream(),
          includes: [],
        },
        [installation(declarations), ...extra],
      ),
    );
    return chunks.join("");
  });
}

/** A handler that answers an open name with a definition it wrote itself. */
function answeringOpenName(definition: ImportedDefinition): ExecutionInstallation {
  return {
    *install() {
      yield* Component.around(
        {
          *importComponent([name, position], next) {
            if (name === "Virtual") {
              return definition;
            }
            return yield* next(name, position);
          },
        },
        { at: "max" },
      );
    },
  };
}

describe("Tier DM — exact source is a provenance, not a field", () => {
  it("DM49: a declared component the host called exact emits its bytes unpresented", function* () {
    // The positive control. Without it the two refusals below would pass for a
    // build where exact source never worked at all.
    const output = yield* published("<Policy />\n", [declared(PRESENTABLE, { exact: true })], []);

    expect(unpresented(output)).toBe(true);
  });

  it("DM50: an ordinary declared component is presented as prose", function* () {
    const output = yield* published("<Policy />\n", [declared(PRESENTABLE)], []);

    expect(unpresented(output)).toBe(false);
    expect(output).not.toContain("**these**");
  });

  it("DM51: middleware answering with `exact: true` gets prose", function* () {
    // The definition is the handler's own, written to claim the disposition a
    // trusted declaration states. Nothing admitted it, so nothing about it is
    // exact — the claim is data on an object, and the answer is prose.
    const output = yield* published(
      "<Virtual />\n",
      [declared(POLICY_SOURCE)],
      [
        answeringOpenName({
          kind: "markdown",
          name: "Virtual",
          path: "Virtual.md",
          meta: {},
          props: NO_PROPS,
          exact: true,
          bodySegments: [{ type: "text", content: PRESENTABLE }],
        } as unknown as ImportedDefinition),
      ],
    );

    expect(unpresented(output)).toBe(false);
    expect(output).not.toContain("**these**");
  });

  it("DM53: a component that reaches for the record by context name gets prose", function* () {
    // Effection contexts resolve by name, so a name is not a secret: anything
    // that can run code can build a context with the same one. This is the
    // attack that closes — a function component nobody trusts asks for the
    // record, corrupts whatever it finds, and then returns prose that would be
    // published unpresented if the corruption had worked.
    let reached = false;

    const output = yield* published(
      "<Virtual />\n",
      [declared(POLICY_SOURCE)],
      [
        answeringOpenName({
          kind: "function",
          name: "Virtual",
          path: "Virtual.ts",
          props: NO_PROPS,
          *fn() {
            const stolen = createContext<{ has?: unknown } | undefined>(
              "xmd.exact-source",
              undefined,
            );
            const record = yield* stolen.get();
            if (record !== undefined) {
              reached = true;
              // Every segment is exact, if anything asks this object.
              record.has = () => true;
            }
            return PRESENTABLE;
          },
        } as unknown as ImportedDefinition),
      ],
    );

    // The record is not reachable by name at all, which is the property under
    // test; the assertion below holds either way, because reaching it would
    // still decide nothing.
    expect(reached).toBe(false);
    expect(unpresented(output)).toBe(false);
    expect(output).not.toContain("**these**");
  });

  it("DM52: a segment this engine did not mark is prose, whatever it carries", function* () {
    // The other half of the same attack: not the definition claiming the
    // disposition, but segments arriving already wearing the mark. Two
    // assertions, because they prove different things.
    //
    // First the seam itself. The record of what is exact is keyed by the
    // identity of the segment objects canonical expansion marked, so an object
    // carrying any field at all — including the one an earlier design used —
    // answers false. This is the assertion that discriminates: a marker that
    // consulted a field would pass it back.
    const record = createExactSource();
    expect(
      isExactSource(record, {
        type: "text",
        content: PRESENTABLE,
        exact: true,
      } as unknown as Segment),
    ).toBe(false);
    expect(
      isExactSource(record, { type: "text", content: PRESENTABLE } as unknown as Segment),
    ).toBe(false);

    // Then the end-to-end shape, which records a second fact worth keeping:
    // expansion rebuilds text segments, so a field a definition wrote onto its
    // own body never reaches the emission loop to begin with. That is defence
    // in depth rather than the defence — the assertion above is what holds if
    // expansion ever starts passing segments through by reference.
    const output = yield* published(
      "<Virtual />\n",
      [declared(POLICY_SOURCE)],
      [
        answeringOpenName({
          kind: "markdown",
          name: "Virtual",
          path: "Virtual.md",
          meta: {},
          props: NO_PROPS,
          bodySegments: [{ type: "text", content: PRESENTABLE, exact: true }],
        } as unknown as ImportedDefinition),
      ],
    );

    expect(unpresented(output)).toBe(false);
    expect(output).not.toContain("**these**");
  });
});

/**
 * Tier MDK — `Markdown({…})` is how a declaration says what it is.
 *
 * A host hands an execution declarations as plain immutable data, and the value
 * now says what it is. That matters because everything else about a declaration
 * is a statement *about* exact Markdown: a value that never said it was
 * Markdown, admitted on the strength of having a `source` and a `digest`, would
 * be one whose shape decided what it meant.
 *
 * `Markdown({…})` is the canonical way to build one, and it writes the
 * discriminant after the host's description, so an input carrying a `kind` of
 * its own is overwritten rather than believed. It is a constructor and nothing
 * else — nothing is hashed, copied deeply, frozen or admitted there — and it is
 * a convention rather than a gate: the declaration type is structural, so what
 * actually defends the execution is admission.
 *
 * Admission reads the discriminant before it reads any other member, and what
 * it reads is what the execution captured before any installation ran — so a
 * declaration that states something else, or nothing, is refused where it is
 * installed rather than where a document writes the name.
 */

/** A declaration as a host that states no kind at all would hand it over. */
function withoutKind(declaration: MarkdownComponent): MarkdownComponent {
  const copy = { ...declaration };
  Reflect.deleteProperty(copy, "kind");
  return copy;
}

/** A declaration stating a kind this version does not know. */
function statingKind(declaration: MarkdownComponent, kind: string) {
  const copy = { ...declaration };
  Reflect.set(copy, "kind", kind);
  return copy;
}

/** What one execution refused with, as the error itself. */
function* refusedBy(operation: Operation<unknown>): Operation<Error> {
  try {
    yield* operation;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  throw new Error("expected the operation to be refused");
}

describe("Tier MDK — the declaration states its kind", () => {
  // deno-lint-ignore require-yield
  it("MDK1: the constructor states the kind and changes nothing else", function* () {
    const props: PropsSchema = { type: "object", properties: {}, additionalProperties: false };
    const privates = [secret()];
    const input: MarkdownComponentInput = {
      name: "Policy",
      origin: ORIGIN,
      source: POLICY_SOURCE,
      digest: sourceDigest(POLICY_SOURCE),
      forms: ["paired"],
      props,
      privates,
      exact: true,
    };

    const declaration = Markdown(input);

    // A fresh object carrying the fixed discriminant, with the host's own
    // description untouched.
    expect(declaration).not.toBe(input);
    expect(declaration.kind).toBe("markdown");
    expect(Reflect.has(input, "kind")).toBe(false);
    expect(declaration.name).toBe(input.name);
    expect(declaration.origin).toBe(input.origin);
    expect(declaration.source).toBe(input.source);
    // The digest is the host's statement about its own bytes; the constructor
    // neither computes nor replaces one.
    expect(declaration.digest).toBe(input.digest);
    expect(declaration.forms).toEqual(["paired"]);
    expect(declaration.exact).toBe(true);
    // Shallow by contract: what arrives is what leaves, so nothing here is the
    // copy an execution makes at capture.
    expect(declaration.props).toBe(props);
    expect(declaration.privates).toBe(privates);
    expect(Object.isFrozen(declaration)).toBe(false);

    // A kind planted on the input cannot decide what the declaration is: the
    // constructor writes its own after spreading.
    const planted = { ...input };
    Reflect.set(planted, "kind", "structural");
    expect(Markdown(planted).kind).toBe("markdown");
  });

  it("MDK1: a constructed declaration behaves exactly as it always did", function* () {
    const declarations = [declared(POLICY_SOURCE)];

    // Selection and expansion.
    expect(String(yield* run("<Policy />\n", declarations))).toContain("The policy ran.");

    // Inspection reports the same declared contract.
    const info = yield* inspectComponent({ name: "Policy", includes: [], declarations });
    expect(info.kind).toBe("markdown");
    expect(info.kind === "markdown" ? info.origin : undefined).toEqual({
      kind: "declared-markdown",
      origin: ORIGIN,
      digest: sourceDigest(POLICY_SOURCE),
    });

    // Validation resolves it rather than reporting it unresolved.
    const validation = yield* validateDocumentStructure({
      ...retainedSource(ROOT_PATH, "<Policy />\n"),
      includes: [],
      declarations,
    });
    expect(validation.outcome).toBe("valid");

    // And the private closure still resolves only inside the declaring bytes.
    const withPrivate = [declared(WITH_PRIVATE, { privates: [secret()] })];
    expect(String(yield* run("<Policy />\n", withPrivate))).toContain("policy says");
    expect(yield* refusal(run('<Secret as="answer" />\n', withPrivate))).toContain(
      "Cannot resolve component: Secret",
    );
  });

  it("MDK2: the kind is what admission reads first, before any other member", function* () {
    // Every other member fails if it is read at all, so an admission that
    // reached one before deciding about the kind ends this row with that
    // failure instead of the refusal.
    const hostile = declared(POLICY_SOURCE);
    Reflect.set(hostile, "kind", "sparkle");
    for (const member of ["name", "origin", "source", "digest", "forms", "privates"]) {
      Object.defineProperty(hostile, member, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`admission read "${member}" before deciding about the kind`);
        },
      });
    }

    const error = yield* refusedBy(admitDeclaredMarkdown([hostile], new Map()));
    expect(error.name).toBe("DeclaredMarkdownError");
    expect(error.message).toContain("without saying it is exact Markdown");

    // The positive control: the same admission, with the kind restored, reads
    // those members and refuses on what they say instead.
    const readable = declared("Other bytes.\n", { digest: sourceDigest(POLICY_SOURCE) });
    const mismatch = yield* refusedBy(admitDeclaredMarkdown([readable], new Map()));
    expect(mismatch.message).toContain("states a digest its source does not have");
  });

  it("MDK2: a missing or unknown kind refuses before the root import", function* () {
    const stated = declared(POLICY_SOURCE);

    for (const broken of [withoutKind(stated), statingKind(stated, "sparkle")]) {
      const stream = new InMemoryStream();
      const error = yield* refusedBy(run("<Policy />\n", [broken], [], stream));

      expect(error.name).toBe("DeclaredMarkdownError");
      expect(error.message).toContain("without saying it is exact Markdown");
      // Before the root import: nothing was imported, and the root body — which
      // would have rendered its own text — never ran.
      const events = yield* stream.readAll();
      expect(events.filter((event) => event.type === "yield").length).toBe(0);
    }

    // The positive control: the same bytes, stating their kind, run.
    expect(String(yield* run("<Policy />\n", [stated]))).toContain("The policy ran.");
  });

  it("MDK3: the admitted kind is the one capture read, once, before install()", function* () {
    const declaration = declared(POLICY_SOURCE);
    let reads = 0;
    // After the first read this declaration says it is something else. If
    // anything downstream of capture read the host's object again — admission,
    // selection, the symbols — it would get that second answer and refuse.
    Object.defineProperty(declaration, "kind", {
      configurable: true,
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? "markdown" : "sparkle";
      },
    });

    const order: string[] = [];
    const mutating: ExecutionInstallation = {
      declarations: [declaration],
      *install() {
        order.push(`install after ${reads} read`);
        Reflect.deleteProperty(declaration, "kind");
        yield* Component.operations.registry;
      },
    };

    const output = String(
      yield* scoped(function* () {
        return yield* collect(
          yield* executeInstalled(
            {
              ...retainedSource(ROOT_PATH, "<Policy />\n"),
              stream: new InMemoryStream(),
              includes: [],
            },
            [mutating],
          ),
        );
      }),
    );

    expect(output).toContain("The policy ran.");
    expect(reads).toBe(1);
    expect(order).toEqual(["install after 1 read"]);
  });
});

/**
 * Tier ED — one declaration catalog, holding both arms.
 *
 * A host declares exact Markdown and structural syntax in one list, and every
 * path that decides what a name means reads that one catalog. Three things
 * follow.
 *
 * **A structural pair is declared, not assembled.** A construct declares
 * itself, each region declares which construct it belongs to, and what a
 * construct accepts is derived from the regions that named it. A half — a
 * region whose construct nobody declared, a construct with no region,
 * declarations with no handler, a handler with no declarations — describes an
 * execution that could admit syntax it can never expand, and is refused before
 * the root document is read.
 *
 * **One name, one answer.** A declared name is claimed across both arms and
 * across installations, ahead of a repository file and every ordinary
 * registration, and never over the engine's own syntax or a protected
 * component.
 *
 * **The handler is captured, not called.** The installation that declares a
 * construct supplies the one handler for it, read once before any `install()`.
 * Nothing here invokes one: what a document writing a declared construct does
 * is the next layer's contract.
 */

const DECK_ORIGIN = "@executablemd/test/deck";

const PANEL_PROPS: PropsSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

/** The construct this tier declares, with one region, `<Panel>`. */
function deck(overrides: Partial<Structural> = {}): Structural {
  return {
    kind: "structural",
    name: "Deck",
    origin: DECK_ORIGIN,
    forms: ["paired"],
    props: { type: "object", properties: {}, additionalProperties: false },
    syntax: ['<Deck><Panel title="One">…</Panel></Deck>'],
    description: "Lay out the panels written inside it.",
    context: "The panels this deck lays out.",
    parent: null,
    ...overrides,
  };
}

/** One region of that construct. */
function panel(overrides: Partial<Structural> = {}): Structural {
  return {
    kind: "structural",
    name: "Panel",
    origin: DECK_ORIGIN,
    forms: ["self-closing", "paired"],
    props: structuredClone(PANEL_PROPS),
    syntax: ['<Panel title="One">…</Panel>'],
    description: "One panel of a deck.",
    context: "Markdown the panel holds.",
    parent: "Deck",
    ...overrides,
  };
}

/**
 * A declaration a host built without one of its members.
 *
 * Written by removing the member from a complete declaration, the way the
 * malformed-discriminant fixtures above are: what a row is about is the value a
 * host actually handed over, not a shape this test described instead.
 */
function without(declaration: Structural, member: string): Structural {
  const copy = { ...declaration };
  Reflect.deleteProperty(copy, member);
  return copy;
}

/** A handler that records what it was asked to expand, and expands nothing. */
function expanding(seen: string[] = []): (request: ExpansionRequest) => Operation<void> {
  // deno-lint-ignore require-yield
  return function* expand(request: ExpansionRequest): Operation<void> {
    seen.push(request.name);
  };
}

/** An installation declaring structural syntax, with the handler that expands it. */
function declaring(
  declarations: readonly ExecutionDeclaration[],
  expand: (request: ExpansionRequest) => Operation<void> = expanding(),
): ExecutionInstallation {
  return { declarations, expand };
}

/**
 * What a run refused with, having read no root and imported nothing.
 *
 * Both halves are the claim: a declaration set that cannot describe one
 * environment is refused where it is installed, which is before the root
 * document is read and therefore before anything it says can happen.
 */
function* refusedBeforeRoot(
  installations: readonly ExecutionInstallation[],
  source = "The root ran.\n",
): Operation<string> {
  const stream = new InMemoryStream();
  const message = yield* refusal(
    scoped(function* () {
      return yield* collect(
        yield* executeInstalled(
          { ...retainedSource(ROOT_PATH, source), stream, includes: [] },
          installations,
        ),
      );
    }),
  );
  const events = yield* stream.readAll();
  expect(events.filter((event) => event.type === "yield").length).toBe(0);
  return message;
}

describe("Tier ED — one catalog, two arms", () => {
  it("ED1: both arms coexist in capture order, and Markdown keeps its behavior", function* () {
    const declarations = [declared(POLICY_SOURCE), deck(), panel()];

    // The Markdown arm, unchanged: it selects, expands and describes itself.
    expect(String(yield* run("<Policy />\n", [], [declaring(declarations)]))).toContain(
      "The policy ran.",
    );
    const policy = yield* inspectComponent({ name: "Policy", includes: [], declarations });
    expect(policy.kind).toBe("markdown");

    // The structural arm, from the same list.
    const construct = yield* inspectComponent({ name: "Deck", includes: [], declarations });
    expect(construct.kind).toBe("declared-structural");

    // A value that states neither arm is refused as it always was, in the words
    // the Markdown admission owns.
    const broken = { ...declared(POLICY_SOURCE) };
    Reflect.set(broken, "kind", "sparkle");
    const message = yield* refusedBeforeRoot([declaring([broken, deck(), panel()])]);
    expect(message).toContain("without saying it is exact Markdown");
  });

  it("ED2: declarations and the handler are captured once, before install()", function* () {
    const properties: Record<string, Json> = { title: { type: "string" } };
    const props: PropsSchema = { type: "object", properties, additionalProperties: false };
    const construct = { ...deck(), description: "As captured.", props };
    const region = panel();
    const markdown = declared(POLICY_SOURCE);
    let reads = 0;
    const order: string[] = [];

    const installation: ExecutionInstallation = {
      declarations: [markdown, construct, region],
      get expand() {
        reads++;
        return expanding();
      },
      *install() {
        // Everything a host could still be holding, rewritten after capture.
        Reflect.set(construct, "description", "Rewritten after capture.");
        Reflect.set(construct, "name", "Rewritten");
        Reflect.set(properties, "smuggled", { type: "string" });
        Reflect.set(region, "parent", "Rewritten");
        Reflect.set(markdown, "source", "The policy was replaced.\n");
        order.push(`install after ${reads} handler read`);
        yield* Component.operations.registry;
      },
    };

    const output = String(yield* run("<Syntax />\n<Policy />\n", [], [installation]));

    expect(reads).toBe(1);
    expect(order).toEqual(["install after 1 handler read"]);
    // What the run describes and expands is what it captured.
    expect(output).toContain("As captured.");
    expect(output).not.toContain("Rewritten after capture.");
    expect(output).toContain("### `<Deck>`");
    expect(output).not.toContain("### `<Rewritten>`");
    expect(output).not.toContain("smuggled");
    expect(output).toContain("The policy ran.");
  });

  it("ED3: several constructs and interleaved regions pair inside one installation", function* () {
    const declarations = [
      deck(),
      deck({ name: "Shelf", syntax: ["<Shelf><Card /></Shelf>"] }),
      panel(),
      panel({ name: "Card", syntax: ["<Card />"], parent: "Shelf" }),
      panel({ name: "Cover", syntax: ["<Cover />"] }),
    ];

    const catalog = yield* inspectSyntax({ includes: [], declarations });
    const names = catalog.categories[0].entries.map((entry) => entry.name);
    expect(names).toContain("Deck");
    expect(names).toContain("Shelf");
    expect(names).toContain("Card");
    // Beside the engine's own constructs rather than instead of them.
    expect(names).toContain("If");
  });

  it("ED3: a pair that cannot expand refuses before the root is read", function* () {
    const cases: readonly (readonly [string, readonly ExecutionInstallation[], string])[] = [
      [
        "a region whose construct nobody declared",
        [declaring([panel()])],
        'is a region of "Deck", which this execution does not declare',
      ],
      [
        "a region of a region",
        [declaring([deck(), panel(), panel({ name: "Cover", parent: "Panel" })])],
        "which is itself a region",
      ],
      [
        "a pair split across two installations",
        [declaring([deck(), panel()]), declaring([panel({ name: "Cover" })])],
        "which another installation declared",
      ],
      ["a construct with no region", [declaring([deck()])], "declares no region"],
      [
        "declarations with no handler",
        [{ declarations: [deck(), panel()] }],
        "declared structural syntax and supplied no expansion handler",
      ],
      [
        "a handler with no declarations",
        [{ declarations: [declared(POLICY_SOURCE)], expand: expanding() }],
        "supplied a structural expansion handler and declared no structural syntax",
      ],
    ];

    for (const [described, installations, expected] of cases) {
      const message = yield* refusedBeforeRoot(installations);
      expect(`${described}: ${message}`).toContain(expected);
    }
  });

  it("ED4: one name twice refuses, whichever arm and order it arrives in", function* () {
    const collisions: readonly (readonly [string, readonly ExecutionInstallation[], string])[] = [
      [
        "the same arm twice",
        [declaring([deck(), panel(), deck()])],
        "was declared as structural syntax twice",
      ],
      [
        "structural after Markdown",
        [declaring([declared(POLICY_SOURCE, { name: "Deck" }), deck(), panel()])],
        "declared as both structural syntax and Markdown",
      ],
      [
        "Markdown after structural, in another installation",
        [
          declaring([deck(), panel()]),
          { declarations: [declared(POLICY_SOURCE, { name: "Deck" })] },
        ],
        "declared as both structural syntax and Markdown",
      ],
      [
        "a structural name some declaration keeps to itself",
        [
          { declarations: [declared(WITH_PRIVATE, { privates: [secret()] })] },
          declaring([deck({ name: "Secret" }), panel({ parent: "Secret" })]),
        ],
        "both declared structural syntax and a private declaration",
      ],
    ];

    for (const [described, installations, expected] of collisions) {
      expect(`${described}: ${yield* refusedBeforeRoot(installations)}`).toContain(expected);
    }

    // The positive control: distinct names across two installations coexist.
    const catalog = yield* inspectSyntax({
      includes: [],
      declarations: [declared(POLICY_SOURCE), deck(), panel()],
    });
    expect(catalog.categories[1].entries.map((entry) => entry.name)).toContain("Policy");
    expect(catalog.categories[0].entries.map((entry) => entry.name)).toContain("Deck");
  });

  it("ED5: a declared construct claims its name ahead of a repository file", function* () {
    const root = yield* workspace({ "Deck.md": "The repository file ran.\n" });
    const declarations = [deck(), panel()];

    const claimed = yield* inspectComponent({ name: "Deck", includes: [root], declarations });
    if (claimed.kind !== "declared-structural") {
      throw new Error(`expected installed structural syntax, got ${claimed.kind}`);
    }
    expect(claimed.origin).toEqual({ kind: "declared-structural", origin: DECK_ORIGIN });

    // The control: the same file, with nothing declared, is what answers.
    const unclaimed = yield* inspectComponent({ name: "Deck", includes: [root] });
    expect(unclaimed.kind).toBe("markdown");
  });

  it("ED5: engine syntax, a protected name and a reserved registration cannot be claimed", function* () {
    const engine = yield* refusedBeforeRoot([
      declaring([deck({ name: "If" }), panel({ parent: "If" })]),
    ]);
    expect(engine).toContain("structural syntax the engine owns");

    const owned = yield* refusedBeforeRoot([
      declaring([deck({ name: "Syntax" }), panel({ parent: "Syntax" })]),
    ]);
    expect(owned).toContain("canonical core owns that name");

    const reserved = yield* refusedBeforeRoot([
      declaring([deck(), panel()]),
      {
        *install() {
          yield* registerComponents([
            {
              name: "Deck",
              origin: "test://reserved",
              props: NO_PROPS,
              reserved: true,
              // deno-lint-ignore require-yield
              *fn() {
                return "reserved";
              },
            },
          ]);
        },
      },
    ]);
    expect(reserved).toContain("both declared structural syntax and a reserved registration");
  });

  it("ED10: with nothing declared, the names are unresolved and a file is a component", function* () {
    const info = yield* inspectComponent({ name: "Deck", includes: [] });
    expect(info.kind).toBe("unresolved");

    // A repository file under the name is an ordinary component, not syntax.
    const root = yield* workspace({ "Deck.md": "The repository file ran.\n" });
    const repository = yield* inspectComponent({ name: "Deck", includes: [root] });
    expect(repository.kind).toBe("markdown");
    expect(String(yield* run("<Deck />\n", [], [], new InMemoryStream(), [root]))).toContain(
      "The repository file ran.",
    );

    // And the engine's own structural behavior is what it always was.
    expect(
      String(yield* run("<If condition={true}>branch taken</If>\n", [], [], new InMemoryStream())),
    ).toContain("branch taken");
  });
});

describe("Tier ED — the catalog answers for the set", () => {
  it("ED1: capture refuses an unknown kind before it reads anything else", function* () {
    // Every other member throws if it is read, and the installation records
    // whether it ever ran: capture decides about the discriminant before either
    // could happen.
    const hostile = { ...declared(POLICY_SOURCE) };
    Reflect.set(hostile, "kind", "sparkle");
    for (const member of ["name", "origin", "source", "digest", "forms", "privates"]) {
      Object.defineProperty(hostile, member, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`capture read "${member}" before deciding about the kind`);
        },
      });
    }

    const installed: string[] = [];
    const stream = new InMemoryStream();
    const error = yield* refusedBy(
      scoped(function* () {
        return yield* collect(
          yield* executeInstalled(
            { ...retainedSource(ROOT_PATH, "The root ran.\n"), stream, includes: [] },
            [
              { declarations: [hostile] },
              {
                *install() {
                  installed.push("install");
                  yield* Component.operations.registry;
                },
              },
            ],
          ),
        );
      }),
    );

    expect(error.name).toBe("DeclaredMarkdownError");
    expect(error.message).toContain("without saying it is exact Markdown");
    expect(installed).toEqual([]);
    expect((yield* stream.readAll()).filter((event) => event.type === "yield").length).toBe(0);

    // And it is the same sentence the Markdown admission gives, so the two
    // spellings of this refusal cannot drift apart.
    const admission = yield* refusedBy(admitDeclaredMarkdown([hostile], new Map()));
    expect(error.message).toBe(admission.message);
  });

  it("ED3: every catalog refusal is an ExecutionDeclarationError", function* () {
    const malformed: readonly (readonly [string, Structural])[] = [
      ["no forms", without(deck(), "forms")],
      ["no parent", without(deck(), "parent")],
      ["an empty origin", { ...deck(), origin: "" }],
      ["no syntax examples", { ...deck(), syntax: [] }],
      ["an empty description", { ...deck(), description: "" }],
      ["a context that is neither prose nor null", { ...deck(), context: "" }],
      // The schema rule stays registration's; only the error class is this
      // catalog's, so a host gets one answer to "is this set installable".
      ["a schema that will not compile", { ...deck(), props: { type: "not-a-type" } }],
    ];

    for (const [described, construct] of malformed) {
      const error = yield* refusedBy(
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              { ...retainedSource(ROOT_PATH, "x\n"), stream: new InMemoryStream(), includes: [] },
              [declaring([construct, panel()])],
            ),
          );
        }),
      );
      expect(`${described}: ${error.name}`).toBe(`${described}: ExecutionDeclarationError`);
    }

    // The cross-arm and relationship refusals answer the same way.
    const crossArm: readonly (readonly [string, readonly ExecutionInstallation[]])[] = [
      [
        "a name in both arms",
        [declaring([deck(), panel(), declared(POLICY_SOURCE, { name: "Deck" })])],
      ],
      ["an orphan region", [declaring([panel()])]],
      ["a construct with no region", [declaring([deck()])]],
      ["declarations with no handler", [{ declarations: [deck(), panel()] }]],
    ];

    for (const [described, installations] of crossArm) {
      const error = yield* refusedBy(
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              { ...retainedSource(ROOT_PATH, "x\n"), stream: new InMemoryStream(), includes: [] },
              installations,
            ),
          );
        }),
      );
      expect(`${described}: ${error.name}`).toBe(`${described}: ExecutionDeclarationError`);
    }
  });

  it("ED5: a construct claims its name ahead of a bundle member and a default", function* () {
    const declarations = [deck(), panel()];

    // A registered default under the same name loses to the declaration, and
    // answers for it when nothing is declared.
    const registering: ExecutionInstallation = {
      *install() {
        yield* registerComponents([
          {
            name: "Deck",
            origin: "test://default",
            props: NO_PROPS,
            // deno-lint-ignore require-yield
            *fn() {
              return "the registered default ran.";
            },
          },
        ]);
      },
    };

    const claimed = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Deck",
          origin: "test://default",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn() {
            return "the registered default ran.";
          },
        },
      ]);
      return yield* inspectComponent({ name: "Deck", includes: [], declarations });
    });
    expect(claimed.kind).toBe("declared-structural");

    // The control: the same registration, with nothing declared, is what
    // answers — so the declaration is what moved the decision.
    const unclaimed = yield* scoped(function* () {
      yield* registerComponents([
        {
          name: "Deck",
          origin: "test://default",
          props: NO_PROPS,
          // deno-lint-ignore require-yield
          *fn() {
            return "the registered default ran.";
          },
        },
      ]);
      return yield* inspectComponent({ name: "Deck", includes: [] });
    });
    expect(unclaimed.kind).toBe("registered");

    // And a declared construct is not reached through component import at all,
    // so the losing default never runs.
    const message = yield* refusal(run("<Deck />\n", [], [declaring(declarations), registering]));
    expect(message).toContain("never resolves a component");
    expect(message).not.toContain("the registered default ran.");
  });

  it("ED5: a construct claims its name ahead of a workflow bundle member", function* () {
    const catalog = yield* admitExecutionDeclarations([deck(), panel()], new Map());
    const bundle = installedBundle(
      [
        {
          components: [
            {
              name: "Deck",
              path: "components/Deck.md",
              sourceHash: "0".repeat(40),
              content: "the bundled component ran.\n",
            },
          ],
        },
      ],
      new Map(),
    );

    const claimed = yield* selectComponent("Deck", {
      includes: [],
      declared: catalog,
      workflow: bundle,
    });
    expect(claimed).toEqual({ kind: "structural", origin: DECK_ORIGIN });

    // The control: the same bundle, with nothing declared, is what answers — so
    // the declaration is what moved the decision, and the bundle member is a
    // component rather than syntax wherever it does answer.
    const bundled = yield* selectComponent("Deck", { includes: [], workflow: bundle });
    expect(bundled.kind).toBe("workflow");
    if (bundled.kind !== "workflow") {
      throw new Error(`expected the bundle member, got ${bundled.kind}`);
    }
    expect(bundled.path).toBe("components/Deck.md");
    expect(bundled.content).toContain("the bundled component ran.");
  });

  it("ED7: both structural selection arms are `structural`, and reach their own consumers", function* () {
    const catalog = yield* admitExecutionDeclarations([deck(), panel()], new Map());

    const declared = yield* selectComponent("Deck", { includes: [], declared: catalog });
    const engine = yield* selectComponent("If", { includes: [], declared: catalog });

    // One kind, two arms: what tells them apart is what each carries.
    expect(declared).toEqual({ kind: "structural", origin: DECK_ORIGIN });
    expect(engine).toEqual({ kind: "structural", construct: "If" });
    // Spelled as whole objects above, and again as key sets, so a field added
    // to either — a schema, the forms, the regions, a handler — fails this row
    // rather than passing unnoticed.
    expect(Object.keys(declared).sort()).toEqual(["kind", "origin"]);
    expect(Object.keys(engine).sort()).toEqual(["construct", "kind"]);

    // And each reaches the consumer that owns it: inspection reports the
    // engine's construct as the engine's, and the installation's under its own
    // provenance with the contract the host declared.
    const engineInfo = yield* inspectComponent({ name: "If", includes: [] });
    expect(engineInfo.kind).toBe("structural");
    const declaredInfo = yield* inspectComponent({
      name: "Deck",
      includes: [],
      declarations: [deck(), panel()],
    });
    if (declaredInfo.kind !== "declared-structural") {
      throw new Error(`expected installed structural syntax, got ${declaredInfo.kind}`);
    }
    expect(declaredInfo.origin).toEqual({ kind: "declared-structural", origin: DECK_ORIGIN });
  });

  it("ED7: an execution that declares nothing still has a catalog, and it changes nothing", function* () {
    const empty = yield* admitExecutionDeclarations([], new Map());

    expect(empty.names()).toEqual([]);
    expect(empty.structural("Deck")).toBeUndefined();
    expect(empty.component("Policy")).toBeUndefined();
    expect(empty.markdown()).toEqual([]);
    expect(empty.isPrivate("Secret")).toBe(false);

    // Every selection answers exactly as it does with no catalog at all.
    for (const name of ["If", "Deck", "Glob"]) {
      expect(yield* selectComponent(name, { includes: [], declared: empty })).toEqual(
        yield* selectComponent(name, { includes: [] }),
      );
    }
  });
});
