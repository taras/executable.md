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

import { ensure } from "effection";
import type { Operation } from "effection";
import { forEach } from "@effectionx/stream-helpers";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { useStubFs } from "@executablemd/runtime/test";
import { execute, fileSource, inlineSource, rootSourcePath } from "@executablemd/core";
import type {
  ChildInvocation,
  ChildSettlement,
  ExecutionHostProvider,
  HostProfileRequest,
  WorkflowRunScope,
} from "../src/execution-host.ts";

import { withFailureJournal } from "../src/failure-journal.ts";
import type { FailureJournalHost } from "../src/failure-journal.ts";

/** What the stub observed, so a test can assert about the request itself. */
export interface StubHostLog {
  /** Every profile the terminal settled on, in the order children were run. */
  readonly requests: HostProfileRequest[];
  /** Every `<WorkflowRun>` scope opened, in declaration order. */
  readonly runs: WorkflowRunScope[];
  /** The identity each child root reports — a path, or `<eval>` for inline text. */
  readonly roots: string[];
}

export interface StubExecutionHost {
  readonly log: StubHostLog;
  readonly provider: ExecutionHostProvider;
}

export interface StubHostOptions {
  readonly childJournal?: (source: string) => FailureJournalHost<ChildSettlement>;
  /** The files the child reads. Usually the same map the outer document uses. */
  readonly files: Record<string, string>;
  /**
   * Emit output on the child's behalf, instead of running a document.
   *
   * A test that is about *when* a chunk is displayed needs to decide when the
   * chunk happens; a document cannot be asked to emit on cue without a timer.
   */
  readonly emit?: (chunk: (text: string) => Operation<void>) => Operation<void>;
  /**
   * Called from the child's own scope when that scope is dismantled.
   *
   * What a declaration installs there belongs to the child, so when its
   * teardown happens relative to the assertions is observable only from inside
   * it.
   */
  readonly onTeardown?: () => void;
}

export function stubExecutionHost(options: StubHostOptions): StubExecutionHost {
  const log: StubHostLog = { requests: [], runs: [], roots: [] };
  let generated = 0;
  const provider: ExecutionHostProvider = {
    *runChild(invocation: ChildInvocation): Operation<ChildSettlement> {
      const request = invocation.request;
      log.requests.push(request);
      function* install(): Operation<void> {
        yield* useStubFs(options.files);
        const onTeardown = options.onTeardown;
        if (onTeardown !== undefined) {
          yield* ensure(() => onTeardown());
        }
      }

      if (options.emit !== undefined) {
        yield* install();
        yield* options.emit((text: string) => invocation.chunk(text));
        return { outcome: { kind: "settled", result: { ok: true, value: "" } }, output: "" };
      }

      const root =
        request.source === undefined
          ? fileSource(request.target ?? "")
          : inlineSource(request.source);
      const source = rootSourcePath(root);

      function* run(stream: DurableStream): Operation<ChildSettlement> {
        yield* install();
        log.roots.push(source);
        const diagnostic = request.journal !== "transient";
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
      }

      return yield* options.childJournal === undefined
        ? run(new InMemoryStream())
        : withFailureJournal(options.childJournal(source), run);
    },
    // deno-lint-ignore require-yield
    *useWorkflowRun({ id }: { readonly id?: string }): Operation<WorkflowRunScope> {
      generated += 1;
      const scope = { id: id ?? `generated-${generated}` };
      log.runs.push(scope);
      return scope;
    },
  };
  return { log, provider };
}
