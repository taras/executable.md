/**
 * The ACP runtime this package executes.
 *
 * XMD patches the ACPX 0.22.0 source closure with the backend-acceptance barrier
 * used by strong-declared session creation. See `../vendor/acpx/PROVENANCE.md`.
 */
// @ts-types="../vendor/acpx/generated/runtime.d.ts"
export * from "../vendor/acpx/generated/runtime.js";

import type { AcpAgentRegistry } from "../vendor/acpx/generated/runtime.d.ts";

/** Preserve string identities; argv identities use the runtime's persisted spelling. */
export function resolveAgentCommand(registry: AcpAgentRegistry, agent: string): string {
  const command = registry.resolve(agent);
  return typeof command === "string"
    ? command
    : command
        .map((arg) => (/^[A-Za-z0-9_@%+=:,./^~-]+$/u.test(arg) ? arg : JSON.stringify(arg)))
        .join(" ");
}
