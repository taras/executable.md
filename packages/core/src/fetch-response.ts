/**
 * What `<Fetch>` keeps of a response.
 *
 * A response is a live thing: a handle on a socket, a header collection the
 * host owns, a body that can be read once. None of that can be bound into a
 * document or written to a journal, because both outlive the request. What
 * crosses is JSON — a status, a header object, and text — read while the live
 * response is still in scope and detached from it before anything else runs.
 *
 * The shape is canonical so that two runs of the same document compare: header
 * names are lowercase, the object is built in lexicographic name order, and a
 * provider that reports one name twice has its values joined in the order it
 * reported them. The default runtime adapter combines repeated names before
 * this sees them, so on a real host each name arrives once and stays one value.
 */

import type { ResponseHeaders } from "@executablemd/runtime";

import { isJsonObject } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

/** A response this component will not retain. */
export class FetchResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchResponseError";
  }
}

/** One settled response, detached from whatever produced it. */
export interface FetchResponseRecord {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The response as journal data and as the captured binding — the same value. */
export function responseRecord(response: FetchResponseRecord): JsonObject {
  return {
    status: response.status,
    headers: { ...response.headers },
    body: response.body,
  };
}

/** Read a response back from what was retained, or from a replay. */
export function parseResponseRecord(value: Json): FetchResponseRecord {
  if (!isJsonObject(value)) {
    throw new FetchResponseError("a retained Fetch response must be a JSON object");
  }
  const { status, headers, body } = value;
  if (typeof status !== "number" || !isJsonObject(headers) || typeof body !== "string") {
    throw new FetchResponseError(
      "a retained Fetch response must carry a numeric status, header object and text body",
    );
  }
  const parsed: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header !== "string") {
      throw new FetchResponseError(`retained Fetch response header "${name}" is not a string`);
    }
    parsed[name] = header;
  }
  return { status, headers: parsed, body };
}

/** The status a provider reported, once it is a status at all. */
export function detachStatus(status: unknown): number {
  if (typeof status !== "number" || !Number.isInteger(status)) {
    throw new FetchResponseError(
      `the Fetch provider reported a non-numeric status: ${JSON.stringify(status)}`,
    );
  }
  return status;
}

/**
 * Every header of one response, as a plain object.
 *
 * A provider that cannot enumerate its headers is refused rather than read
 * through `get()`: retaining the headers somebody thought to ask for would
 * record a response that was never received.
 */
export function detachHeaders(headers: ResponseHeaders): Record<string, string> {
  const { entries } = headers;
  if (typeof entries !== "function") {
    throw new FetchResponseError(
      "the Fetch provider cannot enumerate response headers, so the complete response " +
        "cannot be retained. A substituted provider supplies `headers.entries()`.",
    );
  }
  const combined = new Map<string, string>();
  for (const [name, value] of entries.call(headers)) {
    if (typeof name !== "string" || typeof value !== "string") {
      throw new FetchResponseError("the Fetch provider reported a non-string header entry");
    }
    const key = name.toLowerCase();
    const seen = combined.get(key);
    combined.set(key, seen === undefined ? value : `${seen}, ${value}`);
  }
  const detached: Record<string, string> = {};
  for (const key of [...combined.keys()].sort()) {
    const value = combined.get(key);
    if (value !== undefined) {
      detached[key] = value;
    }
  }
  return detached;
}
