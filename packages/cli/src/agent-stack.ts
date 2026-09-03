/**
 * The Agent configuration an invocation resolves, and what a host does with it
 * (specs/acp-client-spec.md §Command-line configuration).
 *
 * Two commands ask, and they ask for different amounts. `xmd run` settles the
 * whole of it and installs the registered provider into the Agent Api so a
 * document may reach it. `xmd plan` writes a program and runs none, so it
 * settles only who writes — the provider name, the default agent and the
 * adapters this build carries — and hands that to the authorship profile.
 * Resolving it once, here, is what keeps `DEFAULT_AGENT_NAME` from being read
 * twice and answered differently.
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
import type { AgentFlags, AuthorshipFlags } from "./agent-config.ts";
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

/**
 * Who writes, and what this host launches them with.
 *
 * The whole of what Plan authorship settles. There is no permission mode here
 * because the authorship frame installs its own fixed one, and no command line
 * selects it: the flags that choose a permission mode configure a document
 * execution, and `xmd plan` starts none.
 */
export interface AuthorshipStack {
  /** The provider name the caller selected, already known to be registered. */
  provider: string;
  /** The agent every consumer defaults to, environment fallback applied. */
  defaultAgent: string;
  /** The ACP adapters this build carries, and where this host puts them. */
  adapters: EmbeddedAdapters;
  /** What this host states about machine-wide agent sessions, if anything. */
  sessions?: MachineSessionAssembly;
}

/** Everything one `xmd run` invocation settled about agents, resolved once. */
export interface AgentStack extends AuthorshipStack {
  permissionMode: PermissionMode;
}

/**
 * Read the provider selection, the environment and the host's assembly into the
 * answer authorship needs.
 *
 * A failure comes back as a `Result` rather than as a printed line and an exit,
 * so the same resolution serves a command that runs a document and one that
 * only writes one.
 */
export function* resolveAuthorshipStack(
  flags: AuthorshipFlags,
  sessions: MachineSessionAssembly | undefined,
): Operation<Result<AuthorshipStack>> {
  if (flags.agentProvider !== "acpx") {
    return Err(new Error(`Unknown agent provider "${flags.agentProvider}"`));
  }
  const defaultAgent =
    flags.defaultAgent ?? (yield* readEnv("DEFAULT_AGENT_NAME")) ?? DEFAULT_AGENT_NAME;
  return Ok({
    provider: flags.agentProvider,
    defaultAgent,
    adapters: createEmbeddedAdapters(DEFAULT_ADAPTER_ROOT),
    ...(sessions === undefined ? {} : { sessions }),
  });
}

/**
 * The same answer, plus the permission mode the document a run executes is
 * installed under.
 */
export function* resolveAgentStack(
  flags: AgentFlags,
  sessions: MachineSessionAssembly | undefined,
): Operation<Result<AgentStack>> {
  const config = resolveAgentConfig(flags);
  if ("error" in config) {
    return Err(new Error(config.error));
  }
  const authorship = yield* resolveAuthorshipStack(
    { agentProvider: flags.agentProvider, defaultAgent: config.defaultAgent },
    sessions,
  );
  if (!authorship.ok) {
    return authorship;
  }
  return Ok({ ...authorship.value, permissionMode: config.permissionMode });
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
export function hostAcpDependencies(stack: AuthorshipStack): AcpxProviderDependencies {
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
}
