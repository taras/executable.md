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

import { isDrawerKind } from "./fixtures.ts";
import { project } from "./view.ts";
import type { ReplView, ScopeLocation } from "./view.ts";
import type { ReplState } from "./store.ts";
import type { Route } from "./route.ts";

/** Which part of a URL could not be resolved, and what it named. */
export interface Refusal {
  readonly segment: "surface" | "entry" | "scope" | "checkpoint" | "drawer";
  /** The segment's own text, so the refusal quotes the URL rather than paraphrasing it. */
  readonly named: string;
  /** One sentence, for the screen. */
  readonly reason: string;
}

/** The names available at one level of the scope tree. */
function namesOf(scopes: readonly ScopeLocation[]): string {
  return scopes.length === 0 ? "nothing" : scopes.map((scope) => scope.id).join(", ");
}

/** Resolve a route against the state it would open, which is to say its view. */
export function refusalOf(state: ReplState): Refusal | undefined {
  return resolve(state.route, project(state));
}

export function resolve(route: Route, view: ReplView): Refusal | undefined {
  const located = view.located;
  if (!located.surfaces.includes(route.surface)) {
    return {
      segment: "surface",
      named: route.surface,
      reason: `this composition shows ${located.surfaces.join(", ")}`,
    };
  }
  const [entry, ...scopes] = route.scopes;
  if (entry !== undefined && entry !== located.entry) {
    return {
      segment: "entry",
      named: entry,
      reason:
        located.entry === undefined
          ? "this execution has not submitted an entry"
          : `this execution recorded ${located.entry}`,
    };
  }
  let inside = located.scopes;
  for (const wanted of scopes) {
    const found = inside.find((scope) => scope.id === wanted);
    if (found === undefined) {
      return {
        segment: "scope",
        named: wanted,
        reason: `what is open here is ${namesOf(inside)}`,
      };
    }
    inside = found.scopes;
  }
  if (route.at !== undefined && !located.markers.includes(route.at)) {
    return { segment: "checkpoint", named: route.at, reason: "no such moment was recorded" };
  }
  for (const drawer of route.drawers) {
    if (!isDrawerKind(drawer)) {
      return { segment: "drawer", named: drawer, reason: "there is no drawer of that kind" };
    }
  }
  // Only the top drawer is visible and interactive, and it is the one the view
  // represents. What is stacked under it is where you came from.
  const top = route.drawers[route.drawers.length - 1];
  if (top !== undefined && isDrawerKind(top) && !located.drawers.includes(top)) {
    return {
      segment: "drawer",
      named: top,
      reason:
        located.drawers.length === 0
          ? "nothing is waiting for an answer"
          : `what is waiting is the ${located.drawers.join(", ")} drawer`,
    };
  }
  return undefined;
}
