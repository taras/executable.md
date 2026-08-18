/**
 * What a `<Fetch>` leaves behind.
 *
 * One effect covers the whole observation: the request goes out and the body is
 * read inside it, so a committed result describes a response that was received
 * complete. Committing the status and headers first and failing on the body
 * would publish a success for a response nobody has.
 *
 * The retained input is the normalized request itself rather than a digest of
 * it, because that request is what a reader of the history needs in order to
 * know what was asked. Identity is the effect's `type` and `name` as always —
 * the name being this expansion's, which the same document derives again on
 * every run — so a replay restores this response without a second request.
 *
 * Whether any of it is persisted belongs to the host: an ordinary run holds an
 * in-memory stream, a diagnostic run a file, and a workflow its run store. This
 * module writes one event either way and chooses nothing.
 */

import { createDurableOperation } from "@executablemd/durable-streams";
import type { Json as DurableJson, Workflow } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { requestRecord } from "./fetch-request.ts";
import type { FetchRequest } from "./fetch-request.ts";
import { responseRecord } from "./fetch-response.ts";
import type { FetchResponseRecord } from "./fetch-response.ts";
import { parseJson } from "./json.ts";
import { sourceDescription } from "./source-position.ts";
import type { Json, SourcePosition } from "./types.ts";

const FETCH = "fetch";

/** Which expansion made the request, and where it was written. */
export interface FetchIdentity {
  /** The expansion identifier — the durable name. */
  id: string;
  /** Where the element was written, for history. Never read back as identity. */
  position?: Readonly<SourcePosition>;
}

function recordName(id: string): string {
  return `fetch:${id}`;
}

/**
 * Perform one request and record what came back, or restore what is recorded.
 *
 * On replay `live` is never entered, which is what keeps a resumed document
 * from asking a server anything a second time.
 */
export function* persistFetch(
  identity: FetchIdentity,
  request: FetchRequest,
  live: () => Operation<FetchResponseRecord>,
): Workflow<Json> {
  const stored = yield createDurableOperation<DurableJson>(
    {
      type: FETCH,
      name: recordName(identity.id),
      input: requestRecord(request),
      ...sourceDescription(identity.position),
    },
    function* (): Operation<DurableJson> {
      return parseJson(responseRecord(yield* live()));
    },
  );
  return parseJson(stored);
}
