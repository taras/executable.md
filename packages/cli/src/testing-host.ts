/**
 * The trusted host profile a Markdown test runs a nested execution under.
 *
 * `@executablemd/testing` owns `<Execution>` and the request it issues; this
 * module owns the answer, because the answer is production assembly and
 * production assembly lives here. The dependency runs this way already — the
 * CLI depends on the testing package — and answering from the other side would
 * close the cycle and, worse, would mean a test passing against a second copy
 * of `xmd run` that nothing ships.
 *
 * So a child gets what `xmd run` gets, after the command line has been read:
 * the same components (`installDocumentComponents`), the same browser-form
 * elicitation provider, the same native service adapter this entrypoint
 * installs, the same root loader and target resolver, and the same
 * `executeInstalled()` call. What it does not get is process
 * presentation — no journal file, no `--verbose` echo, no terminal formatting,
 * no stdout of its own. Its rendered output goes back to the document that ran
 * it, which is the only reader it has.
 *
 * The child runs in the isolated scope the harness created for it, so nothing
 * this module installs here reaches the test that asked, and nothing the test
 * installed reaches the child.
 */

import type { DeclaredMarkdownComponent } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";
import { API, useHostFiles } from "@executablemd/runtime";
import { installWebElicitation } from "@executablemd/web";
import { ensure, Err, Ok, until, useScope } from "effection";
import type { Operation, Result, Scope } from "effection";
import {
  agentIdentityComponents,
  fileSource,
  inlineSource,
  installAgentComponents,
} from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import { executeInstalled, installAnswerProvider } from "@executablemd/core/host";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_AGENT_CONTEXT } from "./authorship-profile.ts";
import type { PlanAuthorship } from "./authorship-profile.ts";
import type { PlanAuthorshipObservation } from "./authorship-profile.ts";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { installChildTestAgent } from "@executablemd/test-agent";
import type { PlanProviderAssembly } from "@executablemd/test-agent";
import type { ChildTestAgentInstallation } from "@executablemd/test-agent";
import type {
  AnswersChildConfiguration,
  ChildInvocation,
  ChildSettlement,
  ExecutionHostProvider,
  HostProfileRequest,
  TestAgentChildConfiguration,
} from "@executablemd/testing";
import { installDocumentComponents } from "./cli.ts";
import { runProfileDocumentation } from "./syntax.ts";
import type { HostServiceInstaller } from "./cli.ts";
import type { RepositoryInstaller } from "./run-repositories.ts";

/** What one child asks the entrypoint to build its `<Plan>` declaration from. */
export interface ChildPlanDeclaration {
  /** The Agent context this child can give a Plan, or why it can give none. */
  readonly context: Result<PlanAuthorship>;
  /** The authorship root the host made for this child, when it made one. */
  readonly authorshipRoot?: string;
  /** The scope this child's own host acts run in. */
  readonly host: Scope;
  /**
   * Who answers this child's Plan review.
   *
   * The frame installs it inside the Plan invocation, which is nearer than
   * anything installed around the child — so a host that installed the browser
   * form here would put it in front of a configured child's `<Answers>`, and the
   * review would wait for a person no test can supply. A configured child
   * therefore installs nothing and lets its own matcher provider answer.
   */
  installElicitation(): Operation<void>;
  observeAuthorship?(observation: PlanAuthorshipObservation): Operation<void>;
}

