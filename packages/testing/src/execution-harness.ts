/**
 * `<Execution>`, `<WorkflowRun>` and the declarations that configure them
 * (specs/testing-spec.md).
 *
 * A Markdown test can already assert about components, commands, output and
 * failures — everything *inside* one document execution. What it could not do
 * is run another document as a root: an entrypoint's own props, its own return,
 * its own journal policy, and the workflow lifecycle are all decisions made at
 * the boundary a document never crosses from the inside. The fallback was a
 * TypeScript test, which makes the lower-level mechanism easier to reach than
 * the authored one.
 *
 * This is that boundary, authored:
 *
 * ```mdx
 * <Test name="bootstraps a package">
 *   <Execution host="run" target="./scripts/bootstrap.md" props={{ name: "x" }} as="run">
 *     <CollectOutput as="output" />
 *
 *     <AssertEqual actual={run.kind} expected="settled" />
 *   </Execution>
 * </Test>
 * ```
 *
 * It is not `<Call>`. `<Call>` composes structure inside the current execution
 * and deliberately reuses its journal, Workspace and error handling. This
 * creates a real child: its own root import, its own journal, its own scope and
 * teardown, and — under the workflow profile — its own durable run.
 *
 * ## Two phases, one body
 *
 * `<Execution>` owns its children as a harness rather than as a wrapper. The
 * declarations have to be *installed* before the child imports its root, and the
 * assertions have to run *after* the child has settled and its observations are
 * complete. A single left-to-right expansion cannot do both, because the same
 * list holds both kinds of child.
 *
 * So the body is read twice. The first pass is a scan: it expands the
 * declaration prefix and stops at the first element that is not a declaration,
 * which is where assertion content begins. Stopping is a refusal raised into
 * the projection — the same thing that ends any expansion early — so nothing
 * beyond the prefix runs, and what the prefix rendered is discarded. The second
 * pass, after the child is over, is the ordinary one: the declarations answer
 * with what they observed, and the assertions follow.
 *
 * A declaration is recognized by the definition it resolves to, never by its
 * name. A repository `CollectOutput.md` is an ordinary component, so the scan
 * ends where it is written and it expands with the assertions — which is the
 * same rule canonical `<Test>` is decided by.
 *
 * ## Authority
 *
 * The definitions that can run a child are the ones canonical `<Test>` handed a
 * harness to: `testHarnessInstallation()` is called from inside the invocation
 * with that invocation's harness, and registers `<Execution>` and
 * `<WorkflowRun>` with the harness in their closure, shadowing the refusing
 * defaults for exactly that test's body. Nothing asks for the capability and
 * nothing can — it is never written to a context, a prop, an Api argument or
 * this package's module state. Every invocation spends a single-use
 * authorization and runs its child through a terminal it created for itself;
 * public host-profile middleware composes around that terminal and can observe,
 * refuse or delegate, and can do nothing else, because the request it
 * holds runs nothing.
 */

import { createContext, createScope, ensure, Err, Ok, scoped, useScope } from "effection";
import type { Context, Operation, Result, Scope } from "effection";
import { createApi } from "@effectionx/context-api";
import {
  Component,
  documented,
  ephemeral,
  DocumentOutput,
  hasBinding,
  hasContent,
  raise,
  registerComponents,
  tryContent,
} from "@executablemd/core";
import type {
  ComponentDefinition,
  FunctionComponentDefinition,
  Json,
  PropsSchema,
  SourcePosition,
} from "@executablemd/core";
import { AnswersDeclaration } from "@executablemd/core/host";
import type {
  AnswerConfiguration,
  ExecutionInstallation,
  TestHarness,
  TestHarnessBinding,
} from "@executablemd/core/host";
import { issueHostRequest } from "./execution-host.ts";
import type {
  ChildConfiguration,
  ChildConfigurationCollector,
  ChildDeclaration,
  OpenChildDeclaration,
} from "./child-configuration.ts";
import type {
  ChildSettlement,
  ExecutionHostApi,
  ExecutionHostProvider,
  HostProfileRequest,
  JournalPolicy,
  WorkflowRunScope,
} from "./execution-host.ts";

/**
 * The end of the declaration prefix.
 *
 * Thrown from the scan's own middleware and caught by the scan, so it never
 * reaches a document, a journal or a test result. It carries no message worth
 * reading: nothing went wrong, the prefix simply ended.
 */
class ScanBoundary extends Error {
  override name = "ScanBoundary";
}

