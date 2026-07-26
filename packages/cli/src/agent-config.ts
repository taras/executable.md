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

export interface AgentFlags {
  agentProvider: string;
  defaultAgent: string | undefined;
  /**
   * The raw `--timeout` text. The argument parser coerces or drops
   * lexical forms — `1e3`, `0x10`, `.5`, `+1` and `Infinity` all reach a
   * number-typed field as something this grammar would have rejected —
   * so the untransformed text is what gets validated.
   */
  timeout: string | undefined;
  approveAll: boolean;
  approveReads: boolean;
  denyAll: boolean;
}

export interface AgentConfig {
  permissionMode: PermissionMode;
  /** The `--default-agent` value; the environment fallback is applied by the caller. */
  defaultAgent: string | undefined;
  timeoutMs: number | undefined;
}

/** `digits` or `digits "." digits` — nothing else is a number of seconds. */
const SECONDS = /^\d+(\.\d+)?$/;

function parseTimeout(value: string): number | { error: string } {
  const invalid = {
    error: `--timeout must be a positive number of seconds, got "${value}"`,
  };
  const trimmed = value.trim();
  if (!SECONDS.test(trimmed)) {
    return invalid;
  }
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return invalid;
  }
  return seconds * 1000;
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

  let timeoutMs: number | undefined;
  if (flags.timeout !== undefined) {
    const parsed = parseTimeout(flags.timeout);
    if (typeof parsed !== "number") {
      return parsed;
    }
    timeoutMs = parsed;
  }

  return { permissionMode, defaultAgent: flags.defaultAgent, timeoutMs };
}
