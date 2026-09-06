/**
 * What one real-CLI proof admits, and nothing wider (specs/decisions.md
 * DEC-017).
 *
 * An Agent name says which command shape to consider. It does not say that the
 * thing found under that name works: a proof ran against one implementation's
 * protocol, on one operating system, on one architecture, and every other
 * protocol and machine is a claim nobody made. So admission is stated as
 * profiles, and a profile is the whole tuple —
 *
 *   adapter protocol + capability + observed probe profile + host OS + host
 *   architecture
 *
 * — matched exactly. Nothing here is a version. A version says which release
 * was installed, not what it can do, and admitting one would make a routine
 * upgrade disable every new session while telling nobody why. What is matched
 * instead is the adapter's stable protocol identifier and what its own
 * side-effect-free probe recognized in the exact executable that was hashed.
 *
 * The host pair is supplied rather than read. Which machine this is is a fact
 * the trusted host has and shared provider code must not go looking for: a
 * provider that detected its own runtime would answer the admission question
 * with the thing being asked about.
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

/** One capability, proved for one protocol shape on one exact machine. */
export interface NativeCapabilityAdmission {
  /**
   * The adapter implementation whose protocol was proved.
   *
   * Deliberately not the Agent registry name and not the launcher command:
   * either can be pointed at something else, and neither says which protocol
   * the thing behind it speaks.
   */
  readonly adapterProtocol: string;
  readonly capability: NativeCapability;
  /** The probe whose recognized shape this admission was proved against. */
  readonly probeProfile: string;
  readonly platform: string;
  readonly architecture: string;
}

/** Everything a host admits, beside the machine it admits it on. */
export interface NativeCapabilityPolicy {
  readonly host: NativeCapabilityHost;
  readonly admissions: readonly NativeCapabilityAdmission[];
}

/** What an adapter carries about its own proofs, before a host names a machine. */
export type ProvedNativeCapability = Omit<NativeCapabilityAdmission, "adapterProtocol">;

/** The live capability an observation offers for admission. */
export interface ObservedNativeCapability {
  readonly adapterProtocol: string;
  readonly capability: NativeCapability;
  readonly probeProfile: string;
}

/**
 * Whether this host admits what was actually observed.
 *
 * The host's own OS and architecture are what an admitted profile is compared
 * against, so a profile proved elsewhere cannot admit anything here. An absent
 * policy admits nothing: a host that states no proof has none, and treating
 * silence as permission is the failure this whole tuple exists to prevent.
 */
export function admitsNativeCapability(
  policy: NativeCapabilityPolicy | undefined,
  observed: ObservedNativeCapability,
): boolean {
  if (policy === undefined) {
    return false;
  }
  const { platform, architecture } = policy.host;
  return policy.admissions.some(
    (admission) =>
      admission.adapterProtocol === observed.adapterProtocol &&
      admission.capability === observed.capability &&
      admission.probeProfile === observed.probeProfile &&
      admission.platform === platform &&
      admission.architecture === architecture,
  );
}