/** What the declarations selected, and what went wrong while selecting it. */
interface DeclaredConfiguration {
  diagnostic: boolean;
  collectOutput: boolean;
  collectJournal: boolean;
  /** The deterministic dependencies declared for the child, in declared order. */
  readonly child: ChildConfiguration[];
  readonly problems: string[];
}

/**
 * One `<Execution>` invocation's state, as its declarations see it.
 *
 * `phase` is what makes a declaration mean two different things in the two
 * passes without either pass knowing about the other: during `scan` it records
 * a choice, and during `assert` it answers with what was observed.
 */
interface HarnessState {
  phase: "scan" | "assert";
  readonly configuration: DeclaredConfiguration;
  settlement: ChildSettlement | undefined;
}

/**
 * The child-configuration declarations one `<Execution>` recognized, and where.
 *
 * Held beside `HarnessState` rather than in it, because nothing authored reads
 * any of it: the collector, the open declarations and the recognized sites are
 * this invocation's own bookkeeping, and the configuration it produces is read
 * back from this closure when the host request is issued.
 */
interface DeclarationScan {
  readonly collect: ChildConfigurationCollector;
  /** By the exact definition each declaration must resolve to. */
  readonly open: ReadonlyMap<unknown, OpenChildDeclaration>;
  /**
   * Where each recognized declaration was written.
   *
   * The assertion pass re-expands the same elements, so what it must not do is
   * expand them a second time as ordinary content. A site is stable across both
   * passes; an expansion path is not, because the second projection of one
   * request derives a path of its own (§5.6).
   */
  readonly recognized: Set<string>;
  /** The declaration currently reading its own children, while it reads them. */
  inside: OpenChildDeclaration | undefined;
}

const Declarations: Context<HarnessState | undefined> = createContext<HarnessState | undefined>(
  "testing.execution.declarations",
  undefined,
);

/** One `<WorkflowRun>` scope, shared by the attempts written inside it. */
interface WorkflowRunState {
  readonly scope: WorkflowRunScope;
  /** A run exists only once a start has been accepted, as in production. */
  started: boolean;
}

const CurrentWorkflowRun: Context<WorkflowRunState | undefined> = createContext<
  WorkflowRunState | undefined
>("testing.execution.workflow-run", undefined);

const EMPTY_PROPS: PropsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const EXECUTION_PROPS: PropsSchema = {
  type: "object",
  properties: {
    host: { type: "string" },
    target: { type: "string" },
    source: { type: "string" },
    action: { type: "string" },
    props: { type: "object" },
  },
  required: ["host"],
  additionalProperties: false,
};

export const WORKFLOW_RUN_PROPS: PropsSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  additionalProperties: false,
};

export const DIAGNOSTIC_JOURNAL_PROPS: PropsSchema = EMPTY_PROPS;
export const COLLECT_OUTPUT_PROPS: PropsSchema = EMPTY_PROPS;
export const COLLECT_JOURNAL_PROPS: PropsSchema = EMPTY_PROPS;

/**
 * Report a configuration failure as this element's own.
 *
 * Raised for the observation chain — which is what fails the enclosing test —
 * and returned as text for the document, so a reader outside a test sees the
 * sentence where the element was written.
 */
function* refuse(source: string, message: string): Operation<string> {
  const reported = yield* raise({ type: "error", message: `<${source}> ${message}`, source });
  return reported.message;
}

/**
 * The state a declaration belongs to, or a refusal naming where it is valid.
 *
 * A declaration outside `<Execution>` is a mistake in the document rather than
 * a silent no-op: it looks like configuration and would configure nothing.
 */
function* declarationState(source: string): Operation<HarnessState | undefined> {
  const state = yield* Declarations.get();
  if (state === undefined) {
    yield* refuse(source, "is valid only as a declaration inside <Execution>.");
    return undefined;
  }
  return state;
}

function* DiagnosticJournal(): Operation<Json> {
  const state = yield* declarationState("DiagnosticJournal");
  if (state === undefined) {
    return "";
  }
  if (state.phase === "scan") {
    if (state.configuration.diagnostic) {
      state.configuration.problems.push("<DiagnosticJournal> is declared more than once.");
    }
    state.configuration.diagnostic = true;
  }
  return "";
}

function* CollectOutput(): Operation<unknown> {
  const state = yield* declarationState("CollectOutput");
  if (state === undefined) {
    return "";
  }
  if (!(yield* hasBinding())) {
    return yield* refuse(
      "CollectOutput",
      'binds the child output it accumulates, so it requires `as`: <CollectOutput as="output" />.',
    );
  }
  if (state.phase === "scan") {
    if (state.configuration.collectOutput) {
      state.configuration.problems.push("<CollectOutput> is declared more than once.");
    }
    state.configuration.collectOutput = true;
    return "";
  }
  // Complete after settlement, and the partial prefix when the child failed or
  // was cancelled — whatever the host observed, unchanged.
  return state.settlement?.output ?? "";
}

