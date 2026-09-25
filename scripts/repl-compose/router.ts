/**
 * A URL in, a location or a refusal out.
 *
 * The router is three pure functions and no state. It holds no current route,
 * no history, no subscription and no callback, and it mounts nothing: the URL
 * *is* the location, so asking where you are means handing the router a URL
 * again. That is what lets the same question be asked of two different models
 * and get two different answers without either input moving.
 *
 * Revolution is the model for the control flow. `route()` there matches a
 * request and hands the result to whatever comes next; it owns no ambient
 * navigation state and knows nothing about rendering. The two halves are kept
 * apart the same way here, with one difference that matters: matching a path
 * and resolving it are separate steps. `decodeRoute()` decides whether a URL is
 * *spelled* like a location, and `resolveRoute()` decides whether the execution
 * ever went there. A router that conflated them would happily describe a scope
 * nothing entered.
 *
 *   xmd://repl/e1/transcript/entry-1/document/+project/+confirm?at=cp-10&inspect
 *
 * Encoding is canonical and decoding is structural. One location has one
 * spelling, and `encodeRoute()` is what gives it — so a URL that means the
 * right thing but is written another way is accepted and answered with the
 * structure it names, leaving the canonical spelling to the encoder. Reordered
 * query parameters and over-percent-encoded segments are equivalent spellings,
 * not errors. What decoding refuses is a URL that is malformed or that names
 * two locations at once: an unknown query key, a repeated one, a value on the
 * valueless `inspect`, an empty `at=`, `inspect` without the marker it
 * reconstructs, an empty path segment, a scope written below a drawer, and a
 * drawer written outside any entry.
 *
 * This module imports `effection` and the model's own types. It reaches no
 * history record, no renderer, no Freedom node, no layout and no host, and the
 * evidence holds it to that by reading its imports.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { checkpointAt, headCheckpoint } from "./model.ts";
import type { Checkpoint, Entry, ReplModel, Scope, Suspension } from "./model.ts";

/**
 * The five regions a location can name.
 *
 * The surface says which region owns focus, so moving focus across a region
 * boundary moves the URL with it.
 */
export const ROUTE_SURFACES = ["sessions", "transcript", "bindings", "input", "history"] as const;

export type RouteSurface = (typeof ROUTE_SURFACES)[number];

export function isRouteSurface(value: string): value is RouteSurface {
  return (ROUTE_SURFACES as readonly string[]).includes(value);
}

/**
 * Only this module mints a `Route`.
 *
 * A route is checked when it is built, and the check is worth nothing if a
 * caller can write an object that satisfies the type without passing through
 * it. This key is module-local, so a look-alike literal is not a `Route` and
 * `encodeRoute()` never receives one. It is a construction boundary and not a
 * secrecy one: a holder can read it, and reading it grants nothing.
 */
const MINTED: unique symbol = Symbol("repl-compose.route");

interface Minted {
  readonly [MINTED]: true;
}

/** What a location selects on the recorded timeline, and what is typed. */
export interface RouteSelection {
  /** The recorded marker the scrubber has selected. Absent means the head. */
  readonly at?: string;
  /** True while the reconstruction at `at` is open rather than merely selected. */
  readonly inspect: boolean;
  /** What has been typed and not run. Empty is the same as nothing typed. */
  readonly draft: string;
}

/** A location that names a region of the REPL and nothing inside an entry. */
export interface SurfaceRoute extends Minted, RouteSelection {
  readonly kind: "surface";
  readonly execution: string;
  readonly surface: RouteSurface;
}

/**
 * A location inside one transcript entry.
 *
 * The entry is separate from the scopes it owns because they are different
 * kinds of thing: an entry is something you submitted, and a scope is something
 * the execution opened while running it.
 */
export interface EntryRoute extends Minted, RouteSelection {
  readonly kind: "entry";
  readonly execution: string;
  readonly surface: RouteSurface;
  readonly entry: string;
  /** The scope path inside that entry, outermost first. */
  readonly scopes: readonly string[];
  /** The drawer stack, outermost first. The last one is the top. */
  readonly drawers: readonly string[];
}

/**
 * One location.
 *
 * Scopes and drawers live on the arm that has an entry to own them, so a route
 * carrying a scope path and no entry is not a value this type can hold — which
 * is what stops `encodeRoute()` writing a scope segment that decodes back as an
 * entry.
 */
export type Route = SurfaceRoute | EntryRoute;

function named(part: string, value: string): Error | undefined {
  if (value === "") {
    return new RouteSyntaxError("", `a ${part} cannot be empty`);
  }
  return undefined;
}

function checkSelection(selection: RouteSelection): Error | undefined {
  if (selection.at !== undefined && selection.at === "") {
    return new RouteSyntaxError("", "a marker cannot be empty; leave `at` out to select none");
  }
  if (selection.inspect && selection.at === undefined) {
    return new RouteSyntaxError("", "inspect needs the marker it reconstructs; add at=<marker>");
  }
  return undefined;
}

