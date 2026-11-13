import { ensure } from "effection";
import { Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "bad-cleanup",
  *install() {
    yield* ensure(() => {
      throw new Error("fixture plugin cleanup failed");
    });
  },
});
