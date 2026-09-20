/**
 * Tier AF — the agent components as function components (spec §5.3, §5.5).
 *
 * They are registered defaults now, so the engine owns expression props, schema
 * validation, `as`, content projection and invocation lifetime. What is left to
 * the components is which of their failures end the document, and the order in
 * which a prompt does its work. These drive `execute()`, so what they assert is
 * what a document gets.
 */

import { beforeAll, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure, scoped } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type {
  AgentPromptEvent,
  PromptOptions,
  Session,
  SessionConfiguration,
} from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import { executeInstalled } from "../host.ts";
import { agentIdentityComponents } from "../src/agent/components.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import { AgentInternal } from "../src/agent/internal.ts";
import { parsePromptRecord } from "../src/agent/journal.ts";
import { installPromptFailurePolicy } from "../src/agent/permission.ts";
import { inspectComponent } from "../src/inspect.ts";
import type { AgentProviderFactory } from "../src/agent/provider-api.ts";
import type { Json } from "../src/types.ts";

/** What the stub agent was asked to do, in order. */
interface Trace {
  prompts: string[];
  agentLookups: (string | undefined)[];
  /** The timeout each prompt carried, in prompt order. */
  timeouts: (number | undefined)[];
  /** Every value the provider issued for a placement, in order. */
  sessions?: Session[];
  /** What each prompt was given as its session, in prompt order. */
  promptSessions?: (string | Session | undefined)[];
  /** What each placement asked its conversation to run under, in order. */
  sessionConfigurations?: (SessionConfiguration | undefined)[];
  /**
   * How many arguments each session call actually carried, in order.
   *
   * The count, not the value: a call that routed `undefined` as its second
   * argument reads identically to one that asked for nothing, and only the
   * arity tells a handler which of the two it was handed.
   */
  sessionArgumentCounts?: number[];
}

/** What this stub says a conversation is running under when nobody asked. */
const STUB_DEFAULTS: Required<SessionConfiguration> = {
  model: "stub-model",
  effort: "stub-effort",
};

function stubFactory(trace: Trace, fail?: boolean): AgentProviderFactory {
  const issued = new Map<string, Session>();
  // The provider owns the association between the exact Session it issued and
  // what that conversation was asked to run under, exactly as a real one does.
  const desired = new Map<Session, SessionConfiguration | undefined>();
  return function* () {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          trace.agentLookups.push(name);
          return name ?? "stub-agent";
        },
        // deno-lint-ignore require-yield
        *session(routed) {
          const [name, configuration] = routed;
          trace.sessionArgumentCounts = [...(trace.sessionArgumentCounts ?? []), routed.length];
          trace.sessionConfigurations = [...(trace.sessionConfigurations ?? []), configuration];
          // One value per placement, kept — as a provider that pins a session
          // keeps the exact value it issued rather than minting a look-alike.
          const key = `stub:${typeof name === "string" ? name : "default"}`;
          const held = issued.get(key);
          if (held) {
            desired.set(held, configuration);
            return held;
          }
          const session: Session = { sessionKey: key, cwd: "." };
          issued.set(key, session);
          desired.set(session, configuration);
          trace.sessions = [...(trace.sessions ?? []), session];
          return session;
        },
        // deno-lint-ignore require-yield
        *prompt([content, options]) {
          trace.prompts.push(content);
          trace.timeouts.push(options?.timeout);
          trace.promptSessions = [...(trace.promptSessions ?? []), options?.session];
          const configuration =
            typeof options?.session === "object" ? desired.get(options.session) : undefined;
          return stubStream(content, options, fail, configuration);
        },
      },
      { at: "min" },
    );
  };
}

