/**
 * How a native UI reaches a pane's terminal instead of the run's
 * (architecture.md §Terminal authority, spec §Terminal-grid composition).
 *
 * `<Session.Launch>` written at the root takes the one foreground-terminal
 * lease, and every other launch waits for it. Written inside a pane it must
 * not: panes stay interactive at the same time, which is the whole reason a
 * grid exists. So core installs this in the pane's own scope, and the launch
 * finds it simply by being there.
 *
 * Nothing about the launch changes. It is handed no pane prop, token,
 * identifier or mode; its request, its result and its retained phases are the
 * ones a root launch would have. What changes is which terminal answers
 * `reserve` and `flush`, and that is a composition fact rather than something
 * the document or the provider can see.
 *
 * The claim is the authority, and it is closed over rather than passed on. A
 * pane claim buys one interactive terminal at one ordinal — it says nothing
 * about which Agent session that pane may own, which stays the session
 * coordinator's to answer.
 */

import { resource } from "effection";
import type { Operation } from "effection";
import { NativeLauncher } from "@executablemd/runtime";
import type { NativeLaunchOutcome, NativeLaunchRequest } from "@executablemd/runtime";

import type { TerminalPaneClaim } from "./authority.ts";

/**
 * Install one pane's native launcher for the scope that runs that pane's work.
 *
 * `flush` is how this pane catches the reader up. A pane's rendered text
 * belongs to the pane, so it goes where the pane's text goes rather than to the
 * root's streams — which the native UI is not drawing over.
 */
/**
 * How a pane actually runs a native UI: the composite's operation for this
 * pane's authored ordinal, bound by core and closed over here.
 *
 * The ordinal lives in this closure and nowhere else. It reaches no request, no
 * Agent request, no session key, no durable phase, no result and no diagnostic.
 */
export type RunInPane = (
  request: NativeLaunchRequest,
  spawned: () => void,
) => Operation<NativeLaunchOutcome>;

export function* usePaneNativeLauncher(
  claim: TerminalPaneClaim,
  flush: () => Operation<void>,
  runInPane: RunInPane,
  notify: (text: string) => Operation<void>,
): Operation<void> {
  yield* NativeLauncher.around({
    /**
     * This pane, for as long as the launch holds it.
     *
     * Deliberately not delegated: delegating would ask for the root lease,
     * which the grid itself is already holding, and two panes would contend
     * over a terminal neither of them is using. The claim refuses a second live
     * launch on *this* pane and does not contend with any other, which is
     * exactly the exclusivity a pane has.
     *
     * It is released when the launch's scope ends, so the pane is free only
     * after the launcher has finished with the child it started.
     */
    reserve() {
      return resource<void>(function* (provide) {
        yield* claim.admit(function* () {
          yield* provide();
        });
      });
    },
    *flush() {
      yield* flush();
    },
    // Into this pane's own text, for the same reason `flush` is: what a launch
    // says is addressed to whoever is watching this pane.
    *notify([text]) {
      yield* notify(text);
    },
    *launch([request, spawned]) {
      // The end of the chain, and deliberately so. Middleware written nearer
      // the authored launch composes in front of this and may observe, wrap,
      // refuse or short-circuit before it delegates here; what it must not do
      // is reach past it, because past it is the root foreground launcher and
      // the root terminal is the one thing a pane exists to avoid.
      //
      // The request crosses exactly as it arrived. What this adds is the
      // ordinal — from the closure, never from the request — and a listener, so
      // the pane is ready when the runtime says the child started and at no
      // earlier moment.
      return yield* runInPane(request, () => {
        claim.ready();
        spawned();
      });
    },
  });
}
