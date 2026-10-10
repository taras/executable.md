/**
 * A REPL host with one installation whose teardown is held open (#881 PR 3).
 *
 * The `settling-head` state is the window a reader watching a run end is
 * actually in: the root has closed, its outcome is recorded, and the process
 * still owns what the entry acquired. No public grammar holds that window
 * open — an ordinary run passes through it in microseconds — so this host does
 * what `holdingTeardown()` does in `repl-entries.test.ts` and waits inside the
 * installation's own `ensure`.
 *
 * What it is not: a copy of the application. The terminal host, the frame
 * pipeline, the renderer, the profile and `runReplProgram` are the production
 * ones, imported. The only difference from `xmd repl` is one extra entry in
 * `installations`, and the latch it waits on is a file this host owns rather
 * than a hook in the product.
 *
 * It assembles no Agent stack, because this state needs none: the entry it
 * holds is a `<Json>` publication. `xmd repl` itself captures every other
 * state in the gallery, including the two paused ones.
 *
 *   XMD881_ENTERED  written when the teardown has been entered
 *   XMD881_RELEASE  waited on; the teardown finishes when it appears
 */

import { ensure, main, sleep } from "effection";
import type { Operation } from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import process from "node:process";
import { API, useHostFiles } from "@executablemd/runtime";
import { compileDataUri } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";

import { useDenoRepl } from "../../../../src/deno-repl.ts";
import { runReplProgram } from "../../../../src/repl/program.ts";
import { ordinaryEvaluationProfile } from "../../../../src/evaluation-profile.ts";

/**
 * The two latch paths, narrowed once at the edge.
 *
 * Read and checked here so everything below has two strings rather than two
 * possibly-absent ones: asserting them later would be claiming what this
 * check is for.
 */
function latches(): { readonly entered: string; readonly release: string } {
  const entered = process.env.XMD881_ENTERED;
  const release = process.env.XMD881_RELEASE;
  if (entered === undefined || release === undefined) {
    console.error("controlled-host: set XMD881_ENTERED and XMD881_RELEASE");
    process.exit(2);
  }
  return { entered, release };
}

const LATCH = latches();

/**
 * One installation that will not finish coming down until it is let go.
 *
 * The `ensure` is registered by `install`, so it runs when this entry's
 * installation scope is released — which is after the entry's outcome has been
 * retained and before the entry's work is finished. Writing the latch is how
 * the harness knows the window is open; waiting for the other one is what
 * keeps it open.
 */
function holdingTeardown(): ExecutionInstallation {
  return {
    *install(): Operation<void> {
      yield* ensure(function* (): Operation<void> {
        yield* writeTextFile(LATCH.entered, "");
        while (!(yield* exists(LATCH.release))) {
          yield* sleep(100);
        }
      });
    },
  };
}

await main(function* (args) {
  yield* API.Env.around(
    {
      *command([xmdArgs = []]) {
        return [process.execPath, "run", "--allow-all", ...xmdArgs];
      },
      *compile([source, options]) {
        return yield* compileDataUri(source, options);
      },
    },
    { at: "min" },
  );
  yield* useHostFiles();
  yield* useDenoRepl();

  const ran = yield* runReplProgram({
    profile: {
      includes: [process.cwd()],
      installations: [{ evaluation: ordinaryEvaluationProfile() }, holdingTeardown()],
      permissionMode: "deny-all",
    },
    ...(args[0] === undefined ? {} : { location: args[0] }),
  });
  if (!ran.ok) {
    console.error(`controlled-host: ${ran.error.message}`);
    process.exit(1);
  }
  console.log(`xmd repl '${ran.value.location}'`);
});