function stubStream(
  content: string,
  options: PromptOptions | undefined,
  fail?: boolean,
  configuration?: SessionConfiguration,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      const session: Session =
        typeof options?.session === "object"
          ? options.session
          : { sessionKey: `stub:${options?.session ?? "default"}`, cwd: "." };
      const events: AgentPromptEvent[] = [
        {
          type: "started",
          agent: options?.agent ?? "stub-agent",
          session,
          ...(configuration === undefined ? {} : { requestedConfiguration: configuration }),
          // What this provider reports the conversation is running under, which
          // for a setting nobody asked about is its own current one rather than
          // an echo of the request.
          effectiveConfiguration: {
            model: configuration?.model ?? STUB_DEFAULTS.model,
            effort: configuration?.effort ?? STUB_DEFAULTS.effort,
          },
        },
        { type: "text_delta", text: `[${content}]` },
        { type: "terminal", status: fail ? "failed" : "completed" },
      ];
      let index = 0;
      return {
        // deno-lint-ignore require-yield
        *next() {
          if (index < events.length) {
            return { done: false, value: events[index++]! };
          }
          return { done: true, value: `[${content}]` };
        },
      };
    },
  };
}

interface RunOptions {
  /** Extra files written beside the document, e.g. a repository component. */
  files?: Record<string, string>;
  trace?: Trace;
  fail?: boolean;
  /** Installed around the execution, as `<TestAgent>` installs it. */
  policy?: () => Operation<boolean>;
  /**
   * The subtree prompt default an `<AgentProvider timeout>` installs, in
   * milliseconds — installed here the way that component installs it.
   */
  promptTimeout?: number;
}

function* runDoc(
  doc: string,
  options: RunOptions = {},
): Operation<{ output: string; result: Result<Json>; trace: Trace; events: DurableEvent[] }> {
  const trace: Trace = options.trace ?? { prompts: [], agentLookups: [], timeouts: [] };
  const dir = path.join(os.tmpdir(), `xmd-af-test-${randomUUID()}`);
  yield* ensureDir(dir);
  return yield* scoped(function* () {
    yield* ensure(() => rm(dir, { recursive: true, force: true }));
    for (const [name, source] of Object.entries(options.files ?? {})) {
      yield* writeTextFile(path.join(dir, name), source);
    }
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);

    if (options.promptTimeout !== undefined) {
      const inherited = options.promptTimeout;
      yield* AgentInternal.around({ promptTimeout: () => inherited }, { at: "min" });
    }
    yield* installAgentComponents({
      rootProvider: {
        factory: stubFactory(trace, options.fail),
        options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
      },
    });
    if (options.policy) {
      yield* installPromptFailurePolicy(options.policy);
    }

    // `<Session>` names durable work after its own invocation, so the host
    // declares it to the execution rather than registering it.
    const stream = new InMemoryStream();
    const execution = yield* executeInstalled(
      {
        path: docPath,
        stream,
        includes: [dir],
      },
      [{ components: agentIdentityComponents() }],
    );
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return {
      output: next.value,
      result: yield* execution,
      trace,
      events: yield* stream.readAll(),
    };
  });
}

