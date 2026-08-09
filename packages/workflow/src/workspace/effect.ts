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
import { ensure, type Operation, scoped } from "effection";
import { WorkspaceCoordination, WorkspaceCoordinationProviderError } from "./api.ts";

export type WorkspaceCoordinationInvocation = object;

export interface WorkspaceCoordinationAuthority {
  readonly executionIdentity: object;
  readonly publicationIdentity: DurablePublicationIdentity | undefined;
  execute(): Operation<Json>;
  publish(result: Result): Operation<void>;
  activateFailure(failure: unknown): Error;
}

export interface WorkspaceCoordinationProvider {
  run(invocation: WorkspaceCoordinationInvocation): Operation<Result>;
}

interface ProviderRegistration {
  open: boolean;
  readonly provider: WorkspaceCoordinationProvider;
}

interface InvocationRecord {
  state: "available" | "active" | "complete";
  readonly executionIdentity: object;
  readonly execute: () => Operation<Json>;
  readonly publish: (result: Result) => Operation<void>;
  readonly activateFailure: ActivateDurabilityFailure;
  readonly publicationIdentity: DurablePublicationIdentity | undefined;
}

const workspaceCoordinationState = (() => {
  const providers = new WeakMap<object, ProviderRegistration>();
  const invocations = new WeakMap<object, InvocationRecord>();

  return {
    registerProvider(provider: WorkspaceCoordinationProvider): {
      selection: object;
      close: () => void;
    } {
      const selection = Object.freeze({});
      const registration: ProviderRegistration = { open: true, provider };
      providers.set(selection, registration);
      return {
        selection,
        close(): void {
          registration.open = false;
          providers.delete(selection);
        },
      };
    },

    provider(selection: object): WorkspaceCoordinationProvider | undefined {
      const registration = providers.get(selection);
      return registration?.open ? registration.provider : undefined;
    },

    createInvocation(record: InvocationRecord): WorkspaceCoordinationInvocation {
      const invocation = Object.freeze({});
      invocations.set(invocation, record);
      return invocation;
    },

    invocation(invocation: WorkspaceCoordinationInvocation): InvocationRecord | undefined {
      return invocations.get(invocation);
    },

    finishInvocation(invocation: WorkspaceCoordinationInvocation, record: InvocationRecord): void {
      record.state = "complete";
      invocations.delete(invocation);
    },
  };
})();

function unavailable(message: string): WorkspaceCoordinationProviderError {
  return new WorkspaceCoordinationProviderError(message);
}

function requireActive(
  invocation: WorkspaceCoordinationInvocation,
  record: InvocationRecord,
): void {
  if (record.state !== "active" || workspaceCoordinationState.invocation(invocation) !== record) {
    throw unavailable("the live Workspace coordination invocation is completed or stale");
  }
}

export function* withWorkspaceCoordinationInvocation(
  invocation: WorkspaceCoordinationInvocation,
  coordinate: (authority: WorkspaceCoordinationAuthority) => Operation<Result>,
): Operation<Result> {
  const record = workspaceCoordinationState.invocation(invocation);
  if (record === undefined || record.state !== "available") {
    throw unavailable(
      "the live Workspace coordination invocation is missing, foreign, reused, completed, or stale",
    );
  }
  record.state = "active";
  const authority: WorkspaceCoordinationAuthority = Object.freeze({
    executionIdentity: record.executionIdentity,
    publicationIdentity: record.publicationIdentity,
    *execute(): Operation<Json> {
      requireActive(invocation, record);
      return yield* record.execute();
    },
    *publish(result: Result): Operation<void> {
      requireActive(invocation, record);
      yield* record.publish(result);
    },
    activateFailure(failure: unknown): Error {
      requireActive(invocation, record);
      return record.activateFailure(failure);
    },
  });

  try {
    return yield* coordinate(authority);
  } finally {
    workspaceCoordinationState.finishInvocation(invocation, record);
  }
}

export function withWorkspaceCoordinationProvider<T>(
  provider: WorkspaceCoordinationProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const registration = workspaceCoordinationState.registerProvider(provider);
    yield* ensure(registration.close);
    yield* WorkspaceCoordination.around({ provider: () => registration.selection }, { at: "min" });
    return yield* operation;
  });
}

function workspaceCoordinator(executionIdentity: object): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: Result) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      publicationIdentity: DurablePublicationIdentity | undefined,
    ): Operation<Result> {
      const record: InvocationRecord = {
        state: "available",
        executionIdentity,
        execute,
        publish,
        activateFailure,
        publicationIdentity,
      };
      const invocation = workspaceCoordinationState.createInvocation(record);

      try {
        const selection = yield* WorkspaceCoordination.operations.provider;
        const provider =
          selection === undefined ? undefined : workspaceCoordinationState.provider(selection);
        if (provider === undefined) {
          throw unavailable(
            "the selected Workspace coordinator is missing, foreign, completed, or stale",
          );
        }
        const result = yield* provider.run(invocation);
        if (record.state !== "complete") {
          throw unavailable(
            "the selected Workspace coordinator did not consume its live invocation",
          );
        }
        return result;
      } catch (error) {
        throw activateFailure(error);
      } finally {
        workspaceCoordinationState.finishInvocation(invocation, record);
      }
    },
  };
}

function createDurableWorkspaceOperationWithIdentity<T extends Json>(
  description: EffectDescription,
  execute: () => Operation<T>,
  executionIdentity: object,
): DurableEffect<T> {
  return createDurableOperation(description, execute, {
    coordinator: workspaceCoordinator(executionIdentity),
  });
}

/** Create a structured durable operation whose live path requires Workspace coordination. */
export function createDurableWorkspaceOperation<T extends Json>(
  description: EffectDescription,
  execute: () => Operation<T>,
): DurableEffect<T> {
  return createDurableWorkspaceOperationWithIdentity(description, execute, Object.freeze({}));
}

export function createOwnedDurableWorkspaceOperation<T extends Json>(
  description: EffectDescription,
  execute: () => Operation<T>,
  executionIdentity: object,
): DurableEffect<T> {
  return createDurableWorkspaceOperationWithIdentity(description, execute, executionIdentity);
}
