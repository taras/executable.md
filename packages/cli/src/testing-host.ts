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
import { useHostFiles } from "@executablemd/runtime";
import { installWebElicitation } from "@executablemd/web";
import type { Operation, Result } from "effection";
import {
  agentIdentityComponents,
  fileSource,
  inlineSource,
  installAgentComponents,
} from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import { executeInstalled, installAnswerProvider } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import { installChildTestAgent } from "@executablemd/test-agent";
import type {
  AnswersChildConfiguration,
  ChildInvocation,
  ChildSettlement,
  ExecutionHostProvider,
  HostProfileRequest,
  TestAgentChildConfiguration,
} from "@executablemd/testing";
import { installDocumentComponents } from "./cli.ts";
import type { HostServiceInstaller } from "./cli.ts";
import type { RepositoryInstaller } from "./run-repositories.ts";

/** What the entrypoint already decided, and a child must not decide again. */
export interface TestingHostSettings {
  /** The component search path this run resolves names through. */
  readonly includes: string[];
  /**
   * The packaged `<Plan>` Component this run profile declares.
   *
   * A child of the run profile writes `<Plan>` and means what a `<Plan>` in the
   * parent means, so the declaration crosses as the value the parent built
   * rather than being rebuilt here from state a child cannot see. It crosses
   * even from an entrypoint that settled no Agent stack: the child is the
   * production run profile whatever launched it, and a `<Plan>` there is refused
   * at the ceiling rather than reported as a component nothing supplies.
   */
  readonly plan: DeclaredMarkdownComponent;
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

function* runProfileChild(
  invocation: ChildInvocation,
  settings: TestingHostSettings,
): Operation<ChildSettlement> {
  const request = invocation.request;
  if (request.host !== "run") {
    throw new Error(`the ${request.host} host profile is not available on this entrypoint`);
  }
  const root = rootOf(request);
  // `--journal` is the only thing that asks `xmd run` for a diagnostic record,
  // and a declaration is the only thing that asks a child for one. Neither
  // keeps anything because output was displayed.
  const diagnostic = request.journal === "diagnostic";
  const stream = new InMemoryStream();
  const { testAgent, answers } = selectConfiguration(request);

  yield* installDocumentComponents({ testing: false }, false);
  const installations: ExecutionInstallation[] = [];
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
    yield* installAgentComponents(
      yield* installChildTestAgent(testAgent, { workerCommand: worker.value }),
    );
    installations.push({ components: agentIdentityComponents() });
  }
  // The production run profile's own vocabulary, whichever command launched the
  // child: `<Execution host="run">` means the run profile, and a child that
  // could not resolve `<Plan>` would be a different one.
  installations.push({ declarations: [settings.plan] });
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
