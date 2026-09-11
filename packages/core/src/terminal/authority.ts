/**
 * Who is allowed to own a terminal, and what "ready" means (architecture.md
 * §Terminal authority).
 *
 * The provider draws a grid. This decides everything about it that matters:
 * which request is live, which provider installation it belongs to, which pane
 * ordinals exist, whether an interactive operation may start on one, when a
 * pane has actually started, and what the grid settled to. None of that is
 * reachable by name. There is no context holding an authority, no member of a
 * request that carries one, and no handler return value that produces one — an
 * authority reachable by name would be an authority every same-name context and
 * every loaded copy could reach.
 *
 * The request object is the unforgeable carrier. It is issued here for one grid
 * under one installation generation, and a request from another grid, an
 * earlier generation, or a finished expansion presents nothing at all.
 * Presenting one grants the provider its drawing surface and nothing else: it
 * says nothing about which Agent session a pane may own, because that is the
 * session coordinator's to answer and stays independently authoritative.
 *
 * What a pane's work may do with its terminal is not decided here. The grid
 * lifecycle owns that, and hands each pane the one `PaneTerminal` it runs on.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";
import type { TerminalComposite, TerminalGridRequest } from "@executablemd/runtime";

export class TerminalAuthorityError extends Error {
  override name = "TerminalAuthorityError";
}

/**
 * What a registered provider must present in order to act.
 *
 * Delivered directly to the provider factory as it installs, and reachable
 * nowhere else. Presenting the exact request core issued is what takes the
 * terminal leases and runs the grid; anything else —
 * a copy, a rebuilt lookalike, an earlier grid's request, a request already
 * presented, or one belonging to a superseded installation — authorizes
 * nothing.
 */
export interface TerminalGridAuthority {
  present(request: TerminalGridRequest, composite: TerminalComposite): Operation<void>;
}

/** One grid this execution issued, from the authority's side. */
export interface LiveGrid {
  /** The exact request object core issued. Compared by identity, never shape. */
  readonly request: TerminalGridRequest;
  /** The installation this grid belongs to. */
  readonly generation: object;
  /** Run the grid on a presented composite, and keep what it settled to. */
  run(composite: TerminalComposite): Operation<void>;
  /** Whether this request has already been presented. */
  used: boolean;
  /** Whether the grid actually ran to a settlement. */
  settled: boolean;
}

/** Every grid this execution has issued and not yet finished. */
export interface GridRegistry {
  live(): readonly LiveGrid[];
  add(grid: LiveGrid): void;
  remove(grid: LiveGrid): void;
}

export function createGridRegistry(): GridRegistry {
  const grids = new Set<LiveGrid>();
  return {
    live: () => [...grids],
    add: (grid) => {
      grids.add(grid);
    },
    remove: (grid) => {
      grids.delete(grid);
    },
  };
}

/**
 * Build the authority one provider installation is given.
 *
 * It closes over the installation's generation and its registry, so a factory
 * that kept an authority from a superseded installation presents into a
 * generation that no longer has the grid it names.
 */
export function createTerminalAuthority(
  generation: object,
  live: () => readonly LiveGrid[],
): TerminalGridAuthority {
  return {
    *present(request, composite) {
      const grid = live().find((candidate) => Object.is(candidate.request, request));
      if (grid === undefined) {
        throw new TerminalAuthorityError(
          "this grid request is not live: it was copied, rebuilt, kept from another grid, or " +
            "belongs to an execution that has finished",
        );
      }
      if (!Object.is(grid.generation, generation)) {
        throw new TerminalAuthorityError(
          "this grid request belongs to another terminal provider installation",
        );
      }
      if (grid.used) {
        throw new TerminalAuthorityError(
          "this grid request has already been presented — one request opens one grid",
        );
      }
      grid.used = true;
      yield* grid.run(composite);
    },
  };
}

/** One execution's terminal installation: its registry and its generation. */
export interface TerminalInstallation {
  readonly registry: GridRegistry;
  /** Identifies this execution's provider installation, and nothing else. */
  readonly generation: object;
}

const Installation: Context<TerminalInstallation | undefined> = createContext<
  TerminalInstallation | undefined
>("core.terminal.installation", undefined);

/**
 * Open one terminal installation for a live document, and hand back the
 * authority its providers are installed with.
 *
 * What travels contextually is the installation — composition data, so a
 * document and the components it expands find the same one. The authority does
 * not: it is handed to a provider factory directly. A replaced installation
 * therefore produces requests the real authority has never heard of, which is a
 * refusal rather than a way in.
 */
export function* useTerminalInstallation(): Operation<TerminalGridAuthority> {
  const registry = createGridRegistry();
  const generation = {};
  yield* Installation.set({ registry, generation });
  return createTerminalAuthority(generation, () => registry.live());
}

/** This execution's terminal installation, or `undefined` outside one. */
export function terminalInstallation(): Operation<TerminalInstallation | undefined> {
  return Installation.get();
}
