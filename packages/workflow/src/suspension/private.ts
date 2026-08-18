/**
 * How the trusted suspension operation reaches its own authority.
 *
 * `suspendFor()` is public and is called by document code. Ending an execution
 * is not something document code may do, so the two are separated: the public
 * operation derives a suspension ID and publishes a request, and the authority
 * to act on that request is a capability the host minted for one execution.
 *
 * This module is not exported from the package. That is the point — reaching
 * the capability means importing a private path, and a document cannot. The
 * capability's identity is checked as well, so even a value of the right shape,
 * obtained some other way, authorizes nothing.
 *
 * Context selects; it does not authorize. An installed provider decides *which*
 * host answers a suspension. Whether this execution may suspend at all is
 * decided by whether the host issued it a capability, which no context value
 * can supply on a document's behalf.
 */

import { createContext, type Context } from "effection";
import type { SuspensionCapability } from "./api.ts";

/**
 * The capability this execution holds, when it holds one.
 *
 * One per execution, installed by the lifecycle host inside the scope it owns.
 * An execution with no capability is one no host is prepared to suspend, and
 * `suspendFor()` refuses rather than publishing a request nothing can act on.
 */
export interface SuspensionAuthority {
  /** The capability for one suspension ID, or nothing for an ID it did not issue. */
  capability(suspensionId: string): SuspensionCapability;
}

export const CurrentSuspensionAuthority: Context<SuspensionAuthority> = createContext<
  SuspensionAuthority
>("executablemd.workflow.suspension.authority");
