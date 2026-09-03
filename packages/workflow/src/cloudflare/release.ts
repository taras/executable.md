/**
 * Which build is allowed to talk to which owner.
 *
 * The runner client and the Durable Object owner ship as one software-factory
 * release, so the messages between them are not a compatibility boundary and
 * carry no version negotiation. What replaces one is this: admission compares
 * an exact immutable fingerprint the deployment supplied on both sides, and a
 * mismatch refuses closed — before any private message is parsed, before an
 * acquisition exists, and before any run state is read.
 *
 * Two builds disagreeing about what was committed is the failure this exists to
 * prevent rather than to survive, so there is no downgrade path and nothing
 * adapts.
 */

/** Why a build was not admitted. */
export type ReleaseRefusal = "release-absent" | "release-malformed" | "release-mismatch";

export class ReleaseIdentityError extends Error {
  override name = "ReleaseIdentityError";

  constructor(readonly refusal: ReleaseRefusal) {
    // The configured and presented fingerprints are deployment facts, and a
    // refusal that printed them would put them in every log that saw one.
    super(`this runner build is not admitted by this owner (${refusal})`);
  }
}

/**
 * A fingerprint is opaque, non-empty and bounded.
 *
 * Bounded because it arrives from outside admission and is compared before
 * anything else has looked at it; opaque because what a deployment derives it
 * from — a commit, a container digest, a build id — is the deployment's
 * business and never this module's.
 */
const FINGERPRINT = /^[A-Za-z0-9._:-]{1,200}$/;

export function admitReleaseFingerprint(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new ReleaseIdentityError("release-absent");
  }
  if (!FINGERPRINT.test(value)) {
    throw new ReleaseIdentityError("release-malformed");
  }
  return value;
}

/**
 * Compare a presented fingerprint with the configured one.
 *
 * Exactness rather than secrecy is the point: a fingerprint proves nothing by
 * itself, and this is the one check that stops a build the owner never agreed
 * to from parsing a private message.
 */
export function requireSameRelease(configured: string, presented: unknown): string {
  const admitted = admitReleaseFingerprint(presented);
  if (admitted !== configured) {
    throw new ReleaseIdentityError("release-mismatch");
  }
  return admitted;
}
