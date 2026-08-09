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
  readonly provider: object | undefined;
}

interface InspectRequest {
  readonly type: "inspect";
}

interface ExecuteRequest {
  readonly type: "execute";
}

interface PublishRequest {
  readonly type: "publish";
  readonly result: Result;
}

interface ActivateFailureRequest {
  readonly type: "activate-failure";
  readonly failure: unknown;
}

interface CompleteRequest {
  readonly type: "complete";
  readonly result: Result;
}

type InvocationRequest =
  | StartRequest
  | InspectRequest
  | ExecuteRequest
  | PublishRequest
  | ActivateFailureRequest
  | CompleteRequest;

interface InspectionResponse {
  readonly type: "inspection";
  readonly executionIdentity: object;
  readonly publicationIdentity: DurablePublicationIdentity | undefined;
}

interface ValueResponse {
  readonly type: "value";
  readonly value: Json;
}

interface PublishedResponse {
  readonly type: "published";
}

interface FailureResponse {
  readonly type: "failure";
  readonly failure: Error;
}

interface ResultResponse {
  readonly type: "result";
  readonly result: Result;
}

type InvocationResponse =
  | InspectionResponse
  | ValueResponse
  | PublishedResponse
  | FailureResponse
  | ResultResponse;

interface WorkspaceInvocationApi {
  coordinate(request: InvocationRequest): Operation<InvocationResponse>;
}

const WORKSPACE_INVOCATION_API = "executablemd.workflow.workspace.coordination.invocation";

function unavailable(message: string): WorkspaceCoordinationProviderError {
  return new WorkspaceCoordinationProviderError(message);
}

const WorkspaceInvocation: Api<WorkspaceInvocationApi> = createApi<WorkspaceInvocationApi>(
  WORKSPACE_INVOCATION_API,
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<InvocationResponse> {
      throw unavailable("no Workspace coordinator accepted this live invocation");
    },
  },
);

function inspect(response: InvocationResponse): InspectionResponse {
  if (response.type !== "inspection") {
    throw unavailable("the Workspace provider received an invalid invocation inspection");
  }
  return response;
}

function value(response: InvocationResponse): Json {
  if (response.type !== "value") {
    throw unavailable("the Workspace provider received an invalid execution response");
  }
  return response.value;
}

function published(response: InvocationResponse): void {
  if (response.type !== "published") {
    throw unavailable("the Workspace provider received an invalid publication response");
  }
}

function activated(response: InvocationResponse): Error {
  if (response.type !== "failure") {
    throw unavailable("the Workspace provider received an invalid durability failure response");
  }
  return response.failure;
}

function completed(response: InvocationResponse): Result {
  if (response.type !== "result") {
    throw unavailable("the selected Workspace provider did not complete its live invocation");
  }
  return response.result;
}

export function withWorkspaceCoordinationProvider<T>(
  provider: WorkspaceCoordinationProvider,
  operation: Operation<T>,
): Operation<T> {
  return scoped(function* () {
    const selection = Object.freeze({});
    let registrationOpen = true;
    yield* ensure(() => {
      registrationOpen = false;
    });
    yield* WorkspaceCoordination.around({ provider: () => selection }, { at: "min" });
    yield* WorkspaceInvocation.around(
      {
        *coordinate([request], next): Operation<InvocationResponse> {
          if (!registrationOpen || request.type !== "start" || request.provider !== selection) {
            throw unavailable(
              "the selected Workspace coordinator is missing, foreign, completed, or stale",
            );
          }

          const details = inspect(yield* next({ type: "inspect" }));
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
              return value(yield* next({ type: "execute" }));
            },
            *publish(result: Result): Operation<void> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              published(yield* next({ type: "publish", result }));
            },
            *activateFailure(failure: unknown): Operation<Error> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              return activated(yield* next({ type: "activate-failure", failure }));
            },
          });

          try {
            const result = yield* provider.run(authority);
            return yield* next({ type: "complete", result });
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

function invocationApi(
  executionIdentity: object,
  execute: () => Operation<Json>,
  publish: (result: Result) => Operation<void>,
  activateFailure: ActivateDurabilityFailure,
  publicationIdentity: DurablePublicationIdentity | undefined,
): { api: Api<WorkspaceInvocationApi>; close: () => void } {
  let state: "available" | "active" | "complete" = "available";
  let executionAttempted = false;
  let publicationCompleted = false;

  function requireActive(): void {
    if (state !== "active") {
      throw unavailable("the live Workspace coordination invocation is completed or stale");
    }
  }

  return {
    api: createApi<WorkspaceInvocationApi>(WORKSPACE_INVOCATION_API, {
      *coordinate(request: InvocationRequest): Operation<InvocationResponse> {
        if (request.type === "start") {
          throw unavailable("no Workspace coordinator accepted this live invocation");
        }
        if (request.type === "inspect") {
          if (state !== "available") {
            throw unavailable(
              "the live Workspace coordination invocation is missing, reused, completed, or stale",
            );
          }
          state = "active";
          return {
            type: "inspection",
            executionIdentity,
            publicationIdentity,
          };
        }
        requireActive();
        if (request.type === "execute") {
          if (executionAttempted) {
            throw unavailable("the live Workspace execution is already consumed");
          }
          executionAttempted = true;
          return { type: "value", value: yield* execute() };
        }
        if (request.type === "publish") {
          if (!executionAttempted || publicationCompleted) {
            throw unavailable("the live Workspace publication is missing or already consumed");
          }
          yield* publish(request.result);
          publicationCompleted = true;
          return { type: "published" };
        }
        if (request.type === "activate-failure") {
          return { type: "failure", failure: activateFailure(request.failure) };
        }
        if (!publicationCompleted) {
          throw unavailable("the selected Workspace provider omitted its live publication");
        }
        state = "complete";
        return { type: "result", result: request.result };
      },
    }),
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
      const invocation = invocationApi(
        executionIdentity,
        execute,
        publish,
        activateFailure,
        publicationIdentity,
      );

      try {
        const selection = yield* WorkspaceCoordination.operations.provider;
        return completed(
          yield* invocation.api.operations.coordinate({ type: "start", provider: selection }),
        );
      } catch (error) {
        throw activateFailure(error);
      } finally {
        invocation.close();
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
