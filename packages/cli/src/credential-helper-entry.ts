/**
 * The module a source host's credential-helper launcher runs.
 *
 * Deno needs a module path to run, and a launcher that named the CLI entrypoint
 * would start a whole CLI to answer one credential question. This is the
 * smallest thing that can be that program: it dispatches the internal helper
 * mode and does nothing else.
 *
 * It is not a command. It appears in no help and in no public grammar, and
 * without the private environment its invocation built it has nothing to answer
 * with.
 */

import process from "node:process";
import { main } from "effection";
import {
  isCredentialHelperMode,
  runCredentialHelper,
} from "@executablemd/workflow/credential-helper";

// The launcher already names the mode; what follows it is Git's operation. The
// whole of what this program does is awaited, so a failure to read the request
// or to record a rejection is this helper failing rather than something that
// happened quietly after it answered.
const invocation = process.argv.slice(2);
if (isCredentialHelperMode(invocation)) {
  await main(() => runCredentialHelper(invocation));
}
