/**
 * How an agent provider is installed, and what installing one grants.
 *
 * A provider is the only thing that can perform a launch, so *selecting* one is
 * itself a coordination decision. The old shape resolved a name to a factory and
 * handed that factory back up the public chain, which meant any handler could
 * answer with a factory of its own — or take the one it was given and install
 * it somewhere else.
 *
 * So nothing is returned. Public middleware receives one frozen, one-use
 * install request naming the provider and its normalized options, and may
 * inspect it, refuse by throwing, or delegate it. The registered provider's
 * handler sits at the terminal end of that chain and holds its own captured
 * continuation — a parameter of its generator, carried by no request and no
 * return value. Through that continuation, and only through it, the invocation
 * terminal hands the factory this document's launch coordinator and records that
 * the provider acknowledged installation.
 *
 * Registration is scope-local: a nested registration overrides an outer one for
 * its own name without touching siblings or process-global state.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure, type Operation } from "effection";
import type { PermissionMode } from "./agent-api.ts";
import type { AgentLaunchCoordinator } from "./launch-coordinator.ts";
import type { AgentSessionPlacement } from "./session-placement.ts";

export interface AgentProviderOptions {
  defaultAgent: string;
  permissionMode: PermissionMode;
}

/**
 * A provider factory installs `Agent` middleware for its scope.
 *
 * The coordinator is the second argument because it is delivered, not published:
 * there is no reader for it, no context holding one, and no request member
 * carrying one. A factory closes over it, and only the handler that closed over
 * it can pair a routed launch request with it.
 */
export type AgentProviderFactory = (
  options: AgentProviderOptions,
  launchCoordinator: AgentLaunchCoordinator,
) => Operation<void>;

/** The stable name every loaded copy composes through. */
export const AGENT_PROVIDERS_API = "AgentProviders";

/** What public installation middleware sees: the name, and what it runs under. */
export interface AgentProviderInstallRequest {
  readonly intent: "install";
  readonly name: string;
  readonly options: AgentProviderOptions;
}

/**
 * One message on the installation operation.
 *
 * Public middleware only ever receives the install request. The two private
 * members are how the registered provider's handler speaks to the invocation's
 * own terminal through the continuation it captured; constructing one grants
 * nothing, because the terminal is reachable from that continuation alone.
 */
export type AgentProviderCall =
  | AgentProviderInstallRequest
  | { readonly intent: "inspect"; readonly install: AgentProviderInstallRequest }
  | { readonly intent: "acknowledge"; readonly install: AgentProviderInstallRequest };

export interface AgentProviderApi {
  /**
   * Install one provider.
   *
   * Answers nothing: a return value is not evidence a provider was installed,
   * and the invocation that issued the request ignores it.
   */
  install(call: AgentProviderCall): Operation<unknown>;
}

export class AgentProviderInstallError extends Error {
  override name = "AgentProviderInstallError";
}

/**
 * The public installation surface. Its own default always refuses.
 *
 * Invoking this descriptor with a captured request outside a live installation
 * reaches this default and installs nothing.
 */
export const AgentProviders: Api<AgentProviderApi> = createApi<AgentProviderApi>(
  AGENT_PROVIDERS_API,
  {
    // deno-lint-ignore require-yield
    *install(call: AgentProviderCall): Operation<unknown> {
      const name = call.intent === "install" ? call.name : call.install.name;
      throw new AgentProviderInstallError(`Unknown agent provider "${name}"`);
    },
  },
);

/** Make `factory` installable as `name` for the current scope. */
export function* registerAgentProvider(
  name: string,
  factory: AgentProviderFactory,
): Operation<void> {
  let registered = true;
  yield* ensure(() => {
    registered = false;
  });
  yield* AgentProviders.around(
    {
      *install([call], next): Operation<unknown> {
        if (call.intent !== "install" || call.name !== name) {
          return yield* next(call);
        }
        if (!registered) {
          throw new AgentProviderInstallError(
            `the "${name}" agent provider registration is no longer live`,
          );
        }
        // Inspection first, and through the captured continuation: the terminal
        // refuses a copied, reused or stale request here, before the factory
        // installs anything.
        const delivery = deliveryOf(yield* next({ intent: "inspect", install: call }));
        yield* factory(delivery.options, delivery.launchCoordinator);
        yield* next({ intent: "acknowledge", install: call });
        return undefined;
      },
    },
    { at: "min" },
  );
}

/**
 * What the terminal told this handler, or a refusal.
 *
 * Parsed rather than believed. The terminal that produced it belongs to the
 * canonical copy, and this handler may belong to another; what arrives is a
 * value, and reading it as a delivery is this side's decision.
 */
