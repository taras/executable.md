/**
 * Agent + testing vocabulary composition (specs/acp-client-spec.md).
 *
 * Both vocabularies decorate the same Execution Api; a prompt failure
 * outside a passing <Test> must still surface as the agent aggregate.
 * Lives in the testing package because core cannot depend on testing.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Result, Stream } from "effection";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Agent, execute, installAgentVocabulary } from "@executablemd/core";
import type { AgentPromptEvent, PromptOptions, Session } from "@executablemd/core";
import { installTestingVocabulary } from "../mod.ts";

function stubStream(
  content: string,
  options: PromptOptions | undefined,
  defaultAgent: string,
  fail: boolean,
  calls: string[],
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      calls.push(content);
      const agent = options?.agent ?? defaultAgent;
      const session: Session = { sessionKey: "stub:default", cwd: "/stub" };
      const text = fail ? "" : `[${agent}:${content}]`;
      const events: AgentPromptEvent[] = [{ type: "started", agent, session }];
      if (text) {
        events.push({ type: "text_delta", text });
      }
      if (fail) {
        events.push({ type: "terminal", status: "failed", stopReason: "refusal" });
      } else {
        events.push({ type: "terminal", status: "completed", stopReason: "end_turn" });
      }
      let index = 0;
      return {
        // deno-lint-ignore require-yield
        *next() {
          if (index < events.length) {
            return { done: false as const, value: events[index++]! };
          }
          return { done: true as const, value: text };
        },
      };
    },
  };
}

describe("agent + testing composition", () => {
  it("both vocabularies decorate one execution", function* () {
    const calls: string[] = [];
    yield* installTestingVocabulary();
    yield* installAgentVocabulary({
      defaultAgent: "stub-agent",
      permissionMode: "deny-all",
      rootProvider: {
        options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
        *factory(options) {
          yield* Agent.around(
            {
              // deno-lint-ignore require-yield
              *agent([name]) {
                return name ?? options.defaultAgent;
              },
              // deno-lint-ignore require-yield
              *session() {
                return { sessionKey: "stub:default", cwd: "/stub" };
              },
              // deno-lint-ignore require-yield
              *prompt([content, promptOptions]) {
                return stubStream(
                  content,
                  promptOptions,
                  options.defaultAgent,
                  content.includes("bad"),
                  calls,
                );
              },
            },
            { at: "min" },
          );
        },
      },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xmd-compose-"));
    try {
      const docPath = path.join(dir, "doc.md");
      fs.writeFileSync(
        docPath,
        [
          "<Testing>",
          '<Test name="prompt works">',
          '  <Prompt prompt="good" />',
          "</Test>",
          "</Testing>",
          "",
          '<Prompt prompt="bad" />',
          "",
        ].join("\n"),
      );
      const execution = yield* execute({ docPath, stream: new InMemoryStream() });
      const subscription = yield* execution.output;
      let next = yield* subscription.next();
      while (!next.done) {
        next = yield* subscription.next();
      }
      const result: Result<string> = yield* execution;

      expect(calls).toEqual(["good", "bad"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AggregateError);
        if (result.error instanceof AggregateError) {
          expect(result.error.message).toBe("1 agent prompt(s) failed");
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
