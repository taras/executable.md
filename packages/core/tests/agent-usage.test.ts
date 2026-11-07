/**
 * Tier PU — Prompt usage in Core (specs/acp-client-spec.md §Prompt usage).
 *
 * The retained shape and its reader, the subscription-local receiver the
 * delivered coordinator hands an installed provider, and what the canonical
 * runner keeps of it: authored Prompts and held conversations through the same
 * path, replay without a provider, and direct calls that retain nothing.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, scoped, spawn, withResolvers } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent, PromptOptions, Session } from "../src/agent/agent-api.ts";
import { executeInstalled, useAgentConversation } from "../host.ts";
import type { ExecutionInstallation } from "../host.ts";
import { agentIdentityComponents, installAgentComponents } from "../src/agent/components.ts";
import { registerAgentProvider } from "../src/agent/provider-api.ts";
import type { AgentProviderFactory } from "../src/agent/provider-api.ts";
import type { AgentLaunchCoordinator } from "../src/agent/launch-coordinator.ts";
import { AgentConversationProvider } from "../src/agent/conversation-provider.ts";
import type { AgentSessionRequest } from "../src/agent/session-request.ts";
import type { ProviderSessionConfiguration } from "../src/agent/session-setup.ts";
import {
  completedPromptUsage,
  observePermissionDecisions,
  parsePromptRecord,
  readCompletedPrompts,
} from "../src/agent/journal.ts";
import {
  promptUsageDestination,
  readPromptUsage,
  serializePromptUsage,
} from "../src/agent/usage.ts";
import { createLaunchCoordinator } from "../src/agent/launch-coordinator.ts";
import { registerComponents } from "../src/components/registration.ts";
import type { SecretScanner } from "../src/secrets/scanner.ts";
import type { SecretFinding } from "../src/secrets/findings.ts";
import type { PromptUsage, PromptUsageReporter } from "../src/agent/usage.ts";
import { useSecretDetection, useSecretScannerFactory } from "../src/secrets/policy.ts";
import { attachInputOwner, createInputOwner } from "../src/secrets/inputs.ts";
import { createContext } from "effection";
import { retainablePromptUsage } from "../src/agent/usage.ts";
import { createSecretScanner } from "../src/secrets/scanner.ts";
import type { Json } from "../src/types.ts";

const AGENT = "usage-agent";

/** The constrained configuration a held conversation's provider states. */
const HELD_CONFIGURATION: ProviderSessionConfiguration = Object.freeze({
  providerTools: Object.freeze([]),
  mcpServers: Object.freeze([]),
  permissions: Object.freeze({
    permissionMode: "deny-all",
    routing: "strict",
    nonInteractivePermissions: "deny",
  }),
  systemPrompt: null,
});

/** A complete value, with an explicit zero, a source null and absent counters. */
function sampleUsage(label: string, model = "model-a"): PromptUsage {
  return {
    requestId: `request-${label}`,
    providerRecordId: `record-${label}`,
    providerMessageId: `message-${label}`,
    providerSessionId: `session-${label}`,
    provenance: {
      host: "deno-source",
      xmd: { version: "0.0.0-test", sourceRevision: "abc123" },
      runtime: { version: "0.21.1" },
      adapter: { version: "9.9.9", digest: "sha256:00" },
      native: { version: "1.2.3" },
    },
    readings: [
      {
        source: "response",
        scope: "main-loop",
        kind: "tokens",
        counter: "turn-total",
        tokens: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      },
      {
        source: "quota-total",
        scope: "main-loop",
        kind: "tokens",
        counter: "turn-total",
        tokens: null,
      },
      {
        source: "quota-model",
        scope: "broader-model-work",
        model,
        kind: "tokens",
        counter: "turn-total",
        tokens: { cachedInputTokens: 4, reasoningOutputTokens: 0 },
      },
      {
        source: "update",
        scope: "session",
        kind: "context",
        used: 120,
        size: 1000,
      },
      {
        source: "update",
        scope: "unknown",
        kind: "cost",
        amount: 0.5,
        currency: "USD",
      },
    ],
    coverage: {
      finalReport: "received",
      outerPrompt: "partial",
      limitations: ["fixture-limit"],
    },
  };
}

