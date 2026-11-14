import { createAcpxProvider } from "@executablemd/acp";
import { registerAgentProvider } from "@executablemd/core";
import { Plugin } from "@executablemd/core/api";
import {
  createFakeAcp,
  makeRegistry,
  makeStore,
} from "../../../packages/cli/tests/support/fake-acp.ts";

export default Plugin({
  name: "wheel-permission-fixture",
  *install({ command }) {
    if (command !== "repl") {
      return undefined;
    }
    const fixture = createFakeAcp();
    fixture.script({
      requestsTool: Array.from(
        { length: 45 },
        (_, index) => `Permission prose ${String(index).padStart(2, "0")}`,
      ).join("\n"),
      permissionChoices: Array.from({ length: 40 }, (_, index) => ({
        optionId: `allow-${index}`,
        name: `Choice ${String(index).padStart(2, "0")}`,
        kind: index === 39 ? "allow_always" : "allow_once",
      })),
      reply: "Permission prompt completed.",
    });
    yield* registerAgentProvider(
      "wheel-permission-fixture",
      createAcpxProvider({
        createRuntime(options) {
          const runtime = fixture.create(options);
          return {
            ...runtime,
            startTurn(input) {
              const turn = runtime.startTurn(input);
              return {
                ...turn,
                // The adapter reports only a decision kind, so Choice 39 has the unique kind.
                result: turn.result.then((outcome): Awaited<typeof turn.result> => {
                  if (outcome.status !== "completed") {
                    return outcome;
                  }
                  if (
                    fixture.prompts.length !== 1 ||
                    fixture.decisions.length !== 1 ||
                    fixture.decisions[0] !== "allow_always"
                  ) {
                    return {
                      status: "failed",
                      error: {
                        message:
                          "Expected one prompt and exactly one decision selecting Choice 39.",
                      },
                    };
                  }
                  return outcome;
                }),
              };
            },
          };
        },
        agentRegistry: makeRegistry({ fixture: "wheel-permission" }),
        sessionStore: makeStore(),
      }),
    );
    return undefined;
  },
});
