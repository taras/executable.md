/**
 * The acts a command performs as the host, and the scope they run in.
 *
 * A profile that refuses its document a capability refuses it *ambiently*: the
 * middleware sits on a scope, and everything running under that scope is refused,
 * including the host's own machinery. `xmd plan` is the profile that has any —
 * the document it runs may write nothing and run nothing — and two of the things
 * the command itself does run a command: it installs this build's ACP adapter,
 * and it opens the review form in a browser.
 *
 * Neither is the document's act. Both were refused as though they were.
 *
 * ## Why a scope has to be carried
 *
 * There is no marker on a call that says who asked. `API.Process.exec` looks the
 * same whether an `exec` fence reached it or this host did, so a refusal that
 * covers a scope covers both, and the only thing that separates them is *where*
 * the work runs.
 *
 * A provider cannot supply that place by itself. The root provider is
 * constructed inside the document execution — core installs it from
 * `Execution.around({ document })` — so the scope it could capture at
 * construction is already under the ceiling, and so is every later call it
 * makes. The place has to come from outside, from the command, which is the one
 * party that exists before the ceiling does.
 *
 * So a host takes its scope before it installs a ceiling and states which of its
 * acts belong to it. Everything else stays refused, and a host with no ceiling —
 * `xmd run`, `xmd workflow` — states the same thing and changes nothing.
 */

import { ensure, scoped, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { FormOpener } from "@executablemd/web";

/**
 * Run one operation in a scope this one is nested inside, and wait for it here.
 *
 * The waiting is what makes it this operation's work: a task created in an outer
 * scope outlives its creator by construction, so the halt is registered before
 * the wait and an ended command takes an unfinished act with it rather than
 * leaving one running under a conversation that is over.
 *
 * `@effectionx/scope-eval` answers a different question. Its worker decouples
 * the call from the work — the operation finishes even when the caller is gone,
 * which is what `persist`, `daemon` and `service` want from it and the opposite
 * of what a host act wants.
 */
export function* inScope<T>(scope: Scope, operation: () => Operation<T>): Operation<T> {
  return yield* scoped(function* () {
    const task = scope.run(operation);
    yield* ensure(() => task.halt());
    return yield* task;
  });
}

/** The scope a command's own acts run in, taken before it installs a ceiling. */
export function hostScope(): Operation<Scope> {
  return useScope();
}

/**
 * Open a form the way the host opens anything, from inside a ceiling.
 *
 * Showing a person a form is the host's provider asking the host's question
 * about a URL the host is serving; no document, agent or authored element
 * decides that it happens or what it opens. A failed open stays what it was — a
 * warning printed beside a URL that stands on its own.
 */
export function installHostFormOpener(host: Scope): Operation<void> {
  return FormOpener.around({
    *open([url], next): Operation<void> {
      yield* inScope(host, () => next(url));
    },
  });
}
