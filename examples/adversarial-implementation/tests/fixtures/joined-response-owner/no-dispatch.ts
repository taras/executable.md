import { Component, Plugin } from "@executablemd/core/api";
import { Agent } from "@executablemd/agent/api";

export default Plugin({
  name: "test://joined-response-no-dispatch",
  *install() {
    yield* Agent.around({
      *prompt() {
        throw new Error("ForbiddenReconciliationPrompt");
      },
    });
    yield* Component.around({
      *expand([request], next) {
        if (
          [
            "Ticket.Step",
            "Ticket.Continue",
            "Ticket.SelectModel",
            "Phase.Run",
            "Phase.Role",
            "Prompt",
          ].includes(request.expansion.name)
        ) {
          throw new Error("ForbiddenReconciliationDispatch: " + request.expansion.name);
        }
        yield* next(request);
      },
    });
    return undefined;
  },
});
