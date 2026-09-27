/**
 * Where the REPL is, as one string a person can copy.
 *
 * A location names the Journal, the surface, the structure selected inside it,
 * the drawers stacked over it and — optionally — the exact history position the
 * whole view is frozen at. That is everything a second process needs to
 * reconstruct what the first one was showing, which is why nothing about the
 * *running* process appears here: pause is expansion control and keyboard focus
 * is derived, so neither is a place, and a URL that carried them would describe
 * a session instead of a view.
 *
 * ```text
 * xmd://repl/<execution>/<surface>[/<entry>][/<scope>]*[/+<drawer>]*
 *   [?at=<marker>][&inspect][&draft=<text>]
 * ```
 *
 * The codec is pure and has no model. `decodeLocation` decides only what the
 * grammar can decide — a malformed escape, a missing segment, an illegal
 * combination — and `resolveLocation` decides everything that depends on what a
 * Journal actually holds, by looking the exact objects up in a frozen model. The
 * split is what keeps a typo in a location from being answered with a guess
 * about the history.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { ENTRY_SCOPE } from "./model.ts";
import type { ReplBinding, ReplElicitation, ReplModel, ReplScope } from "./model.ts";

/** The one scheme and authority a REPL location has. */
const PREFIX = "xmd://repl/";

/** What a location could not say, and why nothing was selected. */
export class ReplRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplRouteError";
  }
}

/** The two surfaces this slice has. */
export type ReplSurface = "repl" | "sessions";

/** One drawer in the stack, as the grammar spells it. */
export type ReplDrawerRef =
  | { readonly kind: "binding"; readonly name: string }
  | { readonly kind: "recorded-elicit"; readonly marker: string }
  | { readonly kind: "live-elicit" }
  | { readonly kind: "history" };

/** One decoded location. Every member is what the grammar said, parsed. */
export interface ReplRoute {
  readonly execution: string;
  readonly surface: ReplSurface;
  /** The entry and then each nested scope key, outermost first. */
  readonly scopes: readonly string[];
  readonly drawers: readonly ReplDrawerRef[];
  /** The history position the whole view is frozen at, or none for the head. */
  readonly at: string | undefined;
  /** Whether that frozen position is read-only. Requires `at`. */
  readonly inspect: boolean;
  /** Text typed but not yet admitted. Exists only before an entry does. */
  readonly draft: string | undefined;
}

/** One drawer resolved against a model. */
export type ReplDrawer =
  | { readonly kind: "binding"; readonly name: string; readonly binding: ReplBinding }
  | { readonly kind: "recorded-elicit"; readonly elicitation: ReplElicitation }
  | { readonly kind: "live-elicit" }
  | { readonly kind: "history" };

/** What one location selects in one model. */
export interface ReplSelection {
  readonly route: ReplRoute;
  readonly surface: ReplSurface;
  readonly entry: ReplScope | undefined;
  /** The entry and each selected nested scope, outermost first. */
  readonly ancestry: readonly ReplScope[];
  /** The innermost selected scope, which is the entry when only it was named. */
  readonly scope: ReplScope | undefined;
  readonly drawers: readonly ReplDrawer[];
}

/**
 * Decode one location into a typed route.
 *
 * Equivalent spellings decode to the same route: percent escapes are resolved,
 * and query members are read by name rather than by position. What decoding
 * refuses is the grammar's own business — an unreadable escape, an absent
 * execution or surface, `inspect` with no position to inspect, a draft beside a
 * structure or a history position it could not coexist with, a drawer before a
 * scope, or a member nothing defines.
 */
