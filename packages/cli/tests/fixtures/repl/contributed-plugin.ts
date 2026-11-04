import { createContext, ensure, sleep } from "effection";
import type { Operation } from "effection";
import { content, contributeDocumentation, formDispatcher } from "@executablemd/core";
import { AgentConversationProvider, Plugin } from "@executablemd/core/api";
import type { ReplPluginInstallation } from "../../../api.ts";
import { createDurableOperation } from "@executablemd/durable-streams";

const State = createContext<{ calls: number }>("test.contributed-plugin.state");
export interface Contributions {
  initialized: number;
  conversations: number;
  closed: number;
  calls: string[];
  beforeBody?(): Operation<void>;
  cleanup?(): Operation<void>;
}

/** A selected Plugin with one dual-form declaration and one authored-only name. */
export function contributedPlugin(counts: Contributions) {
  return Plugin({
    name: "contribution-witness",
    *install(): Operation<ReplPluginInstallation> {
      yield* contributeDocumentation(function* () {
        yield* sleep(0);
        return {
          source: {
            owner: "test://contributed",
            asset: "contributed.md",
            text: "## Contributed\nRead or edit this session's value.\n\n## Authored\nRead the authored-only value.\n",
          },
          supplies: new Set(["Contributed", "Authored"]),
        };
      });
      return {
        repl: {
          *initialize() {
            counts.initialized++;
            yield* State.set({ calls: 0 });
          },
          *sidekick() {
            counts.conversations++;
            yield* ensure(() => {
              counts.closed++;
            });
            const provider = yield* AgentConversationProvider.expect();
            if (provider === undefined) {
              throw new Error("Missing conversation provider");
            }
            yield* AgentConversationProvider.set({
              agent: provider.agent.bind(provider),
              session: provider.session.bind(provider),
              options: provider.options.bind(provider),
              prompt: (text, options) =>
                provider.prompt(text + "\ncontribution-conversation", options),
            });
          },
          components: [
            {
              name: "Contributed",
              origin: "test://contributed",
              props: { type: "object", properties: {}, additionalProperties: false },
              returns: {
                type: "object",
                properties: { count: { type: "integer" }, form: { type: "string" } },
                required: ["count", "form"],
                additionalProperties: false,
              },
              generated: {
                "self-closing": {
                  identity: "https://executable.md/test/contributed/read",
                  effect: "read",
                },
                paired: {
                  identity: "https://executable.md/test/contributed/write",
                  effect: "write",
                },
              },
              factory(claim) {
                const body = (form: string) =>
                  function* (
                    _props: unknown,
                    invocation: Parameters<typeof claim>[0],
                  ): Operation<unknown> {
                    const name = yield* claim(invocation);
                    if (counts.cleanup !== undefined) {
                      yield* ensure(counts.cleanup);
                    }
                    if (counts.beforeBody !== undefined) {
                      yield* counts.beforeBody();
                    }
                    if (form === "write") {
                      yield* content();
                    }
                    return yield createDurableOperation(
                      { type: "contributed", name },
                      function* () {
                        const state = yield* State.expect();
                        state.calls++;
                        counts.calls.push(form);
                        return { count: state.calls, form };
                      },
                    );
                  };
                return formDispatcher({
                  forms: "both",
                  "self-closing": body("read"),
                  paired: body("write"),
                });
              },
            },
            {
              name: "Authored",
              origin: "test://contributed",
              props: { type: "object", properties: {}, additionalProperties: false },
              factory: () =>
                function* () {
                  return (yield* State.expect()).calls;
                },
            },
          ],
        },
      };
    },
  });
}
