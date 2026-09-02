/**
 * The run id a software-factory run is addressed by.
 *
 * One GitHub issue is one durable run, so the id has to be a function of the
 * issue and of nothing that can change while the work is going on. Repository
 * names get renamed, issue numbers move between deployments, Project items and
 * their statuses are edited constantly, branches and revisions are the point of
 * the exercise, and delivery ids and actors differ on every request. None of
 * them takes part. What is left is the deployment the issue lives in and the
 * opaque node id that deployment gave it, and those two are what this hashes.
 *
 * Because every input is immutable, admitting one issue twice derives one id and
 * reaches one run through ordinary compatible reuse, and no separate idempotency
 * concept appears anywhere above it. Two independent implementations handed the
 * same authority and node id produce the same 52 characters.
 *
 * The derivation is specified in `specs/github-actions-software-factory-spec.md`
 * §1.1 and restated in `specs/workflow-spec.md` §9.1. It is host-selected public
 * run id and nothing more: opaque to everything but equality and lifecycle
 * addressing, and a legal one under the storage rule, which wants a non-empty
 * string containing no NUL.
 */

import { until } from "effection";
import type { Operation } from "effection";

/** The version tag the digest opens with. A different scheme takes a different tag. */
const SCHEME = "github-issue-v1";

/** Lowercase RFC 4648 Base32. No padding is ever emitted, so `=` is absent. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * How many characters a full SHA-256 becomes.
 *
 * 32 bytes is 256 bits, and Base32 carries five bits per character, so the
 * unpadded encoding is `ceil(256 / 5)` characters. Stated rather than computed
 * because it is a contract a second implementation is held to.
 */
export const FACTORY_RUN_ID_LENGTH = 52;

/** Why a subject could not be turned into a run id. */
export type FactoryRunSubjectFailure =
  | "authority-empty"
  | "authority-has-scheme"
  | "authority-has-userinfo"
  | "authority-has-path"
  | "authority-has-query"
  | "authority-has-fragment"
  | "authority-has-whitespace"
  | "authority-malformed-host"
  | "authority-malformed-port"
  | "authority-default-port"
  | "node-id-empty"
  | "node-id-has-nul";

/** A subject this build cannot derive an id from, named by what was wrong with it. */
export class FactoryRunSubjectError extends Error {
  override name = "FactoryRunSubjectError";

  constructor(
    readonly reason: FactoryRunSubjectFailure,
    detail: string,
  ) {
    super(`this GitHub subject cannot address a factory run: ${detail}`);
  }
}

/** The exact GitHub subject one factory run is a run of. */
export interface FactoryRunSubject {
  /**
   * The canonical GitHub authority: a lowercase DNS hostname, plus `:` and a
   * port when that port is not the scheme's default.
   */
  readonly authority: string;
  /**
   * The exact string GitHub's GraphQL API returned for this issue.
   *
   * Compared byte for byte. It is an opaque provider identity, and normalizing
   * one would be inventing a second.
   */
  readonly issueNodeId: string;
}

/** The port `https` implies, and therefore the one an authority may not spell out. */
const DEFAULT_PORT = 443;

/**
 * A hostname the DNS grammar admits: labels of letters, digits and hyphens,
 * each starting and ending with an alphanumeric, separated by dots.
 *
 * Deliberately not a URL parse. A parser would accept — and silently discard —
 * the parts an authority may not carry, and the point here is to refuse them.
 */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Normalize what an operator configured into the one spelling this hash uses.
 *
 * Case folding is the only transformation. Everything else an authority must not
 * contain is refused rather than stripped: a value that had to be repaired to be
 * usable is a value somebody meant differently, and two spellings that both
 * became one authority would be two runs quietly becoming one.
 */
