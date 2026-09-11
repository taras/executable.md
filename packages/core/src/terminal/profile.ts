/**
 * Opening one terminal installation for a live document.
 *
 * A grid needs two things before it can be durable at all: this execution's
 * installation — which mints the generation every request belongs to, and adds
 * the requests it issues to the private lookup presentation converges through —
 * and a provider installed against the presentation function that installation
 * builds. A grid outside one refuses rather than presenting something no replay
 * could resume.
 *
 * The installation's lifetime has to surround authored work and end while the
 * journal is still live, which is what `Execution.document` is.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { installTerminalProvider } from "@executablemd/terminal";
import { useTerminalInstallation } from "@executablemd/terminal/lifecycle";

import { Execution } from "../execute.ts";

export interface TerminalGridProfileOptions {
  /**
   * The registered provider to install for this execution.
   *
   * Omitted, the installation is opened and no provider is installed — which is
   * a host that validates and inspects grids but cannot present one, and
   * refuses when a document asks for one.
   */
  readonly provider?: string;
  /** How the provider names itself in provider-neutral diagnostics. */
  readonly label?: string;
}

/**
 * Install the terminal-grid profile for the executions composed under it.
 *
 * Presentation reaches the named provider's factory and nothing else: it is
 * delivered through the installation handshake rather than published, so a
 * handler that answers the install request itself installs no provider and the
 * document is told so.
 */
export function installTerminalGridProfile(
  options: TerminalGridProfileOptions = {},
): Operation<void> {
  return Execution.around({
    *document([request], next) {
      yield* scoped(function* () {
        const present = yield* useTerminalInstallation();
        if (options.provider !== undefined) {
          yield* installTerminalProvider(
            options.provider,
            { label: options.label ?? options.provider },
            present,
          );
        }
        yield* next(request);
      });
    },
  });
}
