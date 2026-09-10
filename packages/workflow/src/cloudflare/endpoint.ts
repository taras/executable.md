/**
 * Where this deployment's owners are, parsed once and then never re-read.
 *
 * One value from trusted configuration, held to what the supported routes can
 * mean before a token is minted or a socket is opened. A credential in it, a
 * fragment, a query, a scheme this build does not speak or a path it never
 * writes are configuration mistakes, and an operator learns about them at
 * construction rather than in the middle of a run.
 *
 * It never travels. The endpoint is host closure state: no workflow record, no
 * journal event, no diagnostic and no document-visible value carries it, so a
 * run cannot report where its owner was reached and a document cannot ask.
 */

import { planePath, type OwnerPlane } from "./routes.ts";

/** Why an endpoint cannot address this deployment's owners. */
export type EndpointRefusal =
  | "endpoint-absent"
  | "endpoint-unparseable"
  | "endpoint-scheme"
  | "endpoint-credentials"
  | "endpoint-query"
  | "endpoint-fragment";

export class OwnerEndpointError extends Error {
  override name = "OwnerEndpointError";

  constructor(readonly refusal: EndpointRefusal) {
    super(`this workflow owner endpoint cannot be used (${refusal})`);
  }
}

/** One deployment's owner endpoint, normalized. */
export interface OwnerEndpoint {
  /** Where one run's plane is, as an absolute URL. */
  planeUrl(runId: string, plane: OwnerPlane): string;
}

/** The schemes an owner is reached over. */
const SCHEMES: readonly string[] = ["https:", "http:"];

/**
 * Parse one endpoint, or refuse it.
 *
 * `http:` is admitted beside `https:` because a local owner — `workerd` on a
 * loopback address — is how this is exercised without a deployment. Which
 * scheme an operator may configure is deployment policy above this, and
 * nothing here weakens transport security on its own.
 */
export function parseOwnerEndpoint(value: unknown): OwnerEndpoint {
  if (typeof value !== "string" || value === "") {
    throw new OwnerEndpointError("endpoint-absent");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OwnerEndpointError("endpoint-unparseable");
  }
  if (!SCHEMES.includes(url.protocol)) {
    throw new OwnerEndpointError("endpoint-scheme");
  }
  // A credential in a configured endpoint would be a credential this client
  // sends on every request without ever having been given one to hold.
  if (url.username !== "" || url.password !== "") {
    throw new OwnerEndpointError("endpoint-credentials");
  }
  if (url.search !== "") {
    throw new OwnerEndpointError("endpoint-query");
  }
  if (url.hash !== "") {
    throw new OwnerEndpointError("endpoint-fragment");
  }
  // The base path, without a trailing separator, so the plane path below is the
  // only thing that decides the shape of what follows.
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return {
    planeUrl(runId: string, plane: OwnerPlane): string {
      return `${base}${planePath(runId, plane)}`;
    },
  };
}
