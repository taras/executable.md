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
import type { DocumentResult } from "../execute.ts";
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
    *execute([request], next) {
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
      const replayed = yield* readCompletedPrompts(request.options.stream);
      if (replayed) {
        for (const record of replayed) {
          const failure = promptFailureFromRecord(record);
          if (failure) {
            failures.push({ sequence: record.sequence, error: failure });
          }
        }
      }

      // The provider's lifetime has to surround authored work and end while the
      // journal is still live, which is what `Execution.document` is. Installed
      // from here so it inherits this execution's replay decision — a confirmed
      // full replay never enters the provider at all.
      const teardown: TeardownSlot = {};
      if (rootProvider && !replayed) {
        yield* Execution.around({
          *document([props], nextDocument) {
            return yield* withRootProvider(rootProvider, teardown, () => nextDocument(props));
          },
        });
      }

      // Additive: prompt failures and a provider teardown failure turn a
      // successful document into a failure. A document that already failed
      // keeps its own failure — the completion policy adds, it does not replace.
      request.addCompletionFailure(() => completionFailure(failures, teardown.error));
      yield* next(request);
    },
  });
}

interface TeardownSlot {
  error?: Error;
}

/**
 * Run the document inside the root provider's lifetime.
 *
 * A failure raised while dismantling the provider is recorded rather than
 * thrown: the document already completed, and reporting the teardown as *its*
 * failure would replace a result the document earned. It becomes an additive
 * completion failure instead, which is the same precedence the bridged
 * implementation had.
 */
function* withRootProvider(
  rootProvider: { factory: AgentProviderFactory; options: AgentProviderOptions },
  teardown: TeardownSlot,
  body: () => Operation<DocumentResult>,
): Operation<DocumentResult> {
  let completed: DocumentResult | undefined;
  try {
    return yield* scoped(function* () {
      yield* rootProvider.factory(rootProvider.options);
      completed = yield* body();
      return completed;
    });
  } catch (error) {
    if (completed === undefined) {
      throw error;
    }
    teardown.error = error instanceof Error ? error : new Error(String(error));
    return completed;
  }
}

/**
 * The one failure a successful document earns from prompts and teardown.
 *
 * Flat, and primary first: the prompt failures in the order they were recorded,
 * then whatever dismantling the provider raised. A reader looking for what went
 * wrong first finds it first, and an `AggregateError` a member already is gets
 * unpacked rather than nested.
 */
function completionFailure(
  failures: SequencedFailure[],
  teardown: Error | undefined,
): Error | undefined {
  const promptErrors = [...failures]
    .sort((a, b) => a.sequence - b.sequence)
    .map((failure) => failure.error);
  const promptMessage = `${promptErrors.length} agent prompt(s) failed`;

  if (promptErrors.length > 0 && teardown) {
    return new AggregateError(
      [...promptErrors, ...flatten(teardown)],
      `${promptMessage}; agent provider teardown failed`,
    );
  }
  if (promptErrors.length > 0) {
    return new AggregateError(promptErrors, promptMessage);
  }
  return teardown;
}

function flatten(error: Error): Error[] {
  if (error instanceof AggregateError) {
    return error.errors.map((member) =>
      member instanceof Error ? member : new Error(String(member)),
    );
  }
  return [error];
}