function* CollectJournal(): Operation<unknown> {
  const state = yield* declarationState("CollectJournal");
  if (state === undefined) {
    return "";
  }
  if (!(yield* hasBinding())) {
    return yield* refuse(
      "CollectJournal",
      'binds the child journal it observes, so it requires `as`: <CollectJournal as="journal" />.',
    );
  }
  if (state.phase === "scan") {
    if (state.configuration.collectJournal) {
      state.configuration.problems.push("<CollectJournal> is declared more than once.");
    }
    state.configuration.collectJournal = true;
    return "";
  }
  // Read-only, and only what the host already retained: observation never
  // enabled retention, so there is nothing here to append to or replay from.
  return Object.freeze([...(state.settlement?.journal ?? [])]);
}

/** The definitions the scan treats as declarations, by identity. */
const DECLARATIONS: ReadonlySet<unknown> = new Set<unknown>([
  DiagnosticJournal,
  CollectOutput,
  CollectJournal,
]);

/**
 * Whether a resolved definition runs a function at all.
 *
 * A Markdown component runs a document, so it is never one of ours and never
 * one a package contributed: identity is a function, and this is what says
 * whether there is one to compare.
 */
function isFunctionComponent(
  definition: ComponentDefinition | FunctionComponentDefinition,
): definition is FunctionComponentDefinition {
  return "fn" in definition;
}

/** Whether a resolved definition is one of this module's declarations. */
function isDeclaration(definition: ComponentDefinition | FunctionComponentDefinition): boolean {
  return isFunctionComponent(definition) && DECLARATIONS.has(definition.fn);
}

/**
 * Where one element was written.
 *
 * The two passes read the same segments, so an element's position is the same
 * in both. A dynamically scanned element carrying no position of its own falls
 * back to its name, which is as much identity as it has.
 */
function siteOf(position: Readonly<SourcePosition> | undefined, name: string): string {
  if (position === undefined) {
    return `!${name}`;
  }
  return `${position.path ?? ""}#${position.offset}`;
}

/** A declaration the assertion pass meets again: read once, and never twice. */
// deno-lint-ignore require-yield
function* alreadyDeclared(): Operation<string> {
  return "";
}

/**
 * A definition standing in for the one the author wrote, run in its place.
 *
 * Everything the resolved definition declares about itself stays — its props
 * schema included — so a declaration is validated as the component it is
 * written as. Only what it does changes.
 */
function substituting(
  definition: FunctionComponentDefinition,
  fn: (props: Record<string, Json>) => Operation<unknown>,
): FunctionComponentDefinition {
  return { ...definition, fn };
}

/**
 * A definition that replaces one entirely, props schema included.
 *
 * What is written inside a declaration is not a component, whatever it
 * resolved to — a Markdown file included. So this keeps nothing of what was
 * resolved: it accepts whatever props were written and reports why they
 * configure nothing.
 */
function inert(
  fn: (props: Record<string, Json>) => Operation<unknown>,
): FunctionComponentDefinition {
  return { kind: "function", name: fn.name, fn, props: ANY_PROPS };
}

const ANY_PROPS: PropsSchema = { type: "object", additionalProperties: true };

/**
 * What one `<Execution>` element asked for, once its props are read.
 *
 * Every refusal is a sentence about the element rather than about the run, so
 * the failure carries no cause: what went wrong is the way the element was
 * written, and it is already said in full.
 */
