/**
 * Verifying the token a runner presents.
 *
 * This is the authority boundary, so it takes bytes rather than a claim set. A
 * caller that could hand over decoded claims would be a caller that could
 * assert whatever the policy asks for, and no amount of equality checking after
 * that point would mean anything — which is exactly the hole this module
 * closes.
 *
 * What it does is ordinary compact-JWS verification, narrowed hard: one
 * algorithm family, keys the deployment configured, and temporal validity
 * checked before any payload member is read as a claim. Everything about the
 * token stops here. The raw JWT, the key material, the header, the claims the
 * policy does not name and the reason a signature failed are all provider
 * state: none of it is retained, attached, journaled, logged, or returned.
 */

import { type Operation, until } from "effection";

/** Why a token was not accepted. */
export type TokenRefusal =
  | "token-absent"
  | "token-malformed"
  | "token-too-large"
  | "unsupported-algorithm"
  | "unsupported-type"
  | "unknown-key"
  | "bad-signature"
  | "malformed-claims"
  | "expired"
  | "not-yet-valid"
  | "misconfigured-clock";

export class TokenError extends Error {
  override name = "TokenError";

  constructor(readonly refusal: TokenRefusal) {
    super(`this runner's token was not accepted (${refusal})`);
  }
}

/**
 * The one signature family this accepts.
 *
 * GitHub Actions signs with RS256. An allowlist rather than a lookup, because
 * reading the algorithm out of the header and trusting it is how a token comes
 * to be "verified" with `none` or with a symmetric key an attacker chose.
 */
const SUPPORTED = "RS256";

/**
 * The longest token this reads at all, and the longest segment inside one.
 *
 * Bounded before anything is decoded, because decoding is the first work an
 * unauthenticated caller can make this owner do.
 */
const MAX_TOKEN = 16 * 1024;
const MAX_SEGMENT = 8 * 1024;

/** The most skew a deployment may configure. */
const MAX_SKEW_SECONDS = 300;

/** A NumericDate: a finite integer count of seconds. */
function numericDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TokenError("malformed-claims");
  }
  return value;
}

/** What a deployment configures before any token can be verified. */
export interface TokenVerification {
  /**
   * The issuer's public keys. Fetched and rotated by the host.
   *
   * `kid` is carried beside the key rather than read off it: the runtime's
   * `JsonWebKey` does not declare one, and a key set that narrows by id is what
   * a JWKS is for.
   */
  readonly keys: readonly VerificationKey[];
  /**
   * How much clock skew to tolerate, in seconds.
   *
   * Adapter policy, not a user setting and never a request field. Bounded above
   * because a large tolerance is indistinguishable from not checking, and below
   * because a negative one would reject tokens for being on time.
   */
  readonly skewSeconds: number;
  /** Now, in seconds since the epoch. Injected so a test can be exact. */
  readonly now: () => number;
}

/** One configured public key, and the id a token may name it by. */
export interface VerificationKey {
  readonly kid?: string;
  readonly jwk: JsonWebKey;
}

function decodeSegment(segment: string): unknown {
  // base64url, without the padding a compact JWS omits.
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const filled = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(filled), (character) => character.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch {
    throw new TokenError("token-malformed");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TokenError("token-malformed");
  }
}

function object(value: unknown): Map<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenError("token-malformed");
  }
  const members: Map<string, unknown> = new Map(Object.entries(value));
  return members;
}

function signatureBytes(segment: string): Uint8Array {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const filled = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(filled), (character) => character.charCodeAt(0));
  } catch {
    throw new TokenError("token-malformed");
  }
}

/**
 * Verify one compact JWS and answer with its payload.
 *
 * The order is the contract: shape, then algorithm, then signature, then time.
 * A payload member is not a claim until every one of those has passed, which is
 * why nothing here returns early with something a caller could mistake for one.
 */
export function* verifyToken(
  configured: TokenVerification,
  token: unknown,
): Operation<Map<string, unknown>> {
  const skew = configured.skewSeconds;
  if (!Number.isFinite(skew) || skew < 0 || skew > MAX_SKEW_SECONDS) {
    throw new TokenError("misconfigured-clock");
  }
  if (typeof token !== "string" || token === "") {
    throw new TokenError("token-absent");
  }
  if (token.length > MAX_TOKEN) {
    throw new TokenError("token-too-large");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenError("token-malformed");
  }
  if (parts.some((part) => part.length === 0 || part.length > MAX_SEGMENT)) {
    throw new TokenError("token-malformed");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new TokenError("token-malformed");
  }

  const header = object(decodeSegment(encodedHeader));
  if (header.get("alg") !== SUPPORTED) {
    throw new TokenError("unsupported-algorithm");
  }
  // GitHub's Actions tokens carry `typ: "JWT"`. Requiring it is cheap and stops
  // a token minted for another purpose from being read as one of these.
  const type = header.get("typ");
  if (typeof type !== "string" || type.toUpperCase() !== "JWT") {
    throw new TokenError("unsupported-type");
  }

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = signatureBytes(encodedSignature);
  // The token names exactly one configured key. Falling back to an unkeyed
  // candidate when the id matched nothing would mean an unrecognized key id
  // still got a signature check against whatever else was configured.
  const keyId = header.get("kid");
  if (typeof keyId !== "string" || keyId === "") {
    throw new TokenError("unknown-key");
  }
  const candidates = configured.keys.filter((key) => key.kid === keyId);
  if (candidates.length !== 1) {
    // None means the id is unrecognized; more than one means the configuration
    // cannot say which key that id is.
    throw new TokenError("unknown-key");
  }

  let verified = false;
  for (const candidate of candidates) {
    const key = yield* until(
      crypto.subtle.importKey(
        "jwk",
        candidate.jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
    const matched = yield* until(crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed));
    if (matched) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    throw new TokenError("bad-signature");
  }

  const payload = object(decodeSegment(encodedPayload));
  const now = configured.now();
  if (!Number.isFinite(now)) {
    throw new TokenError("misconfigured-clock");
  }

  // All three are required. Checking a temporal claim only when it happens to
  // be a number means a token that omits it is treated as one that satisfies
  // it, which is the opposite of what the claim is for.
  const expiry = numericDate(payload.get("exp"));
  const issued = numericDate(payload.get("iat"));
  const notBefore = numericDate(payload.get("nbf"));

  // RFC 7519 §4.1.4: the current time must be *before* the expiration, so the
  // boundary itself is expired rather than the last valid instant.
  if (now >= expiry + skew) {
    throw new TokenError("expired");
  }
  if (now + skew < notBefore) {
    throw new TokenError("not-yet-valid");
  }
  if (now + skew < issued) {
    // Issued in the future by more than the tolerance: the token and this clock
    // disagree about when now is, and nothing here can tell which is wrong.
    throw new TokenError("not-yet-valid");
  }
  return payload;
}
