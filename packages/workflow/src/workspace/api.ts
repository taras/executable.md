import { type Api, createApi } from "@effectionx/context-api";
import type {
  ActivateDurabilityFailure,
  DurableStream,
  Json,
  LiveDurableOperationCoordinator,
  Result,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";

export type WorkspaceCoordinationApi = LiveDurableOperationCoordinator;

/** A Workspace operation has no safe live fallback without its owning provider. */
export class WorkspaceCoordinationProviderError extends Error {
  override name = "WorkspaceCoordinationProviderError";

  constructor() {
    super(
      "no Workspace coordinator is installed, so a live Workspace operation cannot execute or publish",
    );
  }
}

export const WorkspaceCoordination: Api<WorkspaceCoordinationApi> =
  createApi<WorkspaceCoordinationApi>("executablemd.workflow.workspace.coordination", {
    // deno-lint-ignore require-yield
    *run<T extends Json>(
      _execute: () => Operation<T>,
      _publish: (result: Result) => Operation<void>,
      _activateFailure: ActivateDurabilityFailure,
      _stream: DurableStream,
    ): Operation<Result> {
      throw new WorkspaceCoordinationProviderError();
    },
  });
