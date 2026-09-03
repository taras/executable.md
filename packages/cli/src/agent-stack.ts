/**
 * The one Agent configuration an invocation resolves, and the two things a
 * host does with it (specs/acp-client-spec.md §Command-line configuration).
 *
 * `xmd run` and `xmd plan` take the same Agent, permission and provider
 * options, so they resolve them once, here, rather than each reading the flags
 * again. What they do with the result differs, and deliberately: a run installs
 * the registered provider into the Agent Api so a document may reach it, while
 * `xmd plan` hands the same answer to two consumers — the authorship profile, which
 * takes the provider name and the default agent and nothing else, and the
 * approved document, which runs the ordinary run stack.
 *
 * `agent-config.ts` stays the pure flag-to-permission mapping. This module is
 * where the environment, the provider registry and the host's own machine
 * session assembly enter.
 */

import {
  installAgentComponents,
  installPermissionMode,
  registerAgentProvider,
} from "@executablemd/core";
import type { AgentProviderFactory, PermissionMode } from "@executablemd/core";
import { installForegroundLauncher, env as readEnv } from "@executablemd/runtime";
import { unsupportedTerminalGrid } from "./terminal/host.ts";
import type { TerminalGridInstaller } from "./terminal/host.ts";
import { createAcpxProvider, DEFAULT_AGENT_NAME } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";
// A separate entrypoint because the embedded adapters are temporary (#636) and
// must not become part of the package's stable surface.
import {
  createEmbeddedAdapters,
  embeddedAdapterDependencies,
} from "@executablemd/acp/embedded-adapters";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import { Err, Ok } from "effection";
import type { Operation, Result } from "effection";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentConfig } from "./agent-config.ts";
import type { AgentFlags } from "./agent-config.ts";
import type { MachineSessionAssembly } from "./session-coordinator.ts";

/**
 * Where a command that is not a workflow run materializes its adapters.
 *
 * One root for this machine, content-addressed beneath it: two invocations
 * asking for the same adapter name the same directory, so the second one runs
 * what the first installed, and a build carrying a different snapshot names a
 * different directory instead of deciding whether this one is current.
 */
export const DEFAULT_ADAPTER_ROOT: string = join(homedir(), ".xmd", "adapters");

/** Everything one invocation settled about agents, resolved exactly once. */
export interface AgentStack {
  /** The provider name the caller selected, already known to be registered. */
  provider: string;
  /** The agent every consumer defaults to, environment fallback applied. */
  defaultAgent: string;
  permissionMode: PermissionMode;
  /**
   * The ACP adapters this build carries, and where this host puts them.
   *
   * Part of the one settled answer because both consumers resolve agents
   * through it: the assistant that writes a Plan and the run of the approved
   * Plan are the same Codex or Claude, launched from the same snapshot.
   */
  adapters: EmbeddedAdapters;
  /** What this host states about machine-wide agent sessions, if anything. */
  sessions?: MachineSessionAssembly;
  /**
   * What presents this host's terminal grids.
   *
   * Deno and the compiled binary supply the tmux provider; Node and Bun supply
   * the one that installs none, so those runtimes describe and validate the
   * same grids and open none of them.
   */
  installTerminalGrid?: TerminalGridInstaller;
}

/**
 * Read the command line, the environment and the host's assembly into one
 * configuration.
 *
 * A failure comes back as a `Result` rather than as a printed line and an exit,
 * so the same resolution serves a command that runs a document and one that
 * generates one first.
 */
export function* resolveAgentStack(
  flags: AgentFlags,
  sessions: MachineSessionAssembly | undefined,
  installTerminalGrid?: TerminalGridInstaller,
): Operation<Result<AgentStack>> {
  const config = resolveAgentConfig(flags);
  if ("error" in config) {
    return Err(new Error(config.error));
  }
  if (flags.agentProvider !== "acpx") {
    return Err(new Error(`Unknown agent provider "${flags.agentProvider}"`));
  }
  const defaultAgent =
    config.defaultAgent ?? (yield* readEnv("DEFAULT_AGENT_NAME")) ?? DEFAULT_AGENT_NAME;
  return Ok({
    provider: flags.agentProvider,
    defaultAgent,
    permissionMode: config.permissionMode,
    adapters: createEmbeddedAdapters(DEFAULT_ADAPTER_ROOT),
    ...(sessions === undefined ? {} : { sessions }),
    ...(installTerminalGrid === undefined ? {} : { installTerminalGrid }),
  });
}

/**
 * What this host carries and what it built, stated to the provider.
 *
 * The adapters are first, and unconditional: an `xmd run` or an `xmd plan` that
 * asked for Codex or Claude and got ACPX's own registry would run whatever
 * `npx` resolved from that build's pins — an adapter that names no turn, or one
 * carrying an agent release this machine does not have (#672).
 *
 * Each of the rest reaches the provider directly rather than through a context:
 * who owns a session and which build it belongs to are security decisions, and
 * ones a document could replace are not ones. The two advertised sets are stated
 * by the host, not inherited.
 */
export function hostAcpDependencies(stack: AgentStack): AcpxProviderDependencies {
  const { sessions } = stack;
  const adapters = embeddedAdapterDependencies(stack.adapters);
  if (sessions === undefined) {
    return adapters;
  }
  return {
    ...adapters,
    ...(sessions.coordinator ? { coordinator: sessions.coordinator } : {}),
    ...(sessions.routeStore ? { routeStore: sessions.routeStore } : {}),
    ...(sessions.executableObserver ? { executableObserver: sessions.executableObserver } : {}),
    advertiseNativeLaunch: sessions.advertiseNativeLaunch,
    advertiseClientNativeAttachment: sessions.advertiseClientNativeAttachment,
  };
}

/**
 * Install the agent stack a document runs under: the registration, the
 * components with the resolved root provider, the permission mode, and the
 * terminal this command has to give away.
 *
 * Nothing starts an agent — the provider validates availability on first use,
 * and an embedded adapter reaches the disk at that same point. A document that
 * asks for no agent installs no adapter.
 */
export function* installRunAgentStack(stack: AgentStack): Operation<void> {
  const acpx = createAcpxProvider(hostAcpDependencies(stack));
  yield* registerAgentProvider("acpx", acpx);

  // The trusted host selects its own root provider by name. Document-level
  // selection goes through the installation protocol; this is the host saying
  // what it configured, which no document is composing around.
  const providers: Record<string, AgentProviderFactory> = { acpx };
  const factory = providers[stack.provider];
  const { defaultAgent, permissionMode } = stack;
  yield* installAgentComponents({
    defaultAgent,
    permissionMode,
    rootProvider: { factory, options: { defaultAgent, permissionMode } },
  });
  yield* installPermissionMode(permissionMode);
  // `xmd run` is the one command that has a terminal to give away. Help,
  // document inspection and `xmd test` install no launcher, so a document that
  // reaches <Session.Launch> under any of them refuses instead of spawning.
  yield* installForegroundLauncher();
  // And whatever presents this host's terminal grids, which on a host that
  // presents none still opens the installation so a grid is validated — the
  // refusal a document meets there is core's own.
  yield* (stack.installTerminalGrid ?? unsupportedTerminalGrid)();
}
