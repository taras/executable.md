/**
 * How a trusted host says what is behind a provider-backed fragment entry.
 *
 * A `component-answer` entry names something the ordinary import chain resolves
 * rather than an operation core supplies a body for. The host does not hand
 * over the implementation — it states which name, and which structural identity
 * a provider must have claimed for that name. This module is the seam a
 * provider uses to make that claim.
 *
 * ## Being asked and answering are two authorities
 *
 * A provider installs through a *registrar*, and receives no handle it can keep
 * and state an answer with. The registrar is the right to be asked; each
 * handler invocation then receives its own {@link ComponentAnswerRequest},
 * which is the right to answer *that* asking and nothing else.
 *
 * The split is the whole point. A stable handle a provider retains can only
 * ever prove "some provider installed by this host" — it cannot prove which
 * invocation is speaking, so a handler that has already returned, or one that
 * lost, could state an answer to an import it is not deciding. A request proves
 * it, because it is minted for one invocation, captures the resolution it was
 * asked in by object identity, and is closed the moment that invocation ends.
 *
 * So `claim` takes no name. The name is fixed when the request is minted, from
 * what the chain asked, and a handler cannot state an answer for a component it
 * was never asked about.
 *
 * All of it is ordinary closures. There is no shared symbol, module registry or
 * context name behind any of these objects, which is what lets a separately
 * loaded copy of core hold one without any of those being a way in.
 *
 * ## Claiming is not authority
 *
 * Claiming identifies an answer. It authorizes nothing. A fragment still needs
 * the host entry, an exact identity match, the right `allow` class, whole-
 * fragment preflight and canonical generated import — all of them
 * independently. Middleware that answers an import without claiming anything is
 * an ordinary replacement and stays exactly as valid as it was; what it cannot
 * do is enter an admitted fragment.
 */

import type { Operation } from "effection";

import { Component } from "./component-api.ts";
import type {
  ComponentAnswerRequest,
  ImportedDefinition,
  ProviderInstallation,
} from "./components/import-authority.ts";
import type { SourcePosition } from "./types.ts";

export type { ComponentAnswerRequest } from "./components/import-authority.ts";

/**
 * One handler a provider registers, invoked once per import it observes.
 *
 * The shape ordinary `Component.importComponent` middleware already has, with
 * the asked name and position arriving as a request rather than as loose
 * arguments. Delegation is unchanged: `yield* next()` reaches the rest of the
 * chain, and an outer handler may delegate, look at what came back, and then
 * claim its own replacement before returning.
 */
export type ComponentAnswerHandler = (
  request: ComponentAnswerRequest,
  next: (name?: string, position?: Readonly<SourcePosition>) => Operation<ImportedDefinition>,
) => Operation<ImportedDefinition>;

/**
 * What a provider installs through, in place of anything it could keep.
 *
 * Registering composes the middleware; canonical execution owns the request
 * lifetime around each invocation of it, so a provider cannot hold the lease
 * open past its own handler.
 */
export interface ComponentAnswerRegistrar {
  /**
   * Compose one handler around this execution's import chain.
   *
   * Spelled `around` because that is what the stable API a provider already
   * knows spells it — `Component.around({ importComponent })` — and this
   * registers the same middleware through the same composition, with the asked
   * name and position arriving as a request instead of as loose arguments. One
   * verb for one act keeps a host from having to learn a second vocabulary for
   * the thing it was already doing.
   */
  around(handler: ComponentAnswerHandler): Operation<void>;
}

/**
 * One provider's installation, run during capture and before ordinary installs.
 *
 * `origin` is the provider's name for itself and becomes the origin on every
 * identity its requests state. `install` registers whatever import middleware
 * answers for its names.
 */
export interface ComponentAnswerInstallation {
  readonly origin: string;
  install(registrar: ComponentAnswerRegistrar): Operation<void>;
}

/**
 * The registrar canonical execution hands one installation.
 *
 * Each registered handler is wrapped so that one request is minted for the
 * invocation and closed in a `finally` when it returns, throws or is cancelled.
 * The close is synchronous on purpose: a lease that needed a suspension point
 * to end would still be open across one, which is exactly the window a settled
 * handler must not have.
 */
export function componentAnswerRegistrar(
  installation: ProviderInstallation,
): ComponentAnswerRegistrar {
  return {
    *around(handler: ComponentAnswerHandler): Operation<void> {
      yield* Component.around({
        *importComponent([name, position], next) {
          const asked = installation.open(name, position);
          try {
            return yield* handler(
              asked.request,
              (forName?: string, forPosition?: Readonly<SourcePosition>) =>
                next(forName ?? name, forPosition ?? position),
            );
          } finally {
            // Synchronous, and in `finally`, so the lease ends the same way the
            // invocation did — returned, threw, or was cancelled. Nothing
            // yields here: a close that needed a suspension point would leave
            // the request open across one.
            asked.close();
          }
        },
      });
    },
  };
}
