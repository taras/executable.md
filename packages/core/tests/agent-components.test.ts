/**
 * Tier AC — agent component tests (specs/acp-client-spec.md).
 *
 * Exercises the agent components end to end against a stub root provider:
 * prompt input selection, scoping and overrides, failure semantics and
 * completion aggregation, and journal replay. The stub is installed through
 * `installAgentComponents`'s `rootProvider` seam — no real provider,
 * subprocess, or provider selection.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensure, scoped } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { executeInstalled } from "../host.ts";
import { agentIdentityComponents } from "../src/agent/components.ts";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent, PromptOptions, Session } from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import { readCompletedPrompts } from "../src/agent/journal.ts";
import type { AgentProviderFactory } from "../src/agent/provider-api.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import { Component } from "../src/component-api.ts";
import type { Json } from "@executablemd/core";

interface StubResponse {
  status?: "completed" | "failed" | "cancelled";
  stopReason?: string;
  deltas?: string[];
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
  /** Root-provider factory invocations — one per live (non-replay) execution. */
  factoryActivations: number;
}

function createStubProvider(respond?: (content: string) => StubResponse): Stub {
  const stub: Stub = {
    promptCalls: [],
    agentProbes: [],
    factoryActivations: 0,
    factory: function* (options) {
      stub.factoryActivations++;
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *agent([name]) {
            const resolved = name ?? options.defaultAgent;
            stub.agentProbes.push(resolved);
            return resolved;
          },
          // deno-lint-ignore require-yield
          *session([routed]) {
            // A `<Session>` element routes a placement rather than a bare
            // string: the descriptive name is on it, and the engine identity is
            // reachable only through provider authority. A stub provider reads
            // the name exactly as a real one does.
            const name = typeof routed === "string" ? routed : routed?.name;
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
      return {
        // deno-lint-ignore require-yield
        *next() {
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
  yield* installAgentComponents({
    rootProvider: {
      factory: stub.factory,
      options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
    },
  });
}

function* runDoc(
  doc: string,
  stream: InMemoryStream,
): Operation<{ output: string; result: Result<Json> }> {
  const dir = path.join(os.tmpdir(), `xmd-ac-test-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));

    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    // `<Session>` names durable work after its own invocation, so the host
    // declares it to the execution rather than registering it.
    const execution = yield* executeInstalled({ path: docPath, stream }, [
      { components: agentIdentityComponents() },
    ]);
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { output: next.value, result };
  });
}

describe("Tier AC — agent components", () => {
  it("AC1: wrapper <Prompt> always sends rendered children, untrimmed", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Prompt text="fallback">\nSay hello\n</Prompt>\n',
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

  it("AC2: empty wrapper children win over the text prop", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { result } = yield* runDoc('<Prompt text="fallback"></Prompt>\n', new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(1);
    expect(stub.promptCalls[0]!.content).toBe("");
  });

  it("AC3: self-closing <Prompt> falls back to the text prop", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc('<Prompt text="hello" />\n', new InMemoryStream());
    expect(result.ok).toBe(true);
    expect(stub.promptCalls[0]!.content).toBe("hello");
    expect(output).toContain("[stub-agent:stub:default:hello]");
  });

  // The printed error is the engine's own now that <Prompt> is an ordinary
  // function component: it names the component and lists the offending prop,
  // where the claimed handler built the same account behind a `<Prompt> `
  // prefix of its own.
  it("AC19: the removed prompt prop is rejected as an unknown prop", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { result } = yield* runDoc('<Prompt prompt="hello" />\n', new InMemoryStream());
    expect(result.ok).toBe(false);
    expect(stub.promptCalls.length).toBe(0);
    const reported = result.ok ? "" : result.error.message;
    expect(reported).toContain("Prop validation failed for <Prompt />");
    expect(reported).toContain("prompt");
  });

  it("AC20: a component's own validation printed error is observed once", function* () {
    const observed: string[] = [];
    const stub = createStubProvider();
    yield* installStub(stub);
    yield* Component.around({
      *raise([error], next) {
        observed.push(error.message);
        return yield* next(error);
      },
    });
    // Written in a region that prints, because what this pins is that the
    // diagnostic is observed once and rendered once — which needs it rendered.
    const { output } = yield* runDoc(
      '<PrintErrors>\n<Prompt prompt="hello" />\n</PrintErrors>\n',
      new InMemoryStream(),
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain("Prop validation failed for <Prompt />");
    expect(output.match(/<Prompt \/>/g)).toHaveLength(1);
  });

  // The composition the whole component exists for, black box: a value bound by
  // `<Let>`, rendered by `<Json>`, consumed and retained by `<Prompt>`. Import
  // graphs cannot prove authored syntax, so the exact bytes are pinned here.
  it("AC21: <Prompt> sends and retains exactly what <Json> rendered", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const stream = new InMemoryStream();
    const { result } = yield* runDoc(
      '<Let as="schema" value={{ type: "object", required: ["bump"] }} />\n\n' +
        "<Prompt>before<Json value={schema} />after</Prompt>\n",
      stream,
    );
    expect(result.ok).toBe(true);

    const expected = 'before{\n  "type": "object",\n  "required": [\n    "bump"\n  ]\n}after';
    expect(stub.promptCalls.length).toBe(1);
    // Two-space JSON, the authored bytes on either side, and no newline of its
    // own between them.
    expect(stub.promptCalls[0]!.content).toBe(expected);

    const events = yield* stream.readAll();
    const prompts = events.filter(
      (event) => event.type === "yield" && event.description.type === "agent_prompt",
    );
    expect(prompts.length).toBe(1);
    const entry = prompts[0]!;
    if (entry.type === "yield") {
      // `<Prompt>` still owns its own record, holding the text it consumed.
      expect(entry.description.input).toBe(expected);
    }
  });

  it("AC4: as binding captures the response instead of emitting it", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const { output, result } = yield* runDoc(
      '<Prompt text="hi" as="answer" />\n\nCaptured: {answer}\n',
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
      '    <Prompt text="one" />',
      "  </Session>",
      "</Agent>",
      "",
      '<Prompt text="two" agent="agent-three" session="named" timeout="500ms" />',
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
      '<Prompt text="first-fail" />',
      "",
      '<Prompt text="ok" />',
      "",
      '<Prompt text="second-fail" />',
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
      '<Prompt text="boom" throwOnError />\n\nnever reached\n',
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

  it("AC10: replay returns recorded results without contacting the provider", function* () {
    const stub = createStubProvider((content) =>
      content.includes("bad") ? { status: "failed", stopReason: "max_tokens" } : {},
    );
    yield* installStub(stub);
    const stream = new InMemoryStream();
    const doc = '<Prompt text="good" />\n\n<Prompt text="bad" />\n';

    const first = yield* runDoc(doc, stream);
    expect(first.result.ok).toBe(false);
    const callsAfterFirst = stub.promptCalls.length;
    const activationsAfterFirst = stub.factoryActivations;
    expect(callsAfterFirst).toBe(2);
    expect(activationsAfterFirst).toBe(1);

    const second = yield* runDoc(doc, stream);
    // Full replay never enters the provider: no factory setup, no availability
    // check, no prompt operation — both counts stay put.
    expect(stub.promptCalls.length).toBe(callsAfterFirst);
    expect(stub.factoryActivations).toBe(activationsAfterFirst);
    expect(second.output).toBe(first.output);
    expect(second.result.ok).toBe(false);
    if (!second.result.ok) {
      expect(second.result.error).toBeInstanceOf(AggregateError);
      if (second.result.error instanceof AggregateError) {
        expect(second.result.error.message).toBe("1 agent prompt(s) failed");
      }
    }
  });

  it("AC14: prompts inside <Each> keep distinct durable identities across replay", function* () {
    const stub = createStubProvider();
    yield* installStub(stub);
    const stream = new InMemoryStream();
    const doc = '<Each in={[1, 2]} let="n">\n<Prompt>iteration {n}</Prompt>\n</Each>\n';

    const first = yield* runDoc(doc, stream);
    expect(first.result.ok).toBe(true);
    expect(stub.promptCalls.length).toBe(2);
    expect(stub.promptCalls.map((call) => call.content)).toEqual(["iteration 1", "iteration 2"]);

    const second = yield* runDoc(doc, stream);
    expect(second.output).toBe(first.output);
    expect(stub.promptCalls.length).toBe(2);
  });

  it("AC15: journal entries carry the full prompt record", function* () {
    const stub = createStubProvider(() => ({
      status: "failed",
      stopReason: "max_tokens",
      deltas: ["partial"],
    }));
    yield* installStub(stub);
    const stream = new InMemoryStream();
    yield* runDoc('<Prompt text="describe" />\n', stream);

    const events = yield* stream.readAll();
    const prompts = events.filter(
      (event) => event.type === "yield" && event.description.type === "agent_prompt",
    );
    expect(prompts.length).toBe(1);
    const entry = prompts[0]!;
    if (entry.type === "yield") {
      expect(entry.description.name).toMatch(/^prompt:.*#0$/);
      expect(entry.description.input).toBe("describe");
      expect(entry.result.status).toBe("ok");
      if (entry.result.status === "ok") {
        expect(entry.result.value).toMatchObject({
          sequence: 0,
          agent: "stub-agent",
          sessionKey: "stub:default",
          status: "failed",
          stopReason: "max_tokens",
          text: "partial",
        });
      }
    }
  });

  it("AC17: throwOnError failures journal a raised marker; plain failures do not", function* () {
    const stub = createStubProvider((content) =>
      content.includes("boom") ? { status: "failed", stopReason: "refusal" } : {},
    );
    yield* installStub(stub);
    const stream = new InMemoryStream();
    yield* runDoc('<Prompt text="plain-boom" />\n', stream);

    const events = yield* stream.readAll();
    const plain = events.find(
      (event) => event.type === "yield" && event.description.type === "agent_prompt",
    );
    if (plain && plain.type === "yield" && plain.result.status === "ok") {
      const value = plain.result.value;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        expect(value.raised).toBe(undefined);
      }
    }

    const thrown = new InMemoryStream();
    yield* runDoc('<Prompt text="boom" throwOnError />\n', thrown);
    const thrownEvents = yield* thrown.readAll();
    const raisedEntry = thrownEvents.find(
      (event) => event.type === "yield" && event.description.type === "agent_prompt",
    );
    expect(raisedEntry).toBeDefined();
    if (raisedEntry && raisedEntry.type === "yield" && raisedEntry.result.status === "ok") {
      const value = raisedEntry.result.value;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        expect(value.raised).toBe(true);
      }
    }
  });

  it("AC18: full replay omits raised failures from aggregate restoration", function* () {
    const stream = new InMemoryStream();
    yield* stream.append({
      type: "yield",
      coroutineId: "root.0",
      description: { type: "agent_prompt", name: "prompt:doc.md:1:1#0", input: "a" },
      result: {
        status: "ok",
        value: {
          sequence: 0,
          agent: "a1",
          sessionKey: "s1",
          status: "failed",
          stopReason: "refusal",
          text: "",
          error: { message: "nope" },
          raised: true,
        },
      },
    });
    yield* stream.append({
      type: "yield",
      coroutineId: "root.1",
      description: { type: "agent_prompt", name: "prompt:doc.md:2:1#0", input: "b" },
      result: {
        status: "ok",
        value: {
          sequence: 1,
          agent: "a1",
          sessionKey: "s1",
          status: "failed",
          text: "",
          error: { message: "kept" },
        },
      },
    });
    yield* stream.append({
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: "" },
    });

    const records = yield* readCompletedPrompts(stream);
    expect(records).toBeDefined();
    if (records) {
      // The raised record is omitted; the older record without the
      // marker parses as not raised and is restored.
      expect(records.length).toBe(1);
      expect(records[0]!.error?.message).toBe("kept");
      expect(records[0]!.raised).toBe(undefined);
    }
  });
});
