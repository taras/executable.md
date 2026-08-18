/**
 * A trusted host profile for this package's own tests.
 *
 * `@executablemd/testing` owns the request and the CLI owns the production
 * answer, so these tests cannot install the shipped provider without inverting
 * the dependency. What they install instead is the smallest thing that is still
 * a real child: canonical `execute()` against the same stubbed files, in the
 * isolated scope the harness created for it.
 *
 * That is the right boundary for what this file's tests are about — the harness
 * itself: which root a target names, what an inline source reports, when the
 * declarations are installed, what is displayed and what is collected, and who
 * may run a child at all. Whether the child sees production's components,
 * providers and workflow storage is the CLI's contract, and
 * `packages/cli/tests/testing-execution-host.test.ts` is where it is held.
 */

import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, fileSource, inlineSource, rootSourcePath } from "@executablemd/core";
import { installExecutionHost } from "../src/execution-host.ts";
import type {
  ChildInvocation,
  ChildSettlement,
  HostProfileRequest,
  WorkflowRunScope,
} from "../src/execution-host.ts";

/** What the stub observed, so a test can assert about the request itself. */
export interface StubHostLog {
  /** Every profile the terminal settled on, in the order children were run. */
  readonly requests: HostProfileRequest[];
  /** Every `<WorkflowRun>` scope opened, in declaration order. */
  readonly runs: WorkflowRunScope[];
  /** The identity each child root reports — a path, or `<eval>` for inline text. */
  readonly roots: string[];
}

export interface StubHostOptions {
  /** The files the child reads. Usually the same map the outer document uses. */
  readonly files: Record<string, string>;
  /**
   * Emit output on the child's behalf, instead of running a document.
   *
   * A test that is about *when* a chunk is displayed needs to decide when the
   * chunk happens; a document cannot be asked to emit on cue without a timer.
   */
  readonly emit?: (chunk: (text: string) => Operation<void>) => Operation<void>;
}

export function* useStubExecutionHost(options: StubHostOptions): Operation<StubHostLog> {
  const log: StubHostLog = { requests: [], runs: [], roots: [] };
  let generated = 0;
  yield* installExecutionHost({
    *runChild(invocation: ChildInvocation): Operation<ChildSettlement> {
      const request = invocation.request;
      log.requests.push(request);
      // Installed here, in the child's own isolated scope: the harness detached
      // it from this document's, so the child reads nothing this document
      // installed.
      yield* useStubFs(options.files);

      if (options.emit !== undefined) {
        yield* options.emit((text: string) => invocation.chunk(text));
        return { outcome: { kind: "settled", result: { ok: true, value: "" } }, output: "" };
      }

      const root =
        request.source === undefined
          ? fileSource(request.target ?? "")
          : inlineSource(request.source);
      log.roots.push(rootSourcePath(root));
      // Retention follows the profile, exactly as the production run host reads
      // `--journal`: a transient child keeps nothing and answers with no
      // snapshot, so "a transient run allocates no journal" is observable
      // rather than asserted.
      const diagnostic = request.journal !== "transient";
      const stream = new InMemoryStream();
      const child = yield* execute({
        ...root,
        stream,
        props: request.props,
        retainProcessOutput: diagnostic,
      });
      const output = yield* forEach(function* (chunk: string) {
        yield* invocation.chunk(chunk);
      }, child.output);
      const result = yield* child;
      const journal: readonly DurableEvent[] | undefined = diagnostic
        ? yield* stream.readAll()
        : undefined;
      return {
        outcome: { kind: "settled", result },
        output,
        ...(journal === undefined ? {} : { journal }),
      };
    },
    // deno-lint-ignore require-yield
    *useWorkflowRun({ id }: { readonly id?: string }): Operation<WorkflowRunScope> {
      generated += 1;
      const scope = { id: id ?? `generated-${generated}` };
      log.runs.push(scope);
      return scope;
    },
  });
  return log;
}
