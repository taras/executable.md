/**
 * Offering one generated selection to an execution a test drives.
 *
 * Production hosts offer `Component.generated` from the scope that executes the
 * document — a command's run scope, a REPL entry's own scope, an isolated
 * child's assembly, a workflow attachment. A test that builds its execution
 * with `executeInstalled()` has that scope too, and these helpers are the two
 * ways of reaching it:
 *
 * - `useSelection()` offers it directly, for a case that already owns a scope
 *   around the execution; and
 * - `selecting()` offers it from an installation's `install()`, which canonical
 *   execution calls in the invocation's own scope *before* it reads the
 *   selection — so a case can state what a fragment may write beside the rest
 *   of what it installs, without restating the scope.
 *
 * Neither is a second delivery path. `install()` is ordinary host setup, and
 * what it composes is the one contextual property core reads once.
 */

import { Component } from "../../src/component-api.ts";
import type { GeneratedSelection } from "../../src/component-api.ts";
import type { ExecutionInstallation } from "../../host.ts";
import type { Operation } from "effection";

/** Offer this selection for the current scope. */
export function useSelection(selection: GeneratedSelection): Operation<void> {
  return Component.around({ generated: () => selection });
}

/** One installation whose setup offers this selection and nothing else. */
export function selecting(selection: GeneratedSelection): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* useSelection(selection);
    },
  };
}
