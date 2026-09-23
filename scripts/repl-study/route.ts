/**
 * Where you are, said as one URL.
 *
 * A REPL that cannot be reopened has no location, only a pile of fields. This
 * module is the whole of what "location" means here: the execution, the surface
 * that owns focus, the entry and scopes you have opened inside it, the drawers
 * stacked on top, the recorded marker you are inspecting, and the draft you have
 * typed but not run. Scroll offsets, the phase of an animation and which target
 * is focused right now are deliberately not in it — they can be thrown away
 * without changing what the REPL means.
 *
 *   xmd://repl/e1/transcript/entry-1/document/+project?at=cp-07&draft=%3CPlan%3E
 *
 * Parsing refuses rather than guesses, because a URL that quietly lost a drawer
 * would reopen a suspended execution as if nothing were waiting.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

/**
 * The five regions a route can name.
 *
 * These are not `layout.ts`'s `SURFACES`. That list is the four regions narrow
 * routing promotes to a whole screen; the REPL input is never one of those
 * because narrow already renders it inside the transcript. It is still a place
 * focus can be, so it is a route surface and not a layout surface.
 */
export const ROUTE_SURFACES = ["sessions", "transcript", "bindings", "input", "history"] as const;

export type RouteSurface = (typeof ROUTE_SURFACES)[number];

export function isRouteSurface(value: string): value is RouteSurface {
  return (ROUTE_SURFACES as readonly string[]).includes(value);
}

export interface Route {
  readonly execution: string;
  readonly surface: RouteSurface;
  /** The entry, then the visible scopes opened inside it. */
  readonly scopes: readonly string[];
  /** The drawer stack. The last one is the top, and only the top is interactive. */
  readonly drawers: readonly string[];
  /** The recorded marker under inspection. Absent means following the live head. */
  readonly at?: string;
  /** What has been typed and not run. Empty is the same as nothing typed. */
  readonly draft: string;
}

/** The authority is `repl`, because this URL addresses a REPL and not a document. */
const PREFIX = "xmd://repl/";

/** A drawer segment wears this, so a drawer is never mistaken for a scope. */
const DRAWER_PREFIX = "+";

export function formatRoute(route: Route): string {
  const path = [
    encodeURIComponent(route.execution),
    route.surface,
    ...route.scopes.map((scope) => encodeURIComponent(scope)),
    ...route.drawers.map((drawer) => `${DRAWER_PREFIX}${encodeURIComponent(drawer)}`),
  ].join("/");
  const query: string[] = [];
  if (route.at !== undefined) {
    query.push(`at=${encodeURIComponent(route.at)}`);
  }
  if (route.draft !== "") {
    query.push(`draft=${encodeURIComponent(route.draft)}`);
  }
  return query.length === 0 ? `${PREFIX}${path}` : `${PREFIX}${path}?${query.join("&")}`;
}

/**
 * One URL, parsed, or the reason it was refused.
 *
 * Percent-decoding is `decodeURIComponent` alone: `+` is a literal plus here,
 * which is what lets a drawer segment wear one.
 */
export function parseRoute(url: string): Result<Route> {
  if (!url.startsWith(PREFIX)) {
    return Err(
      new Error(`a REPL route starts with ${PREFIX}, and ${JSON.stringify(url)} does not`),
    );
  }
  const rest = url.slice(PREFIX.length);
  const split = rest.indexOf("?");
  const path = split === -1 ? rest : rest.slice(0, split);
  const query = split === -1 ? "" : rest.slice(split + 1);
  const segments = path.split("/");
  if (segments.length < 2) {
    return Err(new Error(`${JSON.stringify(url)} names no surface`));
  }
  const execution = decodeURIComponent(segments[0]);
  if (execution === "") {
    return Err(new Error(`${JSON.stringify(url)} names no execution`));
  }
  const surface = segments[1];
  if (!isRouteSurface(surface)) {
    return Err(
      new Error(
        `${JSON.stringify(surface)} is not a surface; the surfaces are ${ROUTE_SURFACES.join(", ")}`,
      ),
    );
  }
  const scopes: string[] = [];
  const drawers: string[] = [];
  for (const segment of segments.slice(2)) {
    if (segment === "") {
      return Err(new Error(`${JSON.stringify(url)} has an empty path segment`));
    }
    if (segment.startsWith(DRAWER_PREFIX)) {
      drawers.push(decodeURIComponent(segment.slice(DRAWER_PREFIX.length)));
      continue;
    }
    if (drawers.length > 0) {
      return Err(
        new Error(`${JSON.stringify(segment)} is a scope below a drawer, which cannot be reopened`),
      );
    }
    scopes.push(decodeURIComponent(segment));
  }

  let at: string | undefined;
  let draft = "";
  for (const pair of query === "" ? [] : query.split("&")) {
    const equals = pair.indexOf("=");
    const key = equals === -1 ? pair : pair.slice(0, equals);
    const value = equals === -1 ? "" : decodeURIComponent(pair.slice(equals + 1));
    if (key === "at") {
      if (value === "") {
        return Err(new Error("at= names no marker; leave it out to follow the live head"));
      }
      at = value;
      continue;
    }
    if (key === "draft") {
      draft = value;
      continue;
    }
    return Err(new Error(`${JSON.stringify(key)} is not part of a REPL route`));
  }

  return Ok({ execution, surface, scopes, drawers, at, draft });
}

/** The top drawer, which is the only one that is visible and interactive. */
export function topDrawer(route: Route): string | undefined {
  return route.drawers[route.drawers.length - 1];
}

/** True while a recorded moment is being inspected rather than the head followed. */
export function inspecting(route: Route): boolean {
  return route.at !== undefined;
}

/**
 * The kinds of move a route can make.
 *
 * Naming them is what lets push and replace be a decision rather than a habit.
 */
export type RouteChange = "surface" | "locus" | "drawer" | "inspection" | "scrub" | "draft";

export type Navigation = "push" | "replace";

/**
 * Whether a change adds a navigation entry or overwrites the current one.
 *
 * Scrubbing and draft editing replace, and both are continuous adjustments
 * rather than places you went: Back from an inspected marker returns to the
 * head rather than walking back through every marker the scrubber passed.
 */
export function navigationFor(change: RouteChange): Navigation {
  return change === "scrub" || change === "draft" ? "replace" : "push";
}
