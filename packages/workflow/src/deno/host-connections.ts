/**
 * The connection registry this host installed, for provider code that is not
 * given one.
 *
 * A `WorkflowRunDatabase` handle is a lease on an authoritative connection, and
 * everything that writes beside a caller's transaction needs the registry that
 * issued it. Most provider code is handed that registry directly, because it is
 * created where the provider is installed. The suspension controller is not: it
 * is created by the trusted host around one execution, from a handle alone.
 *
 * So the registry travels under a stable contextual name — and what travels is
 * an opaque token, never the registry. The token is meaningless without the
 * private map that resolves it, so a scope that reconstructs the name selects
 * nothing, and a registration closed with its installing scope stops resolving.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure, type Operation } from "effection";
import type { WorkflowRunConnections } from "./connections.ts";

interface HostConnectionsApi {
  readonly selection: object | undefined;
}

const HostConnections: Api<HostConnectionsApi> = createApi<HostConnectionsApi>(
  "executablemd.workflow.deno.host.connections",
  { selection: undefined },
);

const registrations = (() => {
  const entries = new WeakMap<object, { open: boolean; connections: WorkflowRunConnections }>();

  return {
    register(connections: WorkflowRunConnections): { selection: object; close: () => void } {
      const selection = Object.freeze({});
      const entry = { open: true, connections };
      entries.set(selection, entry);
      return {
        selection,
        close(): void {
          entry.open = false;
          entries.delete(selection);
        },
      };
    },

    get(selection: object | undefined): WorkflowRunConnections | undefined {
      if (selection === undefined) {
        return undefined;
      }
      const entry = entries.get(selection);
      return entry?.open ? entry.connections : undefined;
    },
  };
})();

/** Publish this host's registry for the installing scope and its descendants. */
export function* useHostConnections(connections: WorkflowRunConnections): Operation<void> {
  const registration = registrations.register(connections);
  yield* ensure(registration.close);
  yield* HostConnections.around({ selection: () => registration.selection }, { at: "min" });
}

/** The registry the enclosing host installed, or nothing outside one. */
export function* hostConnections(): Operation<WorkflowRunConnections | undefined> {
  return registrations.get(yield* HostConnections.operations.selection);
}
