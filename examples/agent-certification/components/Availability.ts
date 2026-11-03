import { Agent } from "@executablemd/core";
import { Qualification } from "../state.ts";
import { recordCleanup } from "../report.ts";

export default function* Availability() {
  const state = yield* Qualification.expect();
  try {
    yield* Agent.operations.agent(state.configuration.command);
  } catch (error) {
    state.failure = error instanceof Error ? error : new Error("Agent availability failed");
    state.report.exitState = "failed";
    for (const name of ["authentication", "streaming", "completion"] satisfies (
      | "authentication"
      | "streaming"
      | "completion"
    )[]) {
      const row = state.report.capabilities[name];
      if (row.selected) {
        row.outcome = "failure";
        row.reason = "agent-unavailable";
      }
    }
  }
  // Availability releases a disposable native probe before returning. Its
  // settlement supplies no exact native-close evidence, so admission ends here.
  recordCleanup(state.report, true, false);
  return false;
}
