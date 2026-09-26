/**
 * The #840 URL grammar, resolved against a Journal prefix.
 *
 * There is one REPL URL grammar and this is not a second one. `decodeRoute()`
 * and `encodeRoute()` are imported from the accepted #840 router and used
 * unchanged: the same five surfaces, the same `+drawer` segments, the same
 * `at` / `inspect` / `draft` query, the same canonical spelling, the same
 * equivalent-spelling decoding and the same refusals. A URL that #840 accepts
 * is a URL this accepts, spelled the same way.
 *
 * What is adapted, and adapted here rather than there, is *resolution*. #840
 * resolves against a `ReplModel` holding every checkpoint of the execution,
 * which is exactly the table #842 must not depend on: a resolver that looks a
 * marker up in a snapshot table needs the table, and the table is supposed to
 * be an accelerator. So resolution here projects the prefix the URL named and
 * answers against that one model. Nothing in `repl-compose` changes, and its
 * evidence is untouched.
 *
 * `RouteRefusal` is reused too, including its `position` / `segment` / `found`
 * shape, so a refusal from this resolver reads exactly like a refusal from
 * that one.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { entryRoute, RouteRefusal, surfaceRoute } from "../repl-compose/router.ts";
import type { Route, RouteSurface } from "../repl-compose/router.ts";

import type { SemanticEvent } from "./journal.ts";
import type { Entry, Scope, SemanticModel, Suspension } from "./model.ts";
import { markersOf, projectPrefix } from "./project.ts";

export {
  decodeRoute,
  encodeRoute,
  entryRoute,
  RouteRefusal,
  RouteSyntaxError,
  surfaceRoute,
} from "../repl-compose/router.ts";
export type { Route, RouteSurface } from "../repl-compose/router.ts";

/**
 * The same location with another draft.
 *
 * Typing moves the draft and nothing else, so the new route is built from the
 * old one's own parts through the same constructors any other caller uses.
 * The draft lives in the URL because the URL is where the selected location
 * lives, and it reaches no Journal: there is no record kind that could carry
 * it.
 */
export function withDraft(route: Route, draft: string): Result<Route> {
  if (route.kind === "surface") {
    return surfaceRoute({
      execution: route.execution,
      surface: route.surface,
      at: route.at,
      inspect: route.inspect,
      draft,
    });
  }
  return entryRoute({
    execution: route.execution,
    surface: route.surface,
    entry: route.entry,
    scopes: route.scopes,
    drawers: route.drawers,
    at: route.at,
    inspect: route.inspect,
    draft,
  });
}

/** What a location names, and the prefix it named it in. */
interface Located {
  readonly route: Route;
  readonly surface: RouteSurface;
  /** The model the selected prefix projects to. Every value below comes out of it. */
  readonly model: SemanticModel;
  readonly inspecting: boolean;
  readonly draft: string;
}

/** A location naming a region and nothing inside an entry. */
export interface SurfaceLocation extends Located {
  readonly kind: "surface";
}

/** A location inside one entry of the selected prefix. */
export interface EntryLocation extends Located {
  readonly kind: "entry";
  readonly entry: Entry;
  /** The scopes the path named, outermost first. The last one is selected. */
  readonly scopes: readonly Scope[];
  /** The suspensions the drawer path named, outermost first. */
  readonly drawers: readonly Suspension[];
}

export type SemanticLocation = SurfaceLocation | EntryLocation;

function list(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

/**
 * Where a route resolves against one journal, or the first segment it could
 * not resolve.
 *
 * The prefix is decided first and everything else is asked of it. That
 * ordering is what makes historical inspection honest: an entry that had not
 * been submitted at the selected marker is not an entry this location can
 * name, and the refusal says which entries were there instead.
 */
export function resolveLocation(
  route: Route,
  execution: string,
  events: readonly SemanticEvent[],
): Result<SemanticLocation> {
  if (route.execution !== execution) {
    return Err(
      new RouteRefusal(
        "execution",
        route.execution,
        [execution],
        `${JSON.stringify(route.execution)} is not this execution; these records are ${JSON.stringify(execution)}`,
      ),
    );
  }

  const projected = projectPrefix(execution, events, route.at);
  if (!projected.ok) {
    const markers = markersOf(events);
    return Err(
      new RouteRefusal(
        "at",
        route.at === undefined ? "" : route.at,
        markers,
        projected.error.message,
      ),
    );
  }
  return resolveIn(route, projected.value);
}

/**
 * The same resolution, against a model that has already been projected.
 *
 * A caller that holds the prefix — because it kept one, or because it has
 * just built one — resolves through here rather than projecting a second
 * time. It is the same function `resolveLocation()` finishes with, so an
 * accelerated answer and a cold one cannot diverge by taking different code.
 *
 * The model decides; a caller that hands over the wrong prefix gets a correct
 * answer about the wrong moment, which is why a snapshot must never outlive
 * the process that derived it.
 */
export function resolveIn(route: Route, model: SemanticModel): Result<SemanticLocation> {
  if (route.kind === "surface") {
    return Ok({
      kind: "surface",
      route,
      surface: route.surface,
      model,
      inspecting: route.inspect,
      draft: route.draft,
    });
  }

  const entry = model.entries.find((candidate) => candidate.id === route.entry);
  if (entry === undefined) {
    const ids = model.entries.map((candidate) => candidate.id);
    return Err(
      new RouteRefusal(
        "entry",
        route.entry,
        ids,
        `${JSON.stringify(route.entry)} is not an entry at ${model.marker}; the entries there are ${list(ids)}`,
      ),
    );
  }

  const scopes: Scope[] = [];
  let level: readonly Scope[] = entry.scopes;
  let holder = entry.id;
  for (const [index, name] of route.scopes.entries()) {
    const found = level.find((scope) => scope.name === name);
    if (found === undefined) {
      const names = level.map((scope) => scope.name);
      return Err(
        new RouteRefusal(
          `scope[${index}]`,
          name,
          names,
          `${JSON.stringify(name)} is not a scope of ${holder} at ${model.marker}; the scopes there are ${list(names)}`,
        ),
      );
    }
    scopes.push(found);
    level = found.children;
    holder = found.name;
  }

  // One entry's drawer stack, in the order each wait opened. A prefix of it is
  // a location; anything else is not, which is what stops a reordered stack
  // resolving to a moment the execution never had.
  const stack = model.suspensions.filter((suspension) => suspension.entry === entry.id);
  const open = stack.map((suspension) => suspension.wait);
  for (const [index, wait] of route.drawers.entries()) {
    const suspension = stack[index];
    if (suspension === undefined) {
      return Err(
        new RouteRefusal(
          `drawer[${index}]`,
          wait,
          open,
          `there is no drawer ${index + 1} of ${entry.id} at ${model.marker}; its suspension stack is ${list(open)}`,
        ),
      );
    }
    if (suspension.wait !== wait) {
      return Err(
        new RouteRefusal(
          `drawer[${index}]`,
          wait,
          [suspension.wait],
          `${JSON.stringify(wait)} is not drawer ${index + 1} of ${entry.id} at ${model.marker}; its suspension stack is ${list(open)}`,
        ),
      );
    }
  }

  return Ok({
    kind: "entry",
    route,
    surface: route.surface,
    model,
    entry,
    scopes,
    drawers: stack.slice(0, route.drawers.length),
    inspecting: route.inspect,
    draft: route.draft,
  });
}
