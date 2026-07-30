/**
 * Agent component registration (specs/acp-client-spec.md).
 *
 * Registers the agent words as ordinary function components for this scope,
 * and decorates the Execution Api so prompt failures — and, when a root
 * provider is configured, provider teardown failures — participate in the
 * DocumentExecution completion.
 *
 * Registration and execution decoration are separate concerns: the components
 * are defaults a document can replace by writing its own file with one of these
 * names, while the completion decoration belongs to the execution regardless of
 * which implementation answered.
 *
 * The root provider's lifetime is part of the execution: the middleware
 * returns a bridged DocumentExecution whose owning spawned operation
 * enters a scoped provider lifetime, runs the inner execution, forwards
 * its output (the bridged output closes when the inner output closes),
 * and resolves the completion only after provider cleanup has finished.
 * Teardown failures therefore affect the final result without delaying
 * rendered output.
 */

import { Err, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { Execution } from "../execute.ts";
import type { DocumentExecution, ExecuteOptions } from "../execute.ts";
import { registerComponents } from "../components/registration.ts";
import { CORE_ORIGIN } from "../components/registry.ts";
import { createReplayStream } from "../replay-stream.ts";
import type { Json } from "../types.ts";
import type { PermissionMode } from "./agent-api.ts";
import type { AgentProviderFactory, AgentProviderOptions } from "./provider-api.ts";
import { AgentInternal } from "./internal.ts";
import { AgentPromptError } from "./errors.ts";
import {
  AGENT_PROPS,
  AGENT_PROVIDER_PROPS,
  AgentComponent,
  AgentProvider,
  ApproveAll,
  AskPermission,
  NO_PROPS_SCHEMA,
  Prompt,
  PROMPT_PROPS,
  SESSION_PROPS,
  SessionComponent,
} from "./function-components.ts";
import { promptFailureFromRecord, readCompletedPrompts } from "./journal.ts";

export interface AgentComponentsOptions {
  /** Default agent seeded for `<AgentProvider>` inheritance. */
  defaultAgent?: string;
  /** Permission mode seeded for `<AgentProvider>` inheritance. */
  permissionMode?: PermissionMode;
  /**
   * Root provider whose lifetime is owned by each DocumentExecution. Its
   * factory installs `Agent` middleware for the execution; resolve it
   * before document execution so an unusable provider fails before any
   * document runs.
   */
  rootProvider?: { factory: AgentProviderFactory; options: AgentProviderOptions };
}

interface SequencedFailure {
  sequence: number;
  error: AgentPromptError;
}

export function* installAgentComponents(options?: AgentComponentsOptions): Operation<void> {
  if (options?.defaultAgent !== undefined) {
    const defaultAgent = options.defaultAgent;
    yield* AgentInternal.around({ defaultAgentName: () => defaultAgent }, { at: "min" });
  }
  if (options?.permissionMode !== undefined) {
    const permissionMode = options.permissionMode;
    yield* AgentInternal.around({ permissionMode: () => permissionMode }, { at: "min" });
  }

  // Non-reserved: a repository component with one of these names is chosen
  // ahead of them, as it would be ahead of any other package's default.
  yield* registerComponents([
    { name: "AgentProvider", origin: CORE_ORIGIN, fn: AgentProvider, props: AGENT_PROVIDER_PROPS },
    { name: "Agent", origin: CORE_ORIGIN, fn: AgentComponent, props: AGENT_PROPS },
    { name: "Session", origin: CORE_ORIGIN, fn: SessionComponent, props: SESSION_PROPS },
    { name: "Prompt", origin: CORE_ORIGIN, fn: Prompt, props: PROMPT_PROPS },
    { name: "ApproveAll", origin: CORE_ORIGIN, fn: ApproveAll, props: NO_PROPS_SCHEMA },
    { name: "AskPermission", origin: CORE_ORIGIN, fn: AskPermission, props: NO_PROPS_SCHEMA },
  ]);

  const rootProvider = options?.rootProvider;

  yield* Execution.around({
    *execute([executeOptions], next) {
      // Fresh per-execution prompt bookkeeping: an explicit sequence
      // records execution order in the journal, and per-location ordinals
      // keep durable identities stable through <Each> loops.
      const failures: SequencedFailure[] = [];
      let sequence = 0;
      const ordinals = new Map<string, number>();
      yield* AgentInternal.around({
        // deno-lint-ignore require-yield
        *recordPromptFailure([error, failedSequence]) {
          failures.push({ sequence: failedSequence, error });
        },
        // deno-lint-ignore require-yield
        *nextPromptSequence() {
          return sequence++;
        },
        // deno-lint-ignore require-yield
        *promptOrdinal([location]) {
          const ordinal = ordinals.get(location) ?? 0;
          ordinals.set(location, ordinal + 1);
          return ordinal;
        },
      });

      // Confirmed full replay: durableRun returns the stored root result
      // without re-expanding, so no prompt would re-record. Restore the
      // journaled failures into this execution's collector instead.
      const replayed = yield* readCompletedPrompts(executeOptions.stream);
      if (replayed) {
        for (const record of replayed) {
          const failure = promptFailureFromRecord(record);
          if (failure) {
            failures.push({ sequence: record.sequence, error: failure });
          }
        }
      }

      // A confirmed full replay restores results from the journal, so it must
      // never enter the root-provider lifetime — no availability check, setup,
      // or prompt. Only a live run with a root provider bridges the provider.
      if (!rootProvider || replayed) {
        const inner = yield* next(executeOptions);
        return decorateCompletion(inner, (result) =>
          combineCompletion(result, failures, undefined),
        );
      }

      return yield* bridgeRootProvider(rootProvider, executeOptions, failures, next);
    },
  });
}

function* bridgeRootProvider(
  rootProvider: { factory: AgentProviderFactory; options: AgentProviderOptions },
  executeOptions: ExecuteOptions,
  failures: SequencedFailure[],
  next: (options: ExecuteOptions) => Operation<DocumentExecution>,
): Operation<DocumentExecution> {
  const channel = createReplayStream<string, string>();
  const completion = withResolvers<Result<Json>>();

  yield* spawn(function* () {
    let docResult: Result<Json> | undefined;
    let teardown: Error | undefined;
    let outputClosed = false;
    let emitted = "";

    try {
      yield* scoped(function* () {
        yield* rootProvider.factory(rootProvider.options);
        const inner = yield* next(executeOptions);
        const subscription = yield* inner.output;
        let chunk = yield* subscription.next();
        while (!chunk.done) {
          emitted += chunk.value;
          yield* channel.send(chunk.value);
          chunk = yield* subscription.next();
        }
        yield* channel.close(chunk.value);
        outputClosed = true;
        docResult = yield* inner;
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (docResult === undefined) {
        docResult = Err(failure);
      } else {
        // The inner execution completed; the throw came from dismantling
        // the provider scope.
        teardown = failure;
      }
    }

    if (!outputClosed) {
      yield* channel.close(emitted);
    }
    completion.resolve(
      combineCompletion(
        docResult ?? Err(new Error("document execution did not complete")),
        failures,
        teardown,
      ),
    );
  });

  return {
    output: channel,
    *[Symbol.iterator]() {
      return yield* completion.operation;
    },
  };
}

/**
 * Map an execution's completion: an `Ok` becomes `Err(failure())` when the
 * policy reports one, after the inner completion — and therefore its
 * closed output stream — settles. An existing `Err` passes through
 * unchanged. (Local copy of the testing package's decorator — core cannot
 * depend on testing.)
 */
function decorateCompletion(
  inner: DocumentExecution,
  decorate: (result: Result<Json>) => Result<Json>,
): DocumentExecution {
  return {
    output: inner.output,
    *[Symbol.iterator]() {
      const result = yield* inner;
      if (!result.ok) {
        return result;
      }
      return decorate(result);
    },
  };
}

/**
 * Combine the document result, collected prompt failures, and provider
 * teardown failure into the final completion. Primary failures come
 * before teardown failures; existing AggregateError members are flattened
 * rather than nested.
 */
function combineCompletion(
  docResult: Result<Json>,
  failures: SequencedFailure[],
  teardown: Error | undefined,
): Result<Json> {
  const promptErrors = [...failures]
    .sort((a, b) => a.sequence - b.sequence)
    .map((failure) => failure.error);
  const promptMessage = `${promptErrors.length} agent prompt(s) failed`;

  if (!docResult.ok) {
    if (!teardown) {
      return docResult;
    }
    return Err(
      new AggregateError(
        [...flatten(docResult.error), ...flatten(teardown)],
        "document execution and agent provider teardown failed",
      ),
    );
  }
  if (promptErrors.length > 0 && teardown) {
    return Err(
      new AggregateError(
        [...promptErrors, ...flatten(teardown)],
        `${promptMessage}; agent provider teardown failed`,
      ),
    );
  }
  if (promptErrors.length > 0) {
    return Err(new AggregateError(promptErrors, promptMessage));
  }
  if (teardown) {
    return Err(teardown);
  }
  return docResult;
}

function flatten(error: Error): Error[] {
  if (error instanceof AggregateError) {
    return error.errors.map((member) =>
      member instanceof Error ? member : new Error(String(member)),
    );
  }
  return [error];
}
