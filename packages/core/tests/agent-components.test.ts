/**
 * Tier AC — agent component tests (specs/acp-client-spec.md).
 *
 * Exercises the agent vocabulary end to end against a stub provider:
 * prompt input selection, scoping and overrides, failure semantics and
 * completion aggregation, permission policies, and journal replay.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Operation, Result, Stream } from "effection";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type {
  AgentPromptEvent,
  PermissionOutcome,
  PromptOptions,
  Session,
} from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import { registerAgentProvider } from "../src/agent/provider-api.ts";
import type { AgentProviderFactory } from "../src/agent/provider-api.ts";
import { installAgentVocabulary } from "../src/agent/vocabulary.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmd-ac-test-"));
}

interface StubResponse {
  status?: "completed" | "failed" | "cancelled";
  stopReason?: string;
  deltas?: string[];
  requestPermission?: boolean;
}

interface StubPromptCall {
  content: string;
  agent: string;
  sessionKey: string;
  timeout?: number;
}

interface Stub {
  factory: AgentProviderFactory;
  promptCalls: StubPromptCall[];
  agentProbes: string[];
  permissionOutcomes: PermissionOutcome[];
}

function createStubProvider(respond?: (content: string) => StubResponse): Stub {
  const stub: Stub = {
    promptCalls: [],
    agentProbes: [],
    permissionOutcomes: [],
    factory: function* (options) {
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *agent([name]) {
            const resolved = name ?? options.defaultAgent;
            stub.agentProbes.push(resolved);
            return resolved;
          },
          // deno-lint-ignore require-yield
          *session([name]) {
            return { sessionKey: `stub:${name ?? "default"}`, cwd: "/stub" };
          },
          // deno-lint-ignore require-yield
          *prompt([content, promptOptions]) {
            return createStubStream(stub, options.defaultAgent, content, promptOptions, respond);
          },
        },
        { at: "min" },
      );
    },
  };
  return stub;
}

function createStubStream(
  stub: Stub,
  defaultAgent: string,
  content: string,
  options: PromptOptions | undefined,
  respond?: (content: string) => StubResponse,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      const agent = options?.agent ?? defaultAgent;
      const session: Session =
        typeof options?.session === "object"
          ? options.session
          : {
              sessionKey: `stub:${typeof options?.session === "string" ? options.session : "default"}`,
              cwd: "/stub",
            };
      const call: StubPromptCall = { content, agent, sessionKey: session.sessionKey };
      if (options?.timeout !== undefined) {
        call.timeout = options.timeout;
      }
      stub.promptCalls.push(call);

      const response = respond ? respond(content) : {};
      const status = response.status ?? "completed";
      const deltas = response.deltas ?? [`[${agent}:${session.sessionKey}:${content}]`];
      const events: AgentPromptEvent[] = [{ type: "started", agent, session }];
      for (const text of deltas) {
        events.push({ type: "text_delta", text });
      }
      const terminal: AgentPromptEvent = { type: "terminal", status };
      if (response.stopReason !== undefined) {
        terminal.stopReason = response.stopReason;
      }
      events.push(terminal);

      let index = 0;
      let asked = false;
      return {
        *next() {
          if (response.requestPermission === true && !asked && index === 1) {
            asked = true;
            const outcome = yield* Agent.operations.requestPermission({
              session,
              toolCall: { toolCallId: "tool-1", title: "write file", kind: "edit" },
              options: [
                { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
                { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
                { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
              ],
            });
            stub.permissionOutcomes.push(outcome);
          }
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: deltas.join("") };
        },
      };
    },
  };
}

function* installStub(stub: Stub): Operation<void> {
  yield* installAgentVocabulary({
    defaultAgent: "stub-agent",
    permissionMode: "deny-all",
    rootProvider: {
      factory: stub.factory,
      options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
    },
  });
}

function* runDoc(
  doc: string,
  stream: InMemoryStream,
): Operation<{ output: string; result: Result<string> }> {
  const tmpDir = makeTempDir();
  try {
    const docPath = path.join(tmpDir, "doc.md");
    fs.writeFileSync(docPath, doc);
    const execution = yield* execute({ docPath, stream });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { output: next.value, result };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("Tier AC — agent components", () => {
  it("AC1: wrapper <Prompt> always sends rendered children, untrimmed", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Prompt prompt="fallback">\nSay hello\n</Prompt>\n',
      new InMemoryStream(),
    );
    expect(result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(1);
    const sent = stub.promptCalls[0]!.content;
    expect(sent).toContain("Say hello");
    expect(sent).not.toBe("fallback");
    expect(sent).not.toBe(sent.trim());
    expect(output).toContain("[stub-agent:stub:default:");
  });

  it("AC2: empty wrapper children win over the prompt prop", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { result } = yield* runDoc('<Prompt prompt="fallback"></Prompt>\n', new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(1);
    expect(stub.promptCalls[0]!.content).toBe("");
  });

  it("AC3: self-closing <Prompt> falls back to the prompt prop", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc('<Prompt prompt="hello" />\n', new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls[0]!.content).toBe("hello");
    expect(output).toContain("[stub-agent:stub:default:hello]");
  });

  it("AC4: as binding captures the response instead of emitting it", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Prompt prompt="hi" as="answer" />\n\nCaptured: {answer}\n',
      new InMemoryStream(),
    );
    expect(result.ok).toBe(true);
    expect(output).toContain("Captured: [stub-agent:stub:default:hi]");
    expect(output.indexOf("[stub-agent")).toBe(output.lastIndexOf("[stub-agent"));
  });

  it("AC5: agent and session scopes compose; per-prompt props override", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const doc = [
      '<Agent name="agent-two">',
      '  <Session name="review">',
      '    <Prompt prompt="one" />',
      "  </Session>",
      "</Agent>",
      "",
      '<Prompt prompt="two" agent="agent-three" session="named" timeout="500ms" />',
      "",
    ].join("\n");
    const { result } = yield* runDoc(doc, new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(2);
    expect(stub.promptCalls[0]).toMatchObject({
      content: "one",
      agent: "agent-two",
      sessionKey: "stub:review",
    });
    expect(stub.promptCalls[1]).toMatchObject({
      content: "two",
      agent: "agent-three",
      sessionKey: "stub:named",
      timeout: 500,
    });
  });

  it("AC6: self-closing <Agent> and <Session> validate without output", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Agent name="probe-me" />\n<Session name="warm" />\nplain text\n',
      new InMemoryStream(),
    );
    expect(result.ok).toBe(true);
    expect(stub.agentProbes).toContain("probe-me");
    expect(stub.promptCalls.length).toBe(0);
    expect(output).toContain("plain text");
    expect(output).not.toContain("probe-me");
  });

  it("AC7: failed prompts render partial text, later content runs, completion aggregates in order", function* () {
    const stub = createStubProvider((content) => {
      if (content.includes("first-fail")) {
        return { status: "failed", stopReason: "max_tokens", deltas: ["partial-one "] };
      }
      if (content.includes("second-fail")) {
        return { status: "failed", stopReason: "refusal", deltas: [] };
      }
      return {};
    });
    yield* installStub(stub);
    const doc = [
      '<Prompt prompt="first-fail" />',
      "",
      '<Prompt prompt="ok" />',
      "",
      '<Prompt prompt="second-fail" />',
      "",
      "after all prompts",
      "",
    ].join("\n");
    const { output, result } = yield* runDoc(doc, new InMemoryStream());
    expect(output).toContain("partial-one");
    expect(output).toContain("after all prompts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AggregateError);
      if (result.error instanceof AggregateError) {
        expect(result.error.message).toBe("2 agent prompt(s) failed");
        const [first, second] = result.error.errors;
        expect(first).toBeInstanceOf(AgentPromptError);
        expect(second).toBeInstanceOf(AgentPromptError);
        if (first instanceof AgentPromptError && second instanceof AgentPromptError) {
          expect(first.stopReason).toBe("max_tokens");
          expect(first.agent).toBe("stub-agent");
          expect(first.sessionKey).toBe("stub:default");
          expect(second.stopReason).toBe("refusal");
        }
      }
    }
  });

  it("AC8: throwOnError aborts the document immediately", function* () {
    const stub = createStubProvider(() => ({ status: "failed", stopReason: "refusal" }));
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Prompt prompt="boom" throwOnError />\n\nnever reached\n',
      new InMemoryStream(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AgentPromptError);
      if (result.error instanceof AgentPromptError) {
        expect(result.error.stopReason).toBe("refusal");
      }
    }
    expect(output).not.toContain("never reached");
  });

  it("AC9: base permission denies; <ApproveAll> approves for its body", function* () {
    const stub = createStubProvider(() => ({ requestPermission: true }));
    yield* installStub(stub);
    const doc = [
      '<Prompt prompt="denied" />',
      "",
      "<ApproveAll>",
      '  <Prompt prompt="approved" />',
      "</ApproveAll>",
      "",
    ].join("\n");
    const { result } = yield* runDoc(doc, new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.permissionOutcomes).toEqual([
      { outcome: "selected", optionId: "reject-once" },
      { outcome: "selected", optionId: "allow-once" },
    ]);
  });

  it("AC10: replay returns recorded results without contacting the provider", function* () {
    const stub = createStubProvider((content) =>
      content.includes("bad") ? { status: "failed", stopReason: "max_tokens" } : {},
    );
    yield* installStub(stub);
    const stream = new InMemoryStream();
    const doc = '<Prompt prompt="good" />\n\n<Prompt prompt="bad" />\n';

    const first = yield* runDoc(doc, stream);
    expect(first.result.ok).toBe(false);
    const callsAfterFirst = stub.promptCalls.length;
    expect(callsAfterFirst).toBe(2);

    const second = yield* runDoc(doc, stream);
    expect(stub.promptCalls.length).toBe(callsAfterFirst);
    expect(second.output).toBe(first.output);
    expect(second.result.ok).toBe(false);
    if (!second.result.ok) {
      expect(second.result.error).toBeInstanceOf(AggregateError);
      if (second.result.error instanceof AggregateError) {
        expect(second.result.error.message).toBe("1 agent prompt(s) failed");
      }
    }
  });

  it("AC11: an unknown nested provider fails when its component expands", function* () {
    const stub = createStubProvider();
    yield* installAgentVocabulary({ defaultAgent: "stub-agent", permissionMode: "deny-all" });
    yield* registerAgentProvider("stub", stub.factory);
    const doc = [
      '<AgentProvider name="bogus" defaultAgent="a1">',
      '  <Prompt prompt="unreachable" />',
      "</AgentProvider>",
      "",
      "still renders",
      "",
    ].join("\n");
    const { output, result } = yield* runDoc(doc, new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(output).toContain('Unknown agent provider "bogus"');
    expect(output).toContain("still renders");
    expect(stub.promptCalls.length).toBe(0);
  });

  it("AC12: a registered nested provider scopes prompts to its body", function* () {
    const stub = createStubProvider();
    yield* installAgentVocabulary({ defaultAgent: "unused", permissionMode: "deny-all" });
    yield* registerAgentProvider("stub", stub.factory);
    const doc = [
      '<AgentProvider name="stub" defaultAgent="scoped-agent">',
      '  <Prompt prompt="inside" />',
      "</AgentProvider>",
      "",
    ].join("\n");
    const { result } = yield* runDoc(doc, new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(1);
    expect(stub.promptCalls[0]).toMatchObject({ content: "inside", agent: "scoped-agent" });
  });

  it("AC13: <AgentProvider> without any default agent fails before expanding children", function* () {
    const stub = createStubProvider();
    yield* installAgentVocabulary();
    yield* registerAgentProvider("stub", stub.factory);
    const { result } = yield* runDoc(
      '<AgentProvider name="stub">\n  <Prompt prompt="unreachable" />\n</AgentProvider>\n',
      new InMemoryStream(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no default agent");
    }
    expect(stub.promptCalls.length).toBe(0);
  });
});