/** What the entrypoint already decided, and a child must not decide again. */
export interface TestingHostSettings {
  /** The component search path this run resolves names through. */
  readonly includes: string[];
  /**
   * How this run profile builds a `<Plan>` declaration for one execution.
   *
   * A child of the run profile writes `<Plan>` and means what a `<Plan>` in the
   * parent means, so the Component, its origin, its digest and its private
   * closure come from the entrypoint rather than from state a child could
   * reach. What the child supplies is the part only the child knows: the
   * Agent context its own configuration settled, the authorship root the host
   * made for it, and its own scope.
   *
   * A declaration built once out there and shared would close over the absence
   * of an Agent context before any child configuration had been read, which is
   * why a configured child could not write a Plan.
   */
  readonly planDeclaration: (request: ChildPlanDeclaration) => Operation<DeclaredMarkdownComponent>;
  /** Whether durable events are scanned for credentials before they persist. */
  readonly secretDetection: boolean;
  /** The native service adapter this entrypoint supplies. */
  readonly installService: HostServiceInstaller;
  /**
   * How this entrypoint installs repository operations for one execution.
   *
   * Called again for every child, so an isolated `<Execution host="run">`
   * constructs a provider instance of its own: its own invocation identity, its
   * own leases and its own Push evidence. Nothing it publishes authorizes its
   * parent or a sibling, and nothing they published authorizes it.
   */
  readonly installRepositories: RepositoryInstaller;
  /**
   * How this entrypoint re-invokes itself as the test-agent worker, or why it
   * cannot.
   *
   * Read from the trusted entrypoint before a child's isolated scope exists,
   * because only a runtime-named entrypoint knows it and a child inherits no
   * `API.Env` handler. A frozen argv crosses; the Api that produced it does
   * not.
   *
   * A refusal rather than an argv, because reading it is not a run's business.
   * A host that installed no command adapter still runs documents — the same
   * allowance `<TestAgent>` makes — and only a child that declares a scripted
   * agent has anything to say about it.
   */
  readonly testAgentWorker: Result<readonly string[]>;
  /** Trusted host evidence after the whole authorship frame is installed. */
  observePlanAuthorship?(observation: PlanAuthorshipObservation): Operation<void>;
}

/**
 * Build the trusted host profile for this run's Markdown tests.
 *
 * Called once, beside the other things a document execution runs with. A
 * document with no `<Execution>` never asks for a child, so this costs nothing
 * but the closure.
 */
export function testingExecutionHost(settings: TestingHostSettings): ExecutionHostProvider {
  return {
    runChild(invocation: ChildInvocation): Operation<ChildSettlement> {
      return runProfileChild(invocation, settings);
    },
    // No `useWorkflowRun`: this host answers the run profile. The workflow
    // profile is a separate capability and `<WorkflowRun>` says so on its own.
  };
}

/** The root a request names: a reference to resolve, or the text itself. */
function rootOf(request: HostProfileRequest): RootDocumentSource {
  if (request.source !== undefined) {
    // The production inline path, identity included: `run -e` reports `<eval>`,
    // and so does a child that was handed text.
    return inlineSource(request.source);
  }
  // The same reference grammar `xmd run` takes, so a kebab-named document in an
  // arbitrary directory — and one target inside it — is addressable without
  // being a component.
  return fileSource(request.target ?? "");
}

/**
 * What the declarations configured, told apart by kind.
 *
 * An exhaustive switch over a closed union: an unknown member would be a
 * request this entrypoint cannot answer, and there is no member for one to be.
 */
function selectConfiguration(request: HostProfileRequest): {
  testAgent: TestAgentChildConfiguration | undefined;
  answers: AnswersChildConfiguration | undefined;
} {
  let testAgent: TestAgentChildConfiguration | undefined;
  let answers: AnswersChildConfiguration | undefined;
  for (const configuration of request.configuration ?? []) {
    switch (configuration.kind) {
      case "test-agent":
        testAgent = configuration;
        break;
      case "answers":
        answers = configuration;
        break;
    }
  }
  return { testAgent, answers };
}

/**
 * The Agent context a configured child gives a Plan: the controlled provider it
 * was already given, installed again for the Plan invocation that asks.
 *
 * Installed *inside* `<PlanAuthorship>` rather than inherited from what the
 * child registered around itself, so the Plan conversation runs under the same
 * fixed policy every Plan runs under, whichever provider is underneath. The
 * provider is the child's own partition, which is what lets a
 * `<TestAgent.Scenario>` address the Plan's session by name.
 *
 * The partition, the scenarios and this closure belong to one child. A sibling
 * that declares the same thing provisions all of it again, and neither reaches
 * the other.
 */
