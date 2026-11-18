import { API } from "@executablemd/runtime";
import { scoped } from "effection";
import { directRecovery } from "./joined-response-recovery.ts";
import type { RecoveryFixture } from "./joined-response-recovery.ts";

export function interruptedRecovery(fixture: RecoveryFixture, mode: "before-commit" | "unknown") {
  return scoped(function* () {
    let injected = false;
    yield* API.Fs.around({
      *rename([source, destination], next) {
        const selected =
          destination.startsWith(fixture.ticket + "/") &&
          (mode === "before-commit"
            ? /\/reconciliations\/[a-f0-9]{64}\/result.json$/.test(destination)
            : destination.endsWith("/confirmation.json"));
        if (!injected && selected && mode === "before-commit") {
          injected = true;
          throw new Error("Controlled filesystem commit failure");
        }
        yield* next(source, destination);
        if (!injected && selected) {
          injected = true;
          throw new Error("Controlled filesystem acknowledgment failure");
        }
      },
    });
    let returned: unknown;
    let failure: unknown;
    try {
      returned = yield* directRecovery(fixture);
    } catch (error) {
      failure = error;
    }
    return { injected, returned, failure: failure instanceof Error ? failure.message : null };
  });
}