/** A location naming a region, checked. */
export function surfaceRoute(
  parts: { execution: string; surface: RouteSurface } & RouteSelection,
): Result<SurfaceRoute> {
  const refusal = named("execution", parts.execution) ?? checkSelection(parts);
  if (refusal !== undefined) {
    return Err(refusal);
  }
  return Ok({
    [MINTED]: true,
    kind: "surface",
    execution: parts.execution,
    surface: parts.surface,
    at: parts.at,
    inspect: parts.inspect,
    draft: parts.draft,
  });
}

/** A location inside one entry, checked. */
export function entryRoute(
  parts: {
    execution: string;
    surface: RouteSurface;
    entry: string;
    scopes: readonly string[];
    drawers: readonly string[];
  } & RouteSelection,
): Result<EntryRoute> {
  const refusal =
    named("execution", parts.execution) ??
    named("entry", parts.entry) ??
    parts.scopes.map((scope) => named("scope", scope)).find((one) => one !== undefined) ??
    parts.drawers.map((drawer) => named("drawer", drawer)).find((one) => one !== undefined) ??
    checkSelection(parts);
  if (refusal !== undefined) {
    return Err(refusal);
  }
  return Ok({
    [MINTED]: true,
    kind: "entry",
    execution: parts.execution,
    surface: parts.surface,
    entry: parts.entry,
    scopes: [...parts.scopes],
    drawers: [...parts.drawers],
    at: parts.at,
    inspect: parts.inspect,
    draft: parts.draft,
  });
}

/**
 * Where a route resolved to, as the exact model values it resolved against.
 *
 * Every member here is a value out of `model`, compared by identity rather than
 * copied. A resolved location is not a second projection of the execution: the
 * layers above it read the model through this, so there is nothing to keep in
 * step with anything.
 */
export interface ResolvedLocation {
  readonly route: Route;
  readonly surface: RouteSurface;
  readonly checkpoint: Checkpoint;
  readonly entry?: Entry;
  /** The scopes the path named, outermost first. The last one is selected. */
  readonly scopes: readonly Scope[];
  /** The suspensions the drawer path named, outermost first. */
  readonly drawers: readonly Suspension[];
  readonly inspecting: boolean;
  readonly draft: string;
}

/** A URL that is not spelled like a location. */
export class RouteSyntaxError extends Error {
  readonly url: string;
  /** Which part of the URL was refused: `execution`, `surface`, `entry`, … */
  readonly part: string;

  constructor(url: string, message: string, part = "url") {
    super(message);
    this.name = "RouteSyntaxError";
    this.url = url;
    this.part = part;
  }
}

/**
 * A location the execution never went to.
 *
 * It names the first segment that did not resolve, where that segment sits, and
 * what exists in its place — so a refusal says what to write instead rather
 * than only that something was wrong.
 */
export class RouteRefusal extends Error {
  /** Which part refused: `execution`, `at`, `entry`, `scope[n]` or `drawer[n]`. */
  readonly position: string;
  /** The segment as the URL wrote it. */
  readonly segment: string;
  /** What the model has in that place. */
  readonly found: readonly string[];

  constructor(position: string, segment: string, found: readonly string[], message: string) {
    super(message);
    this.name = "RouteRefusal";
    this.position = position;
    this.segment = segment;
    this.found = found;
  }
}

/** The authority is `repl`, because this URL addresses a REPL and not a document. */
const PREFIX = "xmd://repl/";

/** A drawer segment wears this, so a drawer is never mistaken for a scope. */
const DRAWER_PREFIX = "+";

/** The query keys, in the one order a canonical URL writes them. */
const QUERY_KEYS = ["at", "inspect", "draft"] as const;

