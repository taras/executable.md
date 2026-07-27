/**
 * Agent + testing component composition (specs/acp-client-spec.md).
 *
 * Both component sets decorate the same Execution Api; a prompt failure
 * outside a passing <Test> must still surface as the agent aggregate.
 * Lives in the testing package because core cannot depend on testing.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensure } from "effection";
import type { Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { Agent, execute, installAgentComponents } from "@executablemd/core";
import type { AgentPromptEvent, PromptOptions, Session } from "@executablemd/core";
import { installTestingComponents } from "../mod.ts";

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
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: text };
        },
      };
    },
  };
}

describe("agent + testing composition", () => {
  it("both component sets decorate one execution", function* () {
    const calls: string[] = [];
    yield* installTestingComponents();
    yield* installAgentComponents({
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

    const dir = path.join(os.tmpdir(), `xmd-compose-${randomUUID()}`);
    yield* ensureDir(dir);
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(
      docPath,
      [
        "<Testing>",
        '<Test name="prompt works">',
        '  <Prompt text="good" />',
        "</Test>",
        "</Testing>",
        "",
        '<Prompt text="bad" />',
        "",
      ].join("\n"),
    );
    const execution = yield* execute({ path: docPath, stream: new InMemoryStream() });
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
  });
});
