import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { until } from "effection";
import type { Operation } from "effection";
import { ReplHost } from "./repl/host.ts";

export function* useNodeReplProjectAccess(): Operation<void> {
  yield* ReplHost.around(
    {
      *checkProjectAccess([directory]) {
        yield* until(access(directory, constants.R_OK | constants.X_OK));
      },
    },
    { at: "min" },
  );
}