export function decodeLocation(location: string): Result<ReplRoute> {
  if (!location.startsWith(PREFIX)) {
    return refuse(`a REPL location begins with ${PREFIX}`);
  }
  const rest = location.slice(PREFIX.length);
  if (rest.includes("#")) {
    return refuse("a REPL location has no fragment");
  }
  const split = rest.indexOf("?");
  const pathText = split === -1 ? rest : rest.slice(0, split);
  const queryText = split === -1 ? "" : rest.slice(split + 1);

  const segments = pathText.length === 0 ? [] : pathText.split("/");
  if (segments.length < 2) {
    return refuse("a REPL location names an execution and a surface");
  }
  const decoded: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) {
      return refuse("a REPL location has no empty path segment");
    }
    const value = decodeSegment(segment);
    if (value === undefined) {
      return refuse("a REPL location's escapes must be readable");
    }
    decoded.push(value);
  }

  const execution = decoded[0];
  if (!isOpaqueExecution(execution)) {
    return refuse("an execution is named by the opaque identifier the REPL created for it");
  }
  const surface = decoded[1];
  if (surface !== "repl" && surface !== "sessions") {
    return refuse('a REPL location addresses the "repl" or the "sessions" surface');
  }

  const scopes: string[] = [];
  const drawers: ReplDrawerRef[] = [];
  for (const segment of decoded.slice(2)) {
    if (segment.startsWith("+")) {
      const drawer = readDrawer(segment.slice(1));
      if (drawer === undefined) {
        return refuse("a drawer segment names a drawer this REPL has");
      }
      drawers.push(drawer);
      continue;
    }
    if (drawers.length > 0) {
      return refuse("a REPL location's scopes precede its drawers");
    }
    scopes.push(segment);
  }
  if (surface === "sessions" && (scopes.length > 0 || drawers.length > 0)) {
    return refuse("the Sessions surface holds no entry, scope or drawer");
  }

  const query = readQuery(queryText);
  if (query === undefined) {
    return refuse("a REPL location's query must be readable and hold only what it defines");
  }
  if (query.inspect && query.at === undefined) {
    return refuse("inspecting a history position needs the position");
  }
  if (query.draft !== undefined && (query.at !== undefined || scopes.length > 0)) {
    return refuse(
      "a draft is text no entry has admitted yet, so it cannot accompany an admitted " +
        "structure or a history position",
    );
  }

  return Ok({
    execution,
    surface,
    scopes: Object.freeze(scopes),
    drawers: Object.freeze(drawers),
    at: query.at,
    inspect: query.inspect,
    draft: query.draft,
  });
}

/**
 * The one canonical spelling of a route.
 *
 * Canonical means one answer: segments in structural order, drawers after them
 * in stack order, and the query members in this fixed order. A route this
 * function cannot spell is an impossible route rather than an unusual one, so it
 * raises instead of emitting something `decodeLocation` would then refuse.
 */
export function encodeLocation(route: ReplRoute): string {
  if (!isOpaqueExecution(route.execution)) {
    throw new TypeError("a REPL location names an execution by its opaque identifier");
  }
  if (route.inspect && route.at === undefined) {
    throw new TypeError("inspecting a history position needs the position");
  }
  if (route.draft !== undefined && (route.at !== undefined || route.scopes.length > 0)) {
    throw new TypeError("a draft cannot accompany an admitted structure or a history position");
  }
  if (route.surface === "sessions" && (route.scopes.length > 0 || route.drawers.length > 0)) {
    throw new TypeError("the Sessions surface holds no entry, scope or drawer");
  }

  const path = [route.execution, route.surface, ...route.scopes].map(encodeSegment);
  for (const drawer of route.drawers) {
    path.push(`+${encodeSegment(spellDrawer(drawer))}`);
  }
  const query: string[] = [];
  if (route.at !== undefined) {
    query.push(`at=${encodeValue(route.at)}`);
  }
  if (route.inspect) {
    query.push("inspect");
  }
  if (route.draft !== undefined) {
    query.push(`draft=${encodeValue(route.draft)}`);
  }
  const search = query.length === 0 ? "" : `?${query.join("&")}`;
  return `${PREFIX}${path.join("/")}${search}`;
}

