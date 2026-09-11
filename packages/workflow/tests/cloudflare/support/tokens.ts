/**
 * Signing tokens for the admission tests, with keys generated here.
 *
 * Real signatures against a real key pair, so the assertions are about
 * verification rather than about a stub that agreed to say yes. The key never
 * leaves this process and is generated per run.
 */

/** One generated key pair, and the JWK a verifier is configured with. */
export interface TestKeys {
  readonly signing: CryptoKey;
  readonly publicJwk: JsonWebKey;
  readonly kid: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeSegment(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function generateKeys(kid = "test-key"): Promise<TestKeys> {
  const generated = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  // `generateKey` is typed as either a key or a pair; an RSA signing algorithm
  // always answers with a pair, and reading it as one is what proves that here.
  if (!("privateKey" in generated) || !("publicKey" in generated)) {
    throw new Error("expected an RSA key pair");
  }
  const exported = await crypto.subtle.exportKey("jwk", generated.publicKey);
  if (exported instanceof ArrayBuffer) {
    throw new Error("expected a JWK export");
  }
  return { signing: generated.privateKey, publicJwk: exported, kid };
}

/** Sign one compact JWS over `claims`. */
export async function signToken(
  keys: TestKeys,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const encodedHeader = encodeSegment({ alg: "RS256", typ: "JWT", kid: keys.kid, ...header });
  const encodedPayload = encodeSegment(claims);
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.signing, signed);
  return `${encodedHeader}.${encodedPayload}.${base64url(new Uint8Array(signature))}`;
}

/** A token whose payload was edited after it was signed. */
export function tamper(token: string, claims: Record<string, unknown>): string {
  const parts = token.split(".");
  return `${parts[0]}.${encodeSegment(claims)}.${parts[2]}`;
}
