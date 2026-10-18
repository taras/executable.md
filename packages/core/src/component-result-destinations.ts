/**
 * Where one occurrence's selected result is allowed to go, and who may say so.
 *
 * A host that evaluates generated source on somebody's behalf has a use for an
 * invocation's result that a document does not: the Sidekick's reply asked the
 * root to do something, and what it asked for has to come back to it. That is a
 * **destination** — not a binding the source wrote, and not something public
 * result middleware may answer.
 *
 * ## The installation is trusted; the association is not negotiable
 *
 * The host states its destinations once, as a value canonical execution copies
 * before any installation, middleware or document code runs — the same terms
 * admissions and declared components travel on. Nothing afterwards can add one,
 * replace one or read the collection: it is reachable through no context, no
 * contextual Api, no stable name and no definition metadata, which is why an
 * entry here cannot be acquired by spelling something.
 *
 * What an entry names is the **exact definition** this execution's capture
 * authenticated. The host supplies the object it published through its own
 * `componentAnswers` request, and the route keeps core's own retained copy of
 * that publication. A look-alike carrying the same members, a copy taken
 * afterwards, a same-named registration and a definition another execution
 * built are each absent from the route, so an occurrence of one is an ordinary
 * invocation with nowhere to send anything.
 *
 * ## A receiver belongs to one occurrence
 *
 * Canonical invocation opens a receiver for the exact occurrence it is about to
 * run, keyed by the `ComponentInvocation` the engine minted for it, and revokes
 * it when that invocation settles. Two same-named controls in one response are
 * two invocations and therefore two receivers; a receiver kept from a finished
 * occurrence answers for nothing. Nothing correlates by component name, by
 * completion order or by "the last one", because those are the readings that
 * hand one occurrence another's answer.
 *
 * The host reaches its own receiver through the lookup core hands it at
 * installation — delivered as the argument of one call, published nowhere. A
 * control body already holds the invocation the engine gave it, so asking for
 * *its own* occurrence is the only thing it can do with that lookup.
 */

import type { Operation } from "effection";

import type { ComponentInvocation } from "./invocation-identity.ts";
import type { FunctionComponentDefinition } from "./types.ts";

/** What one occurrence of an owned definition may do with its own result. */
export interface ResultOccurrence {
  /**
   * The `yq` expression this occurrence was written with, when it wrote one.
   *
   * The engine's own reading of the authored invocation, so a host deciding
   * how to record the occurrence is reading what will actually happen rather
   * than an argument the source supplied.
   */
  readonly query: string | undefined;
  /**
   * Hand this occurrence's accepted, selected result to its destination.
   *
   * Called by canonical expansion after the producer's own contract accepted
   * what it produced, its invocation joined, and the selection and any capture
   * or publication the occurrence owed have happened. Once per occurrence: a
   * second call answers nothing, because one invocation produces one result.
   */
  deliver(selected: unknown): Operation<void>;
}

/** What a host's destination does with one occurrence's selected result. */
export interface ResultDestination {
  /**
   * Accept one occurrence's selected result.
   *
   * The host's own work — writing it down, sending it on — and its outcome is
   * the host's too. A failure here is an ordinary failure of the invocation
   * that produced the result, in the region that invocation was written in.
   */
  accept(selected: unknown): Operation<void>;
  /**
   * Which occurrence this destination is serving.
   *
   * Told once, immediately after the destination is opened and before the
   * invocation runs. It exists because the two halves of a host's own
   * bookkeeping meet at different moments: its component body knows what the
   * occurrence is doing while it runs, and this destination is what is left to
   * receive the result afterwards. Pairing them by the exact occurrence object
   * is what keeps a host from correlating by component name, by completion
   * order or by whichever occurrence came last.
   */
  serves?(occurrence: ResultOccurrence): void;
}

/**
 * One component this host owns a destination for, named one of two ways.
 *
 * A host publishes most of what a generated source may write, and for those it
 * hands over the **exact definition** it published: the route compares that
 * object against core's own record of the publication, so a look-alike, a copy
 * taken afterwards and a definition another execution built are each absent.
 *
 * A **selected** name is the other case, and it exists because some of what a
 * host offers is not the host's to publish. Canonical `<Elicit>` is protected,
 * so the host selects the name and core's own tier answers it — there is no
 * published object for the host to hand over. Naming it here states nothing
 * about the implementation: core resolves it from its own capture, and refuses
 * a name some provider published, because a name a provider answered for is one
 * whose destination belongs to whoever published it.
 */
export type ResultDestinationEntry =
  | {
      readonly definition: FunctionComponentDefinition;
      /** Open a destination for one occurrence of it. */
      open(query: string | undefined): ResultDestination;
    }
  | {
      readonly selected: string;
      open(query: string | undefined): ResultDestination;
    };

/**
 * What a trusted host states about its destinations, and what it is handed back.
 *
 * `destinations` is read once and copied; `installed` is called with the lookup
 * a control body uses to reach its own occurrence. The call is where the
 * capability is delivered, which is why there is no reader for one.
 */
export interface ResultDestinationInstallation {
  readonly destinations: readonly ResultDestinationEntry[];
  installed?(lookup: ResultOccurrenceLookup): void;
}

