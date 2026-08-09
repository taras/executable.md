import {
  createDurableOperation,
  type ActivateDurabilityFailure,
  type DurableEffect,
  type DurablePublicationIdentity,
  type EffectDescription,
  type Json,
  type LiveDurableOperationCoordinator,
  type Result,
} from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { WorkspaceCoordination } from "./api.ts";

const workspaceCoordinator: LiveDurableOperationCoordinator = {
  *run<T extends Json>(
    execute: () => Operation<T>,
    publish: (result: Result) => Operation<void>,
    activateFailure: ActivateDurabilityFailure,
    publicationIdentity: DurablePublicationIdentity | undefined,
  ): Operation<Result> {
    return yield* WorkspaceCoordination.operations.run(
      execute,
      publish,
      activateFailure,
      publicationIdentity,
    );
  },
};

/** Create a structured durable operation whose live path requires Workspace coordination. */
export function createDurableWorkspaceOperation<T extends Json>(
  description: EffectDescription,
  execute: () => Operation<T>,
): DurableEffect<T> {
  return createDurableOperation(description, execute, {
    coordinator: workspaceCoordinator,
  });
}