/** How the stub provider answers one subscribed turn. */
interface TurnPlan {
  /** Report this usage from inside the subscribed turn, before its terminal. */
  usage?: () => PromptUsage | undefined;
  /** The terminal status this turn ends with. */
  status?: "completed" | "failed" | "cancelled";
  /** Hold the turn after it starts until this resolves. */
  hold?: Operation<void>;
  /** Called once the turn's receiver is captured. */
  captured?: (reporter: PromptUsageReporter | undefined) => void;
}

interface StubTrace {
  /** How many times a turn was subscribed: one native turn each. */
  subscriptions: number;
  /** How many receivers were captured. */
  acquisitions: number;
}

function newTrace(): StubTrace {
  return { subscriptions: 0, acquisitions: 0 };
}

/** One cold turn. The plan is chosen per subscription, because each is its own turn. */
function stubTurn(
  content: string,
  options: PromptOptions | undefined,
  coordinator: AgentLaunchCoordinator,
  trace: StubTrace,
  plans: () => TurnPlan,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      trace.subscriptions++;
      const plan = plans();
      let report: PromptUsageReporter | undefined;
      if (coordinator.promptUsage !== undefined) {
        trace.acquisitions++;
        report = yield* coordinator.promptUsage();
      }
      plan.captured?.(report);
      const session: Session =
        typeof options?.session === "object" && options.session !== null
          ? options.session
          : {
              sessionKey: `stub:${options?.session ?? "default"}`,
              cwd: "/stub",
            };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? AGENT, session },
        { type: "text_delta", text: `[${content}]` },
        { type: "terminal", status: plan.status ?? "completed" },
      ];
      let index = 0;
      let held = false;
      return {
        *next() {
          if (index === 1 && plan.hold !== undefined && !held) {
            held = true;
            yield* plan.hold;
          }
          if (index === 2) {
            const usage = plan.usage?.();
            if (usage !== undefined) {
              report?.(usage);
            }
          }
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: `[${content}]` };
        },
      };
    },
  };
}

function stubFactory(trace: StubTrace, plans: () => TurnPlan): AgentProviderFactory {
  return function* (_options, coordinator) {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? AGENT;
        },
        // deno-lint-ignore require-yield
        *session([name]) {
          return {
            sessionKey: `stub:${typeof name === "string" ? name : "default"}`,
            cwd: "/stub",
          };
        },
        // deno-lint-ignore require-yield
        *prompt([content, options]) {
          return stubTurn(content, options, coordinator, trace, plans);
        },
      },
      { at: "min" },
    );
    yield* AgentConversationProvider.set({
      // deno-lint-ignore require-yield
      *agent(name: string): Operation<string> {
        return name;
      },
      *session(request: AgentSessionRequest, agent: string): Operation<Session> {
        const setup = coordinator.sessionSetup(request);
        const authorized = yield* setup.activate("stub", "stub-cmd", HELD_CONFIGURATION);
        if (!authorized.ok) {
          throw authorized.error;
        }
        // Established, as a provider that kept the conversation answers both
        // when it is first opened and when its retained history is reopened.
        return yield* setup.finish(
          { sessionKey: `stub:${request.name ?? agent}`, cwd: "/stub" },
          {
            kind: "existing",
            // deno-lint-ignore require-yield
            *configure(asked) {
              return asked;
            },
          },
        );
      },
      // deno-lint-ignore require-yield
      *options(agent: string) {
        return { agent, model: null, effort: null };
      },
      // deno-lint-ignore require-yield
      *prompt(content: string, options: PromptOptions & { agent: string; session: Session }) {
        return stubTurn(content, options, coordinator, trace, plans);
      },
    });
  };
}

function always(plan: TurnPlan): () => TurnPlan {
  return () => ({ ...plan });
}

