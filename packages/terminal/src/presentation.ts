/**
 * Who may present a grid, and for which request.
 *
 * The provider draws a grid. This decides one thing about it: whether the
 * request being presented is the exact one the lifecycle issued, under the
 * installation that issued it, and not one that has been presented already.
 * Nothing else here decides anything — and nothing here owns a grid.
 *
 * Ownership belongs to the expansion that submitted it. A grid runs beneath
 * that operation, so its cells keep the durable identity and the bindings of
 * the document position that wrote them, and structured concurrency takes the
 * grid down whenever that operation unwinds.
 *
 * What is kept here is the smallest lookup that lets the two sides converge:
 * the exact request object an expansion submitted, the generation it belongs
 * to, whether it has been presented, and the operation that runs it. That
 * lookup holds no tasks and owns no lifetime — an entry is added and removed by
 * the submitting expansion itself, so nothing here can keep a grid running
 * after the work that asked for it has gone. A request reaching this from
 * anywhere else — copied, rebuilt, kept from another grid, belonging to a
 * superseded installation, or already used — presents nothing, and the
 * provider is never touched.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";

import { TerminalGridPresentationError } from "./errors.ts";
import type { PresentTerminalGrid, TerminalGridProvider } from "./host.ts";
import type { TerminalGridRequest } from "./layout.ts";

/** One grid an expansion submitted, and what it is waiting to be given. */
export interface IssuedGrid {
  /** The exact request object the lifecycle issued. Compared by identity, never shape. */
  readonly request: TerminalGridRequest;
  /** The installation this grid belongs to. */
  readonly generation: object;
  /** Whether this request has already been presented. */
  used: boolean;
  /** Run the grid, beneath the operation that submitted it. */
  run(provider: TerminalGridProvider): Operation<void>;
}

/**
 * Build the presentation function one provider installation is given.
 *
 * It closes over the installation's generation, so a factory that kept one from
 * a superseded installation presents under a generation the issued requests no
 * longer belong to.
 */
export function createPresentTerminalGrid(
  generation: object,
  issued: ReadonlySet<IssuedGrid>,
): PresentTerminalGrid {
  return function* present(request, provider) {
    const found = [...issued].find((candidate) => Object.is(candidate.request, request));
    if (found === undefined) {
      throw new TerminalGridPresentationError(
        "this grid request is not live: it was copied, rebuilt, kept from another grid, or " +
          "belongs to an execution that has finished",
      );
    }
    if (!Object.is(found.generation, generation)) {
      throw new TerminalGridPresentationError(
        "this grid request belongs to another terminal provider installation",
      );
    }
    if (found.used) {
      throw new TerminalGridPresentationError(
        "this grid request has already been presented — one request opens one grid",
      );
    }
    // Admitted before anything of the provider's is touched: a refused
    // presentation creates no store, acquires no host, and leaves the provider
    // holding nothing.
    found.used = true;
    yield* found.run(provider);
  };
}

/** One execution's terminal installation: the grids it has issued, and its generation. */
export interface TerminalInstallation {
  /**
   * Every grid this execution has issued and not yet finished.
   *
   * One lookup for the execution rather than one per installation, so a
   * superseded installation's presentation function still *finds* the grid it
   * names and is turned away for the reason that is actually true — it belongs
   * to another installation — instead of being told the request is unknown.
   */
  readonly grids: Set<IssuedGrid>;
  /** Identifies this execution's provider installation, and nothing else. */
  readonly generation: object;
}

const Installation: Context<TerminalInstallation | undefined> = createContext<
  TerminalInstallation | undefined
>("terminal.installation", undefined);

/**
 * Open one terminal installation for a live document, and hand back the
 * presentation function its providers are installed with.
 *
 * What travels contextually is the installation — composition data, so a
 * document and the components it expands find the same one. The presentation
 * function does not: it is handed to a provider factory directly. A replaced
 * installation therefore produces requests the real one has never heard of,
 * which is a refusal rather than a way in.
 */
export function* useTerminalInstallation(): Operation<PresentTerminalGrid> {
  // A nested installation supersedes the one around it but shares its lookup:
  // the generation is what tells them apart, and sharing is what lets it.
  const existing = yield* Installation.get();
  const grids = existing?.grids ?? new Set<IssuedGrid>();
  const generation = {};
  yield* Installation.set({ grids, generation });
  return createPresentTerminalGrid(generation, grids);
}

/** This execution's terminal installation, or `undefined` outside one. */
export function terminalInstallation(): Operation<TerminalInstallation | undefined> {
  return Installation.get();
}
