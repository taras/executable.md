import { Agent, Plugin } from "@executablemd/core/api";

export default Plugin({
  name: "development-test-session-routing",
  *install(request) {
    if (request.command !== "run") {
      return undefined;
    }
    yield* Agent.around({
      *session([routed], next) {
        const name = typeof routed === "string" || routed === undefined ? routed : routed.name;
        return yield* next(name);
      },
    });
    return undefined;
  },
});
