/**
 * The agent-provider factory contract (specs/acp-client-spec.md
 * §Provider seam). A provider factory installs `Agent` middleware for its
 * scope; it is supplied to `installAgentVocabulary` through the
 * `rootProvider` option and owned by each DocumentExecution.
 */

import type { Operation } from "effection";
import type { PermissionMode } from "./agent-api.ts";

export interface AgentProviderOptions {
  defaultAgent: string;
  permissionMode: PermissionMode;
}

export type AgentProviderFactory = (options: AgentProviderOptions) => Operation<void>;
