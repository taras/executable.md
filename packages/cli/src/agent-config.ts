/**
 * Agent flag parsing for `xmd run` (specs/acp-client-spec.md
 * §Command-line configuration).
 *
 * A pure function over the parsed flags: it reads no Context Apis, no
 * environment, and no configuration. The `DEFAULT_AGENT_NAME` lookup and
 * every install step stay in the CLI, so the flag-to-configuration
 * mapping can be asserted on its own.
 */

import type { PermissionMode } from "@executablemd/core";

/** What settling who writes needs, and the whole of it. */
export interface AuthorshipFlags {
  agentProvider: string;
  defaultAgent: string | undefined;
}

/** The same, plus the flags that select a document execution's permission mode. */
export interface AgentFlags extends AuthorshipFlags {
  approveAll: boolean;
  approveReads: boolean;
  denyAll: boolean;
}

export interface AgentConfig {
  permissionMode: PermissionMode;
  /** The `--default-agent` value; the environment fallback is applied by the caller. */
  defaultAgent: string | undefined;
}

export function resolveAgentConfig(flags: AgentFlags): AgentConfig | { error: string } {
  const selected = [flags.approveAll, flags.approveReads, flags.denyAll].filter(Boolean);
  if (selected.length > 1) {
    return { error: "--approve-all, --approve-reads, and --deny-all are mutually exclusive" };
  }
  const permissionMode: PermissionMode = flags.approveAll
    ? "approve-all"
    : flags.denyAll
      ? "deny-all"
      : "approve-reads";

  return { permissionMode, defaultAgent: flags.defaultAgent };
}
