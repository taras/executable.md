/**
 * Resolving a URL against what the execution actually did.
 *
 * A route addresses structure; it never creates any. The entry, the scopes
 * inside it, the recorded marker and the suspension a drawer answers are all
 * facts the journal holds, and a URL naming one that is not there is a URL that
 * cannot be opened. Saying so is the whole of this module.
 *
 * The alternative is what a router usually does by accident: resolve what it
 * can, drop what it cannot, and render a screen that looks like somewhere. That
 * screen is the dangerous one. It shows an execution that never ran, at a
 * moment that was never recorded, and nothing on it says which part was made
 * up.
 *
 * Nothing here keeps navigation state. It is a question asked of a route and a
 * journal, and the answer is either nothing — it resolves — or the one segment
 * that does not, in words the interface can draw.
 */

import { ROOT_SCOPE, siblingsOf } from "./journal.ts";
import type { JournalFixture } from "./journal.ts";
import { isDrawerKind } from "./fixtures.ts";
import type { Route } from "./route.ts";

/** Which part of a URL could not be resolved, and what it named. */
export interface Refusal {
  readonly segment: "entry" | "scope" | "checkpoint" | "drawer";
  /** The segment's own text, so the refusal quotes the URL rather than paraphrasing it. */
  readonly named: string;
  /** One sentence, for the screen. */
  readonly reason: string;
}

/**
 * The entry a journal recorded, by the name a route spells it with.
 *
 * This study runs one entry at a time, so there is one name. It is derived
 * rather than declared: an entry segment resolves because something was
 * submitted, not because the URL was well formed.
 */
export function entryOf(journal: JournalFixture): string | undefined {
  return journal.some((record) => record.kind === "entry.submitted") ? "entry-1" : undefined;
}

/** Whether a moment in this journal ever had something waiting for an answer. */
function suspends(journal: JournalFixture): boolean {
  return journal.some((record) => record.kind === "suspension.opened");
}

export function resolve(route: Route, journal: JournalFixture): Refusal | undefined {
  const [entry, ...scopes] = route.scopes;
  if (entry !== undefined) {
    const recorded = entryOf(journal);
    if (recorded === undefined || entry !== recorded) {
      return {
        segment: "entry",
        named: entry,
        reason:
          recorded === undefined
            ? "this execution has not submitted an entry"
            : `this execution recorded ${recorded}`,
      };
    }
  }
  for (let depth = 0; depth < scopes.length; depth += 1) {
    const inside = siblingsOf(journal, scopes.slice(0, depth));
    const wanted = scopes[depth];
    if (!inside.includes(wanted)) {
      const parent = depth === 0 ? ROOT_SCOPE : scopes[depth - 1];
      return {
        segment: "scope",
        named: wanted,
        reason:
          inside.length === 0
            ? `${parent} opened no scopes`
            : `${parent} opened ${inside.join(", ")}`,
      };
    }
  }
  if (route.at !== undefined && !journal.some((record) => record.marker === route.at)) {
    return {
      segment: "checkpoint",
      named: route.at,
      reason: "no such moment was recorded",
    };
  }
  for (const drawer of route.drawers) {
    if (!isDrawerKind(drawer)) {
      return { segment: "drawer", named: drawer, reason: "there is no drawer of that kind" };
    }
    if (!suspends(journal)) {
      return { segment: "drawer", named: drawer, reason: "nothing is waiting for an answer" };
    }
  }
  return undefined;
}
