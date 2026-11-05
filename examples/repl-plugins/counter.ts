import { createContext } from "effection";
import type { Operation } from "effection";
import { contributeDocumentation, packageDocumentation } from "@executablemd/core";
import { AgentConversationProvider, Plugin } from "@executablemd/core/api";
import type { ReplPluginInstallation } from "@executablemd/cli/api";

const Counter = createContext<{ count: number }>("example.repl.counter");

export default Plugin({
  name: "example-counter",
  *install(): Operation<ReplPluginInstallation> {
    yield* contributeDocumentation(function* (read) {
      return yield* packageDocumentation(
        new URL("./counter.md", import.meta.url),
        {
          owner: "example-counter",
          asset: "counter.md",
        },
        ["Counter"],
        read,
      );
    });
    return {
      repl: {
        *initialize() {
          yield* Counter.set({ count: 0 });
        },
        components: [
          {
            name: "Counter",
            origin: "example-counter",
            props: { type: "object", properties: {}, additionalProperties: false },
            returns: { type: "integer" },
            description: 'Count visits in this session with `<Counter as="visits" />`.',
            factory: () =>
              function* () {
                const state = yield* Counter.expect();
                return ++state.count;
              },
          },
        ],
        *sidekick() {
          const state = yield* Counter.expect();
          const provider = yield* AgentConversationProvider.expect();
          if (provider === undefined) {
            throw new Error("Counter requires a conversation provider");
          }
          yield* AgentConversationProvider.set({
            agent: provider.agent.bind(provider),
            session: provider.session.bind(provider),
            options: provider.options.bind(provider),
            prompt: (text, options) =>
              provider.prompt(`${text}\nSession counter: ${state.count}`, options),
          });
        },
      },
    };
  },
});
