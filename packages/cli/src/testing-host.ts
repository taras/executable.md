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
 * the same components (`installDocumentComponents`), the same native service
 * adapter this entrypoint installs, the same root loader and target resolver,
 * and the same `executeInstalled()` call. What it does not get is process
 * presentation — no journal file, no `--verbose` echo, no terminal formatting,
 * no stdout of its own. Its rendered output goes back to the document that ran
 * it, which is the only reader it has.
 *
 * The child runs in the isolated scope the harness created for it, so nothing
 * this module installs here reaches the test that asked, and nothing the test
 * installed reaches the child.
 */

import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { forEach } from "@effectionx/stream-helpers";
import type { Operation } from "effection";
import { fileSource, inlineSource } from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type {
  ChildInvocation,
  ChildSettlement,
  ExecutionHostProvider,
  HostProfileRequest,
} from "@executablemd/testing";
import { installDocumentComponents } from "./cli.ts";
import type { HostServiceInstaller } from "./cli.ts";

/** What the entrypoint already decided, and a child must not decide again. */
export interface TestingHostSettings {
  /** The component search path this run resolves names through. */
  readonly componentDirs: string[];
  /** Whether durable events are scanned for credentials before they persist. */
  readonly secretDetection: boolean;
  /** The native service adapter this entrypoint supplies. */
  readonly installService: HostServiceInstaller;
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

  yield* installDocumentComponents({ testing: false }, false);
  // Native service authority belongs only to document execution, here as in the
  // command that owns it.
  yield* settings.installService();

  const execution = yield* executeInstalled(
    {
      ...root,
      stream,
      props: request.props,
      componentDirs: settings.componentDirs,
      secretDetection: settings.secretDetection,
      retainProcessOutput: diagnostic,
    },
    [],
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
