/**
 * What one real-CLI proof admits, and nothing wider (specs/decisions.md
 * DEC-017).
 *
 * An adapter name says which command shape to consider. It does not say that
 * the thing found under that name works: a proof ran against one build of one
 * CLI, on one operating system, on one architecture, and every other build and
 * machine is a claim nobody made. So admission is stated as points, and a point
 * is the whole tuple —
 *
 *   adapter + capability + canonical reported version + host OS + host
 *   architecture
 *
 * — matched exactly. Nothing here parses, orders or ranges a version. A
 * semver-shaped line is a value one adapter recognized, not evidence about the
 * build behind it, and comparing two of them would turn one installed CLI into
 * a statement about releases that have never run.
 *
 * The host pair is supplied rather than read. Which machine this is is a fact
 * the trusted host has and shared provider code must not go looking for: a
 * provider that detected its own runtime would answer the compatibility
 * question with the thing being asked about.
 */

/**
 * Which behavior a proof established.
 *
 * Two, not one, because they are proved separately: handing a session to a
 * native UI and later joining that same conversation through ACP are different
 * things that can be true independently.
 */
export type NativeCapability = "native-launch" | "client-native-attachment";

/** The machine a host is actually running on, as that host states it. */
export interface NativeCapabilityHost {
  readonly platform: string;
  readonly architecture: string;
}

/** One capability, proved for one exact build on one exact machine. */
export interface NativeCapabilityCompatibilityPoint {
  readonly agent: string;
  readonly capability: NativeCapability;
  /** The canonical line the adapter recognized, whole. Never a number alone. */
  readonly reportedVersion: string;
  readonly platform: string;
  readonly architecture: string;
}

/** Everything a host admits, beside the machine it admits it on. */
export interface NativeCapabilityCompatibility {
  readonly host: NativeCapabilityHost;
  readonly points: readonly NativeCapabilityCompatibilityPoint[];
}

/** What an adapter carries about its own proofs, before a host names a machine. */
export type ProvedNativeCapability = Omit<NativeCapabilityCompatibilityPoint, "agent">;

/** The live capability an observation offers for admission. */
export interface ObservedNativeCapability {
  readonly agent: string;
  readonly capability: NativeCapability;
  readonly reportedVersion: string;
}

/**
 * Whether this host admits what was actually observed.
 *
 * The host's own OS and architecture are what an admitted point is compared
 * against, so a point proved elsewhere cannot admit anything here. Absent
 * compatibility admits nothing: a host that states no proof has none, and
 * treating silence as permission is the failure this whole tuple exists to
 * prevent.
 */
export function admitsNativeCapability(
  compatibility: NativeCapabilityCompatibility | undefined,
  observed: ObservedNativeCapability,
): boolean {
  if (compatibility === undefined) {
    return false;
  }
  const { platform, architecture } = compatibility.host;
  return compatibility.points.some(
    (point) =>
      point.agent === observed.agent &&
      point.capability === observed.capability &&
      point.reportedVersion === observed.reportedVersion &&
      point.platform === platform &&
      point.architecture === architecture,
  );
}
