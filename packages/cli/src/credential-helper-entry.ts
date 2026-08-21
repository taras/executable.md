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
import { runCredentialHelperMode } from "@executablemd/workflow/deno";

// The launcher already names the mode; what follows it is Git's operation.
runCredentialHelperMode(process.argv.slice(2));
