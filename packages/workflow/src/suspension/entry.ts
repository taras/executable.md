/**
 * The handoff from the suspension operation to the controller.
 *
 * Standing at the right durable position is not enough to enter a wait, because
 * a position is something a document can arrange. Replay identity is a durable
 * operation's type and name, so document-side code can build an operation of the
 * same shape, replay the retained request with it, and arrive exactly where
 * `suspendFor()` would have — having never called `suspendFor()` at all, and so
 * having never passed its request admission.
 *
 * What distinguishes the real operation is that it is the one running. This slot
 * is how it says so: `suspendFor()` arms it immediately before entering, and the
 * controller takes it, once. Nothing else can arm it, because nothing else can
 * reach this module — it is not exported from the package, so importing it means
 * importing a private path, which a document cannot do.
 *
 * A slot rather than a value handed along the call, because the call goes
 * through a public API whose arguments a caller chooses. Taking it clears it, so
 * one arming admits one entry: an operation that armed and was refused leaves
 * nothing behind for a later caller to use.
 */

import type { Operation } from "effection";
import type { Json } from "@executablemd/core";
import { WorkflowSuspensionProviderError, type WorkflowSuspensionRequest } from "./api.ts";

/** The suspension `suspendFor()` is entering, between arming and being taken. */
let armed: string | undefined;

/** Say that the real suspension operation is about to enter this exact wait. */
export function armSuspensionEntry(suspensionId: string): void {
  armed = suspensionId;
}

/** The wait the real operation armed, consumed so it admits exactly one entry. */
export function takeSuspensionEntry(): string | undefined {
  const taken = armed;
  armed = undefined;
  return taken;
}

/** What the execution-owned controller does with a wait it accepts. */
export type SuspensionEntry = (
  suspensionId: string,
  request: WorkflowSuspensionRequest,
) => Operation<Json>;

/**
 * The controller each live run installed, by run.
 *
 * `suspendFor()` reaches its controller through this map rather than through a
 * contextual API, because a contextual API is composable by design: a public
 * `around()` handler may answer an operation without delegating, and a document
 * that could answer `enter()` could return a value from a wait that never
 * happened. Composition is the right default for a provider a document may
 * legitimately replace. A durable wait is not one.
 *
 * Keyed by run id so two runs in one process reach their own controllers, and
 * removed when the execution that installed it ends.
 */
const controllers = (() => {
  const installed = new Map<string, SuspensionEntry>();
  return {
    install(runId: string, entry: SuspensionEntry): () => void {
      installed.set(runId, entry);
      return () => {
        if (installed.get(runId) === entry) {
          installed.delete(runId);
        }
      };
    },

    get(runId: string): SuspensionEntry | undefined {
      return installed.get(runId);
    },
  };
})();

export function installSuspensionEntry(runId: string, entry: SuspensionEntry): () => void {
  return controllers.install(runId, entry);
}

/** Enter this run's wait through the controller its own execution installed. */
export function enterSuspension(
  runId: string,
  suspensionId: string,
  request: WorkflowSuspensionRequest,
): Operation<Json> {
  const entry = controllers.get(runId);
  if (entry === undefined) {
    throw new WorkflowSuspensionProviderError();
  }
  return entry(suspensionId, request);
}
