/**
 * AgentProviders Api — resolves agent-provider factories by name
 * (specs/acp-client-spec.md §AgentProviderApi).
 *
 * Registration is scope-local middleware: `registerAgentProvider` installs
 * a resolver for one name in the current scope, delegating every other
 * name outward. Nested registrations override an outer registration
 * without changing siblings or process-global state.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { PermissionMode } from "./agent-api.ts";

export interface AgentProviderOptions {
  defaultAgent: string;
  permissionMode: PermissionMode;
}

export type AgentProviderFactory = (options: AgentProviderOptions) => Operation<void>;

export interface AgentProviderApi {
  resolve(name: string): Operation<AgentProviderFactory>;
}

export const AgentProviders: Api<AgentProviderApi> = createApi<AgentProviderApi>("AgentProviders", {
  // deno-lint-ignore require-yield
  *resolve(name: string): Operation<AgentProviderFactory> {
    throw new Error(`Unknown agent provider "${name}"`);
  },
});

export function* registerAgentProvider(
  name: string,
  factory: AgentProviderFactory,
): Operation<void> {
  yield* AgentProviders.around(
    {
      *resolve([requested], next) {
        if (requested === name) {
          return factory;
        }
        return yield* next(requested);
      },
    },
    { at: "min" },
  );
}
