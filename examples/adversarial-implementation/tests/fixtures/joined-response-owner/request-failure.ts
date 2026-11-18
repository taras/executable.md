import { Plugin } from "@executablemd/core/api";
import { API } from "@executablemd/runtime";
import { join } from "node:path";

export default Plugin({
  name: "test://request-only-native-failure",
  *install() {
    let stopped = false;
    yield* API.Files.around({
      *writeTextFile([request], next) {
        const result = yield* next(request);
        if (
          !stopped &&
          /\/reconciliations\/[a-f0-9]{64}\/request.json$/.test(join(request.cwd, request.path))
        ) {
          stopped = true;
          throw new Error("Controlled stop after original request commit");
        }
        return result;
      },
    });
    return undefined;
  },
});