function readProfile(
  props: Record<string, Json>,
  configuration: DeclaredConfiguration,
  run: WorkflowRunState | undefined,
): Result<HostProfileRequest> {
  const host = props.host;
  if (host !== "run" && host !== "workflow") {
    return Err(new Error('requires host="run" or host="workflow".'));
  }
  const target = typeof props.target === "string" ? props.target : undefined;
  const source = typeof props.source === "string" ? props.source : undefined;
  const action = typeof props.action === "string" ? props.action : undefined;
  const childProps =
    props.props !== undefined && typeof props.props === "object" && !Array.isArray(props.props)
      ? (props.props as Record<string, Json>)
      : {};

  if (host === "run") {
    if (action !== undefined) {
      return Err(new Error('`action` belongs to host="workflow".'));
    }
    if ((target === undefined) === (source === undefined)) {
      return Err(new Error('host="run" takes exactly one of `target` or `source`.'));
    }
    if (configuration.collectJournal && !configuration.diagnostic) {
      return Err(
        new Error(
          "<CollectJournal> observes a journal the host selected; a transient run has none. " +
            "Declare <DiagnosticJournal /> to select one.",
        ),
      );
    }
    const journal: JournalPolicy = configuration.diagnostic ? "diagnostic" : "transient";
    return Ok({
      host,
      ...(target === undefined ? {} : { target }),
      ...(source === undefined ? {} : { source }),
      props: childProps,
      journal,
      collectJournal: configuration.collectJournal,
      ...(configuration.child.length === 0 ? {} : { configuration: configuration.child }),
    });
  }

  // Deterministic providers are the run profile's. A workflow attempt reaches
  // its Agent and its elicitations through the run it belongs to, so a
  // declaration here would configure something this profile does not assemble.
  if (configuration.child.length > 0) {
    return Err(
      new Error(
        `<${writtenAs(configuration.child[0]!.kind)}> configures a host="run" child, and this ` +
          'execution is host="workflow".',
      ),
    );
  }
  if (run === undefined) {
    return Err(new Error('host="workflow" is valid only inside <WorkflowRun>.'));
  }
  if (configuration.diagnostic) {
    return Err(
      new Error(
        "<DiagnosticJournal> selects diagnostic run retention; a workflow always uses its own " +
          "durable journal.",
      ),
    );
  }
  if (action !== "start" && action !== "resume") {
    return Err(new Error('host="workflow" requires action="start" or action="resume".'));
  }
  if (action === "start") {
    if (target === undefined) {
      return Err(new Error('action="start" requires `target`.'));
    }
    if (source !== undefined) {
      return Err(new Error('action="start" runs a stored definition and rejects `source`.'));
    }
    if (run.started) {
      return Err(
        new Error('one <WorkflowRun> accepts one start; later attempts use action="resume".'),
      );
    }
  } else {
    if (target !== undefined || source !== undefined) {
      return Err(new Error('action="resume" continues the run <WorkflowRun> already names.'));
    }
    if (!run.started) {
      return Err(new Error('action="resume" needs a start in this <WorkflowRun> first.'));
    }
  }
  return Ok({
    host,
    action,
    ...(target === undefined ? {} : { target }),
    props: childProps,
    journal: "workflow",
    collectJournal: configuration.collectJournal,
  });
}

/**
 * `<WorkflowRun>` — one real workflow run, in storage the test owns.
 *
 * The isolation is temporary ownership rather than simulated durability: the
 * start, the journal, the suspension, the retained result and the resume are
 * the production ones, kept somewhere that belongs to this scope and is removed
 * with it. Two scopes declaring the same public id are still two runs, because
 * the storage is per-scope and the id is only what the run calls itself.
 */
function authorizedWorkflowRun(harness: TestHarness, provider: ExecutionHostProvider | undefined) {
  return harness.component(function* WorkflowRun(
    props: Record<string, Json>,
    _binding: TestHarnessBinding,
  ): Operation<unknown> {
    return yield* runWorkflowScope(props, harness, provider);
  });
}

function* runWorkflowScope(
  props: Record<string, Json>,
  harness: TestHarness,
  provider: ExecutionHostProvider | undefined,
): Operation<unknown> {
  if (provider === undefined) {
    return yield* refuse(
      "WorkflowRun",
      "needs a trusted host profile, and this execution has none installed.",
    );
  }
  const openRun = provider.useWorkflowRun;
  if (openRun === undefined) {
    return yield* refuse(
      "WorkflowRun",
      "needs a host that can execute workflow runs, and this one has no workflow profile.",
    );
  }
  try {
    harness.authorize().spend();
  } catch (error) {
    return yield* refuse("WorkflowRun", message(error));
  }
  const id = typeof props.id === "string" ? props.id : undefined;
  // Acquired in this frame, so the private root is removed when the invocation
  // is dismantled — before the test that owns it reports anything.
  const scope = yield* openRun.call(provider, id === undefined ? {} : { id });
  yield* CurrentWorkflowRun.set({ scope, started: false });
  if (!(yield* hasContent())) {
    return "";
  }
  const body = yield* tryContent();
  if (body.failure !== undefined) {
    throw body.failure;
  }
  return body.text;
}

/**
 * `<Execution>` — one nested root execution under a production host profile.
 */