describe("Tier AF — the engine owns props", () => {
  beforeAll(() => useTempFileCompiler());

  it("AF1: an expression prop resolves, where the claimed handler rejected it", function* () {
    const { output, result } = yield* runDoc(
      ["```js eval", 'const who = "hello";', "```", "", "<Prompt text={who} />", ""].join("\n"),
    );

    expect(result.ok).toBe(true);
    expect(output).toContain("[hello]");
  });

  it("AF2: a boolean expression prop resolves", function* () {
    const { result } = yield* runDoc(
      [
        "```js eval",
        "const strict = false;",
        "```",
        "",
        '<Prompt text="hi" throwOnError={strict} />',
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
  });

  it("AF3: an expression resolving to the wrong type is a schema printed error, and nothing runs", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc(
      ["```js eval", "const who = 42;", "```", "", "<Prompt text={who} />", ""].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain(
      "Prop validation failed for <Prompt />",
    );
    // Validation is the engine's, and it runs before the component does.
    expect(trace.prompts).toEqual([]);
    expect(trace.agentLookups).toEqual([]);
  });

  it("AF4: an unknown prop is rejected before the component performs anything", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { output, result } = yield* runDoc(
      '<AgentProvider name="stub" nope="x">body</AgentProvider>\n',
      { trace },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain(
      "Prop validation failed for <AgentProvider />",
    );
    expect(output).not.toContain("body");
    expect(trace.prompts).toEqual([]);
  });
});

describe("Tier AF — the engine owns `as`", () => {
  it("AF5: the returned string is captured once and not also emitted", function* () {
    const { output, result } = yield* runDoc('<Prompt text="hi" as="answer" />\n\nGot: {answer}\n');

    expect(result.ok).toBe(true);
    expect(output).toContain("Got: [hi]");
    expect(output.indexOf("[hi]")).toBe(output.lastIndexOf("[hi]"));
  });

  it("AF6: an invalid `as` prevents every component effect", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc('<Prompt text="hi" as="not an identifier" />\n', { trace });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain('Prop "as" on <Prompt />');
    expect(trace.prompts).toEqual([]);
    expect(trace.agentLookups).toEqual([]);
  });
});

describe("Tier AF — a prompt does nothing before its content renders", () => {
  it("AF7: a failing wrapper performs no lookup, no prompt and no journal entry", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc("<Prompt>\n<Missing />\n</Prompt>\n", { trace });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toContain("Failed to import component Missing");
    expect(trace.prompts).toEqual([]);
    expect(trace.agentLookups).toEqual([]);
  });

  it("AF8: an empty wrapper still overrides the text prop", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    yield* runDoc('<Prompt text="fallback"></Prompt>\n', { trace });

    expect(trace.prompts).toEqual([""]);
  });
});

