/**
 * How a terminal provider is installed, and what installing one grants.
 *
 * A provider is the only thing that can present a grid, so *selecting* one is
 * itself an authority decision. Returning a factory up the public chain would
 * mean any handler could answer with a factory of its own — or take the one it
 * was given and install it somewhere else.
 *
 * So nothing is returned. Public middleware receives one frozen, one-use
 * install request naming the provider and its normalized options, and may
 * inspect it, refuse by throwing, or delegate it. The registered provider's
 * handler sits at the terminal end of that chain and holds its own captured
 * continuation — a parameter of its generator, carried by no request and no
 * return value. Through that continuation, and only through it, the invocation
 * terminal hands the factory this execution's terminal authority and records
 * that the provider acknowledged installation.
 *
 * Registration is scope-local: a nested registration overrides an outer one for
 * its own name without touching siblings or process-global state.
 *
 * This is the same handshake `AgentProviders` uses, deliberately. The two
 * capabilities are different — one hands a child the whole terminal, one
 * divides it into panes — but the question "who may install the thing that
 * performs it" has one right answer, and two spellings of it would be two
 * chances to get it wrong.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure } from "effection";
import type { Operation } from "effection";

import type { TerminalGridAuthority } from "./authority.ts";

/** What a host says about the provider it is installing. */
export interface TerminalProviderOptions {
  /** How the provider names itself in provider-neutral diagnostics. */
  readonly label: string;
}

/**
 * A provider factory installs `TerminalGrids` middleware for its scope.
 *
 * The authority is the second argument because it is delivered, not published:
 * there is no reader for it, no context holding one, and no request member
 * carrying one. A factory closes over it, and only the handler that closed over
 * it can pair a routed grid request with it.
 */
export type TerminalProviderFactory = (
  options: TerminalProviderOptions,
  authority: TerminalGridAuthority,
) => Operation<void>;

/** The stable name every loaded copy composes through. */
export const TERMINAL_PROVIDERS_API = "TerminalProviders";

/** What public installation middleware sees: the name, and what it runs under. */
export interface TerminalProviderInstallRequest {
  readonly intent: "install";
  readonly name: string;
  readonly options: TerminalProviderOptions;
}

/**
 * One message on the installation operation.
 *
 * Public middleware only ever receives the install request. The two private
 * members are how the registered provider's handler speaks to the invocation's
 * own terminal through the continuation it captured; constructing one grants
 * nothing, because the terminal is reachable from that continuation alone.
 */
export type TerminalProviderCall =
  | TerminalProviderInstallRequest
  | { readonly intent: "inspect"; readonly install: TerminalProviderInstallRequest }
  | { readonly intent: "acknowledge"; readonly install: TerminalProviderInstallRequest };

export interface TerminalProviderApi {
  /**
   * Install one provider.
   *
   * Answers nothing: a return value is not evidence a provider was installed,
   * and the invocation that issued the request ignores it.
   */
  install(call: TerminalProviderCall): Operation<unknown>;
}

export class TerminalProviderInstallError extends Error {
  override name = "TerminalProviderInstallError";
}

/**
 * The public installation surface. Its own default always refuses.
 *
 * Invoking this descriptor with a captured request outside a live installation
 * reaches this default and installs nothing.
 */
export const TerminalProviders: Api<TerminalProviderApi> = createApi<TerminalProviderApi>(
  TERMINAL_PROVIDERS_API,
  {
    // deno-lint-ignore require-yield
    *install(call: TerminalProviderCall): Operation<unknown> {
      const name = call.intent === "install" ? call.name : call.install.name;
      throw new TerminalProviderInstallError(`Unknown terminal provider "${name}"`);
    },
  },
);

