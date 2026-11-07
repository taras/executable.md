/**
 * Keep one execution's journal in memory, and hand it to its host only when the
 * work that owns it fails (specs/testing-spec.md).
 *
 * A test harness wants a journal it can read after a failure without paying for
 * persistence on every append of every passing test. This helper owns that
 * decision for whatever operation its caller protects: the execution, any
 * assertions the harness makes about it afterwards, and the teardown of
 * everything either one installed. The host owns where the events go.
 *
 * ```ts
 * // The `xmd test` root (packages/cli/src/cli.ts): a returned Err is a failed
 * // document, whether a test, an assertion, delivery or teardown failed it.
 * return withFailureJournal(
 *   root.journal((result: Result<void>) => !result.ok),
 *   (stream) => runScopedDocument({ ...config, stream }, observed, installService),
 * );
 *
 * // A nested `<Execution host="run">` child (packages/cli/src/testing-host.ts):
 * // a settled Err is a failed child, even when the test binds it as data.
 * return withFailureJournal(
 *   diagnostics.journal(
 *     (settlement: ChildSettlement) =>
 *       settlement.outcome.kind === "settled" && !settlement.outcome.result.ok,
 *   ),
 *   (stream) => assembleChild(invocation, settings, stream, diagnostics),
 * );
 * ```
 *
 * What it removes from each harness is the ordering, which is easy to get
 * wrong: the snapshot is taken once, after the protected operation and its
 * whole scope have unwound, so an event a finalizer commits is in it and no
 * later append can be missed. A returned value the host calls failed, a thrown
 * error, a timeout that halts the work, and a cancellation of its owner all
 * save; a success saves nothing and touches no file. What the operation
 * returned or threw — and a cancellation — reaches the caller unchanged.
 *
 * The host supplies three things and keeps them current when the outcome it
 * protects changes shape: which returned values are failures, how to persist a
 * snapshot, and how to make a persistence failure visible. A failed save is
 * handed to `reportSaveFailure` and never replaces the failure that caused it.
 * An abrupt process exit that skips cleanup saves nothing.
 */

import { ensure, scoped } from "effection";
import type { Operation } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";

/** What the owning host decides about one protected execution's journal. */
export interface FailureJournalHost<T> {
  /** Whether a value the protected operation returned is a failure. */
  failed(value: T): boolean;
  /** Persist the snapshot. Called at most once, after joined teardown. */
  save(events: readonly DurableEvent[]): Operation<void>;
  /** Make a failed save visible. It must not be mistaken for the original outcome. */
  reportSaveFailure(error: Error): Operation<void>;
}

/**
 * Run `body` against a fresh in-memory journal, saving that journal through
 * `host` only if the protected work fails, times out or is cancelled.
 */
export function withFailureJournal<T>(
  host: FailureJournalHost<T>,
  body: (stream: InMemoryStream) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const stream = new InMemoryStream();
    let succeeded = false;
    // Registered before the protected work exists, so a halt at any point
    // after this line still runs it. It runs once this scope unwinds, which is
    // after the nested scope below has finished tearing down.
    yield* ensure(function* () {
      if (!succeeded) {
        yield* preserve(host, stream);
      }
    });
    const value = yield* scoped(() => body(stream));
    succeeded = !host.failed(value);
    return value;
  });
}

function* preserve<T>(host: FailureJournalHost<T>, stream: InMemoryStream): Operation<void> {
  const events = yield* stream.readAll();
  if (events.length === 0) {
    return;
  }
  try {
    yield* host.save(events);
  } catch (error) {
    // A cleanup that threw would replace the failure that made this save
    // necessary, so the save's own failure goes to the host instead — and a
    // host that cannot report it either leaves the original outcome standing.
    try {
      yield* host.reportSaveFailure(error instanceof Error ? error : new Error(String(error)));
    } catch {
      return;
    }
  }
}