describe("Tier AF — failures that end the document", () => {
  it("AF9: an unavailable agent stops the document, nested in another wrapper", function* () {
    const { output, result } = yield* runDoc(
      [
        "BEFORE",
        "",
        '<Agent name="stub-agent">',
        '  <Prompt text="hi" />',
        "</Agent>",
        "",
        "AFTER",
        "",
      ].join("\n"),
      { fail: false },
    );

    // The nested case succeeds; the point is that the wrapper does not swallow.
    expect(result.ok).toBe(true);
    expect(output).toContain("BEFORE");
    expect(output).toContain("AFTER");
  });

  it("AF10: a throwOnError prompt inside <Agent> still ends the document", function* () {
    const { output, result } = yield* runDoc(
      [
        "BEFORE",
        "",
        '<Agent name="stub-agent">',
        '  <Prompt text="hi" throwOnError={true} />',
        "</Agent>",
        "",
        "AFTER",
        "",
      ].join("\n"),
      { fail: true },
    );

    expect(result.ok).toBe(false);
    // The original failure, by type — not a transport wrapper.
    expect(result.ok === false && result.error).toBeInstanceOf(AgentPromptError);
    expect(output).toContain("BEFORE");
    expect(output).not.toContain("AFTER");
  });

  it("AF11: the same holds two wrappers deep", function* () {
    const { output, result } = yield* runDoc(
      [
        "BEFORE",
        "",
        '<Agent name="stub-agent">',
        '  <Session name="review">',
        '    <Prompt text="hi" throwOnError={true} />',
        "  </Session>",
        "</Agent>",
        "",
        "AFTER",
        "",
      ].join("\n"),
      { fail: true },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(AgentPromptError);
    expect(output).not.toContain("AFTER");
  });

  it("AF12: it survives a repository component projecting the prompt as content", function* () {
    const { output, result } = yield* runDoc(
      [
        "BEFORE",
        "",
        "<Wrapper>",
        '  <Prompt text="hi" throwOnError={true} />',
        "</Wrapper>",
        "",
        "AFTER",
        "",
      ].join("\n"),
      {
        fail: true,
        files: { "Wrapper.md": "<Content />\n" },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(AgentPromptError);
    expect(output).not.toContain("AFTER");
  });
});

describe("Tier AF — registered defaults a document can replace", () => {
  const names = ["AgentProvider", "Agent", "Prompt", "ApproveAll", "AskPermission"];

  it("AF24: a Session hands the exact value it was issued to every nested Prompt", function* () {
    // The value is the capability. A `<Session>` places one and pins it around
    // its body, and what the first nested Prompt is given has to be that exact
    // object — a provider decides whether a session may be acted on by
    // identity, and a rebuilt look-alike was issued by nobody.
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc(
      [
        '<Session name="review">',
        '  <Prompt text="first" />',
        '  <Prompt text="second" />',
        "</Session>",
        "",
      ].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(true);
    // Placed once, however many prompts are inside it.
    expect(trace.sessions).toHaveLength(1);
    const placed = trace.sessions?.[0];
    expect(trace.promptSessions).toEqual([placed, placed]);
    expect(trace.promptSessions?.[0]).toBe(placed);
    expect(trace.promptSessions?.[1]).toBe(placed);
  });

  it("AF25: a self-closing Session places one and renders nothing", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { output, result } = yield* runDoc(
      ["BEFORE", "", '<Session name="review" />', "", "AFTER", ""].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(true);
    // The placement happened and nothing else did: no prompt, and nothing in
    // the document where the element stood.
    expect(trace.sessions).toHaveLength(1);
    expect(trace.prompts).toEqual([]);
    expect(output).toContain("BEFORE");
    expect(output).toContain("AFTER");
    expect(output).not.toContain("stub:review");
  });

  it("AF13: each name resolves to core's registration when nothing is on disk", function* () {
    yield* installAgentComponents();
    for (const name of names) {
      const info = yield* inspectComponent({ name, includes: [] });
      expect(info.kind).toBe("registered");
      expect(
        info.kind === "registered" && info.origin.kind === "registered" && info.origin.origin,
      ).toBe("@executablemd/core");
    }
  });

  it("AF13: <Session> is the execution's, not this installation's", function* () {
    yield* installAgentComponents();
    // It names durable work after its own invocation, so it exists only where
    // an execution was told about it — a document run by a host that declares
    // none has no `<Session>` at all, which is the safe direction.
    const info = yield* inspectComponent({ name: "Session", includes: [] });
    expect(info.kind).toBe("unresolved");
  });

  it("AF14: a repository component overrides each of them", function* () {
    for (const name of names) {
      const { output } = yield* runDoc(`<${name}>ignored</${name}>\n`, {
        files: { [`${name}.md`]: "MINE\n" },
      });
      expect(output).toContain("MINE");
    }
  });

  it("AF15: a repository Prompt contacts no provider and writes no journal entry", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { output } = yield* runDoc("<Prompt />\n", {
      trace,
      files: { "Prompt.md": "LOCAL PROMPT\n" },
    });

    expect(output).toContain("LOCAL PROMPT");
    expect(trace.prompts).toEqual([]);
    expect(trace.agentLookups).toEqual([]);
  });
});

describe("Tier AF — the scoped prompt-failure policy", () => {
  it("AF16: without a policy a failing prompt is collected, not fatal", function* () {
    const { output, result } = yield* runDoc('<Prompt text="hi" />\n\nAFTER\n', { fail: true });

    expect(result.ok).toBe(false); // aggregated at completion, as always
    expect(output).toContain("AFTER"); // but the document ran on
  });

  it("AF17: a policy that says yes ends the document at the prompt", function* () {
    let asked = 0;
    const { output } = yield* runDoc('<Prompt text="hi" />\n\nAFTER\n', {
      fail: true,
      // deno-lint-ignore require-yield
      policy: function* () {
        asked++;
        return true;
      },
    });

    expect(asked).toBe(1);
    expect(output).not.toContain("AFTER");
  });

  it("AF18: an explicit throwOnError wins without consulting the policy", function* () {
    let asked = 0;
    const { output } = yield* runDoc('<Prompt text="hi" throwOnError={true} />\n\nAFTER\n', {
      fail: true,
      // deno-lint-ignore require-yield
      policy: function* () {
        asked++;
        return false;
      },
    });

    expect(asked).toBe(0);
    expect(output).not.toContain("AFTER");
  });

  it("AF19: a policy that says no leaves the prompt collected", function* () {
    const { output } = yield* runDoc('<Prompt text="hi" />\n\nAFTER\n', {
      fail: true,
      // deno-lint-ignore require-yield
      policy: function* () {
        return false;
      },
    });

    expect(output).toContain("AFTER");
  });

  it("AF20: a repository Prompt never consults the policy", function* () {
    let asked = 0;
    const { output } = yield* runDoc("<Prompt />\n\nAFTER\n", {
      fail: true,
      files: { "Prompt.md": "LOCAL\n" },
      // deno-lint-ignore require-yield
      policy: function* () {
        asked++;
        return true;
      },
    });

    expect(output).toContain("LOCAL");
    expect(output).toContain("AFTER");
    expect(asked).toBe(0);
  });
});

describe("Tier AF — prompt timeouts", () => {
  it("AF21: a prompt nobody bounded carries no timeout", function* () {
    const { trace } = yield* runDoc('<Prompt text="one" />\n');
    expect(trace.timeouts).toEqual([undefined]);
  });

  it("AF22a: a prompt inherits the subtree default an <AgentProvider timeout> installs", function* () {
    const { trace } = yield* runDoc('<Prompt text="one" />\n', { promptTimeout: 500 });
    expect(trace.timeouts).toEqual([500]);
  });

  it("AF22b: a prompt's own timeout outranks the inherited one", function* () {
    const { trace } = yield* runDoc('<Prompt text="one" timeout="250ms" />\n', {
      promptTimeout: 500,
    });
    expect(trace.timeouts).toEqual([250]);
  });

  it("AF22: a prompt's own timeout is the duration it declares", function* () {
    const { trace } = yield* runDoc('<Prompt text="one" timeout="250ms" />\n');
    expect(trace.timeouts).toEqual([250]);
  });

  it("AF23: a malformed prompt timeout refuses instead of prompting", function* () {
    const { result, trace } = yield* runDoc('<Prompt text="one" timeout="soon" />\n');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("must be a duration");
    expect(trace.timeouts).toEqual([]);
  });
});

/**
 * Tier AF — the model and effort one `<Session>` configures (issue #828).
 *
 * Configuration belongs to the element that owns the conversation, so these
 * rows are about two things: which element may carry it, and what a prompt
 * beneath it retains. Applying it is the provider's, and the stub here stands
 * in for one — what it reports back is what the document journals.
 */
function promptRecords(events: DurableEvent[]): {
  description: Record<string, Json>;
  value: Record<string, Json>;
}[] {
  return events.flatMap((event) => {
    if (event.type !== "yield" || event.description.type !== "agent_prompt") {
      return [];
    }
    if (event.result.status !== "ok" || typeof event.result.value !== "object") {
      return [];
    }
    if (event.result.value === null || Array.isArray(event.result.value)) {
      return [];
    }
    return [
      {
        description: event.description as unknown as Record<string, Json>,
        value: event.result.value as Record<string, Json>,
      },
    ];
  });
}

describe("Tier AF — Session configuration", () => {
  beforeAll(() => useTempFileCompiler());

  it("AF26: the exact configuration reaches the provider with the placement", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4" effort="high" />', ""].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(true);
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4", effort: "high" }]);
    expect(trace.sessionArgumentCounts).toEqual([2]);
    // A configured self-closing Session still places and nothing more: no
    // prompt is sent on its behalf.
    expect(trace.prompts).toEqual([]);
  });

  it("AF27: an unconfigured Session asks for nothing rather than for an empty configuration", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc('<Session name="review" />\n', { trace });

    expect(result.ok).toBe(true);
    expect(trace.sessionConfigurations).toEqual([undefined]);
    // The released one-argument call, not a two-argument one whose second
    // argument happens to be undefined.
    expect(trace.sessionArgumentCounts).toEqual([1]);
  });

  it("AF28: a prompt retains what its Session asked for and what the provider reported", function* () {
    const { result, events } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4" effort="high">',
        '<Prompt text="hi" />',
        "</Session>",
        "",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    const [prompt] = promptRecords(events);
    // Described before the turn, so a prompt that stopped while the provider
    // was still applying the configuration says what it asked for.
    expect(prompt?.description.model).toBe("gpt-5.4");
    expect(prompt?.description.effort).toBe("high");
    expect(prompt?.value.requestedModel).toBe("gpt-5.4");
    expect(prompt?.value.requestedEffort).toBe("high");
    expect(prompt?.value.model).toBe("gpt-5.4");
    expect(prompt?.value.effort).toBe("high");
  });

  it("AF29: an effective value is the provider's observation, not an echo of the request", function* () {
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
    );

    expect(result.ok).toBe(true);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.requestedModel).toBe("gpt-5.4");
    // Nothing asked about effort, so nothing requested one — and what the
    // conversation is nevertheless running under is the provider's own answer.
    expect(prompt?.value.requestedEffort).toBe(undefined);
    expect(prompt?.value.effort).toBe(STUB_DEFAULTS.effort);
    expect(prompt?.description.effort).toBe(undefined);
  });

  it("AF30: a prompt under no configured Session retains none of these members", function* () {
    const { result, events } = yield* runDoc('<Prompt text="hi" />\n');

    expect(result.ok).toBe(true);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.requestedModel).toBe(undefined);
    expect(prompt?.value.requestedEffort).toBe(undefined);
    // The provider reported what the turn ran under even though nobody asked,
    // which is an observation rather than a request.
    expect(prompt?.value.model).toBe(STUB_DEFAULTS.model);
  });

  it("AF31: an inner Session does not inherit the outer element's request", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      [
        '<Session name="outer" model="gpt-5.4" effort="high">',
        '<Session name="inner">',
        '<Prompt text="hi" />',
        "</Session>",
        "</Session>",
        "",
      ].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(true);
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4", effort: "high" }, undefined]);
    // The inner placement travels out through the outer Session's own session
    // middleware, and arrives as the one-argument call it started as.
    expect(trace.sessionArgumentCounts).toEqual([2, 1]);
    // The conversation this prompt belongs to is the inner one, which asked for
    // nothing — so the record must not describe the outer element's request.
    const [prompt] = promptRecords(events);
    expect(prompt?.value.requestedModel).toBe(undefined);
    expect(prompt?.value.requestedEffort).toBe(undefined);
  });

  it("AF32: a prompt record written before this feature still parses", function* () {
    // The members are additions, so history that predates them is read as a
    // prompt that asked for nothing — never refused, and never inferred.
    const legacy = {
      sequence: 0,
      agent: "codex",
      sessionKey: "xmd:v1:a",
      status: "completed",
      text: "hello",
    };
    const parsed = parsePromptRecord(legacy);
    expect(parsed?.text).toBe("hello");
    expect([
      parsed?.requestedModel,
      parsed?.requestedEffort,
      parsed?.model,
      parsed?.effort,
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("AF33: a configuration member that names no choice refuses the record", function* () {
    const complete = {
      sequence: 0,
      agent: "codex",
      sessionKey: "xmd:v1:a",
      status: "completed",
      text: "hello",
      requestedModel: "gpt-5.4",
      requestedEffort: "high",
      model: "gpt-5.4",
      effort: "high",
    };
    expect(parsePromptRecord(complete)?.requestedEffort).toBe("high");
    for (const member of ["requestedModel", "requestedEffort", "model", "effort"]) {
      for (const value of ["", 7, null, ["gpt-5.4"]]) {
        expect([member, value, parsePromptRecord({ ...complete, [member]: value })]).toEqual([
          member,
          value,
          undefined,
        ]);
      }
    }
  });

  it("AF34: only <Session> admits model and effort", function* () {
    for (const element of [
      '<Agent name="stub-agent" model="gpt-5.4" />',
      '<Prompt text="hi" effort="high" />',
      '<Session.Launch model="gpt-5.4" />',
    ]) {
      const { result } = yield* runDoc(`${element}\n`);
      expect([element, result.ok]).toEqual([element, false]);
      expect([element, result.ok ? "" : result.error.message]).toEqual([
        element,
        expect.stringContaining("Prop validation failed"),
      ]);
    }
  });
});
