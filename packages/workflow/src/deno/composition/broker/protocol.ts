/**
 * What the provider, the broker child and the helper shim say to each other.
 *
 * Three processes, one question. The provider knows which repository it is about
 * to transport to and holds a capability; the broker child holds whatever the
 * invoking user's Git could prove for that repository; the shim is what Git runs
 * and is the only one of the three that ever writes a credential anywhere. This
 * module is the vocabulary they share, and it is deliberately tiny: a request is
 * one line of JSON and an answer is another.
 *
 * ## Why a line of JSON rather than Git's own credential format
 *
 * Git's format is what the shim speaks to *Git*. Between the shim and the broker
 * the question is a different one — it carries a capability, and it is answered
 * only when the locator matches the lease exactly — so it is written in its own
 * words. A protocol that looked like Git's would invite the shim to forward what
 * Git said instead of stating what it was asked.
 */

/** The variables a shim is told where to ask, and with what. */
export const ENDPOINT_VARIABLE = "XMD_CREDENTIAL_ENDPOINT";
export const CAPABILITY_VARIABLE = "XMD_CREDENTIAL_CAPABILITY";

/** The only operation this service answers. */
export const GET = "get";

/**
 * The operation a shim sends when Git tells it to forget a credential.
 *
 * Not a forwarding of Git's `erase`: nothing is forgotten anywhere, and no
 * helper, keychain or store is reached. It is a signal, local to this
 * invocation, that the transport rejected what it was given — which is the one
 * thing that distinguishes a credential this host could not prove from a
 * credential it proved and the remote refused. Both are authentication
 * unavailability; neither is an invalid locator.
 */
export const REJECTED = "rejected";

/**
 * One question the shim asks the broker.
 *
 * The locator is repeated in full rather than referred to. The broker leased one
 * exact repository, and what Git hands the shim is whatever Git decided to ask
 * about — which, after a redirect, is not necessarily where the lease was minted
 * for. Restating it is what lets the broker refuse.
 */
export interface CredentialQuestion {
  readonly capability: string;
  readonly operation: string;
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
}

/** What the broker answers. Absent members mean it proved nothing. */
export interface CredentialAnswer {
  readonly username?: string;
  readonly password?: string;
}

/** The line a broker prints once it is listening, and nothing else it prints. */
export const READY = "xmd-credential-broker-ready";

/** The line a broker prints when it acquired an identity for its lease. */
export const ACQUIRED = "xmd-credential-broker-acquired";

/** The line a broker prints when its lease's transport rejected what it gave. */
export const REFUSED = "xmd-credential-broker-refused";

/** One record, as a line. A value can hold no newline, so a line holds one. */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** The question this line is, or `undefined` when it is not one. */
export function decodeQuestion(line: string): CredentialQuestion | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const read = (name: string): string | undefined => {
    const value = Reflect.get(parsed as object, name);
    return typeof value === "string" ? value : undefined;
  };
  const capability = read("capability");
  const operation = read("operation");
  const protocol = read("protocol");
  const host = read("host");
  const path = read("path");
  if (
    capability === undefined ||
    operation === undefined ||
    protocol === undefined ||
    host === undefined ||
    path === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ capability, operation, protocol, host, path });
}

/** The answer this line is, or an empty one when it is not readable. */
export function decodeAnswer(line: string): CredentialAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const username = Reflect.get(parsed, "username");
  const password = Reflect.get(parsed, "password");
  return typeof username === "string" && typeof password === "string" ? { username, password } : {};
}

/**
 * Whether two secrets are the same, without saying how far they agreed.
 *
 * A capability is compared here and only here. Comparison that stops at the
 * first difference tells a caller how much of one it guessed, which is a way to
 * learn one a byte at a time.
 */
export function sameSecret(one: string, other: string): boolean {
  if (one.length !== other.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < one.length; index += 1) {
    difference |= one.charCodeAt(index) ^ other.charCodeAt(index);
  }
  return difference === 0;
}
