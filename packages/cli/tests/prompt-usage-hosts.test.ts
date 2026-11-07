/**
 * Tier HU — Prompt usage through each concrete host assembly
 * (specs/acp-client-spec.md §Prompt usage).
 *
 * Every row drives the product's own assembly — the agent stack, the Plan
 * writer's dependencies, the REPL profile and its headless wrapper, the
 * workflow Agent profile and the Sidekick's installation — and replaces only
 * the runtime leaf. What each row asserts is the canonical record the history
 * actually retains and reads back, not that a dependency was constructed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream } from "@executablemd/durable-streams";
import { scoped, useScope } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm } from "@effectionx/fs";
import { ensure } from "effection";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { useHostFiles } from "@executablemd/runtime";
import { agentIdentityComponents, collect, retainedSource } from "@executablemd/core";
import type { PromptUsage } from "@executablemd/core";
import { executeInstalled, parsePromptRecord, useAgentConversation } from "@executablemd/core/host";
import { withWorkflowWorkspace } from "@executablemd/workflow/deno";
import type { AcpxProviderDependencies, PromptUsageHost } from "@executablemd/acp";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { AgentStack } from "../src/agent-stack.ts";
import { hostAcpDependencies, installAgentProviderStack } from "../src/agent-stack.ts";
import { planWriterDependencies } from "../src/plan-writer-profile.ts";
import { assembleReplProfile } from "../src/repl-profile.ts";
import { NO_PLUGINS } from "../src/plugin-host.ts";
import { sidekickAssembly } from "../src/repl/sidekick/assembly.ts";
import { useWorkflowAgentProfile } from "../src/workflow-agent.ts";
import { createFakeAcp, makeStore } from "./support/fake-acp.ts";
import type { FakeAcp } from "./support/fake-acp.ts";
import { createRun, useStorageRoot, withStorage } from "./support/workflow-run.ts";
import { records, useHarness } from "./fixtures/repl/issue-883/sidekick-harness.ts";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { sleep } from "effection";

const HOST: PromptUsageHost = { host: "deno-source", xmd: { version: "0.0.0-hosts" } };

const RETAINED = {
  promptMessageId: "message-hosts",
  acpxRecordId: "record-hosts",
  sessionId: "acp-session-hosts",
  response: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
};

function* useRoot(): Operation<string> {
  const root = join(tmpdir(), `xmd-hu-${randomUUID()}`);
  yield* ensureDir(root);
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

function stackAt(root: string, defaultAgent = "claude"): AgentStack {
  const embedded = createEmbeddedAdapters(join(root, "adapters"));
  return {
    provider: "acpx",
    defaultAgent,
    permissionMode: "deny-all",
    adapters: { ...embedded, *materialize() {} },
    sessions: { advertiseNativeLaunch: [], advertiseClientNativeAttachment: [], usage: HOST },
  };
}

/**
 * The controlled native leaf: the scripted runtime, and the child environment it
 * would launch with.
 *
 * The host's own environment fact resolves a real Claude executable from this
 * machine, which a turn served by the scripted runtime never starts. Stating the
 * child environment here keeps the row independent of what the machine has
 * installed, and everything above the leaf is the product's own assembly.
 */
function leaf(stack: AgentStack, fake: FakeAcp): AcpxProviderDependencies {
  return {
    ...hostAcpDependencies(stack),
    createRuntime: fake.create,
    sessionStore: makeStore(),
    // deno-lint-ignore require-yield
    *agentProcessEnv() {
      return { CLAUDE_CODE_EXECUTABLE: CONTROLLED_CLAUDE };
    },
  };
}

/** The controlled native Claude fixture, named but never started by the scripted runtime. */
const CONTROLLED_CLAUDE = fileURLToPath(
  new URL("../../acp/tests/fixtures/fake-claude-cli.cjs", import.meta.url),
);

function usageIn(events: readonly DurableEvent[]): (PromptUsage | undefined)[] {
  return events.flatMap((event) =>
    event.type === "yield" &&
    event.description.type === "agent_prompt" &&
    event.result.status === "ok"
      ? [parsePromptRecord(event.result.value)?.usage]
      : [],
  );
}

function* promptOnce(stream: DurableStream): Operation<void> {
  yield* collect(
    yield* executeInstalled(
      { ...retainedSource("hosts.md", "<Prompt>measure me</Prompt>"), stream },
      [{ components: agentIdentityComponents() }],
    ),
  );
}

function expectRetained(usage: PromptUsage | undefined, adapterVersion: string): void {
  expect(usage?.providerMessageId).toBe("message-hosts");
  expect(usage?.providerRecordId).toBe("record-hosts");
  expect(usage?.provenance.host).toBe("deno-source");
  expect(usage?.provenance.xmd).toEqual({ version: "0.0.0-hosts" });
  expect(usage?.provenance.adapter.version).toBe(adapterVersion);
  expect(usage?.readings[0]).toEqual({
    source: "response",
    scope: adapterVersion === "0.70.0" ? "main-loop" : "last-request",
    kind: "tokens",
    counter: adapterVersion === "0.70.0" ? "turn-total" : "snapshot",
    tokens: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
  });
}