function list(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

/** One location, in the one spelling it has. */
export function encodeRoute(route: Route): string {
  const inside =
    route.kind === "entry"
      ? [
          encodeURIComponent(route.entry),
          ...route.scopes.map((scope) => encodeURIComponent(scope)),
          ...route.drawers.map((drawer) => `${DRAWER_PREFIX}${encodeURIComponent(drawer)}`),
        ]
      : [];
  const path = [encodeURIComponent(route.execution), route.surface, ...inside].join("/");

  const query: string[] = [];
  if (route.at !== undefined) {
    query.push(`at=${encodeURIComponent(route.at)}`);
  }
  if (route.inspect) {
    // Valueless, which is the only spelling the encoder writes.
    query.push("inspect");
  }
  if (route.draft !== "") {
    query.push(`draft=${encodeURIComponent(route.draft)}`);
  }

  return query.length === 0 ? `${PREFIX}${path}` : `${PREFIX}${path}?${query.join("&")}`;
}

/**
 * One percent-encoded piece of a URL, decoded, or `undefined` when it is not
 * valid percent-encoding.
 *
 * `decodeURIComponent` throws on a lone `%`, and a URL is untrusted text, so
 * every decode in this module goes through here. A syntax failure that escaped
 * as a thrown `URIError` would leave `decodeRoute()`'s `Result<Route>` a
 * promise it does not keep.
 */
function percentDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function malformed(url: string, part: string, value: string): RouteSyntaxError {
  return new RouteSyntaxError(
    url,
    `the ${part} ${JSON.stringify(value)} is not valid percent-encoding`,
    part,
  );
}

function decodeQuery(url: string, query: string): Result<RouteSelection> {
  let at: string | undefined;
  let inspect = false;
  let draft = "";
  const seen: string[] = [];

  for (const pair of query === "" ? [] : query.split("&")) {
    const equals = pair.indexOf("=");
    const key = equals === -1 ? pair : pair.slice(0, equals);
    const written = equals === -1 ? "" : pair.slice(equals + 1);
    if (!(QUERY_KEYS as readonly string[]).includes(key)) {
      return Err(
        new RouteSyntaxError(url, `${JSON.stringify(key)} is not part of a REPL route`, "query"),
      );
    }
    if (seen.includes(key)) {
      return Err(
        new RouteSyntaxError(url, `${key} is written twice, and names two locations`, key),
      );
    }
    seen.push(key);
    const value = percentDecode(written);
    if (value === undefined) {
      return Err(malformed(url, key, written));
    }
    if (key === "at") {
      if (value === "") {
        return Err(
          new RouteSyntaxError(url, "at= names no marker; leave it out to select none", "at"),
        );
      }
      at = value;
    }
    if (key === "inspect") {
      if (equals !== -1) {
        return Err(
          new RouteSyntaxError(
            url,
            "inspect takes no value; it is present or it is not",
            "inspect",
          ),
        );
      }
      inspect = true;
    }
    if (key === "draft") {
      // An empty draft is the same as no draft, so `draft=` is an equivalent
      // spelling rather than a malformed one. The encoder leaves it out.
      draft = value;
    }
  }

  if (inspect && at === undefined) {
    return Err(
      new RouteSyntaxError(
        url,
        "inspect needs the marker it reconstructs; add at=<marker>",
        "inspect",
      ),
    );
  }

  return Ok({ at, inspect, draft });
}

/**
 * One URL, parsed, or the reason it was refused.
 *
 * The answer is the structure the URL names, not the bytes it was written with.
 * Two spellings of one location decode to the same `Route`, and
 * `encodeRoute()` gives that route the one spelling it is stored and generated
 * with — so canonicalizing is `encodeRoute(decodeRoute(url))` rather than a
 * rule that turns an equivalent spelling away.
 *
 * Percent-decoding is `decodeURIComponent` alone: `+` is a literal plus here,
 * which is what lets a drawer segment wear one. Text it cannot decode is a
 * refusal naming the part it came from, never a throw.
 */
export function decodeRoute(url: string): Result<Route> {
  if (!url.startsWith(PREFIX)) {
    return Err(
      new RouteSyntaxError(
        url,
        `a REPL route starts with ${PREFIX}, and ${JSON.stringify(url)} does not`,
      ),
    );
  }

  const rest = url.slice(PREFIX.length);
  const split = rest.indexOf("?");
  const path = split === -1 ? rest : rest.slice(0, split);
  const segments = path.split("/");
  if (segments.length < 2) {
    return Err(new RouteSyntaxError(url, `${JSON.stringify(url)} names no surface`));
  }

  const execution = percentDecode(segments[0]);
  if (execution === undefined) {
    return Err(malformed(url, "execution", segments[0]));
  }
  if (execution === "") {
    return Err(new RouteSyntaxError(url, `${JSON.stringify(url)} names no execution`, "execution"));
  }

  const surface = segments[1];
  if (!isRouteSurface(surface)) {
    return Err(
      new RouteSyntaxError(
        url,
        `${JSON.stringify(surface)} is not a surface; the surfaces are ${list([...ROUTE_SURFACES])}`,
        "surface",
      ),
    );
  }

  let entry: string | undefined;
  const scopes: string[] = [];
  const drawers: string[] = [];
  for (const segment of segments.slice(2)) {
    if (segment === "") {
      return Err(new RouteSyntaxError(url, `${JSON.stringify(url)} has an empty path segment`));
    }
    if (segment.startsWith(DRAWER_PREFIX)) {
      const written = segment.slice(DRAWER_PREFIX.length);
      const drawer = percentDecode(written);
      if (drawer === undefined) {
        return Err(malformed(url, "drawer", written));
      }
      if (drawer === "") {
        return Err(new RouteSyntaxError(url, "a drawer segment names no drawer", "drawer"));
      }
      drawers.push(drawer);
      continue;
    }
    if (drawers.length > 0) {
      return Err(
        new RouteSyntaxError(
          url,
          `${JSON.stringify(segment)} is a scope below a drawer, which cannot be reopened`,
          "scope",
        ),
      );
    }
    const part = entry === undefined ? "entry" : "scope";
    const name = percentDecode(segment);
    if (name === undefined) {
      return Err(malformed(url, part, segment));
    }
    if (entry === undefined) {
      entry = name;
      continue;
    }
    scopes.push(name);
  }
  if (entry === undefined && drawers.length > 0) {
    return Err(
      new RouteSyntaxError(
        url,
        `a drawer is opened inside an entry, and ${JSON.stringify(url)} names none`,
        "drawer",
      ),
    );
  }

  const selection = decodeQuery(url, split === -1 ? "" : rest.slice(split + 1));
  if (!selection.ok) {
    return selection;
  }

  // Building through the same constructors any other caller uses is what keeps
  // one definition of a well-formed location rather than two.
  const built =
    entry === undefined
      ? surfaceRoute({ execution, surface, ...selection.value })
      : entryRoute({ execution, surface, entry, scopes, drawers, ...selection.value });
  if (!built.ok) {
    return Err(new RouteSyntaxError(url, built.error.message, "url"));
  }
  return built;
}

/**
 * Where a route resolves to against one model, or the first segment it could
 * not resolve.
 *
 * Nothing here manufactures a value from the URL. Every entry, scope,
 * checkpoint and drawer in the answer came out of `model`, so a location that
 * resolves is a location the execution actually reached.
 */
export function resolveRoute(route: Route, model: ReplModel): Result<ResolvedLocation> {
  if (route.execution !== model.execution) {
    return Err(
      new RouteRefusal(
        "execution",
        route.execution,
        [model.execution],
        `${JSON.stringify(route.execution)} is not this execution; these records are ${JSON.stringify(model.execution)}`,
      ),
    );
  }

  const markers = model.checkpoints.map((checkpoint) => checkpoint.marker);
  const checkpoint = route.at === undefined ? headCheckpoint(model) : checkpointAt(model, route.at);
  if (checkpoint === undefined) {
    const named = route.at ?? model.head;
    return Err(
      new RouteRefusal(
        "at",
        named,
        markers,
        `${JSON.stringify(named)} names no recorded checkpoint; the markers are ${list(markers)}`,
      ),
    );
  }

  if (route.kind === "surface") {
    return Ok({
      route,
      surface: route.surface,
      checkpoint,
      entry: undefined,
      scopes: [],
      drawers: [],
      inspecting: route.inspect,
      draft: route.draft,
    });
  }

  const entry = checkpoint.entries.find((candidate) => candidate.id === route.entry);
  if (entry === undefined) {
    const ids = checkpoint.entries.map((candidate) => candidate.id);
    return Err(
      new RouteRefusal(
        "entry",
        route.entry,
        ids,
        `${JSON.stringify(route.entry)} is not an entry at ${checkpoint.marker}; the entries there are ${list(ids)}`,
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
          `${JSON.stringify(name)} is not a scope of ${holder} at ${checkpoint.marker}; the scopes there are ${list(names)}`,
        ),
      );
    }
    scopes.push(found);
    level = found.children;
    holder = found.name;
  }

  // One entry's drawer stack, in recorded order. A checkpoint holds every
  // suspension the moment was waiting on, across every entry; the drawer path
  // under `entry-1` indexes entry-1's, so a wait `entry-2` owns is not a drawer
  // `entry-1` can open even when both spell the kind the same way.
  const stack = checkpoint.suspensions.filter((suspension) => suspension.entry === entry.id);
  const open = stack.map((suspension) => suspension.kind);
  for (const [index, kind] of route.drawers.entries()) {
    const suspension = stack[index];
    if (suspension === undefined) {
      return Err(
        new RouteRefusal(
          `drawer[${index}]`,
          kind,
          open,
          `there is no drawer ${index + 1} of ${entry.id} at ${checkpoint.marker}; its suspension stack is ${list(open)}`,
        ),
      );
    }
    if (suspension.kind !== kind) {
      return Err(
        new RouteRefusal(
          `drawer[${index}]`,
          kind,
          [suspension.kind],
          `${JSON.stringify(kind)} is not drawer ${index + 1} of ${entry.id} at ${checkpoint.marker}; its suspension stack is ${list(open)}`,
        ),
      );
    }
  }

  return Ok({
    route,
    surface: route.surface,
    checkpoint,
    entry,
    scopes,
    drawers: stack.slice(0, route.drawers.length),
    inspecting: route.inspect,
    draft: route.draft,
  });
}