/** How a host asks for the occurrence one invocation of its own is in. */
export type ResultOccurrenceLookup = (
  invocation: ComponentInvocation,
) => ResultOccurrence | undefined;

/** This execution's own destinations, as canonical expansion consults them. */
export interface ResultDestinationRoute {
  /** Whether this execution owns a destination for this exact implementation. */
  owns(fn: unknown): boolean;
  /**
   * Record that `wrapper` is canonical resolution's own answer for `implementation`.
   *
   * A generated import is answered with a fresh wrapper per import — canonical
   * resolution builds it so the admitted form can be decided per invocation —
   * and that wrapper is what the expansion site is holding. So the site cannot
   * recognize the implementation underneath it, and resolution is the only
   * thing that can say which one it is.
   *
   * Exact objects on both sides, stated by canonical resolution at the moment
   * it produces the answer. Nothing a host, a document or a middleware package
   * holds reaches this, and an alias for an implementation this route does not
   * own records nothing.
   */
  alias(wrapper: unknown, implementation: unknown): void;
  /**
   * Open the receiver for one occurrence, or none.
   *
   * `undefined` when nothing owns this implementation, which is every ordinary
   * invocation. Opened before the invocation runs, so the destination exists
   * while required-as is being decided and while the producer's own body is
   * recording what it is about to do; `bind` then ties it to the exact
   * invocation object the engine mints, which is what a host's own body
   * presents when it asks for its occurrence. The closer runs when the
   * invocation settles, however it settles.
   */
  open(
    fn: unknown,
    request: { readonly component: string; readonly query: string | undefined },
  ): OpenedDestination | undefined;
  /** End the route with its execution. */
  revoke(): void;
}

/**
 * Build this execution's route from what the host stated.
 *
 * `authenticated` is asked about each entry and answers with the implementation
 * this execution's capture holds for it, or nothing. An entry nothing
 * authenticated is left out — not refused, because a host may legitimately
 * state a destination for a name a particular execution never resolved, and an
 * execution that resolved it is the only one that can route it.
 */
export function createResultDestinationRoute(
  installation: ResultDestinationInstallation | undefined,
  authenticated: (entry: ResultDestinationEntry) => unknown,
): ResultDestinationRoute {
  const owned = new Map<unknown, ResultDestinationEntry>();
  for (const entry of installation?.destinations ?? []) {
    const implementation = authenticated(entry);
    if (typeof implementation === "function") {
      owned.set(implementation, entry);
    }
  }
  // Keyed by the exact invocation object the engine minted, held weakly: a
  // receiver's lifetime is its occurrence's, and nothing here keeps one alive.
  const open = new WeakMap<ComponentInvocation, ResultOccurrence>();
  let live = true;

  // Canonical resolution's own answers, each standing for the implementation it
  // wraps. Weak, because a wrapper belongs to one import.
  const aliases = new WeakMap<object, unknown>();
  const held = (fn: unknown): ResultDestinationEntry | undefined => {
    if (!live) {
      return undefined;
    }
    const direct = owned.get(fn);
    if (direct !== undefined) {
      return direct;
    }
    const behind = typeof fn === "function" ? aliases.get(fn) : undefined;
    return behind === undefined ? undefined : owned.get(behind);
  };

  const route: ResultDestinationRoute = {
    owns(fn: unknown): boolean {
      return held(fn) !== undefined;
    },
    alias(wrapper: unknown, implementation: unknown): void {
      if (live && typeof wrapper === "function" && owned.has(implementation)) {
        aliases.set(wrapper, implementation);
      }
    },
    open(fn, request) {
      const entry = held(fn);
      if (entry === undefined) {
        return undefined;
      }
      const destination = entry.open(request.query);
      let usable = true;
      let delivered = false;
      let bound: ComponentInvocation | undefined;
      const occurrence: ResultOccurrence = {
        query: request.query,
        *deliver(selected: unknown): Operation<void> {
          if (!usable || !live) {
            throw new ResultDestinationError(
              `<${request.component} /> has finished, so its result has nowhere to go.`,
            );
          }
          if (delivered) {
            throw new ResultDestinationError(
              `<${request.component} /> delivered its result more than once.`,
            );
          }
          delivered = true;
          yield* destination.accept(selected);
        },
      };
      destination.serves?.(occurrence);
      return {
        occurrence,
        bind(invocation: ComponentInvocation): void {
          if (!usable) {
            return;
          }
          bound = invocation;
          open.set(invocation, occurrence);
        },
        close(): void {
          usable = false;
          if (bound !== undefined) {
            open.delete(bound);
          }
        },
      };
    },
    revoke(): void {
      live = false;
      owned.clear();
    },
  };

  installation?.installed?.((invocation: ComponentInvocation) =>
    live ? open.get(invocation) : undefined,
  );
  return route;
}

/** One occurrence's open destination, as canonical expansion holds it. */
export interface OpenedDestination {
  readonly occurrence: ResultOccurrence;
  /** Tie this destination to the exact invocation the engine minted. */
  bind(invocation: ComponentInvocation): void;
  /** End it, however the invocation settled. */
  close(): void;
}

/** A result offered to a destination that is no longer there to take it. */
export class ResultDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultDestinationError";
  }
}
