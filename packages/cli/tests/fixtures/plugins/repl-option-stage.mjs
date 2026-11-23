import { Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "probe-passthrough",
  command([cmd, args], next) {
    if (cmd !== "repl") {
      throw new Error("wrong command");
    }
    console.log("probe stage forwarded");
    return next(cmd, args);
  },
});