/**
 * Resolve one route against one frozen model.
 *
 * Every answer is an object the model already holds, so two readings of one
 * prefix are the same reading and nothing here can invent a value the Journal
 * did not record. A target that is absent refuses; so does a drawer stack whose
 * earlier members were left out, because a stack with a hole in it does not
 * describe a surface anybody saw.
 *
 * `asking` is the one thing the model cannot answer. A question that is waiting
 * has by definition not been recorded — a Journal holds answered questions, not
 * pending ones — so no reading of any history can establish that a live
 * question's drawer is mountable. The process that is asking says so. It
 * defaults to false, because a caller that cannot say is a caller with no
 * question: resolving one it does not have would accept a URL naming a drawer
 * nothing will mount.
 */
export function resolveLocation(
  model: ReplModel,
  route: ReplRoute,
  asking = false,
): Result<ReplSelection> {
  if (route.at !== model.selection) {
    return Err(
      new ReplRouteError(
        "this route selects a history position the model was not projected at. Project the " +
          "prefix the route names before resolving against it.",
      ),
    );
  }
  if (route.surface === "sessions") {
    return Ok({
      route,
      surface: "sessions",
      entry: undefined,
      ancestry: Object.freeze([]),
      scope: undefined,
      drawers: Object.freeze([]),
    });
  }
  if (route.draft !== undefined && model.entry !== undefined) {
    return Err(
      new ReplRouteError(
        "this route carries a draft, and this execution has already admitted its entry. An " +
          "admitted entry is immutable.",
      ),
    );
  }

  const ancestry: ReplScope[] = [];
  let scope: ReplScope | undefined;
  for (const key of route.scopes) {
    if (scope === undefined) {
      if (key !== ENTRY_SCOPE) {
        return Err(new ReplRouteError(`this execution has no ${key}.`));
      }
      if (model.entry === undefined) {
        return Err(
          new ReplRouteError(
            "this route selects an entry, and this execution has not admitted one yet.",
          ),
        );
      }
      scope = model.entry;
      ancestry.push(scope);
      continue;
    }
    const child = scope.scopes.find((candidate) => candidate.key === key);
    if (child === undefined) {
      return Err(new ReplRouteError(`${scope.key} holds no ${key} at this history position.`));
    }
    scope = child;
    ancestry.push(child);
  }

  const drawers: ReplDrawer[] = [];
  for (const reference of route.drawers) {
    const drawer = openDrawer(model, route, scope, reference, asking);
    if (!drawer.ok) {
      return drawer;
    }
    drawers.push(drawer.value);
  }

  return Ok({
    route,
    surface: "repl",
    entry: model.entry,
    ancestry: Object.freeze(ancestry),
    scope,
    drawers: Object.freeze(drawers),
  });
}

function openDrawer(
  model: ReplModel,
  route: ReplRoute,
  scope: ReplScope | undefined,
  reference: ReplDrawerRef,
  asking: boolean,
): Result<ReplDrawer> {
  if (reference.kind === "history") {
    return Ok({ kind: "history" });
  }
  if (reference.kind === "binding") {
    if (scope === undefined) {
      return Err(
        new ReplRouteError("a binding drawer opens over the scope that published the name."),
      );
    }
    const binding = scope.bindings.find((candidate) => candidate.name === reference.name);
    if (binding === undefined) {
      return Err(
        new ReplRouteError(`${scope.key} publishes no ${reference.name} at this history position.`),
      );
    }
    return Ok({ kind: "binding", name: reference.name, binding });
  }
  if (reference.kind === "live-elicit") {
    if (route.at !== undefined) {
      return Err(
        new ReplRouteError(
          "a live question belongs to the running expansion, and this view is frozen at an " +
            "earlier position. Return to the live head to answer it.",
        ),
      );
    }
    if (!asking) {
      // Nothing retained can establish this drawer. A waiting question is the
      // one thing a Journal never holds — it records answers — so `settled`,
      // the recorded elicitations and every other fact in the model are all
      // consistent with no question ever arriving. A route resolved here
      // without one replays a whole execution, mounts nothing and reports
      // success. Only the process actually asking may open it.
      return Err(
        new ReplRouteError(
          "nothing is being asked. A live question's drawer belongs to the process holding the " +
            "question, and no history records one that is still waiting — so this location " +
            "cannot be reopened into answering it.",
        ),
      );
    }
    return Ok({ kind: "live-elicit" });
  }
  if (scope === undefined) {
    return Err(new ReplRouteError("an answered question is inspected in the scope that asked it."));
  }
  const elicitation = scope.elicitations.find((candidate) => candidate.marker === reference.marker);
  if (elicitation === undefined) {
    if (model.entry === undefined) {
      return Err(new ReplRouteError("this execution has recorded no question."));
    }
    return Err(new ReplRouteError(`${scope.key} recorded no question at ${reference.marker}.`));
  }
  return Ok({ kind: "recorded-elicit", elicitation });
}

