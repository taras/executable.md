import { type Api, createApi } from "@effectionx/context-api";

export interface WorkspaceCoordinationApi {
  readonly provider: object | undefined;
}

/** A Workspace operation has no safe live fallback without its owning provider. */
export class WorkspaceCoordinationProviderError extends Error {
  override name = "WorkspaceCoordinationProviderError";

  constructor(
    message = "no Workspace coordinator is installed, so a live Workspace operation cannot execute or publish",
  ) {
    super(message);
  }
}

/** Selects a Workspace provider without carrying live-operation authority. */
export const WorkspaceCoordination: Api<WorkspaceCoordinationApi> =
  createApi<WorkspaceCoordinationApi>("executablemd.workflow.workspace.coordination", {
    provider: undefined,
  });
