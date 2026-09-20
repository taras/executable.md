/**
 * One launch installation per live document, and the programmatic
 * `Agent.launch()` that runs inside it.
 *
 * The installation is what a launch needs before it can be durable at all: the
 * per-location ordinal, the journal, the terminal, and the provider that was
 * installed for *this* document. A call outside one refuses rather than
 * performing a launch no replay could resume.
 *
 * What travels contextually is the installation — composition data, so a
 * document and the components it expands find the same one. What it holds does
 * not: the coordinator is handed to a provider factory directly, and the owner
 * that settles placements and issues configured uses is a closure inside the
 * installing operation. A replaced installation therefore produces requests the
 * real coordinator has never heard of, which is a refusal rather than a way
 * in.
 */

import { createContext, ensure } from "effection";
import type { Context, Operation } from "effection";
import { Agent } from "./agent-api.ts";
import type {
  LaunchOptions,
  Session,
  SessionConfiguration,
  SessionLaunchResult,
} from "./agent-api.ts";
import { configurationOf } from "./session-use.ts";
import type { AgentSessionUse } from "./session-use.ts";
import type { AgentSessionRequest } from "./session-request.ts";
import { createLaunchCoordinator } from "./launch-coordinator.ts";
import type { AgentLaunchCoordinator } from "./launch-coordinator.ts";
import { createLaunchRegistry, launchSession } from "./launch-owner.ts";
import type { LaunchRegistry } from "./launch-owner.ts";
import { AgentInternal } from "./internal.ts";
import { installPermissionMode } from "./permission.ts";
import { installAgentProvider } from "./provider-api.ts";
import type { AgentProviderOptions } from "./provider-api.ts";
import { createSessionPlacementOwner } from "./session-placement.ts";
import { configurePlacement, sessionPlacement } from "./session-request.ts";

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
 * coordinator its providers are installed with.
 */
export function* useLaunchInstallation(): Operation<void> {
  const registry = createLaunchRegistry();
  const generation = {};
  yield* Installation.set({ registry, generation });
}

/**
 * Build the coordinator one installed provider is handed, and own it.
 *
 * The placement owner is created here, in the operation that installs the
 * provider, and closed immediately after that provider's own finalizers —
 * cleanups registered later unwind first, so a provider is fully dismantled
 * before the thing that could still configure its conversations goes away. A
 * placement settled after that refuses rather than reaching a provider that is
 * no longer there.
 */
export function* useInstalledCoordinator(): Operation<AgentLaunchCoordinator> {
  const installation = yield* Installation.get();
  if (!installation) {
    throw new Error("an agent provider is installable only inside a document execution");
  }
  const owner = createSessionPlacementOwner();
  yield* ensure(() => owner.close());
  return createLaunchCoordinator(
    installation.generation,
    () => installation.registry.live(),
    owner,
  );
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
 * Resolve one session and issue an authentic use of it.
 *
 * The one way a configured session comes into being. A caller supplies what the
 * conversation should run under; what comes back is the exact `Session` the
 * provider issued, carrying an authority only this document installation can
 * read. There is deliberately no operation that takes a session somebody
 * already holds and pairs it with settings of their choosing: that value would
 * be one any holder could rebuild, and the provider would act on it.
 *
 * Supported from anywhere inside an active document expansion, including a
 * repository function component. `<Session model effort>` calls exactly this.
 */
export function* useConfiguredSession(
  name: string | AgentSessionRequest | undefined,
  configuration: SessionConfiguration,
): Operation<Session> {
  const installation = yield* Installation.get();
  if (!installation) {
    throw new Error(
      `a configured session is available only while a document execution with an installed ` +
        `agent provider is running — nothing outside one can say which installation a ` +
        `configuration belongs to`,
    );
  }
  if (typeof name === "object") {
    // An element that already opened its placement is only now saying what it
    // asks of the conversation. Sealed before anything routes, so the provider
    // is told what the document authored rather than what a handler left.
    configurePlacement(name, configuration);
    return yield* Agent.operations.session(name);
  }
  // A programmatic caller has no element, so there is nothing durable to name:
  // this placement exists for the length of this call and describes only the
  // name it was given.
  const issuance = sessionPlacement(undefined, name);
  issuance.configure(configuration);
  try {
    return yield* Agent.operations.session(issuance.request);
  } finally {
    issuance.close();
  }
}

/**
 * What a session this installation issued says its conversation runs under.
 *
 * Core's own read, for the one thing core owns about a configuration: writing
 * it down. A name or an ordinary session answers with nothing; a value that
 * claims to be a configured use and is not one refuses here exactly as it would
 * at the provider.
 */
export function* sessionUseConfiguration(
  routed: string | Session | undefined,
): Operation<SessionConfiguration | undefined> {
  // What the value itself says, not what an installation admits: deciding
  // whether a use may act belongs to the provider installation that issued it,
  // and by the time this is asked that decision has already been made — the
  // turn ran. What is left is writing down what it ran under. A name or an
  // ordinary session says nothing; a value that claims to be a configured use
  // and is not one refuses rather than being read as either.
  return configurationOf(routed);
}

/**
 * Install the provider named by `<AgentProvider>` for `body`.
 *
 * The coordinator a registered factory receives is this document's, reached only
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
  const launchCoordinator = yield* useInstalledCoordinator();
  yield* installAgentProvider(name, options, launchCoordinator);
}