function controlledAgentContext(installation: ChildTestAgentInstallation): Result<PlanAuthorship> {
  const root = installation.components.rootProvider;
  const defaultAgent = installation.components.defaultAgent;
  if (root === undefined || defaultAgent === undefined) {
    // Not reachable from `installChildTestAgent`, which states both. A child
    // that somehow reached here has no provider to give a Plan, and saying so is
    // the honest answer rather than supplying one anyway.
    return Err(new Error(NO_AGENT_CONTEXT));
  }
  return Ok({
    defaultAgent,
    *installProvider(invocation): Operation<PlanProviderAssembly> {
      return yield* installation.installPlanProvider({
        agent: defaultAgent,
        ...(invocation.authoredSession === undefined
          ? {}
          : { authoredSession: invocation.authoredSession }),
        session: invocation.session,
        workdir: invocation.workdir,
        policy: invocation.policy,
      });
    },
  });
}

/**
 * A Plan authorship root this child owns and nothing else can reach.
 *
 * Not the child's working directory, not the outer test's, not the process
 * home and not anything a document named: an agent writing a program has no
 * business in the tree the program will run in. Registered before the
 * directory exists, so a partial creation is still cleaned up, and recursive
 * because the Plan sessions underneath it are this child's too — including a
 * named one, which production keeps and a test may not.
 */
function* useChildAuthorshipRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-child-plan-${randomUUID()}`);
  yield* ensure(() => until(rm(root, { recursive: true, force: true })));
  yield* until(mkdir(root, { recursive: true }));
  return root;
}

function* runProfileChild(
  invocation: ChildInvocation,
  settings: TestingHostSettings,
): Operation<ChildSettlement> {
  const request = invocation.request;
  if (request.host !== "run") {
    throw new Error(`the ${request.host} host profile is not available on this entrypoint`);
  }
  // First, because everything below resolves against it. This scope inherits no
  // `API.Env` handler, so without this the child would stand in the *process*
  // directory: a `<Dir>` around the `<Execution>` would scope every component
  // in it except the child, the root reference would resolve from somewhere the
  // document never named, and the repository provider installed below would
  // discover its ambient Git from whatever checkout the process was launched
  // in. Installed ahead of the root, the provider and the execution, so all
  // three agree with the document that asked.
  yield* API.Env.around(
    {
      // deno-lint-ignore require-yield
      *cwd(): Operation<string> {
        return invocation.cwd;
      },
    },
    { at: "min" },
  );
  const root = rootOf(request);
  // `--journal` is the only thing that asks `xmd run` for a diagnostic record,
  // and a declaration is the only thing that asks a child for one. Neither
  // keeps anything because output was displayed.
  const diagnostic = request.journal === "diagnostic";
  const stream = new InMemoryStream();
  const { testAgent, answers } = selectConfiguration(request);

  yield* installDocumentComponents({ testing: false }, false);
  const installations: ExecutionInstallation[] = [];
  // What this child can establish for a `<Plan>` written inside it. A child
  // nobody configured establishes nothing, which is the refusal `<Plan>` has
  // always given where no Agent context exists.
  let context: Result<PlanAuthorship> = Err(new Error(NO_AGENT_CONTEXT));
  let authorshipRoot: string | undefined;
  if (testAgent !== undefined) {
    const worker = settings.testAgentWorker;
    if (!worker.ok) {
      throw new Error(
        "<TestAgent> configures this child with a scripted agent, and this entrypoint cannot " +
          `re-invoke itself to run one: ${worker.error.message}`,
      );
    }
    // The controlled provider before the Agent words, exactly as `<TestAgent>`
    // arranges them for an ordinary test: what the six defaults reach is
    // decided by what is installed when they run. `<Session>` travels
    // separately because its implementation names durable work after its own
    // invocation, so the execution is told about it rather than a registration
    // being made for it.
    const agents = yield* installChildTestAgent(testAgent, { workerCommand: worker.value });
    yield* installAgentComponents(agents.components);
    installations.push({ components: agentIdentityComponents() });
    // Created out here, outside the frame that refuses a directory to
    // everything inside it, and owned by this child alone: the Plan invocation
    // still makes and proves its own empty session directory underneath it, and
    // the whole tree goes when this child settles however it settles.
    authorshipRoot = yield* useChildAuthorshipRoot();
    context = controlledAgentContext(agents);
  }
  // The production run profile's own vocabulary, whichever command launched the
  // child: `<Execution host="run">` means the run profile, and a child that
  // could not resolve `<Plan>` would be a different one. Built here, from what
  // this child settled above, rather than taken from a declaration the
  // entrypoint built before this child's configuration had been read.
  installations.push({
    declarations: [
      yield* settings.planDeclaration({
        context,
        ...(authorshipRoot === undefined ? {} : { authorshipRoot }),
        host: yield* useScope(),
        // Nothing, so the review is answered by whatever this child already
        // has: the `<Answers>` matcher provider installed above when the test
        // declared one, and the browser form installed for the child otherwise.
        // deno-lint-ignore require-yield
        *installElicitation(): Operation<void> {},
        ...(settings.observePlanAuthorship === undefined
          ? {}
          : { observeAuthorship: settings.observePlanAuthorship }),
      }),
    ],
    // The documentation for the same profile's registrations, beside the
    // declarations rather than anywhere else. A child that registered the run
    // profile's components without their documentation would answer
    // `<Syntax names={["WebForm"]} />` with the no-documentation sentence — a
    // component it can run, described as undocumented — because the index it
    // built would hold core's contributions alone.
    documentation: yield* runProfileDocumentation(),
  });
  // A child gets what `xmd run` gets, and the browser form is part of that.
  // Installed here rather than inherited: this scope is isolated from the
  // command that started it, so the run profile's provider reaches a child only
  // if the run profile composes it — and a child of `xmd test`, whose command
  // composes none, still gets one because *this* is the run profile.
  yield* installWebElicitation();
  if (answers !== undefined) {
    // After the form, so it is the nearer provider at the same `{ at: "min" }`
    // and an unmatched request fails here rather than opening a browser. A test
    // that said what the answers are does not fall through to a person.
    yield* installAnswerProvider(answers);
  }
  // Document filesystem access resolves in the caller's own filesystem, as it
  // does for `xmd run`. The entrypoint installs its provider process-wide, but
  // the child runs in an isolated scope, so the child's assembly must restate
  // it — `API.Files` has no host default, and a child without one refuses
  // every document filesystem operation.
  yield* useHostFiles();
  // Native service authority belongs only to document execution, here as in the
  // command that owns it.
  yield* settings.installService();
  // And repository authority the same way, from the same installer the command
  // used — a fresh instance for this child alone.
  yield* settings.installRepositories();

  const execution = yield* executeInstalled(
    {
      ...root,
      stream,
      props: request.props,
      includes: settings.includes,
      secretDetection: settings.secretDetection,
      retainProcessOutput: diagnostic,
    },
    installations,
  );
  // Forwarded as it arrives. The document that ran this child is the reader, so
  // the chunks reach its output stream in the order the child produced them.
  const output = yield* forEach(function* (chunk: string) {
    yield* invocation.chunk(chunk);
  }, execution.output);
  const result = yield* execution;
  const journal: readonly DurableEvent[] | undefined = request.collectJournal
    ? yield* stream.readAll()
    : undefined;
  return {
    outcome: { kind: "settled", result },
    output,
    ...(journal === undefined ? {} : { journal }),
  };
}
