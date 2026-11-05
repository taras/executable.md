import { Plugin, Component } from "../source/packages/core/api.ts";
import { API } from "../source/packages/runtime/mod.ts";
import { writeTextFile } from "@effectionx/fs";
import process from "node:process";
import { basename, dirname } from "node:path";

export default Plugin({
  name: "friction-diagnostic-timing",
  *install(request) {
    const at = request.args.indexOf("--journal");
    const journal = request.args[at + 1];
    const suite = typeof journal === "string" ? basename(dirname(journal)) : "";
    if (at < 0 || !["Sanity", "Friction"].includes(suite)) {
      throw new Error("Timing plugin requires the diagnostic's owned journal path");
    }
    let sequence = 0;
    let processId = 0;
    const directory = new URL("../result/timing/", import.meta.url);
    function* save(value) {
      const seq = ++sequence;
      yield* writeTextFile(new URL(`${suite}-${process.pid}-${seq}.json`, directory), JSON.stringify({
        ...value, suite, pid: process.pid, sequence: seq,
        observedMs: performance.now(), timeOriginMs: performance.timeOrigin,
      }));
    }
    yield* API.Process.around({
      *exec([options], next) {
        const id = ++processId;
        const startMs = performance.now();
        yield* save({ event: "process_start", id, startMs, command: options.command,
          cwd: options.cwd ?? null, configuredTimeout: options.timeout ?? null });
        let returned = false;
        let exitCode = null;
        try {
          const outcome = yield* next(options);
          returned = true;
          exitCode = outcome.exitCode;
          return outcome;
        } finally {
          const endMs = performance.now();
          yield* save({ event: "process_end", id, startMs, endMs,
            elapsedMs: endMs - startMs, delegationReturned: returned, exitCode });
        }
      },
    });
    yield* Component.around({
      *expand([expansionRequest], next) {
        const expansion = expansionRequest.expansion;
        if (expansion.name !== "Test") {
          yield* next(expansionRequest);
          return;
        }
        const startMs = performance.now();
        yield* save({ event: "test_start", id: expansion.id,
          position: expansion.position ?? null, startMs });
        let returned = false;
        try {
          yield* next(expansionRequest);
          returned = true;
        } finally {
          const endMs = performance.now();
          yield* save({ event: "test_delegate_end", id: expansion.id, startMs, endMs,
            elapsedMs: endMs - startMs, delegationReturned: returned });
        }
      },
    });
    yield* save({ event: "plugin_installed", journal });
    return undefined;
  },
});
