/**
 * The ACP runtime this package executes.
 *
 * The released 0.21.1 source closure retains the explicit backend-acceptance
 * barrier required by session creation. Its transport acknowledgement does not
 * establish a durable conversation. See `../vendor/acpx/PROVENANCE.md`.
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
