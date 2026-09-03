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
  | "unsupported-algorithm"
  | "unknown-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid";

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
  /** How much clock skew to tolerate, in seconds. */
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

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TokenError("token-malformed");
  }
  return value as Record<string, unknown>;
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
): Operation<Record<string, unknown>> {
  if (typeof token !== "string" || token === "") {
    throw new TokenError("token-absent");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
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
  if (header["alg"] !== SUPPORTED) {
    throw new TokenError("unsupported-algorithm");
  }

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = signatureBytes(encodedSignature);
  const keyId = header["kid"];
  // A `kid` narrows which key is tried; its absence means every configured key
  // is a candidate. Either way only a configured key can verify anything.
  const candidates = configured.keys.filter(
    (key) => typeof keyId !== "string" || key.kid === undefined || key.kid === keyId,
  );
  if (candidates.length === 0) {
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
  const expiry = payload["exp"];
  if (typeof expiry === "number" && now > expiry + configured.skewSeconds) {
    throw new TokenError("expired");
  }
  const notBefore = payload["nbf"];
  if (typeof notBefore === "number" && now + configured.skewSeconds < notBefore) {
    throw new TokenError("not-yet-valid");
  }
  return payload;
}
