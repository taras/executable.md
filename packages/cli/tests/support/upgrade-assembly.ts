/**
 * The upgrade assembly a suite driving `runXmd` in-process stands in for.
 *
 * A runtime entrypoint states what this `xmd` is, and `runXmd` requires one
 * because inheriting installation authority by omission is exactly what the
 * parameter exists to prevent. A suite about something else says the honest
 * thing about a test process: it is running from source, it carries no
 * authority, and `xmd upgrade` under it refuses before reading anything.
 */

import type { UpgradeAssembly } from "../../src/upgrade.ts";

export const SOURCE_UPGRADE: UpgradeAssembly = {
  provenance: "deno-source",
  currentVersion: "0.0.0",
  executablePath: "/nonexistent/xmd",
  platform: "linux",
  architecture: "x64",
};