/** Make `factory` installable as `name` for the current scope. */
export function* registerTerminalProvider(
  name: string,
  factory: TerminalProviderFactory,
): Operation<void> {
  let registered = true;
  yield* ensure(() => {
    registered = false;
  });
  yield* TerminalProviders.around(
    {
      *install([call], next): Operation<unknown> {
        if (call.intent !== "install" || call.name !== name) {
          return yield* next(call);
        }
        if (!registered) {
          throw new TerminalProviderInstallError(
            `the "${name}" terminal provider registration is no longer live`,
          );
        }
        // Inspection first, and through the captured continuation: the terminal
        // refuses a copied, reused or stale request here, before the factory
        // installs anything.
        const delivery = deliveryOf(yield* next({ intent: "inspect", install: call }));
        yield* factory(delivery.options, delivery.authority);
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
  options: TerminalProviderOptions;
  authority: TerminalGridAuthority;
} {
  if (typeof value !== "object" || value === null) {
    throw new TerminalProviderInstallError(
      "this terminal provider installation is not live, so nothing was delivered to it",
    );
  }
  const options = Reflect.get(value, "options");
  const authority = Reflect.get(value, "authority");
  if (typeof options !== "object" || options === null) {
    throw new TerminalProviderInstallError(
      "the live terminal provider installation named no options",
    );
  }
  if (typeof authority !== "object" || authority === null) {
    throw new TerminalProviderInstallError(
      "the live terminal provider installation carried no authority",
    );
  }
  const label = Reflect.get(options, "label");
  if (typeof label !== "string") {
    throw new TerminalProviderInstallError("the live terminal provider options are not readable");
  }
  const present = Reflect.get(authority, "present");
  if (typeof present !== "function") {
    throw new TerminalProviderInstallError(
      "the live terminal provider installation carried no grid authority",
    );
  }
  return {
    options: { label },
    authority: {
      present: (request, composite) => Reflect.apply(present, authority, [request, composite]),
    },
  };
}

/**
 * Install the provider registered as `name`, under `options`, for the calling
 * operation.
 *
 * The authority reaches whichever factory answers, and nothing else: a handler
 * that short-circuits, fabricates a return, or never acknowledges installs no
 * provider, and this refuses rather than leaving the caller believing one is
 * there.
 */
export function installTerminalProvider(
  name: string,
  options: TerminalProviderOptions,
  authority: TerminalGridAuthority,
): Operation<void> {
  return (function* (): Operation<void> {
    const request: TerminalProviderInstallRequest = Object.freeze({
      intent: "install",
      name,
      options: Object.freeze({ ...options }),
    });
    const terminal = installationTerminal(request, options, authority);
    // Same stable name, so the shared middleware chain applies; own descriptor,
    // so the chain ends in this invocation's terminal rather than in the public
    // refusing default.
    const invocation = createApi<TerminalProviderApi>(TERMINAL_PROVIDERS_API, {
      install: terminal.install,
    });
    yield* invocation.operations.install(request);
    if (!terminal.acknowledged()) {
      throw new TerminalProviderInstallError(
        `the "${name}" terminal provider did not install — a handler answered without ` +
          `delivering the request to a registered provider`,
      );
    }
    terminal.close();
  })();
}

function installationTerminal(
  request: TerminalProviderInstallRequest,
  options: TerminalProviderOptions,
  authority: TerminalGridAuthority,
): {
  install: (call: TerminalProviderCall) => Operation<unknown>;
  acknowledged: () => boolean;
  close: () => void;
} {
  let state: "available" | "inspected" | "acknowledged" | "closed" = "available";

  return {
    // deno-lint-ignore require-yield
    *install(call: TerminalProviderCall): Operation<unknown> {
      if (call.intent === "install") {
        // Reaching the terminal means no registered provider consumed it.
        throw new TerminalProviderInstallError(`Unknown terminal provider "${call.name}"`);
      }
      // Object identity, not shape: a request rebuilt with the same members
      // describes the same ask and authorizes nothing.
      if (!Object.is(call.install, request)) {
        throw new TerminalProviderInstallError(
          "the live terminal provider installation received a copied, substituted or foreign request",
        );
      }
      if (call.intent === "inspect") {
        if (state !== "available") {
          throw new TerminalProviderInstallError(
            "this terminal provider installation is reused, completed or stale",
          );
        }
        state = "inspected";
        return { options, authority };
      }
      if (state !== "inspected") {
        throw new TerminalProviderInstallError(
          "this terminal provider acknowledgement is unsolicited, duplicated or stale",
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
