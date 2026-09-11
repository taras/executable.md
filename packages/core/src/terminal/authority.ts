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

import { createContext, createScope, ensure, resource, until } from "effection";
import type { Context, Operation, Scope, Task } from "effection";
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

/**
 * One grid the supervisor has been asked to run, before a composite exists.
 *
 * The scope is the submitting operation's own. A grid keeps the contexts of the
 * expansion that wrote it — its durable child above all, which is what gives its
 * panes their identities — so the supervisor owns when a grid stops, never what
 * it runs under.
 */
export interface SubmittedGrid {
  /** The exact request object core issued. Compared by identity, never shape. */
  readonly request: TerminalGridRequest;
  /** The installation this grid belongs to. */
  readonly generation: object;
  /** Where the grid runs: a scope of its own, beneath the submitter's. */
  readonly scope: Scope;
  /** Run the grid on a presented composite. */
  run(composite: TerminalComposite): Operation<void>;
}

/** What the submitting operation can ask about its own grid afterwards. */
export interface GridSubmission {
  /** Whether a provider presented for this request and the grid ran through. */
  readonly settled: boolean;
}

/** One submitted grid, and whatever of it is currently live. */
interface Entry extends SubmittedGrid, GridSubmission {
  presented: boolean;
  settled: boolean;
  task?: Task<void>;
  destroy?: () => Promise<void>;
}

/**
 * Who owns the grids one terminal installation has issued.
 *
 * Two things have to meet before a grid exists: the document submits the
 * authored request and the work its panes do, and a provider presents a
 * composite for that exact request. Neither alone starts anything — a
 * registration that never routes and a presentation of a request nobody
 * submitted both open nothing — and the supervisor is what makes them converge
 * by object identity and installation generation rather than by shape.
 *
 * It holds what it starts. Each grid runs as a task the supervisor keeps, in a
 * scope of its own beneath the operation that submitted it — beneath, because a
 * pane's durable identity and the bindings its content reads are the
 * expansion's, and a grid parented anywhere else is a grid whose panes belong
 * to nobody in particular.
 *
 * That parentage is also what makes a grid impossible to strand: the submitting
 * operation unwinds whenever the call that routed it does, and takes the grid
 * with it. The supervisor stopping its own entries at installation teardown,
 * and stopping one whose presenting call was cancelled, is therefore belt and
 * braces rather than the mechanism — deliberately so, because the mechanism is
 * a structural property nobody reading this file can see.
 *
 * Private to core: nothing reachable by importing this package can submit a
 * grid, present for one, or ask what is live.
 */
export interface GridSupervisor {
  /**
   * Register one authored request and its work.
   *
   * The entry is removed when the submitting operation unwinds — after that
   * operation's own finalizers, so the foreground-terminal lease is released
   * before the grid stops being something a provider could present for.
   */
  submit(grid: SubmittedGrid): Operation<GridSubmission>;
  /** Run the grid this exact request names, under this exact generation. */
  present(
    request: TerminalGridRequest,
    composite: TerminalComposite,
    generation: object,
  ): Operation<void>;
}

/**
 * Stop one grid and wait for all of it.
 *
 * Halting the task settles its panes, runs their finalizers and destroys the
 * composite; destroying the scope is what releases everything the grid itself
 * established. Both are idempotent here, because a grid may be stopped by the
 * presenting call that was cancelled, by installation teardown, or by neither.
 */
function* stopGrid(entry: Entry): Operation<void> {
  const task = entry.task;
  entry.task = undefined;
  if (task !== undefined) {
    yield* task.halt();
  }
  const destroy = entry.destroy;
  entry.destroy = undefined;
  if (destroy !== undefined) {
    yield* until(destroy());
  }
}

/** Open the supervisor one execution's grids belong to. */
export function useGridSupervisor(): Operation<GridSupervisor> {
  return resource(function* (provide) {
    const entries = new Set<Entry>();

    // Installation teardown. Every grid still live is stopped here and waited
    // for. Scope parentage already reaches each one, so this is the supervisor
    // saying so itself rather than the only thing that says it.
    yield* ensure(function* () {
      for (const entry of [...entries]) {
        yield* stopGrid(entry);
      }
    });

    yield* provide({
      *submit(grid: SubmittedGrid): Operation<GridSubmission> {
        const entry: Entry = { ...grid, presented: false, settled: false };
        entries.add(entry);
        yield* ensure(() => {
          entries.delete(entry);
        });
        return entry;
      },
      *present(
        request: TerminalGridRequest,
        composite: TerminalComposite,
        generation: object,
      ): Operation<void> {
        const entry = [...entries].find((candidate) => Object.is(candidate.request, request));
        if (entry === undefined) {
          throw new TerminalAuthorityError(
            "this grid request is not live: it was copied, rebuilt, kept from another grid, or " +
              "belongs to an execution that has finished",
          );
        }
        if (!Object.is(entry.generation, generation)) {
          throw new TerminalAuthorityError(
            "this grid request belongs to another terminal provider installation",
          );
        }
        if (entry.presented) {
          throw new TerminalAuthorityError(
            "this grid request has already been presented — one request opens one grid",
          );
        }
        entry.presented = true;

        // A scope of its own beneath the submitter's: the grid inherits the
        // expansion's contexts, and the supervisor still holds the task.
        const [scope, destroy] = createScope(entry.scope);
        entry.destroy = destroy;
        entry.task = scope.run(() => entry.run(composite));

        // A presenting call that unwinds takes its grid with it. The submitter
        // unwinding would too, which is why removing this changes no test —
        // it is here so the supervisor's ownership does not depend on a
        // structural coincidence holding forever.
        yield* ensure(function* () {
          yield* stopGrid(entry);
        });

        yield* entry.task;
        entry.settled = true;
        // Settled, so nothing is owed: the scope goes now rather than waiting
        // for the provider's own call to end.
        entry.task = undefined;
        yield* until(destroy());
        entry.destroy = undefined;
      },
    });
  });
}

/**
 * Build the authority one provider installation is given.
 *
 * It closes over the installation's generation, so a factory that kept an
 * authority from a superseded installation presents under a generation the
 * supervisor no longer has the grid for. Deciding that is the supervisor's, and
 * this is the seam that carries the generation to it.
 */
export function createTerminalAuthority(
  generation: object,
  present: (
    request: TerminalGridRequest,
    composite: TerminalComposite,
    generation: object,
  ) => Operation<void>,
): TerminalGridAuthority {
  return {
    *present(request, composite) {
      yield* present(request, composite, generation);
    },
  };
}

/** One execution's terminal installation: its supervisor and its generation. */
export interface TerminalInstallation {
  readonly supervisor: GridSupervisor;
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
  const supervisor = yield* useGridSupervisor();
  const generation = {};
  yield* Installation.set({ supervisor, generation });
  return createTerminalAuthority(generation, supervisor.present);
}

/** This execution's terminal installation, or `undefined` outside one. */
export function terminalInstallation(): Operation<TerminalInstallation | undefined> {
  return Installation.get();
}
