/**
 * The deterministic dependencies one nested execution is declared with
 * (specs/testing-spec.md, "Deterministic Agent and elicitation
 * configuration").
 *
 * A test that runs another document sometimes needs that document to meet an
 * Agent that answers the same way every time, or an elicitation that does not
 * wait for a person. Neither is something the child can be edited to say: the
 * child is the thing under test, and a test that changed it would be testing
 * something else.
 *
 * So the declaration is written in the test and what it produces is *data*.
 *
 * ```mdx
 * <Execution host="run" target="./prompt.md" as="run">
 *   <TestAgent>
 *     <TestAgent.Scenario session="review" src="./agents/review.md" />
 *   </TestAgent>
 *
 *   <Answers>
 *     <Answer template="Approve?" value={{ decision: "approve" }} />
 *   </Answers>
 *
 *   <AssertEquals actual={run.result.ok} expected={true} />
 * </Execution>
 * ```
 *
 * ## Why data, and why closed
 *
 * The child is a real root in a scope of its own, and the trusted host is what
 * assembles it. If a test could hand that host a provider, an installation or a
 * scope, the host would be running something the test built — and the child
 * would no longer be `xmd run` with configuration, it would be whatever the
 * test wrote. So what crosses is a closed union of frozen values, and every
 * variant names a domain that owns its own assembly on the other side.
 *
 * Closed is the load-bearing half. An open "configuration" bag is a provider
 * tunnel with extra steps: the host would have to decide what an unknown member
 * means, and the only safe answers are to refuse it or to trust it. A union the
 * host switches over exhaustively has neither problem, and adding a variant is
 * a deliberate act in both packages.
 *
 * ## How a declaration is recognized
 *
 * By the definition ordinary resolution selected, never by the name. A
 * repository `TestAgent.md` is an ordinary component: it ends the declaration
 * scan and expands with the assertions, configuring nothing. A package that
 * contributes a declaration hands over the exact definitions it registered, and
 * the harness substitutes a declaration-reading expansion for those and for
 * nothing else.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/core";
import type { AnswerMatcher } from "@executablemd/core/host";

/** Everything one `<Execution>`'s declarations configured, in declared order. */
export type ChildConfiguration = TestAgentChildConfiguration | AnswersChildConfiguration;

/** One `<TestAgent.Scenario>` mapping, normalized where it was written. */
export interface ChildScenario {
  /** The agent this mapping answers for, with the declaration's default applied. */
  readonly agent: string;
  /** The logical session, or the empty string for the unnamed one. */
  readonly session: string;
  /**
   * Whether this mapping answers for any of its agent's sessions that no exact
   * mapping claims.
   *
   * For a conversation whose name the test cannot write down. `<Plan>` is the
   * case it exists for: it derives its session from the expansion that asked,
   * so there is no name an author could put here. An exact mapping always wins,
   * and an agent may declare at most one of these — it is an explicit opt-out
   * of exact matching, never what omitting `session` means.
   */
  readonly anySession?: boolean;
  /** The containment root the behavior document's dependencies resolve under. */
  readonly rootDir: string;
  readonly document: { readonly path: string; readonly source: string };
}

/** Scripted Agent behavior for one child, as `<TestAgent>` declared it. */
export interface TestAgentChildConfiguration {
  readonly kind: "test-agent";
  readonly defaultAgent: string;
  readonly scenarios: readonly ChildScenario[];
}

/** Elicitation answers for one child, as `<Answers>` declared them. */
export interface AnswersChildConfiguration {
  readonly kind: "answers";
  readonly matchers: readonly AnswerMatcher[];
  readonly bindings: Readonly<Record<string, string>>;
}

/**
 * What a declaration reports to the `<Execution>` that owns it.
 *
 * A declaration raises nothing. It configures a child no root has imported yet,
 * so a mistake in it is the *execution's* refusal — reported where the element
 * was written, before anything runs.
 */
export interface ChildConfigurationCollector {
  configure(configuration: ChildConfiguration): void;
  refuse(problem: string): void;
}

/** The expansion a declaration's direct child is read by. */
export type ChildDeclarationChild = (props: Record<string, Json>) => Operation<unknown>;

/**
 * One package's contribution: the definition its declaration must resolve to,
 * and how to read one bound to a particular execution's collector.
 */
export interface ChildDeclaration {
  /** The authored element name, for the sentences a refusal is written in. */
  readonly name: string;
  /** The exact registered definition ordinary resolution must have selected. */
  readonly definition: unknown;
  open(collect: ChildConfigurationCollector): OpenChildDeclaration;
}

/** One declaration, bound to the execution whose configuration it reads. */
export interface OpenChildDeclaration {
  readonly name: string;
  /** Read this declaration element. Renders nothing and installs nothing. */
  expand(props: Record<string, Json>): Operation<unknown>;
  /**
   * The definitions accepted as direct children, by the exact definition each
   * must resolve to. A repository component shadowing one of these names is
   * malformed child configuration rather than an ordinary component: it sits
   * inside a declaration, which is not a place ordinary content may be.
   */
  readonly children: ReadonlyMap<unknown, ChildDeclarationChild>;
}

/**
 * The configuration a child runs under, detached from the document that
 * declared it.
 *
 * Public host middleware sees the request after this, and the chain unwinds
 * before the terminal creates a child — so a handler that kept a reference and
 * edited it afterwards would otherwise change what runs. Every layer is copied
 * and frozen: the union, its arrays, each parsed template, the bindings, the
 * scenario documents, and the JSON each matcher answers with.
 */
export function detachChildConfiguration(
  configuration: readonly ChildConfiguration[],
): readonly ChildConfiguration[] {
  return frozen(configuration.map(detachOne));
}

function detachOne(configuration: ChildConfiguration): ChildConfiguration {
  switch (configuration.kind) {
    case "test-agent":
      return frozen({
        kind: configuration.kind,
        defaultAgent: configuration.defaultAgent,
        scenarios: frozen(configuration.scenarios.map(detachScenario)),
      });
    case "answers":
      return frozen({
        kind: configuration.kind,
        matchers: frozen(configuration.matchers.map(detachMatcher)),
        bindings: frozen({ ...configuration.bindings }),
      });
  }
}

function detachScenario(scenario: ChildScenario): ChildScenario {
  return frozen({
    agent: scenario.agent,
    session: scenario.session,
    ...(scenario.anySession === true ? { anySession: true } : {}),
    rootDir: scenario.rootDir,
    document: frozen({ path: scenario.document.path, source: scenario.document.source }),
  });
}

function detachMatcher(matcher: AnswerMatcher): AnswerMatcher {
  const value = detachJson(matcher.value);
  if (matcher.template === undefined) {
    return frozen({ value });
  }
  return frozen({
    value,
    template: frozen({
      source: matcher.template.source,
      tokens: frozen(matcher.template.tokens.map((token) => frozen({ ...token }))),
      captureNames: frozen([...matcher.template.captureNames]),
    }),
  });
}

/** A JSON value nothing that received it can change. */
export function detachJson(value: Json): Json {
  if (Array.isArray(value)) {
    return frozen(value.map((member) => detachJson(member)));
  }
  if (typeof value === "object" && value !== null) {
    return detachJsonObject(value);
  }
  return value;
}

export function detachJsonObject(value: Record<string, Json>): Record<string, Json> {
  return frozen(
    Object.fromEntries(Object.entries(value).map(([key, member]) => [key, detachJson(member)])),
  );
}

/** Frozen at runtime, unchanged to the type system. */
export function frozen<T>(value: T): T {
  Object.freeze(value);
  return value;
}
