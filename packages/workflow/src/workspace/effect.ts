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
  readonly provider: object | undefined;
}

interface ExecuteRequest {
  readonly type: "execute";
  readonly provider: object | undefined;
}

interface PublishRequest {
  readonly type: "publish";
  readonly provider: object | undefined;
  readonly result: Result;
}

interface ActivateFailureRequest {
  readonly type: "activate-failure";
  readonly provider: object | undefined;
  readonly failure: unknown;
}

interface CompleteRequest {
  readonly type: "complete";
  readonly provider: object | undefined;
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

          const details = inspect(yield* next({ type: "inspect", provider: selection }));
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
              return value(yield* next({ type: "execute", provider: selection }));
            },
            *publish(result: Result): Operation<void> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              published(yield* next({ type: "publish", provider: selection, result }));
            },
            *activateFailure(failure: unknown): Operation<Error> {
              if (!authorityOpen) {
                throw unavailable(
                  "the live Workspace coordination authority is completed or stale",
                );
              }
              return activated(
                yield* next({ type: "activate-failure", provider: selection, failure }),
              );
            },
          });

          try {
            const result = yield* provider.run(authority);
            return yield* next({ type: "complete", provider: selection, result });
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
  provider: object | undefined,
  executionIdentity: object,
  execute: () => Operation<Json>,
  publish: (result: Result) => Operation<void>,
  activateFailure: ActivateDurabilityFailure,
  publicationIdentity: DurablePublicationIdentity | undefined,
): {
  api: Api<WorkspaceInvocationApi>;
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

  return {
    api: createApi<WorkspaceInvocationApi>(WORKSPACE_INVOCATION_API, {
      *coordinate(request: InvocationRequest): Operation<InvocationResponse> {
        if (request.type === "start") {
          throw unavailable("no Workspace coordinator accepted this live invocation");
        }
        if (provider === undefined || request.provider !== provider) {
          throw unavailable("the live Workspace coordination invocation has foreign authority");
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
          if (!executionAttempted || publishedResult !== undefined) {
            throw unavailable("the live Workspace publication is missing or already consumed");
          }
          yield* publish(request.result);
          publishedResult = request.result;
          return { type: "published" };
        }
        if (request.type === "activate-failure") {
          return { type: "failure", failure: activateFailure(request.failure) };
        }
        if (publishedResult === undefined || request.result !== publishedResult) {
          throw unavailable("the selected Workspace provider omitted its live publication");
        }
        completedResult = publishedResult;
        state = "complete";
        return { type: "result", result: completedResult };
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
      let invocation: ReturnType<typeof invocationApi> | undefined;

      try {
        const selection = yield* WorkspaceCoordination.operations.provider;
        invocation = invocationApi(
          selection,
          executionIdentity,
          execute,
          publish,
          activateFailure,
          publicationIdentity,
        );
        yield* invocation.api.operations.coordinate({ type: "start", provider: selection });
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