function authorizedExecution(
  harness: TestHarness,
  provider: ExecutionHostProvider | undefined,
  declarations: readonly ChildDeclaration[],
) {
  return harness.component(function* Execution(
    props: Record<string, Json>,
    binding: TestHarnessBinding,
  ): Operation<unknown> {
    return yield* runNestedExecution(props, harness, provider, declarations, binding);
  });
}

/**
 * The bookkeeping one `<Execution>`'s child-configuration declarations run
 * against.
 *
 * Ordered by declaration, at most one of each kind, and every problem a
 * declaration found reported as this element's own. A declaration never raises:
 * what it configures is a child no root has imported, so a mistake in it is a
 * refusal before the child rather than a failure inside one.
 */
function declarationScan(
  configuration: DeclaredConfiguration,
  declarations: readonly ChildDeclaration[],
): DeclarationScan {
  const collect: ChildConfigurationCollector = {
    configure(declared: ChildConfiguration): void {
      if (configuration.child.some((existing) => existing.kind === declared.kind)) {
        configuration.problems.push(`<${writtenAs(declared.kind)}> is declared more than once.`);
        return;
      }
      configuration.child.push(declared);
    },
    refuse(problem: string): void {
      configuration.problems.push(problem);
    },
  };
  const open = new Map<unknown, OpenChildDeclaration>();
  for (const declaration of declarations) {
    open.set(declaration.definition, declaration.open(collect));
  }
  return { collect, open, recognized: new Set<string>(), inside: undefined };
}

/** What a configuration kind is written as, for the sentence that refuses it. */
function writtenAs(kind: ChildConfiguration["kind"]): string {
  switch (kind) {
    case "test-agent":
      return "TestAgent";
    case "answers":
      return "Answers";
  }
}

/**
 * Collect the `<Answers>` core dispatches structurally.
 *
 * Set in the invocation's own frame, so the content projected into it reads it
 * and the child — which runs in a scope that does not descend from this one —
 * does not. It carries no authority: what it records is read back from this
 * invocation's own closure, so a recorder set further in records into nothing
 * anybody reads.
 */
function* recordAnswers(state: HarnessState, declared: DeclarationScan): Operation<void> {
  const parsed = new Set<string>();
  yield* AnswersDeclaration.set({
    declares(site: string): "parse" | "parsed" | undefined {
      if (state.phase === "scan") {
        return "parse";
      }
      return parsed.has(site) ? "parsed" : undefined;
    },
    record(site: string, configuration: Result<AnswerConfiguration>): void {
      parsed.add(site);
      if (!configuration.ok) {
        declared.collect.refuse(configuration.error.message);
        return;
      }
      declared.collect.configure({ kind: "answers", ...configuration.value });
    },
  });
}

