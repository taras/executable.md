/**
 * The ACP runtime this package executes.
 *
 * It resolves to the snapshot in `../vendor/acpx`, not to the published `acpx`
 * package, because native session launch must be able to bind one exact Claude
 * executable into the agent child that the runtime spawns — a capability
 * ACPX 0.12.0 has no transient input for. `../vendor/acpx/PROVENANCE.md`
 * records the patch and why it exists.
 *
 * Everything the package needs from ACPX comes through here, so there is one
 * answer to what runtime is running. Types travel with the runtime for the
 * same reason: the patch adds one, and a declaration taken from the unpatched
 * package would not have it.
 */
// @ts-types="../vendor/acpx/generated/runtime.d.ts"
export * from "../vendor/acpx/generated/runtime.js";
