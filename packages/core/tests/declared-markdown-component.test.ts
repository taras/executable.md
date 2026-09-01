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
import { ensure, scoped, until } from "effection";
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
import { executeInstalled, sourceDigest } from "../host.ts";
import type {
  DeclaredMarkdownComponent,
  ExecutionInstallation,
  IdentityClaimant,
  IdentityComponent,
} from "../host.ts";
import { inspectComponent, inspectSyntax } from "../src/inspect.ts";
import { validateDocument, validateDocumentStructure } from "../src/document-validation.ts";
import { registerComponents } from "../src/components/registration.ts";
import { retainedSource } from "../src/root-source.ts";
import type { ComponentInvocation } from "../src/invocation-identity.ts";

const ROOT_PATH = "documents/root.md";
const ORIGIN = "@executablemd/test/Policy.md";
const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** The declared Markdown this tier runs against, with its digest computed. */
function declared(
  source: string,
  overrides: Partial<DeclaredMarkdownComponent> = {},
): DeclaredMarkdownComponent {
  return {
    name: "Policy",
    origin: ORIGIN,
    source,
    digest: sourceDigest(source),
    ...overrides,
  };
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

function installation(declarations: readonly DeclaredMarkdownComponent[]): ExecutionInstallation {
  return { declarations };
}

/** Run one root against a set of declarations, with no component search path. */
function run(
  source: string,
  declarations: readonly DeclaredMarkdownComponent[] = [declared(POLICY_SOURCE)],
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

    expect(message).toContain("canonical execution did not produce");
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
