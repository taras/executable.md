import { type Api, createApi } from "@effectionx/context-api";
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

export interface WorkspaceCoordinationAuthority {
  readonly executionIdentity: object;
  readonly publicationIdentity: DurablePublicationIdentity | undefined;
  execute(): Operation<Json>;
  publish(result: Result): Operation<void>;
  activateFailure(failure: unknown): Operation<Error>;
}

export interface WorkspaceCoordinationProvider {
  run(authority: WorkspaceCoordinationAuthority): Operation<Result>;
}

interface StartRequest {
  readonly type: "start";
  readonly route: object;
  readonly invocation: WorkspaceInvocationCapability;
}

interface WorkspaceInvocationDetails {
  readonly executionIdentity: object;
  readonly publicationIdentity: DurablePublicationIdentity | undefined;
}

interface WorkspaceInvocationCapability {
  inspect(credential: object): Operation<WorkspaceInvocationDetails>;
  execute(credential: object): Operation<Json>;
  publish(credential: object, result: Result): Operation<void>;
  activateFailure(credential: object, failure: unknown): Operation<Error>;
  complete(credential: object, result: Result): Operation<void>;
}

interface WorkspaceInvocationApi {
  coordinate(request: StartRequest): Operation<void>;
}

interface ProviderSelection {
  readonly route: object;
  readonly credential: object;
}

const WORKSPACE_INVOCATION_API = "executablemd.workflow.workspace.coordination.invocation";

function unavailable(message: string): WorkspaceCoordinationProviderError {
  return new WorkspaceCoordinationProviderError(message);
}

const WorkspaceInvocation: Api<WorkspaceInvocationApi> = createApi<WorkspaceInvocationApi>(
  WORKSPACE_INVOCATION_API,
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<void> {
      throw unavailable("no Workspace coordinator accepted this live invocation");
    },
  },
);

function providerSelection(value: object | undefined): ProviderSelection {
  const route = value === undefined ? undefined : Reflect.get(value, "route");
  const credential = value === undefined ? undefined : Reflect.get(value, "credential");
  if (
    typeof route !== "object" ||
    route === null ||
    typeof credential !== "object" ||
    credential === null
  ) {
    throw unavailable("the selected Workspace coordinator is missing, foreign, or substituted");
  }
  return { route, credential };
}

export function withWorkspaceCoordinationProvider<T>(
  provider: WorkspaceCoordinationProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const registrations = new WeakMap<object, object>();
    let registrationOpen = true;
    yield* ensure(() => {
      registrationOpen = false;
    });
    yield* WorkspaceCoordination.around(
      {
        provider(): object {
          const route = Object.freeze({});
          const credential = Object.freeze({});
          registrations.set(route, credential);
          return Object.freeze({ route, credential });
        },
      },
      { at: "min" },
    );
    yield* WorkspaceInvocation.around(
      {
        *coordinate([request]): Operation<void> {
          const credential = registrations.get(request.route);
          registrations.delete(request.route);
          if (!registrationOpen || request.type !== "start" || credential === undefined) {
            throw unavailable(
              "the selected Workspace coordinator is missing, foreign, completed, or stale",
            );
          }

          const details = yield* request.invocation.inspect(credential);
          let authorityOpen = true;
          const authority: WorkspaceCoordinationAuthority = Object.freeze({
            executionIdentity: details.executionIdentity,
            publicationIdentity: details.publicationIdentity,
            *execute(): Operation<Json> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              return yield* request.invocation.execute(credential);
            },
            *publish(result: Result): Operation<void> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              yield* request.invocation.publish(credential, result);
            },
            *activateFailure(failure: unknown): Operation<Error> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              return yield* request.invocation.activateFailure(credential, failure);
            },
          });

          try {
            const result = yield* provider.run(authority);
            yield* request.invocation.complete(credential, result);
          } finally {
            authorityOpen = false;
          }
        },
      },
      { at: "min" },
    );
    return yield* operation;
  });
}

function invocationCapability(
  credential: object,
  executionIdentity: object,
  execute: () => Operation<Json>,
  publish: (result: Result) => Operation<void>,
  activateFailure: ActivateDurabilityFailure,
  publicationIdentity: DurablePublicationIdentity | undefined,
): {
  capability: WorkspaceInvocationCapability;
  authoritativeResult: () => Result | undefined;
  close: () => void;
} {
  let state: "available" | "active" | "complete" = "available";
  let executionAttempted = false;
  let publishedResult: Result | undefined;
  let completedResult: Result | undefined;

  function requireActive(): void {
    if (state !== "active") {
      throw unavailable("the live Workspace coordination invocation is completed or stale");
    }
  }

  function requireCredential(candidate: object): void {
    if (candidate !== credential) {
      throw unavailable("the live Workspace coordination invocation has foreign authority");
    }
  }

  return {
    capability: Object.freeze({
      *inspect(candidate: object): Operation<WorkspaceInvocationDetails> {
        requireCredential(candidate);
        if (state !== "available") {
          throw unavailable(
            "the live Workspace coordination invocation is missing, reused, completed, or stale",
          );
        }
        state = "active";
        return { executionIdentity, publicationIdentity };
      },
      *execute(candidate: object): Operation<Json> {
        requireCredential(candidate);
        requireActive();
        if (executionAttempted) {
          throw unavailable("the live Workspace execution is already consumed");
        }
        executionAttempted = true;
        return yield* execute();
      },
      *publish(candidate: object, result: Result): Operation<void> {
        requireCredential(candidate);
        requireActive();
        if (!executionAttempted || publishedResult !== undefined) {
          throw unavailable("the live Workspace publication is missing or already consumed");
        }
        yield* publish(result);
        publishedResult = result;
      },
      *activateFailure(candidate: object, failure: unknown): Operation<Error> {
        requireCredential(candidate);
        requireActive();
        return activateFailure(failure);
      },
      *complete(candidate: object, result: Result): Operation<void> {
        requireCredential(candidate);
        requireActive();
        if (publishedResult === undefined || result !== publishedResult) {
          throw unavailable("the selected Workspace provider omitted its live publication");
        }
        completedResult = publishedResult;
        state = "complete";
      },
    }),
    authoritativeResult(): Result | undefined {
      return completedResult;
    },
    close(): void {
      state = "complete";
    },
  };
}

function workspaceCoordinator(executionIdentity: object): LiveDurableOperationCoordinator {
  return {
    *run<T extends Json>(
      execute: () => Operation<T>,
      publish: (result: Result) => Operation<void>,
      activateFailure: ActivateDurabilityFailure,
      publicationIdentity: DurablePublicationIdentity | undefined,
    ): Operation<Result> {
      let invocation: ReturnType<typeof invocationCapability> | undefined;

      try {
        const selection = providerSelection(yield* WorkspaceCoordination.operations.provider);
        invocation = invocationCapability(
          selection.credential,
          executionIdentity,
          execute,
          publish,
          activateFailure,
          publicationIdentity,
        );
        yield* WorkspaceInvocation.operations.coordinate({
          type: "start",
          route: selection.route,
          invocation: invocation.capability,
        });
        const result = invocation.authoritativeResult();
        if (result === undefined) {
          throw unavailable("the selected Workspace provider did not complete its live invocation");
        }
        return result;
      } catch (error) {
        const result = invocation?.authoritativeResult();
        if (result !== undefined) {
          return result;
        }
        throw activateFailure(error);
      } finally {
        invocation?.close();
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