function* runDocument(
  doc: string,
  stream: InMemoryStream,
  factory: AgentProviderFactory,
  options: {
    register?: boolean;
    direct?: boolean;
    scanner?: () => SecretScanner;
  } = {},
): Operation<{ result: Result<Json>; events: DurableEvent[] }> {
  const dir = path.join(os.tmpdir(), `xmd-pu-test-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    if (options.register === true) {
      yield* registerAgentProvider("usage-stub", factory);
      yield* installAgentComponents({
        defaultAgent: AGENT,
        permissionMode: "deny-all",
      });
    } else {
      yield* installAgentComponents({
        rootProvider: {
          factory,
          options: { defaultAgent: AGENT, permissionMode: "deny-all" },
        },
      });
    }
    yield* useSecretScannerFactory(options.scanner ?? createSecretScanner);
    if (options.direct === true) {
      yield* registerComponents([
        {
          name: "Direct",
          origin: "test",
          props: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          // A repository component asking the public Api directly: no
          // <Prompt> authors this turn, so nothing may record it.
          *fn() {
            return yield* consume(yield* Agent.operations.prompt("direct", {}));
          },
        },
      ]);
    }
    const execution = yield* executeInstalled(
      {
        path: docPath,
        stream,
        includes: [dir],
      },
      [{ components: agentIdentityComponents() }],
    );
    const output = yield* execution.output;
    let next = yield* output.next();
    while (!next.done) {
      next = yield* output.next();
    }
    return { result: yield* execution, events: yield* stream.readAll() };
  });
}

function promptValues(events: readonly DurableEvent[]): Record<string, unknown>[] {
  return events.flatMap((event) => {
    if (event.type !== "yield" || event.description.type !== "agent_prompt") {
      return [];
    }
    if (event.result.status !== "ok") {
      return [];
    }
    const value = event.result.value;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? [value as Record<string, unknown>]
      : [];
  });
}

function versioned(version: string): PromptUsage {
  const usage = sampleUsage(version);
  return { ...usage, provenance: { ...usage.provenance, xmd: { version } } };
}

function* consume(stream: Stream<AgentPromptEvent, string>): Operation<string> {
  return yield* scoped(function* () {
    const subscription = yield* stream;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return next.value;
  });
}

describe("Tier PU — subscription-local receiver", () => {
  it("PU-B1: a sealed destination ignores reports; an unreadable report keeps only its provenance", function* () {
    const destination = promptUsageDestination();
    destination.report(versioned("first"));
    destination.seal();
    destination.report(versioned("late"));
    expect(destination.reported()?.provenance.xmd.version).toBe("first");

    const broken = promptUsageDestination();
    broken.report({
      ...versioned("broken"),
      readings: [{ bogus: true } as never],
    });
    expect(broken.reported()).toEqual({
      provenance: versioned("broken").provenance,
      readings: [],
      coverage: {
        finalReport: "unavailable",
        outerPrompt: "unknown",
        limitations: ["invalid-usage"],
      },
    });
  });

  it("PU-B2: a cold stream captures nothing; concurrent subscriptions keep their own receivers", function* () {
    const trace = newTrace();
    const firstCaptured = withResolvers<void>();
    const firstRelease = withResolvers<void>();
    const receivers: (PromptUsageReporter | undefined)[] = [];
    const plans: TurnPlan[] = [
      {
        captured: (report) => {
          receivers.push(report);
          firstCaptured.resolve();
        },
        hold: firstRelease.operation,
        usage: () => versioned("first"),
      },
      {
        captured: (report) => receivers.push(report),
        usage: () => versioned("second"),
      },
    ];
    yield* scoped(function* () {
      yield* observePermissionDecisions();
      const coordinator = createLaunchCoordinator({}, () => []);
      yield* stubFactory(trace, () => plans.shift() ?? {})(
        { defaultAgent: AGENT, permissionMode: "deny-all" },
        coordinator,
      );
      const cold = yield* Agent.operations.prompt("twice", {});
      // Wrapping and obtaining the stream starts nothing and captures nothing.
      expect(trace.acquisitions).toBe(0);
      expect(trace.subscriptions).toBe(0);

      const first = yield* spawn(() => consume(cold));
      yield* firstCaptured.operation;
      expect(yield* consume(cold)).toBe("[twice]");
      // The second subscription has ended: its receiver is inert, and the
      // first — still running — is unaffected by that teardown.
      receivers[1]?.(versioned("late"));
      firstRelease.resolve();
      expect(yield* first).toBe("[twice]");
      expect(receivers.length).toBe(2);
      expect(receivers[0]).not.toBe(receivers[1]);

      // Two native turns through one stream: no canonical owner, so the
      // association stays an explicit gap rather than the last report.
      const canonical = yield* completedPromptUsage(cold);
      expect(canonical?.readings).toEqual([]);
      expect(canonical?.coverage.limitations).toEqual(["association-ambiguous"]);
      expect(canonical?.provenance.xmd.version).toBe("first");
    });
    expect(trace.subscriptions).toBe(2);
    expect(trace.acquisitions).toBe(2);
  });

  it("PU-B3: a direct Agent.prompt() gets an ephemeral receiver and lends nothing to the next Prompt", function* () {
    const trace = newTrace();
    const receivers: (PromptUsageReporter | undefined)[] = [];
    const plans: TurnPlan[] = [
      {
        usage: () => versioned("direct"),
        captured: (report) => receivers.push(report),
      },
      { captured: (report) => receivers.push(report) },
      {
        usage: () => versioned("canonical"),
        captured: (report) => receivers.push(report),
      },
    ];
    const { result, events } = yield* runDocument(
      "<Direct />\n\n<Prompt>silent</Prompt>\n\n<Prompt>measured</Prompt>\n",
      new InMemoryStream(),
      stubFactory(trace, () => plans.shift() ?? {}),
      { direct: true },
    );
    expect(result.ok).toBe(true);
    expect(receivers.length).toBe(3);
    expect(receivers[0]).not.toBe(undefined);
    // The direct call's turn reported, and no record exists for it; the
    // adjacent Prompt that reported nothing retains nothing; the one that did
    // retains its own.
    const records = promptValues(events);
    expect(records.length).toBe(2);
    expect(Object.hasOwn(records[0], "usage")).toBe(false);
    expect(parsePromptRecord(records[1])?.usage?.provenance.xmd.version).toBe("canonical");
  });

  it("PU-B4: a registered provider's delivered coordinator keeps the optional receiver", function* () {
    const trace = newTrace();
    const { result, events } = yield* runDocument(
      '<AgentProvider name="usage-stub">\n\n<Prompt>one</Prompt>\n\n</AgentProvider>\n',
      new InMemoryStream(),
      stubFactory(trace, always({ usage: () => versioned("registered") })),
      { register: true },
    );
    expect(result.ok).toBe(true);
    expect(trace.acquisitions).toBe(1);
    expect(parsePromptRecord(promptValues(events)[0])?.usage?.provenance.xmd.version).toBe(
      "registered",
    );
  });
});

describe("Tier PU — canonical retention and replay", () => {
  it("PU-P1: an authored Prompt retains usage, and a completed replay restores it without a turn", function* () {
    const stream = new InMemoryStream();
    const live = newTrace();
    const first = yield* runDocument(
      "<Prompt>one</Prompt>\n",
      stream,
      stubFactory(live, always({ usage: () => sampleUsage("one") })),
    );
    expect(first.result.ok).toBe(true);
    const recorded = promptValues(first.events);
    expect(recorded.length).toBe(1);
    expect(parsePromptRecord(recorded[0])?.usage).toEqual(sampleUsage("one"));

    const replayTrace = newTrace();
    const again = yield* runDocument(
      "<Prompt>one</Prompt>\n",
      stream,
      stubFactory(replayTrace, always({ usage: () => versioned("refreshed") })),
    );
    expect(again.result.ok).toBe(true);
    expect(replayTrace.subscriptions).toBe(0);
    expect(replayTrace.acquisitions).toBe(0);
    expect(again.events.length).toBe(first.events.length);
    const restored = yield* readCompletedPrompts(stream);
    expect(restored?.map((record) => record.usage)).toEqual([sampleUsage("one")]);
  });

  it("PU-P2: an acknowledged failed turn keeps what it reported, and no checkpoint", function* () {
    const failing = sampleUsage("failed");
    const partial: PromptUsage = {
      ...failing,
      coverage: {
        finalReport: "unavailable",
        outerPrompt: "unknown",
        limitations: ["final-report-unavailable"],
      },
    };
    const { events } = yield* runDocument(
      "<Prompt>fails</Prompt>\n",
      new InMemoryStream(),
      stubFactory(newTrace(), always({ status: "failed", usage: () => partial })),
    );
    const record = parsePromptRecord(promptValues(events)[0]);
    expect(record?.status).toBe("failed");
    expect(record?.usage).toEqual(partial);
    expect(record?.checkpoint).toBe(undefined);
  });

  it("PU-P3: a held conversation's turn retains usage through the same runner", function* () {
    const stream = new InMemoryStream();
    const trace = newTrace();
    const factory = stubFactory(trace, always({ usage: () => versioned("held") }));
    const installation: ExecutionInstallation = {
      *install(): Operation<void> {
        yield* installAgentComponents({
          rootProvider: {
            factory,
            options: { defaultAgent: AGENT, permissionMode: "deny-all" },
          },
        });
      },
    };
    const answered = yield* scoped(function* () {
      const opened = yield* useAgentConversation({
        history: stream,
        id: "chat-usage",
        agent: AGENT,
        installations: [installation],
      });
      if (!opened.ok) {
        throw opened.error;
      }
      return yield* opened.value.prompt("hello");
    });
    expect(answered.ok ? "ok" : answered.error.message).toBe("ok");
    const records = promptValues(yield* stream.readAll());
    expect(records.length).toBe(1);
    expect(parsePromptRecord(records[0])?.usage?.provenance.xmd.version).toBe("held");
    expect(trace.subscriptions).toBe(1);
  });

  it("PU-P4: an unsafe model name is withheld by the producing execution; the rest is kept", function* () {
    const marker = ["tok", "en-", "USAGE01"].join("");
    const unsafe = sampleUsage("unsafe", marker);
    const { result, events } = yield* scoped(function* () {
      return yield* runDocument(
        "<Prompt>one</Prompt>\n",
        new InMemoryStream(),
        stubFactory(newTrace(), always({ usage: () => unsafe })),
        { scanner: markerScanner(marker) },
      );
    });
    expect(result.ok).toBe(true);
    const retained = parsePromptRecord(promptValues(events)[0])?.usage;
    expect(JSON.stringify(retained).includes(marker)).toBe(false);
    expect(retained?.readings.some((reading) => reading.source === "quota-model")).toBe(false);
    expect(retained?.readings.length).toBe(unsafe.readings.length - 1);
    expect(retained?.coverage.limitations).toEqual(["fixture-limit", "field-withheld"]);
    expect(retained?.requestId).toBe(unsafe.requestId);
  });
});

/** A scanner that finds a secret in whatever text contains `marker`. */
function markerScanner(marker: string): () => SecretScanner {
  return () => ({
    // deno-lint-ignore require-yield
    *scan(content: string): Operation<SecretFinding[]> {
      return content.includes(marker)
        ? [
            {
              ruleId: "test-rule",
              messageId: "TEST_SECRET",
              location: { line: 1, column: 1 },
              fingerprint: "test-fingerprint",
            },
          ]
        : [];
    },
  });
}

describe("Tier PU — producing-execution disclosure", () => {
  it("PU-P5: a protected input stays withheld under scanner opt-out, whatever context is rebound", function* () {
    const owner = yield* createInputOwner();
    const values = yield* attachInputOwner(owner);
    const protectedText = "PU_PROTECTED_MARKER";
    values.protect({ coroutine: "root", index: 0, field: "code" }, protectedText);
    // The producing execution's own policy, selected with its protected
    // inputs and with the scanner explicitly turned off.
    yield* useSecretDetection(false, new InMemoryStream(), values);
    const reported: PromptUsage = {
      ...versioned("protected"),
      providerMessageId: protectedText,
      coverage: {
        finalReport: "received",
        outerPrompt: "partial",
        limitations: ["fixture-limit", protectedText, "Not A Category"],
      },
    };
    const expected = {
      message: undefined,
      limitations: ["fixture-limit", "field-withheld"],
    };
    const normal = yield* retainablePromptUsage(reported);
    expect({
      message: normal.providerMessageId,
      limitations: normal.coverage.limitations,
    }).toEqual(expected);
    // Removing the same-name contextual inputs removes nothing: the policy
    // binding carries the inputs it was selected with.
    yield* createContext<unknown>("executablemd.secret-input.values").set(undefined);
    const substituted = yield* retainablePromptUsage(reported);
    expect({
      message: substituted.providerMessageId,
      limitations: substituted.coverage.limitations,
    }).toEqual(expected);
    expect(substituted.requestId).toBe(reported.requestId);
  });

  it("PU-P6: outside an execution's policy every supplied string is withheld", function* () {
    const retained = yield* retainablePromptUsage(sampleUsage("orphan"));
    expect(retained.requestId).toBe(undefined);
    expect(retained.provenance).toEqual({
      host: "deno-source",
      xmd: {},
      runtime: {},
      adapter: {},
      native: {},
    });
    expect(retained.readings.some((reading) => reading.source === "quota-model")).toBe(false);
    expect(retained.coverage.limitations).toEqual(["field-withheld"]);
  });

  it("PU-P7: the final whole-event gate still refuses a record its fields passed one by one", function* () {
    // Each optional string is clean alone; only the complete event holds both.
    const scanner = (): SecretScanner => ({
      // deno-lint-ignore require-yield
      *scan(content: string): Operation<SecretFinding[]> {
        return content.includes("model-a") && content.includes("USD")
          ? [
              {
                ruleId: "test-rule",
                messageId: "TEST_SECRET",
                location: { line: 1, column: 1 },
                fingerprint: "test-fingerprint",
              },
            ]
          : [];
      },
    });
    const stream = new InMemoryStream();
    const { result, events } = yield* runDocument(
      "<Prompt>one</Prompt>\n",
      stream,
      stubFactory(newTrace(), always({ usage: () => sampleUsage("gated") })),
      { scanner },
    );
    expect(result.ok).toBe(false);
    expect(promptValues(events)).toEqual([]);
  });

  it("PU-P8: reopening a held conversation replays its usage without a provider or a new event", function* () {
    const stream = new InMemoryStream();
    const installation = (trace: StubTrace, label: string): ExecutionInstallation => ({
      *install(): Operation<void> {
        yield* installAgentComponents({
          rootProvider: {
            factory: stubFactory(trace, always({ usage: () => versioned(label) })),
            options: { defaultAgent: AGENT, permissionMode: "deny-all" },
          },
        });
      },
    });
    function* converse(trace: StubTrace, label: string, text: string) {
      return yield* scoped(function* () {
        const opened = yield* useAgentConversation({
          history: stream,
          id: "chat-replay",
          agent: AGENT,
          installations: [installation(trace, label)],
        });
        if (!opened.ok) {
          throw opened.error;
        }
        return yield* opened.value.prompt(text);
      });
    }
    const first = newTrace();
    const opened = yield* converse(first, "original", "hello");
    expect(opened.ok ? "ok" : opened.error.message).toBe("ok");
    const before = yield* stream.readAll();
    const [original] = promptValues(before);

    const again = newTrace();
    const reopened = yield* converse(again, "refreshed", "again");
    expect(reopened.ok ? "ok" : reopened.error.message).toBe("ok");
    const after = promptValues(yield* stream.readAll());
    // Only the new turn reached a provider or captured a receiver; the
    // retained one answered from its record, unchanged and not appended again.
    expect([again.subscriptions, again.acquisitions]).toEqual([1, 1]);
    expect(after.length).toBe(2);
    expect(after[0]).toEqual(original);
    expect(parsePromptRecord(after[0])?.usage?.provenance.xmd.version).toBe("original");
    expect(parsePromptRecord(after[1])?.usage?.provenance.xmd.version).toBe("refreshed");
  });
});

describe("Tier PU — retained data", () => {
  it("PU-D1: a complete value round-trips, keeping zero, null and absent apart", function* () {
    const usage = sampleUsage("one");
    const read = readPromptUsage(serializePromptUsage(usage));
    expect(read).toEqual(usage);
    const [response, quota, model] = read?.readings ?? [];
    expect(response?.kind === "tokens" ? response.tokens : "missing").toEqual({
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
    });
    expect(quota?.kind === "tokens" ? quota.tokens : "missing").toBe(null);
    expect(
      model?.kind === "tokens" &&
        model.tokens !== null &&
        Object.hasOwn(model.tokens, "inputTokens"),
    ).toBe(false);
  });

  it("PU-D2: present malformed usage refuses the record; absent usage stays unknown", function* () {
    const base = {
      sequence: 0,
      agent: AGENT,
      sessionKey: "stub:default",
      status: "completed",
      text: "",
    };
    expect(parsePromptRecord(base)).not.toBe(undefined);
    expect(parsePromptRecord(base)?.usage).toBe(undefined);
    const written = serializePromptUsage(sampleUsage("one"));
    if (typeof written !== "object" || written === null || Array.isArray(written)) {
      throw new Error("usage serializes as an object");
    }
    expect(parsePromptRecord({ ...base, usage: written })?.usage).toEqual(sampleUsage("one"));
    const reading = {
      source: "response",
      scope: "main-loop",
      kind: "tokens",
      counter: "turn-total",
    };
    for (const malformed of [
      { ...written, extra: 1 },
      { ...written, readings: [{ ...reading, tokens: { inputTokens: -1 } }] },
      { ...written, readings: [{ ...reading, tokens: { inputTokens: 1, renamed: 2 } }] },
      { ...written, readings: [reading] },
      {
        ...written,
        coverage: { finalReport: "received", outerPrompt: "complete", limitations: [] },
      },
      { ...written, provenance: { host: "node", xmd: {}, runtime: {}, adapter: {} } },
      "usage",
      null,
    ]) {
      expect(parsePromptRecord({ ...base, usage: malformed })).toBe(undefined);
    }
  });
});
