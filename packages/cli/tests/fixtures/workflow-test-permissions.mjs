import { Plugin } from "@executablemd/core/api";
import { Permissions } from "@executablemd/runtime";
import preparedWorker from "./prepared-test-worker.mjs";

export default Plugin({
  name: "workflow-test-permissions",
  *install(request) {
    yield* Permissions.around({
      files: ([operation], next) => operation === "absolute" || next(operation),
    });
    yield* preparedWorker.install(request);
  },
});
