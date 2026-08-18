/**
 * What a `<Fetch>` invocation asks for, decided before anything is sent.
 *
 * The whole request is settled here: where it goes, which method it uses, the
 * headers it carries, and what bounds it. Nothing in this module performs I/O,
 * which is what makes "refused before transport" observable — a refusal leaves
 * the request count at zero because the provider was never reached.
 *
 * What comes out is the value the journal retains, so it holds only what a
 * later run needs to recognize the same request: no credentials store, no
 * provider identity, no live header object, and no authored timeout spelling
 * beside the milliseconds it meant.
 */

import { parseDuration, timeoutFetch } from "@executablemd/runtime";
import type { Operation } from "effection";

import { isJsonObject } from "./json.ts";
import type { Json, JsonObject } from "./types.ts";

/** A request this component will not send. */
export class FetchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRequestError";
  }
}

/** The methods a read may use. Anything else needs an external-effect contract. */
const METHODS = ["GET", "HEAD"];

const SCHEMES = ["http:", "https:"];

/**
 * One admitted request.
 *
 * `timeout` is milliseconds and is present only when one of the two sources
 * supplied it — an explicit prop, or the contextual Fetch default. "Nobody
 * bounded this" and "somebody bounded it at zero" are different answers, and
 * an absent field is how the first one is written.
 */
export interface FetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
}

/** The request as journal data, with its fields in their settled order. */
export function requestRecord(request: FetchRequest): JsonObject {
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
  };
}

/**
 * Read a request back from what was retained.
 *
 * A replayed description is durable input, so it is parsed rather than trusted:
 * what a journal holds was written by an earlier run of a document that may
 * since have changed.
 */
export function parseRequestRecord(value: Json): FetchRequest {
  if (!isJsonObject(value)) {
    throw new FetchRequestError("a retained Fetch request must be a JSON object");
  }
  const { url, method, headers, timeout } = value;
  if (typeof url !== "string" || typeof method !== "string" || !isJsonObject(headers)) {
    throw new FetchRequestError("a retained Fetch request must carry url, method and headers");
  }
  const parsed: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header !== "string") {
      throw new FetchRequestError(`retained Fetch header "${name}" is not a string`);
    }
    parsed[name] = header;
  }
  return {
    url,
    method,
    headers: parsed,
    ...(typeof timeout === "number" ? { timeout } : {}),
  };
}

/**
 * The URL a document wrote, checked but not rewritten.
 *
 * Parsing answers whether the string is an absolute `http:` or `https:` URL;
 * it does not decide what the request is *for*. `URL.href` normalizes case,
 * default ports, and escaping, and sending a URL the author did not write would
 * make the retained request disagree with the document.
 */
function admitUrl(value: Json): string {
  if (typeof value !== "string") {
    throw new FetchRequestError('prop "url" on <Fetch /> must be a string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new FetchRequestError(
      `<Fetch url> must be an absolute http: or https: URL, got ${JSON.stringify(value)}`,
    );
  }
  if (!SCHEMES.includes(parsed.protocol)) {
    throw new FetchRequestError(
      `<Fetch url> must use http: or https:, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  return value;
}

/**
 * The method, spelled exactly as it is admitted.
 *
 * Uppercase and nothing else: HTTP methods are case-sensitive, and accepting
 * `get` would mean this component decided what the document meant. A mutating
 * method is refused here rather than sent, because retrying an interrupted
 * request is only safe while it is a read.
 */
function admitMethod(value: Json | undefined): string {
  if (value === undefined) {
    return "GET";
  }
  if (typeof value !== "string" || !METHODS.includes(value)) {
    throw new FetchRequestError(
      `<Fetch method> accepts only ${METHODS.join(" and ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * The request headers, lowercased and ordered.
 *
 * Two authored names that become the same key are refused rather than folded:
 * writing `Accept` and `accept` says two things about one header, and choosing
 * either would silently discard the other. The check happens while the authored
 * entries are read, before there is an object one could overwrite.
 */
function admitHeaders(value: Json | undefined): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new FetchRequestError('prop "headers" on <Fetch /> must be an object');
  }
  const admitted = new Map<string, string>();
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string") {
      throw new FetchRequestError(
        `<Fetch headers> value for ${JSON.stringify(name)} must be a string`,
      );
    }
    const key = name.toLowerCase();
    if (admitted.has(key)) {
      throw new FetchRequestError(
        `<Fetch headers> names ${JSON.stringify(key)} twice: header names are case-insensitive, ` +
          "so two spellings of one name are ambiguous",
      );
    }
    admitted.set(key, header);
  }
  const headers: Record<string, string> = {};
  for (const key of [...admitted.keys()].sort()) {
    const header = admitted.get(key);
    if (header !== undefined) {
      headers[key] = header;
    }
  }
  return headers;
}

/**
 * The whole request, or the reason there will not be one.
 *
 * The timeout is resolved here rather than left to the transport, because the
 * effective bound is part of what the run retains: an explicit prop outranks
 * the contextual Fetch default, and when neither exists the request carries no
 * bound at all.
 */
export function* prepareFetchRequest(props: Record<string, Json>): Operation<FetchRequest> {
  const url = admitUrl(props.url);
  const method = admitMethod(props.method);
  const headers = admitHeaders(props.headers);

  const declared = props.timeout;
  if (declared !== undefined && typeof declared !== "string") {
    throw new FetchRequestError('prop "timeout" on <Fetch /> must be a string');
  }
  const timeout =
    declared === undefined
      ? yield* timeoutFetch
      : parseDuration(declared, '<Fetch timeout> ("timeout" prop)');

  return {
    url,
    method,
    headers,
    ...(timeout === undefined ? {} : { timeout }),
  };
}