function* runNestedExecution(
  props: Record<string, Json>,
  harness: TestHarness,
  provider: ExecutionHostProvider | undefined,
  declarations: readonly ChildDeclaration[],
  binding: TestHarnessBinding,
): Operation<unknown> {
  if (provider === undefined) {
    return yield* refuse(
      "Execution",
      "needs a trusted host profile, and this execution has none installed.",
    );
  }
  // Named `grant`, not for the concept — this is the harness authorization —
  // but because the credential gate reads that word followed by an assignment as
  // a secret-bearing field, and source travels through that gate as diff text on
  // its way into a review's journal.
  let grant;
  try {
    grant = harness.authorize();
  } catch (error) {
    return yield* refuse("Execution", message(error));
  }

  const state: HarnessState = {
    phase: "scan",
    configuration: {
      diagnostic: false,
      collectOutput: false,
      collectJournal: false,
      child: [],
      problems: [],
    },
    settlement: undefined,
  };
  const declared = declarationScan(state.configuration, declarations);
  yield* Declarations.set(state);
  yield* recordAnswers(state, declared);
  yield* installScan(state, declared);

  if (yield* hasContent()) {
    yield* scanDeclarations();
  }
  state.phase = "assert";

  const run = yield* CurrentWorkflowRun.get();
  const profile = readProfile(props, state.configuration, run);
  // A declaration problem is reported ahead of a prop problem: the declarations
  // are what the author wrote first, and one of them being wrong is why the
  // profile could not be read.
  const problem =
    state.configuration.problems[0] ?? (profile.ok ? undefined : profile.error.message);
  if (problem !== undefined || !profile.ok) {
    // Before the child's root is imported, so a malformed harness leaves no
    // execution, no journal entry and no workflow run behind.
    return yield* refuse("Execution", problem ?? "is malformed.");
  }

  const collected: string[] = [];
  const wanted = state.configuration.collectOutput;
  const host = yield* hostScope();
  const settlement = yield* runChild(provider, profile.value, run, grant, {
    *chunk(text: string): Operation<void> {
      // Both, always, in one place: display is what the harness does with child
      // output and collection is what it keeps, so neither can change the other.
      // A child that is not collected takes the identical path, so collection
      // cannot be what makes display happen — or stop happening.
      if (wanted) {
        collected.push(text);
      }
      yield* host.run(() => ephemeral(DocumentOutput.operations.output(text)));
    },
  });
  state.settlement = { ...settlement, output: wanted ? collected.join("") : settlement.output };
  if (run !== undefined && profile.value.action === "start") {
    run.started = true;
  }

  const bound = binding.has();
  if (bound) {
    // Published before the assertion body expands, because the body is *about*
    // this outcome. What the invocation returns is the same value, so the
    // binding the engine finally makes is the one already read here.
    yield* binding.publish(settlement.outcome);
  } else if (settlement.outcome.kind === "settled" && !settlement.outcome.result.ok) {
    // No binding means nothing can assert about the failure, and a test that
    // ran a failing document and said nothing passed vacuously.
    yield* refuse(
      "Execution",
      `ran a child that failed: ${settlement.outcome.result.error.message}`,
    );
  }

  const text = yield* expandAssertions();
  return bound ? settlement.outcome : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install the scan's interception for this invocation.
 *
 * Installed in the invocation's own frame rather than a nested scope, because
 * projected content anchors to the invocation and would not see it otherwise.
 * Every handler reads `state.phase`, so the second pass runs with the same
 * middleware in place and nothing intercepted.
 */
function* installScan(state: HarnessState, declared: DeclarationScan): Operation<void> {
  yield* Component.around(
    {
      *importComponent([name, position], next) {
        const definition = yield* next(name, position);
        if (state.phase !== "scan") {
          // A declaration the scan already read. Expanding it again would run
          // it as the ordinary component it is written as — which for
          // `<TestAgent>` is a provider installed in the test that ran the
          // child.
          if (
            !declared.recognized.has(siteOf(position, name)) ||
            !isFunctionComponent(definition)
          ) {
            return definition;
          }
          return substituting(definition, alreadyDeclared);
        }

        const nested = declared.inside;
        if (nested !== undefined) {
          // Inside a recognized declaration, where ordinary content is not a
          // thing that may be written. Only the exact definitions that
          // declaration accepts are its children, so a repository component
          // shadowing one of those names is malformed configuration rather
          // than a component that renders where it was written.
          const child = isFunctionComponent(definition)
            ? nested.children.get(definition.fn)
            : undefined;
          if (child !== undefined && isFunctionComponent(definition)) {
            return substituting(definition, child);
          }
          return inert(function* refuseNested(): Operation<string> {
            declared.collect.refuse(
              `<${nested.name}> configures a child, so it accepts only its own declarations, ` +
                `and <${name}> here resolves to something else.`,
            );
            return "";
          });
        }

        const open = isFunctionComponent(definition) ? declared.open.get(definition.fn) : undefined;
        if (open !== undefined && isFunctionComponent(definition)) {
          declared.recognized.add(siteOf(position, name));
          return substituting(definition, function* declaring(props): Operation<unknown> {
            declared.inside = open;
            try {
              return yield* open.expand(props);
            } finally {
              declared.inside = undefined;
            }
          });
        }
        if (!isDeclaration(definition)) {
          throw new ScanBoundary(name);
        }
        return definition;
      },
      *applyModifiers([modifiers, block], next) {
        if (state.phase === "scan") {
          throw new ScanBoundary(block.blockId);
        }
        return yield* next(modifiers, block);
      },
      *applyBoundModifiers([modifiers, block], next) {
        if (state.phase === "scan") {
          throw new ScanBoundary(block.blockId);
        }
        return yield* next(modifiers, block);
      },
      *raise([segment], next) {
        // The scan's own stop arrives here as an ordinary component failure the
        // engine turned into a segment. Rethrown rather than reported, so it
        // ends the projection instead of printing into a discarded buffer — and
        // so an enclosing `<Test>` never sees a failure that did not happen.
        if (state.phase === "scan") {
          throw new ScanBoundary(segment.source ?? "");
        }
        return yield* next(segment);
      },
    },
    { at: "min" },
  );
}

/**
 * Expand the declaration prefix, and stop where it ends.
 *
 * The rendered text is discarded: a declaration renders nothing, and whatever
 * whitespace or prose sat between two of them is rendered again by the second
 * pass. Only a failure that is not the scan's own stop is a real one.
 */
function* scanDeclarations(): Operation<void> {
  const scanned = yield* tryContent();
  const failure = scanned.failure;
  if (failure !== undefined && !carriesScanBoundary(failure)) {
    throw failure;
  }
}

/** Expand the assertion body, with the outcome and observations already bound. */
function* expandAssertions(): Operation<string> {
  if (!(yield* hasContent())) {
    return "";
  }
  const body = yield* tryContent();
  if (body.failure !== undefined) {
    throw body.failure;
  }
  return body.text;
}

/** Whether a failure is, or wraps, the scan's own stop. */
function carriesScanBoundary(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof ScanBoundary) {
    return true;
  }
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some((e) => carriesScanBoundary(e, seen))) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined
    ? carriesScanBoundary(error.cause, seen)
    : false;
}

