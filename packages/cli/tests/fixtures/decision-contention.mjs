import { Plugin } from "@executablemd/core/api";
import { API, env } from "@executablemd/runtime";
import { exists } from "@effectionx/fs";
import { sleep } from "effection";

function* waitFor(path) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (yield* exists(path)) {
      return;
    }
    yield* sleep(10);
  }
  throw new Error("Decision contention barrier timed out: " + path);
}

export default Plugin({
  name: "decision-contention",
  *install() {
    const contender = yield* env("XMD_DECISION_CONTENDER");
    const meeting = yield* env("XMD_DECISION_MEETING");
    const reservation = yield* env("XMD_DECISION_RESERVATION");
    if (!contender || !meeting || !reservation) {
      throw new Error("Decision contention fixture requires both contender identities and paths.");
    }
    yield* API.Process.around({
      *exec([options], next) {
        const script = options.command[2] ?? "";
        if (script.includes("printf confirmed")) {
          const quote = (path) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
          const arrival = quote(meeting + "/" + contender);
          const other = quote(meeting + "/" + (contender === "first" ? "second" : "first"));
          // Meet only after each command independently observes no reservation.
          // This barrier does not depend on the acquisition implementation.
          const barrier = `printf none; : > ${arrival}; for attempt in $(seq 1000); do if test -e ${other}; then break; fi; sleep 0.01; done; test -e ${other} || exit 1;`;
          return yield* next({
            ...options,
            command: ["bash", "-c", script.replace("printf none;", barrier)],
          });
        }
        const result = yield* next(options);
        if (script.includes("&& mkdir --") && result.exitCode !== 0) {
          // Model only the old utility's EEXIST false success. Let the winner
          // retain its snapshot first so the original loser deterministically refuses there.
          if (!(yield* exists(reservation))) {
            throw new Error("The old mkdir failed without an existing reservation.");
          }
          yield* waitFor(reservation + "/receipt.json");
          return { ...result, exitCode: 0 };
        }
        return result;
      },
    });
  },
});
