/**
 * The Worker in front of these owners, as far as this package decides it.
 *
 * One job: find which run a request is for, and hand the request to that run's
 * object. The run id comes out of the path, is admitted before it reaches
 * `idFromName` — that call answers with an object for any string, so a
 * mistyped id would otherwise address a fresh, empty owner rather than fail —
 * and the request travels on unopened.
 *
 * Nothing else happens here. The body is not read, the headers are not
 * inspected, no token is verified and no state is touched: an owner that
 * trusted a gateway's account of any of those would have moved its own
 * admission outside itself.
 */

import { admitRunId, ownerFor, type OwnerNamespace } from "./routing.ts";
import { routeOf } from "./routes.ts";

/** What a stub has to offer for a request to be forwarded to it. */
export interface OwnerStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Forward one request to the owner of the run it names.
 *
 * Answers `404` for a path this build does not write and `400` for a run id
 * that cannot address an owner — neither of which reaches an object at all.
 */
export async function ownerRoute<Stub extends OwnerStub>(
  namespace: OwnerNamespace<Stub>,
  request: Request,
): Promise<Response> {
  const route = routeOf(new URL(request.url).pathname);
  if (route === undefined) {
    return new Response("route", { status: 404 });
  }
  let runId: string;
  try {
    runId = admitRunId(route.runId);
  } catch {
    return new Response("run-id", { status: 400 });
  }
  return await ownerFor(namespace, runId).fetch(request);
}