function deliveryOf(value: unknown): {
  options: AgentProviderOptions;
  launchCoordinator: AgentLaunchCoordinator;
} {
  if (typeof value !== "object" || value === null) {
    throw new AgentProviderInstallError(
      "this agent provider installation is not live, so nothing was delivered to it",
    );
  }
  const options = Reflect.get(value, "options");
  const launchCoordinator = Reflect.get(value, "launchCoordinator");
  if (typeof options !== "object" || options === null) {
    throw new AgentProviderInstallError("the live agent provider installation named no options");
  }
  if (typeof launchCoordinator !== "object" || launchCoordinator === null) {
    throw new AgentProviderInstallError(
      "the live agent provider installation carried no launch coordinator",
    );
  }
  const defaultAgent = Reflect.get(options, "defaultAgent");
  const permissionMode = permissionModeOf(Reflect.get(options, "permissionMode"));
  if (typeof defaultAgent !== "string" || permissionMode === undefined) {
    throw new AgentProviderInstallError("the live agent provider options are not readable");
  }
  const perform = Reflect.get(launchCoordinator, "perform");
  const refuse = Reflect.get(launchCoordinator, "refuse");
  const sessionPlacement = Reflect.get(launchCoordinator, "sessionPlacement");
  const checkpoint = Reflect.get(launchCoordinator, "checkpoint");
  const sessionUse = Reflect.get(launchCoordinator, "sessionUse");
  const registerSessionConfiguration = Reflect.get(
    launchCoordinator,
    "registerSessionConfiguration",
  );
  if (
    typeof perform !== "function" ||
    typeof refuse !== "function" ||
    typeof sessionPlacement !== "function" ||
    typeof checkpoint !== "function" ||
    typeof sessionUse !== "function"
  ) {
    throw new AgentProviderInstallError(
      "the live agent provider installation carried no launch coordination",
    );
  }
  return {
    options: { defaultAgent, permissionMode },
    launchCoordinator: {
      perform: (request, phases) => Reflect.apply(perform, launchCoordinator, [request, phases]),
      refuse: (request, preparation) =>
        Reflect.apply(refuse, launchCoordinator, [request, preparation]),
      sessionPlacement: (request) =>
        placementOf(Reflect.apply(sessionPlacement, launchCoordinator, [request])),
      checkpoint: (terminal, token) => {
        Reflect.apply(checkpoint, launchCoordinator, [terminal, token]);
      },
      sessionUse: (routed) => Reflect.apply(sessionUse, launchCoordinator, [routed]),
    },
  };
}

/**
 * What the terminal answered a placement with, read rather than believed.
 *
 * The handle settles one conversation, so a value that cannot do that is a
 * value this side refuses rather than hands to a provider.
 */
function placementOf(value: unknown): AgentSessionPlacement {
  if (typeof value !== "object" || value === null) {
    throw new AgentProviderInstallError(
      "the live agent provider installation answered a session placement with nothing that " +
        "could settle it",
    );
  }
  const complete = Reflect.get(value, "complete");
  const sessionIdentity = Reflect.get(value, "sessionIdentity");
  if (typeof complete !== "function") {
    throw new AgentProviderInstallError(
      "the live agent provider installation answered a session placement that settles nothing",
    );
  }
  return {
    ...(typeof sessionIdentity === "string" ? { sessionIdentity } : {}),
    complete: (session, state) => Reflect.apply(complete, value, [session, state]),
  };
}

const PERMISSION_MODES: readonly PermissionMode[] = ["approve-all", "approve-reads", "deny-all"];

function permissionModeOf(value: unknown): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode === value);
}

/**
 * Install the provider registered as `name`, under `options`, for the calling
 * operation.
 *
 * Deliberately not wrapped around a body. A component's content is projected
 * into that component's *invocation*, not into a frame nested inside it, so a
 * provider installed inside a `scoped()` here would be invisible to exactly the
 * content it exists for. Installing into the caller's own operation is what
 * puts it where the content can reach it.
 *
 * The coordinator reaches whichever factory answers, and nothing else: a handler
 * that short-circuits, fabricates a return, or never acknowledges installs no
 * provider, and this refuses rather than leaving the caller believing one is
 * there.
 */
export function installAgentProvider(
  name: string,
  options: AgentProviderOptions,
  launchCoordinator: AgentLaunchCoordinator,
): Operation<void> {
  return (function* (): Operation<void> {
    const request: AgentProviderInstallRequest = Object.freeze({
      intent: "install",
      name,
      options: Object.freeze({ ...options }),
    });
    const terminal = installationTerminal(request, options, launchCoordinator);
    // Same stable name, so the shared middleware chain applies; own descriptor,
    // so the chain ends in this invocation's terminal rather than in the public
    // refusing default.
    const invocation = createApi<AgentProviderApi>(AGENT_PROVIDERS_API, {
      install: terminal.install,
    });
    yield* invocation.operations.install(request);
    if (!terminal.acknowledged()) {
      throw new AgentProviderInstallError(
        `the "${name}" agent provider did not install — a handler answered without ` +
          `delivering the request to a registered provider`,
      );
    }
    terminal.close();
  })();
}

function installationTerminal(
  request: AgentProviderInstallRequest,
  options: AgentProviderOptions,
  launchCoordinator: AgentLaunchCoordinator,
): {
  install: (call: AgentProviderCall) => Operation<unknown>;
  acknowledged: () => boolean;
  close: () => void;
} {
  let state: "available" | "inspected" | "acknowledged" | "closed" = "available";

  return {
    // deno-lint-ignore require-yield
    *install(call: AgentProviderCall): Operation<unknown> {
      if (call.intent === "install") {
        // Reaching the terminal means no registered provider consumed it.
        throw new AgentProviderInstallError(`Unknown agent provider "${call.name}"`);
      }
      // Object identity, not shape: a request rebuilt with the same members
      // describes the same ask and is admitted nowhere.
      if (!Object.is(call.install, request)) {
        throw new AgentProviderInstallError(
          "the live agent provider installation received a copied, substituted or foreign request",
        );
      }
      if (call.intent === "inspect") {
        if (state !== "available") {
          throw new AgentProviderInstallError(
            "this agent provider installation is reused, completed or stale",
          );
        }
        state = "inspected";
        return { options, launchCoordinator };
      }
      if (state !== "inspected") {
        throw new AgentProviderInstallError(
          "this agent provider acknowledgement is unsolicited, duplicated or stale",
        );
      }
      state = "acknowledged";
      return undefined;
    },
    acknowledged: () => state === "acknowledged",
    close() {
      state = "closed";
    },
  };
}
