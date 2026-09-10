/**
 * Where a request reaches one run's owner, and what it carries outside its body.
 *
 * Three planes, three paths, and the path is what says which. A gateway routes
 * on the run id in it and forwards the request whole; nothing here parses a
 * command, verifies a token or decides anything about a run — the owner does
 * all three, and a boundary that pre-decided any of them would be a second
 * authority the owner would have to trust.
 *
 * Private to one release, like everything else that crosses. The paths and the
 * header names are this build talking to itself: they are journaled by neither
 * side, exported by neither, and named in no public type. What is public is the
 * endpoint an operator configures and the three planes' behavior.
 *
 * The executor plane carries its admission in `Sec-WebSocket-Protocol` because
 * that is the one header a standard `WebSocket` client can set. It is a
 * transport header on a request that is never retained, and the alternative —
 * a token in the URL — would put a credential somewhere URLs get written down.
 */

/** The one path prefix every plane hangs from. */
const RUNS = "runs";

/** Which plane a path names. */
export type OwnerPlane = "executor" | "read" | "delivery";

/** The order the subprotocol carries admission in. */
const PROTOCOL = "executablemd.workflow.owner.v1";

/** What a request said about itself, outside its body. */
export interface RouteAdmission {
  readonly release: string | null;
  readonly token: string | null;
  readonly runId: string | null;
}

/** The header a release identity travels in. */
export const RELEASE_HEADER = "x-executablemd-workflow-release";

/**
 * The one subprotocol this build offers, and the two values beside it.
 *
 * Offered in a fixed order so the owner reads by position rather than by
 * guessing which value is which, and the name is first so the owner can echo
 * exactly one selected protocol back — a handshake that selected none is one a
 * standard client fails.
 */
export function upgradeProtocols(release: string, token: string): readonly string[] {
  return [PROTOCOL, release, token];
}

/** The admission one upgrade request carries, read back out of its protocols. */
export function upgradeAdmission(header: string | null, runId: string | null): RouteAdmission {
  const offered = (header ?? "").split(",").map((value) => value.trim());
  const [name, release, token] = offered;
  return name === PROTOCOL
    ? { release: release ?? null, token: token ?? null, runId }
    : { release: null, token: null, runId };
}

/** The protocol an owner selects, so the handshake completes. */
export function selectedProtocol(): string {
  return PROTOCOL;
}

/** Where one plane of one run's owner is, under a normalized endpoint. */
export function planePath(runId: string, plane: OwnerPlane): string {
  return `/${RUNS}/${encodeURIComponent(runId)}/${plane}`;
}

/**
 * Which run and plane a path names, or nothing.
 *
 * Read from the end, because a configured endpoint may carry a path of its own
 * and what is in front of the route belongs to the deployment. The three
 * segments the route is made of are exact all the same: a tail this build does
 * not write names no plane, and the only sender is this build.
 */
export function routeOf(pathname: string): { runId: string; plane: OwnerPlane } | undefined {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const route = segments.slice(-3);
  if (route.length !== 3 || route[0] !== RUNS) {
    return undefined;
  }
  const [, encoded, plane] = route;
  if (encoded === undefined || encoded === "" || plane === undefined) {
    return undefined;
  }
  if (plane !== "executor" && plane !== "read" && plane !== "delivery") {
    return undefined;
  }
  let runId: string;
  try {
    runId = decodeURIComponent(encoded);
  } catch {
    // A percent sequence this build never wrote. The id it would name is not
    // one to guess at.
    return undefined;
  }
  return { runId, plane };
}
