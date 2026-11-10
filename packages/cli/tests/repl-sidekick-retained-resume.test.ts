/**
 * A Sidekick conversation reopened under a different adapter command (#1221).
 *
 * A release can change the command an agent resolves to — the bundled Codex
 * adapter became the host-installed one — while every saved Sidekick chat still
 * names the native conversation it was having. Reopening continues that
 * conversation through today's adapter. What must not move with it is what the
 * Sidekick decides about every turn: no provider tools, no MCP servers, every
 * native permission request denied in the provider without asking anybody, and
 * the model and effort this turn asked for applied and read back.
 *
 * The production assembly over the canonical conversation, with the scripted
 * runtime standing where the agent process would be. The subprocess and the
 * real ACPX runtime are `packages/acp/tests/host-conversation.test.ts` HR1/HR2.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { Agent } from "@executablemd/core";
import { useAgentConversation } from "@executablemd/core/host";
import type { AgentConversation, ExecutionInstallation } from "@executablemd/core/host";

import { sidekickAssembly } from "../src/repl/sidekick/assembly.ts";
import { createFakeAcp, makeRegistry, makeStore } from "./support/fake-acp.ts";
import type { FakeAcp, FakeStore, ScriptedConfiguration } from "./support/fake-acp.ts";
import { useTemporary } from "./fixtures/repl/issue-883/sidekick-harness.ts";

const AGENT = "scripted-sidekick";

/** What the scripted agent offers, so a turn has something real to ask for. */
const OFFERED: ScriptedConfiguration = {
  model: {
    selected: "balanced",
    choices: [{ id: "balanced" }, { id: "fast" }],
  },
  effort: {
    balanced: { selected: "medium", choices: [{ id: "medium" }] },
    fast: { selected: "low", choices: [{ id: "low" }, { id: "high" }] },
  },
};

/** The command's own Sidekick assembly, over one release's adapter command. */
function sidekick(fake: FakeAcp, store: FakeStore, command: string, cwd: string) {
  return sidekickAssembly(AGENT, {
    createRuntime: fake.create,
    sessionStore: store,
    agentRegistry: makeRegistry({ [AGENT]: command }),
    // deno-lint-ignore require-yield
    *agentCwd() {
      return cwd;
    },
  });
}

/** Open the Sidekick's conversation over this history, run `body`, and close it. */
function conversing<T>(
  history: InMemoryStream,
  installations: readonly ExecutionInstallation[],
  body: (chat: AgentConversation) => Operation<T>,
): Operation<Result<T>> {
  return scoped(function* () {
    const opened = yield* useAgentConversation({
      history,
      id: "sidekick-chat",
      agent: AGENT,
      installations,
    });
    if (!opened.ok) {
      return opened;
    }
    return Ok(yield* body(opened.value));
  });
}

describe("Sidekick retained resume through a changed adapter command", () => {
  it("keeps the Sidekick's own tools, permissions and configuration under today's adapter", function* () {
    const cwd = yield* useTemporary("xmd-sidekick-resume-");
    const fake = createFakeAcp();
    const store = makeStore();
    const history = new InMemoryStream();

    fake.script({ reply: "one" });
    const first = yield* conversing(
      history,
      sidekick(fake, store, "sidekick-cmd", cwd).installations,
      (chat) => chat.prompt("first"),
    );
    expect(first).toEqual(Ok(Ok("one")));
    const original = fake.ensured.at(-1)?.sessionKey;
    if (original === undefined) {
      throw new Error("the first turn established no session");
    }

    // Public middleware that would allow anything it is asked. The Sidekick's
    // strict routing means it is never asked.
    const consulted: string[] = [];
    const permissive: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* Agent.around(
          {
            // deno-lint-ignore require-yield
            *requestPermission() {
              consulted.push("asked");
              return { outcome: "selected", optionId: "allow" };
            },
          },
          { at: "max" },
        );
      },
    };
    const ensured = fake.ensured.length;
    const created = fake.created.length;
    fake.configuration(OFFERED);
    // The agent asks to run a native tool, then reports success anyway.
    fake.script({ requestsTool: "rm -rf build", reply: "done" });
    const second = yield* conversing(
      history,
      [...sidekick(fake, store, "sidekick-next-cmd", cwd).installations, permissive],
      (chat) => chat.prompt("second", { model: "fast", effort: "high" }),
    );

    // The native request was denied in the provider and failed its turn,
    // whatever the backend then said, and nobody else was asked.
    if (!second.ok) {
      throw second.error;
    }
    expect(second.value.ok).toBe(false);
    expect(!second.value.ok && second.value.error.message).toContain("grants to no agent");
    expect(consulted).toEqual([]);
    expect(fake.decisions).toEqual(["reject_once"]);

    // The same conversation, reached through today's command: its own record,
    // reopened by its ACP target, and nothing created in its place.
    const reopened = fake.ensured.slice(ensured);
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.every((one) => one.sessionKey === original)).toBe(true);
    expect(reopened[0]?.resumeSessionId).toBe(`acp:${original}`);
    expect(store.records.get(original)?.agentCommand).toBe("sidekick-next-cmd");
    expect(fake.prompts).toEqual(["first", "second"]);

    // Constructed under the Sidekick's constraints, stated rather than left to
    // the agent's defaults.
    for (const options of fake.created.slice(created)) {
      expect(options.mcpServers).toEqual([]);
      expect(options.permissionMode).toBe("deny-all");
      expect(options.nonInteractivePermissions).toBe("deny");
    }
    expect(reopened.every((one) => JSON.stringify(one.sessionOptions?.allowedTools) === "[]")).toBe(
      true,
    );

    // This turn's model and effort were written and read back before it ran.
    const writes = fake.configCalls.filter((call) => call.startsWith("set "));
    expect(writes).toContain("set model=fast");
    expect(writes).toContain("set effort=high");
    expect(fake.configCalls.at(-1)).toBe("status");
    expect(fake.running(original)).toEqual({ model: "fast", effort: "high" });
  });
});
