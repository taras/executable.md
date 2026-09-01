/**
 * One launch installation per live document, and the programmatic
 * `Agent.launch()` that runs inside it.
 *
 * The installation is what a launch needs before it can be durable at all: the
 * per-location ordinal, the journal, the terminal, and the provider that was
 * installed for *this* document. A call outside one refuses rather than
 * performing a launch no replay could resume.
 *
 * What travels contextually is the registry — composition data, so a document
 * and the components it expands find the same one. The authority does not: it
 * is handed to a provider factory directly. A replaced registry therefore
 * produces requests the real authority has never heard of, which is a refusal
 * rather than a way in.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { LaunchOptions, SessionLaunchResult } from "./agent-api.ts";
import { createLaunchAuthority } from "./launch-authority.ts";
import type { AgentProviderAuthority } from "./launch-authority.ts";
import { createLaunchRegistry, launchSession } from "./launch-owner.ts";
import type { LaunchRegistry } from "./launch-owner.ts";
import { AgentInternal } from "./internal.ts";
import { installPermissionMode } from "./permission.ts";
import { installAgentProvider } from "./provider-api.ts";
import type { AgentProviderOptions } from "./provider-api.ts";

interface LaunchInstallation {
  registry: LaunchRegistry;
  /** Identifies this document's provider installation, and nothing else. */
  generation: object;
}

const Installation: Context<LaunchInstallation | undefined> = createContext<
  LaunchInstallation | undefined
>("executablemd.agent.launch.installation", undefined);

/**
 * Open one launch installation for a live document, and hand back the
 * authority its providers are installed with.
 */
export function* useLaunchInstallation(): Operation<AgentProviderAuthority> {
  const registry = createLaunchRegistry();
  const generation = {};
  yield* Installation.set({ registry, generation });
  return createLaunchAuthority(generation, () => registry.live());
}

/**
 * `Agent.launch()` — prepare one native session and hand its UI the terminal.
 *
 * Supported from anywhere inside an active document expansion, including a
 * repository function component. `<Session.Launch>` renders its body and calls
 * exactly this.
 */
export function* launchAgentSession(
  instructions: string,
  options?: LaunchOptions,
): Operation<SessionLaunchResult> {
  const installation = yield* Installation.get();
  if (!installation) {
    throw new Error(
      `Agent.launch() is available only while a document execution with an installed ` +
        `agent provider is running — a launch outside one retains no phase and could ` +
        `not be resumed`,
    );
  }
  return yield* launchSession(
    installation.registry,
    installation.generation,
    instructions,
    options,
  );
}

/**
 * Install the provider named by `<AgentProvider>` for `body`.
 *
 * The authority a registered factory receives is this document's, reached only
 * through the terminal the installation opens — so a handler that answers the
 * install request itself installs nothing.
 */
/**
 * Install one registered Agent provider for the current invocation, as
 * `<AgentProvider>` does for the content it projects.
 *
 * A trusted host component that establishes a constrained ceiling around the
 * content it projects needs exactly this and nothing else: the provider is
 * installed in the invocation rather than in a frame nested inside it, so the
 * content the ceiling was selected for can see it. The default agent and the
 * permission mode travel with it, because a ceiling that left either to be
 * inherited would be a ceiling the enclosing document could widen.
 *
 * It is a host capability rather than a document one: nothing reachable by
 * importing `@executablemd/core` can install a provider for a region it did not
 * author, and no prop, binding or middleware return value supplies one.
 */
export function* installInvocationAgentProvider(
  name: string,
  options: AgentProviderOptions,
): Operation<void> {
  yield* AgentInternal.around({ defaultAgentName: () => options.defaultAgent }, { at: "min" });
  yield* installPermissionMode(options.permissionMode);
  yield* useProviderInstallation(name, options);
}

export function* useProviderInstallation(
  name: string,
  options: AgentProviderOptions,
): Operation<void> {
  const installation = yield* Installation.get();
  if (!installation) {
    throw new Error(`<AgentProvider name="${name}"> is available only inside a document execution`);
  }
  const authority = createLaunchAuthority(installation.generation, () =>
    installation.registry.live(),
  );
  yield* installAgentProvider(name, options, authority);
}
