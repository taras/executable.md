/**
 * `<Fetch>` — one authorized HTTP read, retained
 * (specs/executable-mdx-spec.md §6.18).
 *
 * ```md
 * <Fetch url="https://api.example.test/status" as="response" />
 * ```
 *
 * A document that needs something from the network says where it is and what it
 * will call the answer. It does not say who performs the request: the live
 * transport is contextual `API.Fetch`, so a host that narrows reachable
 * destinations narrows this, and a test substitutes a provider at the same seam
 * a host uses. Nothing here reads a credential store, an environment variable,
 * or a host token, and a header a document writes is ordinary retained data
 * rather than an authentication mechanism.
 *
 * The whole request is admitted before transport — the URL, the method, the
 * headers, and the bound — so a refusal costs no request at all. Only `GET` and
 * `HEAD` are admitted: an interruption before the record commits may repeat the
 * request, and repeating a read is safe in a way that repeating a write is not.
 *
 * `as` decides what a status means, and nothing else does. A captured response
 * is data whatever its status, which is how a document branches on a 404. An
 * uncaptured one succeeds on 2xx and fails otherwise — after the response is
 * recorded, so the history holds what happened either way.
 *
 * It declares no `returns`. Declaring one would make `as` mandatory and delete
 * the uncaptured mode; without one, a successful uncaptured response is an
 * ordinary non-string return and renders nothing.
 */

import type { Operation } from "effection";
import { fetch } from "@executablemd/runtime";

import { hasBinding } from "../component-api.ts";
import { getExpansion } from "../expansion.ts";
import { prepareFetchRequest } from "../fetch-request.ts";
import type { FetchRequest } from "../fetch-request.ts";
import { detachHeaders, detachStatus, parseResponseRecord } from "../fetch-response.ts";
import type { FetchResponseRecord } from "../fetch-response.ts";
import { persistFetch } from "../fetch-journal.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    url: { type: "string" },
    method: { type: "string" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    timeout: { type: "string" },
  },
  required: ["url"],
  additionalProperties: false,
};

/** A response that arrived complete, with a status the document did not capture. */
export class FetchStatusError extends Error {
  readonly status: number;

  constructor(url: string, status: number) {
    super(
      `<Fetch url="${url}" /> responded with status ${status}. Capture the response with ` +
        "`as` to treat every status as data.",
    );
    this.name = "FetchStatusError";
    this.status = status;
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

/**
 * The request and the body read, as one observation.
 *
 * The headers are detached before the body is read, so what is retained does
 * not depend on a provider that invalidates its own header collection once the
 * body has been consumed. A `HEAD` never calls `text()`: there is no body to
 * read, and asking for one would fail against a provider that says so.
 */
function* observe(request: FetchRequest): Operation<FetchResponseRecord> {
  const response = yield* fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
  });
  const status = detachStatus(response.status);
  const headers = detachHeaders(response.headers);
  const body = request.method === "HEAD" ? "" : yield* response.text();
  return { status, headers, body };
}

export default function* Fetch(props: Record<string, Json>): Operation<Json> {
  const request = yield* prepareFetchRequest(props);

  const expansion = yield* getExpansion();
  // Asked before the request, because the answer belongs to how the element was
  // written rather than to what came back.
  const bound = yield* hasBinding();

  const retained = yield* persistFetch(
    {
      id: expansion.id,
      ...(expansion.position === undefined ? {} : { position: expansion.position }),
    },
    request,
    () => observe(request),
  );

  const response = parseResponseRecord(retained);
  if (!bound && !isSuccess(response.status)) {
    throw new FetchStatusError(request.url, response.status);
  }
  return retained;
}