/**
 * Ask the host for one child, through this invocation's own terminal.
 *
 * The public chain composes around a request that runs nothing. The terminal is
 * the default handler of an Api instance created here and reachable from
 * nowhere else, so a handler that answers without delegating produces no child,
 * and a request another invocation issued is refused rather than run.
 */
function* runChild(
  provider: ExecutionHostProvider,
  profile: HostProfileRequest,
  run: WorkflowRunState | undefined,
  grant: { spend(): void },
  channel: { chunk(text: string): Operation<void> },
): Operation<ChildSettlement> {
  const issued = issueHostRequest(profile);
  const terminal = createApi<ExecutionHostApi>("ExecutionHost", {
    // deno-lint-ignore require-yield
    *run(request): Operation<void> {
      issued.consume(request);
    },
  });
  // Whatever a handler returns is not a child, so it is not read.
  yield* terminal.operations.run(issued.request);
  const settled = issued.settle();
  // Spent only once the chain has agreed there is a child to run, and never
  // twice: two nested executions are two authorizations.
  grant.spend();
  return yield* inIsolation(function* (childScope) {
    return yield* childScope.run(() =>
      provider.runChild({ request: settled, run: run?.scope, chunk: channel.chunk }),
    );
  });
}

/**
 * Run one child in a scope of its own, owned by this invocation.
 *
 * A child is a *root* execution, so it must not inherit what the document
 * running it installed: the outer testing session's collectors and its
 * one-execution guard, the outer host's output routing and service adapters,
 * the outer document's contextual providers and middleware. Every one of those
 * is contextual, and context is inherited — so the only way for the child not
 * to inherit them is for its scope not to descend from theirs.
 *
 * Ownership is kept all the same, and by the ordinary means: the scope is
 * destroyed when this invocation is dismantled, so cancelling or completing the
 * test halts the child and waits for its teardown before anything else in the
 * test proceeds. Detached is about what the child *reads*, not about who ends
 * it.
 */
function* inIsolation<T>(body: (scope: Scope) => Operation<T>): Operation<T> {
  // Scoped, so the child's teardown completes before this returns rather than
  // when the invocation is finally dismantled. What a declaration installed
  // there — a controlled Agent provider, its worker, its controller — belongs
  // to the child, and the outcome is published to the assertions that follow
  // only once all of it has finished.
  return yield* scoped(function* () {
    const [childScope, destroy] = createScope();
    yield* ensure(() => destroy());
    return yield* body(childScope);
  });
}

/**
 * The scope the harness itself runs in, for work that belongs to this document.
 *
 * Forwarding a child's output is the outer document's own effect — it is this
 * element rendering — so it runs here rather than in the child's scope, where
 * this document's output channel does not exist.
 */
function* hostScope(): Operation<Scope> {
  return yield* useScope();
}

/**
 * What the name `Execution` means where no `<Test>` delivered a harness.
 *
 * Registered by `installTestingComponents`, so the element is recognized
 * everywhere and refuses everywhere — including inside a canonical `<Test>`
 * whose host attached no installer. The authorized definition is registered by
 * the installer *inside* the invocation, where it shadows this one for exactly
 * that test's body.
 */
function* Execution(): Operation<Json> {
  return yield* refuse("Execution", "is valid only inside a canonical <Test>.");
}

function* WorkflowRun(): Operation<Json> {
  return yield* refuse("WorkflowRun", "is valid only inside a canonical <Test>.");
}

/** The registrations `installTestingComponents` adds for the harness. */
/** The origin every component this package registers reports to inspection. */
export const TESTING_ORIGIN = "@executablemd/testing";