describe("Tier HU — Prompt usage through the host assemblies", () => {
  it("HU1: an ordinary run's agent stack retains usage in the run's own history", function* () {
    yield* useHostFiles();
    const root = yield* useRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const stack = stackAt(root);
      yield* installAgentProviderStack(stack, leaf(stack, fake));
      yield* promptOnce(stream);
    });
    const [usage] = usageIn(yield* stream.readAll());
    expectRetained(usage, "0.70.0");
  });

  it("HU2: the Plan writer's dependencies retain usage the same way", function* () {
    yield* useHostFiles();
    const root = yield* useRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const stack = stackAt(root);
      const host = yield* useScope();
      yield* installAgentProviderStack(
        stack,
        planWriterDependencies({ stack, acp: leaf(stack, fake) }, root, host),
      );
      yield* promptOnce(stream);
    });
    expectRetained(usageIn(yield* stream.readAll())[0], "0.70.0");
  });

  it("HU3: the REPL profile, through its headless wrapper, retains usage", function* () {
    yield* useHostFiles();
    const root = yield* useRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const stack = stackAt(root);
      yield* assembleReplProfile(stack, NO_PLUGINS, {
        acp: leaf(stack, fake),
        planWriterRoot: join(root, "plans"),
      });
      yield* promptOnce(stream);
    });
    expectRetained(usageIn(yield* stream.readAll())[0], "0.70.0");
  });

  it("HU4: the Sidekick's held conversation retains usage through its own assembly", function* () {
    yield* useHostFiles();
    const root = yield* useRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    const history = new InMemoryStream();
    const stack = stackAt(root);
    const assembly = sidekickAssembly("claude", leaf(stack, fake));
    const answered = yield* scoped(function* () {
      const opened = yield* useAgentConversation({
        history,
        id: "sidekick-usage",
        agent: "claude",
        installations: assembly.installations,
      });
      if (!opened.ok) {
        throw opened.error;
      }
      return yield* opened.value.prompt("measure me");
    });
    expect(answered.ok ? "ok" : answered.error.message).toBe("ok");
    expectRetained(usageIn(yield* history.readAll())[0], "0.70.0");
  });

  it("HU5: the workflow Agent profile retains usage in the run's journal", function* () {
    yield* useHostFiles();
    const root = yield* useStorageRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      yield* withWorkflowWorkspace(
        database,
        scoped(function* () {
          return yield* collect(
            yield* executeInstalled(
              {
                ...retainedSource(
                  "workflows/usage.md",
                  '<Session name="review"><Prompt>measure me</Prompt></Session>',
                ),
                stream: database.journal,
              },
              [{ components: [...agentIdentityComponents()] }],
            ),
          );
        }),
        {
          agent: (attachment) =>
            useWorkflowAgentProfile({
              // deno-lint-ignore require-yield
              agentProcessEnv: function* () {
                return undefined;
              },
              root,
              attachment,
              defaultAgent: "codex",
              sessionStore: makeStore(),
              createRuntime: fake.create,
              adapters: { ...createEmbeddedAdapters(join(root, "adapters")), *materialize() {} },
              promptUsageHost: HOST,
            }),
        },
      );
      expectRetained(usageIn(yield* database.journal.readAll())[0], "1.6.2");
    });
  });

  it("HU6: a host that states no usage facts collects none, and runs the same turn", function* () {
    yield* useHostFiles();
    const root = yield* useRoot();
    const fake = createFakeAcp();
    fake.script({ reply: "ok", usage: RETAINED });
    const stream = new InMemoryStream();
    yield* scoped(function* () {
      const stack: AgentStack = {
        ...stackAt(root),
        sessions: { advertiseNativeLaunch: [], advertiseClientNativeAttachment: [] },
      };
      yield* installAgentProviderStack(stack, leaf(stack, fake));
      yield* promptOnce(stream);
    });
    expect(usageIn(yield* stream.readAll())).toEqual([undefined]);
  });

  it("HU7: a REPL entry retains usage through the entry publisher, and the Sidekick through its owner", function* () {
    yield* useHostFiles();
    const held = yield* useHarness(undefined, { promptUsageHost: HOST });
    held.fake.script({ reply: "entry answered", usage: RETAINED });
    const entry = yield* held.session.submit(
      '<Session name="planner"><Prompt text="measure the entry" /></Session>\n',
    );
    expect(entry.ok ? "ok" : entry.error.message).toBe("ok");
    const entryUsage = yield* settledUsage(() => held.execution.stream.readAll());
    expect(entryUsage.length).toBe(1);
    // The scripted agent has no traced adapter release, so its semantics stay
    // unknown — the retained identities and provenance are the row's subject.
    expect(entryUsage[0]?.providerMessageId).toBe("message-hosts");
    expect(entryUsage[0]?.provenance.host).toBe("deno-source");
    expect(entryUsage[0]?.coverage.limitations).toContain("source-semantics-unknown");

    held.fake.script({
      reply: "<Output>sidekick answered</Output>",
      usage: { ...RETAINED, promptMessageId: "message-sidekick" },
    });
    const turn = yield* held.owner.message("measure the conversation");
    expect(turn.ok ? "ok" : turn.error.message).toBe("ok");
    const chat = yield* settledUsage(function* () {
      return (yield* records(held.execution)).flatMap((one) => {
        if (one.kind !== "event") {
          return [];
        }
        const parsed = parseDurableEvent(one.event);
        return parsed.ok ? [parsed.value] : [];
      });
    });
    expect(chat.map((usage) => usage?.providerMessageId)).toEqual(["message-sidekick"]);
    expect(chat[0]?.provenance.host).toBe("deno-source");
  });
});

/** The usage each retained Prompt carries, once a history holds at least one. */
function* settledUsage(
  read: () => Operation<readonly DurableEvent[]>,
): Operation<(PromptUsage | undefined)[]> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const found = usageIn(yield* read());
    if (found.length > 0) {
      return found;
    }
    yield* sleep(10);
  }
  throw new Error("no Prompt was retained");
}
