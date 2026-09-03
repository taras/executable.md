/**
 * The standard-input reader a suite driving `runXmd` in-process stands in for.
 *
 * A runtime entrypoint supplies the one operation that reads a whole document
 * from the process's own stdin, and `runXmd` requires one because reaching a
 * host global from the shared CLI is exactly what the parameter exists to
 * prevent. A suite about another command says the honest thing: nothing it runs
 * asks for standard input, so a reader that was called at all is a defect
 * rather than an unread value.
 */

import type { Operation, Result } from "effection";
import type { StandardInputReader } from "../../src/standard-input.ts";

export const refusedStandardInput: StandardInputReader = function* (): Operation<Result<string>> {
  throw new Error("this run read standard input");
};