export const HARNESS_REGISTRATIONS = [
  {
    name: "Execution",
    origin: TESTING_ORIGIN,
    fn: Execution,
    props: EXECUTION_PROPS,
    ...documented({
      description:
        "Run another document from inside a test, and assert on how it finished. " +
        '`<Execution host="run" target="./setup.md" as="run">…</Execution>` runs it for ' +
        "real, with its own journal and output. Pass `source` instead of `target` to " +
        "supply the markdown directly, and `props` for the document's properties.",
      as:
        "Optional. The child's outcome: a settled result, or a suspension. Without it a " +
        "settled failure fails the owning test rather than passing vacuously.",
      context: "The declarations for the child, then the assertions about it.",
    }),
  },
  {
    name: "WorkflowRun",
    origin: TESTING_ORIGIN,
    fn: WorkflowRun,
    props: WORKFLOW_RUN_PROPS,
    ...documented({
      description:
        "Scope a workflow-hosted execution. `<WorkflowRun>…</WorkflowRun>` holds " +
        '`<Execution host="workflow">` children, and refuses unless the host supplies a ' +
        "workflow profile.",
      as: null,
      context: "The workflow-hosted executions this scope owns.",
    }),
  },
  {
    name: "DiagnosticJournal",
    origin: TESTING_ORIGIN,
    fn: DiagnosticJournal,
    props: DIAGNOSTIC_JOURNAL_PROPS,
    ...documented({
      description:
        "Give a child execution a journal of its own. `<DiagnosticJournal />` goes " +
        "inside `<Execution>`, before the assertions, and is invalid anywhere else. " +
        "Without it the child keeps no journal — with it, `<CollectJournal>` has one " +
        "to read.",
      as: null,
      context: null,
    }),
  },
  {
    name: "CollectOutput",
    origin: TESTING_ORIGIN,
    fn: CollectOutput,
    props: COLLECT_OUTPUT_PROPS,
    ...documented({
      description:
        "Capture a child execution's output so a test can assert on it. " +
        '`<CollectOutput as="output" />` goes inside `<Execution>`, before the ' +
        "assertions, and is invalid anywhere else. It changes nothing about the run, " +
        "and a child that fails partway still leaves what it printed.",
      as: "Required. The child's accumulated output.",
      context: null,
    }),
  },
  {
    name: "CollectJournal",
    origin: TESTING_ORIGIN,
    fn: CollectJournal,
    props: COLLECT_JOURNAL_PROPS,
    ...documented({
      description:
        "Capture a child execution's journal so a test can assert on it. " +
        '`<CollectJournal as="journal" />` goes inside `<Execution>`, beside ' +
        "`<CollectOutput>`. It reads a journal the run already has — pair it with " +
        "`<DiagnosticJournal>` to create one.",
      as: "Required. The journal snapshot.",
      context: null,
    }),
  },
] as const;

/**
 * What a trusted host attaches so its tests can run nested executions.
 *
 * The whole of the authority path, and it is a closure: canonical `<Test>` calls
 * this with the harness it minted, inside that invocation, and what this does is
 * register definitions that have the harness and the host's provider in scope.
 * Neither value is written anywhere — not a context, not a prop, not an Api
 * argument, not this package's module state — so a component running inside the
 * test, a same-name context, a second loaded copy of this package and any
 * middleware composed around anything all find nothing to take.
 *
 * The registration is made in the invocation's frame, so it shadows the refusing
 * default for exactly this test's body and is removed with the test. Two tests
 * are two harnesses and two registrations; neither can reach the other's.
 */
export function testHarnessInstallation(
  provider?: ExecutionHostProvider,
  /**
   * The packages that contribute a child-configuration declaration, each
   * naming the exact definition ordinary resolution must have selected.
   *
   * Supplied by the trusted host, because recognizing a declaration is
   * recognizing a *definition*, and only the host knows which package's copy
   * it installed. A host that supplies none has no such declarations: the scan
   * ends where one is written, and it expands as the ordinary component it is.
   */
  declarations: readonly ChildDeclaration[] = [],
): ExecutionInstallation {
  return {
    *testHarness(harness: TestHarness): Operation<void> {
      yield* registerComponents([
        {
          name: "Execution",
          origin: "@executablemd/testing",
          fn: authorizedExecution(harness, provider, declarations),
          props: EXECUTION_PROPS,
        },
        {
          name: "WorkflowRun",
          origin: "@executablemd/testing",
          fn: authorizedWorkflowRun(harness, provider),
          props: WORKFLOW_RUN_PROPS,
        },
      ]);
    },
  };
}
