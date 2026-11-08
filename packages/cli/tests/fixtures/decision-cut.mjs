import { Plugin } from "@executablemd/core/api";
import { API, env } from "@executablemd/runtime";

// Fail the first host commit whose target contains XMD_DECISION_CUT_MATCH, either before
// its bytes exist or after the rename completed without acknowledging it to the writer.
export default Plugin({
  name: "decision-cut",
  *install() {
    const mode = yield* env("XMD_DECISION_CUT_MODE");
    const match = yield* env("XMD_DECISION_CUT_MATCH");
    if (mode === undefined || match === undefined) {
      return;
    }
    let cut = false;
    yield* API.Fs.around({
      *rename([from, to], next) {
        if (!cut && String(to).includes(match)) {
          cut = true;
          if (mode === "after") {
            yield* next(from, to);
          }
          throw new Error("synthetic " + mode + " cut at " + String(to));
        }
        return yield* next(from, to);
      },
    });
  },
});
