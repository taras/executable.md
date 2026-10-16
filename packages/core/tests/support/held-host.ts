/**
 * One trusted host execution, held open while its caller works with it.
 *
 * Every claim about `HostExecution.evaluateGeneratedXmdRoot()` is a claim about
 * a *live* execution: the method reaches the documentation that execution
 * captured, the route its canonical `<Syntax />` is entered through, and the
 * runtime services its own document installed. A root source that completed
 * would take all three with it, so these rows need a document whose body is
 * still running while the caller evaluates — which is also the production
 * shape, since a Sidekick holds its execution open across turns.
 *
 * The holding is one identity component that suspends until the case releases
 * it. Nothing else about the execution is arranged: it is assembled through the
 * ordinary `executeInstalled` boundary, over a real canonical journal, with
 * whatever installations the case supplies.
 */

import { resource, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result, Task } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json as DurableJson } from "@executablemd/durable-streams";

import { executeInstalled } from "../../host.ts";
import type { ExecutionInstallation, HostExecution } from "../../host.ts";
import { retainedSource } from "../../src/root-source.ts";
import type { Json } from "../../src/types.ts";

const NO_PROPS = { type: "object", properties: {}, additionalProperties: false } as const;

/** The component that holds one of these executions open. */
const HOLD_COMPONENT = "Held";

/** The root every held execution runs, so a reopening binds to the same text. */
export const HELD_ROOT_PATH = "host/held.md";
const HELD_ROOT_SOURCE = `<${HOLD_COMPONENT} />\n`;

/** The document a held execution runs, for a case that needs its own. */
export interface HeldRoot {
  readonly path: string;
  /** Anything the case wants in scope, ending in the holding element. */
  readonly source: string;
}

/** One held execution, and the things a case does with it. */
export interface HeldHost {
  /** The trusted handle, live until the case releases or halts it. */
  readonly execution: HostExecution;
  /** Let the main body finish, so the document completes on its own terms. */
  release(): void;
  /** Whether the holding body has been entered, which is when services exist. */
  readonly started: Operation<void>;
  /**
   * The task observing this execution's completion.
   *
   * Halting it closes the execution, because a consumer halted before
   * settlement halts the invocation on its way out. A row about what closure
   * does needs that, and nothing else here provides it.
   */
  readonly watched: Task<Result<DurableJson>>;
}

/** What a case asks a held execution for. */
export interface HeldHostRequest {
  /** The journal this execution reads and writes. A fresh one by default. */
  readonly stream?: InMemoryStream;
  /** Whatever else the case installs beside the holding component. */
  readonly installations?: readonly ExecutionInstallation[];
  /** Work the holding body performs before it suspends. */
  readonly inside?: () => Operation<void>;
  /**
   * The document this execution runs, when the case's claim is about the
   * document rather than about the root it evaluates.
   *
   * It must end in `<Held />`, because that is what keeps the execution open.
   */
  readonly root?: HeldRoot;
}

/**
 * Hold one execution open for the caller's scope.
 *
 * A resource, so the execution is cancelled when the case's scope ends whether
 * or not the case released it — which is what makes "the handle refuses after
 * its execution closed" something a row can arrange without leaving a run
 * behind.
 */
export function useHeldHost(request: HeldHostRequest = {}): Operation<HeldHost> {
  return resource(function* (provide) {
    const gate = withResolvers<void>();
    const entered = withResolvers<void>();
    let open = false;
    const installation: ExecutionInstallation = {
      components: [
        {
          name: HOLD_COMPONENT,
          origin: "test://held",
          props: NO_PROPS,
          description: "Hold this execution open while its caller evaluates generated roots.",
          factory: () =>
            function* (): Operation<Json> {
              const inside = request.inside;
              if (inside !== undefined) {
                yield* inside();
              }
              if (!open) {
                open = true;
                entered.resolve();
              }
              yield* gate.operation;
              return "";
            },
        },
      ],
    };
    const stream = request.stream ?? new InMemoryStream();
    const document = request.root ?? { path: HELD_ROOT_PATH, source: HELD_ROOT_SOURCE };
    const execution = yield* executeInstalled(
      { ...retainedSource(document.path, document.source), stream },
      [...(request.installations ?? []), installation],
    );
    // Observed in a task of its own so that a failure of the run reaches this
    // scope rather than waiting for a case that is not watching the handle.
    // Halting this scope halts the invocation with it, which is what lets a row
    // arrange a handle whose execution has closed.
    const watched = yield* spawn(() => execution);
    yield* entered.operation;
    yield* provide({
      execution,
      release: () => {
        gate.resolve();
      },
      started: entered.operation,
      watched,
    });
  });
}

/**
 * Run one case against a held execution and hand back the completion.
 *
 * The release is explicit, so a case that means to observe the main document's
 * own completion gets it after its own work rather than racing it.
 */
export function withHeldHost<T>(
  request: HeldHostRequest,
  work: (held: HeldHost) => Operation<T>,
): Operation<{ readonly value: T; readonly completion: Result<DurableJson> }> {
  return scoped(function* () {
    const held = yield* useHeldHost(request);
    const value = yield* work(held);
    held.release();
    const completion = yield* held.execution;
    return { value, completion };
  });
}
