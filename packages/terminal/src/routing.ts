/**
 * How a grid request reaches a provider, and how a provider is installed.
 *
 * **Routing is routing, and only routing.** Middleware here may observe,
 * narrow, refuse, wrap or delegate one grid request. What it cannot do is open
 * a grid: `open()` answers `unknown`, and the answer is thrown away. The
 * capability that takes the terminal lease and settles a grid is the
 * non-contextual presentation function delivered straight to the registered
 * provider, so a handler that answers without delegating has presented nothing
 * and settled nothing.
 *
 * Installation works the same way, and deliberately mirrors the Agent provider
 * handshake. Selecting a provider *is* a presentation decision, so nothing is
 * returned up the public chain: public middleware receives one frozen, one-use
 * install request and may inspect it, refuse by throwing, or delegate it. The
 * registered provider's handler sits at the terminal end of that chain and
 * holds its own captured continuation — a parameter of its generator, carried
 * by no request and no return value. Through it, and only through it, the
 * invocation terminal hands the factory this execution's presentation function
 * and records that the provider acknowledged installation.
 */

import { type Api, createApi } from "@effectionx/context-api";
import { ensure } from "effection";
import type { Operation } from "effection";

import { TerminalProviderInstallError, TerminalProviderUnavailableError } from "./errors.ts";
import type { PresentTerminalGrid } from "./host.ts";
import type { TerminalGridRequest } from "./layout.ts";

/** The stable name every loaded copy composes through. */
export const TERMINAL_GRIDS_API = "TerminalGrids";

export interface TerminalGridApi {
  /**
   * Route one grid request to whatever presents it.
   *
   * Answers `unknown`, and the answer is discarded: a return value is not
   * evidence that a grid was opened, and the lifecycle reads what presentation
   * settled instead of what a handler said.
   */
  open(request: TerminalGridRequest): Operation<unknown>;
}

/**
 * The public routing surface. Its own default always refuses.
 *
 * Reaching this default means no registered provider consumed the request, so
 * nothing was presented — which is the honest answer for a host that installs
 * no provider at all.
 */
export const TerminalGrids: Api<TerminalGridApi> = createApi<TerminalGridApi>(TERMINAL_GRIDS_API, {
  // deno-lint-ignore require-yield
  *open(_request: TerminalGridRequest): Operation<unknown> {
    throw new TerminalProviderUnavailableError();
  },
});

/** What a host says about the provider it is installing. */
export interface TerminalProviderOptions {
  /** How the provider names itself in provider-neutral diagnostics. */
  readonly label: string;
}

/**
 * A provider factory installs `TerminalGrids` middleware for its scope.
 *
 * Presentation is the second argument because it is delivered, not published:
 * there is no reader for it, no context holding one, and no request member
 * carrying one. A factory closes over it, and only the handler that closed over
 * it can pair a routed grid request with it.
 */
export type TerminalProviderFactory = (
  options: TerminalProviderOptions,
  present: PresentTerminalGrid,
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
        yield* factory(delivery.options, delivery.present);
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
  present: PresentTerminalGrid;
} {
  if (typeof value !== "object" || value === null) {
    throw new TerminalProviderInstallError(
      "this terminal provider installation is not live, so nothing was delivered to it",
    );
  }
  const options = Reflect.get(value, "options");
  const present = Reflect.get(value, "present");
  if (typeof options !== "object" || options === null) {
    throw new TerminalProviderInstallError(
      "the live terminal provider installation named no options",
    );
  }
  if (typeof present !== "function") {
    throw new TerminalProviderInstallError(
      "the live terminal provider installation carried no way to present a grid",
    );
  }
  const label = Reflect.get(options, "label");
  if (typeof label !== "string") {
    throw new TerminalProviderInstallError("the live terminal provider options are not readable");
  }
  return {
    options: { label },
    present: (request, provider) => Reflect.apply(present, undefined, [request, provider]),
  };
}

/**
 * Install the provider registered as `name`, under `options`, for the calling
 * operation.
 *
 * Presentation reaches whichever factory answers, and nothing else: a handler
 * that short-circuits, fabricates a return, or never acknowledges installs no
 * provider, and this refuses rather than leaving the caller believing one is
 * there.
 */
export function installTerminalProvider(
  name: string,
  options: TerminalProviderOptions,
  present: PresentTerminalGrid,
): Operation<void> {
  return (function* (): Operation<void> {
    const request: TerminalProviderInstallRequest = Object.freeze({
      intent: "install",
      name,
      options: Object.freeze({ ...options }),
    });
    const terminal = installationTerminal(request, options, present);
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
  present: PresentTerminalGrid,
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
        return { options, present };
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