export function canonicalGitHubAuthority(value: string): string {
  if (value === "") {
    throw new FactoryRunSubjectError("authority-empty", "the authority is empty");
  }
  if (/\s/.test(value)) {
    throw new FactoryRunSubjectError(
      "authority-has-whitespace",
      "the authority contains whitespace",
    );
  }
  if (value.includes("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new FactoryRunSubjectError(
      "authority-has-scheme",
      "the authority carries a scheme; write the host alone",
    );
  }
  if (value.includes("@")) {
    throw new FactoryRunSubjectError(
      "authority-has-userinfo",
      "the authority carries user information",
    );
  }
  if (value.includes("#")) {
    throw new FactoryRunSubjectError("authority-has-fragment", "the authority carries a fragment");
  }
  if (value.includes("?")) {
    throw new FactoryRunSubjectError("authority-has-query", "the authority carries a query");
  }
  if (value.includes("/")) {
    throw new FactoryRunSubjectError(
      "authority-has-path",
      "the authority carries a path or a trailing separator",
    );
  }

  const folded = value.toLowerCase();
  const separator = folded.lastIndexOf(":");
  const host = separator === -1 ? folded : folded.slice(0, separator);
  const port = separator === -1 ? undefined : folded.slice(separator + 1);

  if (!HOSTNAME.test(host)) {
    throw new FactoryRunSubjectError("authority-malformed-host", "the host is not a DNS hostname");
  }
  if (port === undefined) {
    return host;
  }
  if (!/^[0-9]{1,5}$/.test(port)) {
    throw new FactoryRunSubjectError("authority-malformed-port", "the port is not a number");
  }
  const numeric = Number(port);
  if (numeric < 1 || numeric > 65535) {
    throw new FactoryRunSubjectError("authority-malformed-port", "the port is out of range");
  }
  if (numeric === DEFAULT_PORT) {
    throw new FactoryRunSubjectError(
      "authority-default-port",
      "the default port is written out; omit it so one deployment has one spelling",
    );
  }
  return `${host}:${numeric}`;
}

/** Hold a node id to what a retained identity has to be, and change nothing about it. */
export function admitIssueNodeId(value: string): string {
  if (value === "") {
    throw new FactoryRunSubjectError("node-id-empty", "the issue node id is empty");
  }
  if (value.includes("\0")) {
    throw new FactoryRunSubjectError("node-id-has-nul", "the issue node id contains a NUL");
  }
  return value;
}

/**
 * The exact bytes the digest is taken over.
 *
 * `github-issue-v1`, NUL, the canonical authority, NUL, the node id — all
 * UTF-8. The NULs are separators the inputs cannot contain, so no pair of
 * (authority, node id) can be rearranged into another pair with the same bytes.
 */
export function factoryRunIdPreimage(subject: FactoryRunSubject): Uint8Array {
  const encoder = new TextEncoder();
  const scheme = encoder.encode(SCHEME);
  const authority = encoder.encode(subject.authority);
  const node = encoder.encode(subject.issueNodeId);
  const bytes = new Uint8Array(scheme.length + 1 + authority.length + 1 + node.length);
  let at = 0;
  bytes.set(scheme, at);
  at += scheme.length;
  bytes[at] = 0;
  at += 1;
  bytes.set(authority, at);
  at += authority.length;
  bytes[at] = 0;
  at += 1;
  bytes.set(node, at);
  return bytes;
}

/** Lowercase unpadded RFC 4648 Base32 of exactly these bytes. */
export function base32Unpadded(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Normalize a subject, refusing anything this build cannot address a run from.
 *
 * Separate from the derivation so a caller can admit a subject before it has
 * anywhere to put the answer — which is what an admission check needs, and what
 * a later story comparing a reread subject against a retained one needs too.
 */
export function admitFactoryRunSubject(subject: FactoryRunSubject): FactoryRunSubject {
  return {
    authority: canonicalGitHubAuthority(subject.authority),
    issueNodeId: admitIssueNodeId(subject.issueNodeId),
  };
}

/**
 * The public run id for one GitHub issue.
 *
 * The subject is admitted first, so a malformed authority or node id is refused
 * before any digest exists and long before anything looks for an owner to route
 * it to.
 */
export function* deriveFactoryRunId(subject: FactoryRunSubject): Operation<string> {
  const admitted = admitFactoryRunSubject(subject);
  const digest = yield* until(
    crypto.subtle.digest("SHA-256", factoryRunIdPreimage(admitted) as BufferSource),
  );
  return base32Unpadded(new Uint8Array(digest));
}
