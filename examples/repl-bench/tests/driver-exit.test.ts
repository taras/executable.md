import { writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { run, scoped } from "effection";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import process from "node:process";
import { platformDataRoot } from "../../../packages/cli/src/repl-assembly.ts";
import { useMountedHost } from "../../../packages/cli/tests/support/mounted-repl.ts";
import {
  invalidRestoreEntries,
  savedRestoreFixture,
} from "../../../packages/cli/tests/support/restore-progress.ts";
import { useTempDirectory } from "../../../scripts/lib/temp-directory.ts";
import { connectDriver } from "../lib/driver-client.ts";
import { exitResult, point } from "../lib/protocol.ts";
import { prepareRun, root } from "../lib/run.ts";

Deno.test("driver reports the final CLI hint and ignores the cold restore command on refusal", () =>
  run(function* () {
    const cwd = yield* useTempDirectory("xmd-bench-driver-project-");
    const home = yield* useTempDirectory("xmd-bench-driver-home-");
    const dataRoot = platformDataRoot(
      process.platform,
      home,
      { XDG_DATA_HOME: join(home, ".local", "share") },
      sep,
    );
    const fixture = yield* savedRestoreFixture(yield* useMountedHost({ dataRoot }), 155);
    const location = `xmd://repl/${fixture.id}/entries/entry-2`;
    const viewport = { columns: 240, rows: 20 };
    for (const refused of [false, true]) {
      if (refused) {
        yield* writeTextFile(fixture.files.entries, invalidRestoreEntries(fixture));
      }
      yield* scoped(function* () {
        const { launch } = yield* prepareRun(cwd, viewport, [location], {
          build: { checkout: root },
          home,
        });
        yield* Stdio.around(
          {
            // deno-lint-ignore require-yield
            *stdout() {},
          },
          { at: "min" },
        );
        const { dispatch, close } = yield* connectDriver(launch);
        if (refused) {
          yield* dispatch({ action: "wait", text: `repl '${location}'` });
          yield* dispatch({ action: "wait", text: "Restoring rounds · 118 / 155 · stopped" });
          yield* dispatch({ action: "key", key: "Escape" });
        } else {
          yield* dispatch({ action: "wait", text: "Saved round 2 witness." });
          const exit = point.parse(yield* dispatch({ action: "wait", text: "[exit]" }));
          yield* dispatch({ action: "click", at: exit });
        }
        const result = exitResult.parse(yield* dispatch({ action: "exit" }));
        assert.equal((yield* close()).code, 0);
        assert.deepEqual(
          result,
          refused ? { exitCode: 1, location: null } : { exitCode: 0, location },
        );
      });
    }
  }));