/** The drawer one segment names, or none when nothing names it. */
function readDrawer(text: string): ReplDrawerRef | undefined {
  const at = text.indexOf(":");
  const kind = at === -1 ? text : text.slice(0, at);
  const argument = at === -1 ? undefined : text.slice(at + 1);

  if (kind === "history") {
    return argument === undefined ? { kind: "history" } : undefined;
  }
  if (kind === "binding") {
    return argument === undefined || argument.length === 0
      ? undefined
      : { kind: "binding", name: argument };
  }
  if (kind === "elicit") {
    if (argument === undefined) {
      return { kind: "live-elicit" };
    }
    return argument.length === 0 ? undefined : { kind: "recorded-elicit", marker: argument };
  }
  return undefined;
}

function spellDrawer(drawer: ReplDrawerRef): string {
  if (drawer.kind === "history") {
    return "history";
  }
  if (drawer.kind === "binding") {
    return `binding:${drawer.name}`;
  }
  return drawer.kind === "recorded-elicit" ? `elicit:${drawer.marker}` : "elicit";
}

/** What the query said, or none when it said something it does not define. */
function readQuery(
  text: string,
): { at: string | undefined; inspect: boolean; draft: string | undefined } | undefined {
  let at: string | undefined;
  let inspect = false;
  let draft: string | undefined;
  if (text.length === 0) {
    return { at, inspect, draft };
  }
  for (const member of text.split("&")) {
    if (member.length === 0) {
      return undefined;
    }
    const equals = member.indexOf("=");
    const name = decodeSegment(equals === -1 ? member : member.slice(0, equals));
    const value = equals === -1 ? undefined : decodeSegment(member.slice(equals + 1));
    if (name === undefined || (equals !== -1 && value === undefined)) {
      return undefined;
    }
    if (name === "at" && value !== undefined && value.length > 0 && at === undefined) {
      at = value;
      continue;
    }
    if (name === "inspect" && value === undefined && !inspect) {
      inspect = true;
      continue;
    }
    if (name === "draft" && value !== undefined && draft === undefined) {
      draft = value;
      continue;
    }
    return undefined;
  }
  return { at, inspect, draft };
}

/**
 * Whether this is an identifier the REPL could have created.
 *
 * Narrow on purpose: the execution segment becomes a file name, so the grammar
 * admits only characters that cannot address a directory, a parent, or a hidden
 * name. Checked in the codec rather than at the filesystem, so an impossible
 * identifier never reaches a path at all.
 */
export function isOpaqueExecution(execution: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(execution);
}

/** Every character a segment or value keeps as written. */
const LITERAL = /^[A-Za-z0-9\-._~:@]$/;

function encodeSegment(text: string): string {
  let encoded = "";
  for (const character of text) {
    encoded += LITERAL.test(character) ? character : percent(character);
  }
  return encoded;
}

function encodeValue(text: string): string {
  let encoded = "";
  for (const character of text) {
    encoded += LITERAL.test(character) || character === "/" ? character : percent(character);
  }
  return encoded;
}

function percent(character: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(character)) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** One segment's text, or none when its escapes will not read. */
function decodeSegment(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function refuse(message: string): Result<ReplRoute> {
  return Err(new ReplRouteError(message));
}
