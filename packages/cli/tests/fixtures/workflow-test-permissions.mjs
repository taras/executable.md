import { Plugin } from "@executablemd/core/api";
import { Permissions } from "@executablemd/runtime";

export default Plugin({
  name: "workflow-test-permissions",
  *install() {
    yield* Permissions.around({
      files: ([operation], next) => operation === "absolute" || next(operation),
    });
  },
});
