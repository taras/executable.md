/**
 * The module a suite's credential-helper launcher runs.
 *
 * The same shape a source host's entrypoint offers, so what a test exercises is
 * the launcher and the helper contract rather than a stand-in for them.
 */

import process from "node:process";
import { main } from "effection";
import {
  isCredentialHelperMode,
  runCredentialHelper,
} from "../../src/deno/composition/credential-helper.ts";

// The launcher already names the mode; what follows it is Git's operation. The
// whole of what this program does is awaited, so a failure to read the request
// or to record a rejection is this helper failing rather than something that
// happened quietly after it answered.
const invocation = process.argv.slice(2);
if (isCredentialHelperMode(invocation)) {
  await main(() => runCredentialHelper(invocation));
}
