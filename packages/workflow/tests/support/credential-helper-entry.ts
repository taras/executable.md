/**
 * The module a suite's credential-helper launcher runs.
 *
 * The same shape a source host's entrypoint offers, so what a test exercises is
 * the launcher and the helper contract rather than a stand-in for them.
 */

import process from "node:process";
import { runCredentialHelperMode } from "../../src/deno/composition/credential-helper.ts";

// The launcher already names the mode; what follows it is Git's operation.
runCredentialHelperMode(process.argv.slice(2));
