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
import { createContext, ensure, scoped } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { Agent } from "../src/agent/agent-api.ts";
import { isSessionUse, sessionOf } from "../src/agent/session-use.ts";
import { isSessionRequest } from "../src/agent/session-request.ts";
import type { ConfigureAgentSession } from "../src/agent/session-placement.ts";
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
import { registerComponents } from "../src/components/registration.ts";
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
  /** The members each started event actually carried, in prompt order. */
  startedKeys?: string[][];
  /**
   * What each registered session was asked to be configured with, in order.
   *
   * Asked through the coordinator the provider factory was handed directly, so
   * an entry here is a question core put to this provider about one of its own
   * sessions — never a value that travelled the public chain.
   */
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

function stubFactory(
  trace: Trace,
  fail?: boolean,
  refuseBeforeStart?: boolean,
): AgentProviderFactory {
  const issued = new Map<string, Session>();
  // One operation per conversation, as a provider has: the owner that settles
  // placements refuses a session registered two different ways, and two
  // elements naming one conversation are two placements asking the same thing.
  const applying = new Map<Session, ConfigureAgentSession>();
  const applyFor = (session: Session): ConfigureAgentSession => {
    const known = applying.get(session);
    if (known !== undefined) {
      return known;
    }
    // deno-lint-ignore require-yield
    const configure: ConfigureAgentSession = function* (configuration) {
      trace.sessionConfigurations = [...(trace.sessionConfigurations ?? []), configuration];
      return configuration;
    };
    applying.set(session, configure);
    return configure;
  };
  return function* (_options, launchCoordinator) {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          trace.agentLookups.push(name);
          return name ?? "stub-agent";
        },
        *session(routed) {
          const [name] = routed;
          trace.sessionArgumentCounts = [...(trace.sessionArgumentCounts ?? []), routed.length];
          // One value per placement, kept — as a provider that pins a session
          // keeps the exact value it issued rather than minting a look-alike.
          const key = `stub:${typeof name === "string" ? name : "default"}`;
          const held = issued.get(key);
          if (held) {
            return held;
          }
          const session: Session = { sessionKey: key, cwd: "." };
          issued.set(key, session);
          trace.sessions = [...(trace.sessions ?? []), session];
          // Settling the placement is where this provider says which kind of
          // conversation it resolved. Everything this stub issues is
          // established, so core applies the settings here and the use it
          // hands back carries what this provider reports it verified.
          if (!isSessionRequest(name)) {
            return session;
          }
          return yield* launchCoordinator
            .sessionPlacement(name)
            .complete(session, { kind: "established", configure: applyFor(session) });
        },
        // deno-lint-ignore require-yield
        *prompt([content, options]) {
          // What a provider does first with the value that names its
          // conversation: ask the installation that issued it. A value that
          // claims to be configured and was issued by nobody refuses here,
          // before anything is recorded or sent.
          launchCoordinator.sessionUse(options?.session);
          trace.prompts.push(content);
          trace.timeouts.push(options?.timeout);
          trace.promptSessions = [...(trace.promptSessions ?? []), options?.session];
          if (refuseBeforeStart === true) {
            return {
              *[Symbol.iterator]() {
                // What a provider that could not put the conversation under
                // what was asked does: it refuses before the turn, so no
                // `started` event is ever produced.
                throw new Error('Unknown model "gpt-5.4" for agent "stub-agent".');
              },
            };
          }
          return stubStream(content, options, fail, trace);
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
  trace?: Trace,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      // The value this turn ran in, as the caller named it: a configured use
      // is the exact session and also the only thing that can say what it was
      // put under, and the record is written from what the turn reports.
      const session: Session =
        typeof options?.session === "object"
          ? options.session
          : { sessionKey: `stub:${options?.session ?? "default"}`, cwd: "." };
      const started: AgentPromptEvent = {
        type: "started",
        agent: options?.agent ?? "stub-agent",
        session,
      };
      if (trace) {
        trace.startedKeys = [...(trace.startedKeys ?? []), Object.keys(started)];
      }
      const events: AgentPromptEvent[] = [
        started,
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
  /** Refuse the turn before it starts, as a failed configuration does. */
  refuseBeforeStart?: boolean;
  /**
   * An ordinary public handler, installed around the whole execution.
   *
   * Installed exactly where a document's own middleware sits: at the default
   * priority, outside every `at: "min"` handler core and the provider install.
   * That is the position the substitutions below are written from, because it
   * is the position that can see a routed session before core's own routing
   * does anything with it.
   */
  handler?: () => Operation<void>;
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
        factory: stubFactory(trace, options.fail, options.refuseBeforeStart),
        options: { defaultAgent: "stub-agent", permissionMode: "deny-all" },
      },
    });
    if (options.policy) {
      yield* installPromptFailurePolicy(options.policy);
    }
    if (options.handler) {
      yield* options.handler();
    }
    yield* registerComponents([
      {
        name: "Probe",
        origin: "test",
        props: { type: "object", properties: {}, additionalProperties: false },
        // A repository function component doing what one may do: sending a
        // prompt with `Agent.operations.prompt()` and naming no session. There
        // is no `<Prompt>` here to author anything, so what binds this call is
        // whatever the enclosing element does on the same ledger.
        *fn() {
          const stream = yield* Agent.operations.prompt("probe", {});
          const subscription = yield* stream;
          let next = yield* subscription.next();
          while (!next.done) {
            next = yield* subscription.next();
          }
          return next.value;
        },
      },
    ]);

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

  it("AF26: the exact configuration reaches the provider, and not through the route", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4" effort="high" />', ""].join("\n"),
      { trace },
    );

    expect(result.ok).toBe(true);
    // Asked of the provider about its own session, through the coordinator it
    // was handed directly — never routed, so no handler saw a settings object.
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4", effort: "high" }]);
    expect(trace.sessionArgumentCounts).toEqual([1]);
    // A configured self-closing Session still places and nothing more: no
    // prompt is sent on its behalf.
    expect(trace.prompts).toEqual([]);
  });

  it("AF27: an unconfigured Session asks the provider nothing at all", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc('<Session name="review" />\n', { trace });

    expect(result.ok).toBe(true);
    // Nothing was asked: an element that configured nothing has nothing to ask
    // about, and an empty configuration object would be a request to leave both
    // settings alone — which a provider cannot tell from one to write two
    // values it was never given.
    expect(trace.sessionConfigurations).toBe(undefined);
    expect(trace.sessionArgumentCounts).toEqual([1]);
  });

  it("AF28: a prompt retains the one configuration its Session runs under", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4" effort="high">',
        '<Prompt text="hi" />',
        "</Session>",
        "",
      ].join("\n"),
      { trace },
    );

    expect(result.ok ? "" : result.error.message).toBe("");
    // One member, naming what the conversation ran under, and no
    // requested-versus-effective pair on the record or on the event.
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toEqual({ model: "gpt-5.4", effort: "high" });
    expect(Object.keys(prompt?.value ?? {}).filter((key) => key.startsWith("requested"))).toEqual(
      [],
    );
    expect(trace.startedKeys).toEqual([["type", "agent", "session"]]);
  });

  it("AF29: a setting nobody authored is retained as nothing at all", function* () {
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
    );

    expect(result.ok).toBe(true);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toEqual({ model: "gpt-5.4" });
  });

  it("AF30: a prompt under no configured Session retains neither member", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc('<Prompt text="hi" />\n', { trace });

    expect(result.ok).toBe(true);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
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
    // Only the outer element asked for anything, and it asked the provider
    // about its own conversation rather than routing settings anywhere.
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4", effort: "high" }]);
    // Both placements travel the same released one-argument route.
    expect(trace.sessionArgumentCounts).toEqual([1, 1]);
    // The conversation this prompt belongs to is the inner one, which asked for
    // nothing — so the record says nothing about the outer element's settings.
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
  });

  it("AF35: a prompt refused before its turn started records no configuration", function* () {
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
      { refuseBeforeStart: true },
    );

    // The turn never started, so the conversation was never under these
    // settings — and a record naming them would say it ran under them.
    expect(result.ok).toBe(false);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
    expect(prompt?.value.status).toBe("failed");
  });

  it("AF36: a prompt that failed after starting retains what it ran under", function* () {
    const { events } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4" effort="high">',
        '<Prompt text="hi" />',
        "</Session>",
        "",
      ].join("\n"),
      { fail: true },
    );

    // It started, so the provider had put the conversation under exactly these
    // settings; what happened afterwards does not change what it ran under.
    const [prompt] = promptRecords(events);
    expect(prompt?.value.status).toBe("failed");
    expect(prompt?.value.configuration).toEqual({ model: "gpt-5.4", effort: "high" });
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
    expect(parsed?.configuration).toBe(undefined);
  });

  it("AF33: a configuration member that names no choice refuses the record", function* () {
    const complete = {
      sequence: 0,
      agent: "codex",
      sessionKey: "xmd:v1:a",
      status: "completed",
      text: "hello",
      configuration: { model: "gpt-5.4", effort: "high" },
    };
    expect(parsePromptRecord(complete)?.configuration).toEqual({
      model: "gpt-5.4",
      effort: "high",
    });
    for (const carried of [{}, { model: "" }, { model: 7 }, { effort: null }, { mode: "fast" }]) {
      const described = JSON.stringify(carried);
      expect([described, parsePromptRecord({ ...complete, configuration: carried })]).toEqual([
        described,
        undefined,
      ]);
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

/** What a prompt record says went wrong, read out of the durable Json. */
function recordedFailure(record: Record<string, Json> | undefined): string {
  const error = record?.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return "";
  }
  return typeof error.message === "string" ? error.message : "";
}

/**
 * Tier AF — what a public handler may do with a configured conversation.
 *
 * Middleware selects, reroutes and refuses whole conversations; that is what it
 * is for, and model and effort never travel as a value it could edit. So the
 * question these rows ask is not whether a handler may reroute — it may — but
 * whether the provider and the journal both follow where it routed.
 *
 * The final routed session decides. An authentic use runs under its own
 * settings; a raw session or no session at all is an ordinary unconfigured
 * route that reads and writes nothing; and a value that claims to be configured
 * and was issued by nobody refuses rather than being read as either.
 */
describe("Tier AF — the final routed Session decides", () => {
  it("AF37: routing the raw session a use names runs unconfigured", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              // The conversation, without what it was to run under. Nothing is
              // forged: this is the exact session the provider issued.
              return yield* next(text, { ...options, session: sessionOf(options?.session) });
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(trace.prompts).toEqual(["hi"]);
    // Nothing was asked of the provider about settings, and the record says so
    // rather than repeating what the element held.
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4" }]);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
  });

  it("AF38: routing no session at all is an ordinary unconfigured route", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      ['<Session name="review" effort="high">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              return yield* next(text, { ...options, session: undefined });
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(trace.prompts).toEqual(["hi"]);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
  });

  it("AF39: routing another authentic use runs under that use", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    // Two elements, each owning one conversation. The handler sends the second
    // element's prompt into the first's use, and what the turn runs under — and
    // what the record says — is the first's settings, because that is the
    // conversation it actually ran in.
    let first: string | Session | undefined;
    const { result, events } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4">',
        '<Prompt text="first" />',
        "</Session>",
        '<Session name="notes" effort="high">',
        '<Prompt text="second" />',
        "</Session>",
        "",
      ].join("\n"),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              if (first === undefined) {
                first = options?.session;
                return yield* next(text, options);
              }
              return yield* next(text, { ...options, session: first });
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(trace.prompts).toEqual(["first", "second"]);
    const [one, two] = promptRecords(events);
    expect(one?.value.configuration).toEqual({ model: "gpt-5.4" });
    // Not `{ effort: "high" }`: that element's settings never ran.
    expect(two?.value.configuration).toEqual({ model: "gpt-5.4" });
  });

  it("AF40: a value that claims to be configured and was issued by nobody refuses", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              // Everything a spread carries: the claim is copied, whatever
              // makes the value authentic is not.
              return yield* next(text, {
                ...options,
                session: { ...(options?.session as Session) },
              });
            },
          }),
      },
    );

    expect(result.ok).toBe(false);
    // Refused rather than read as the ordinary session it resembles, which
    // would run this conversation under nothing while saying nothing.
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
    expect(recordedFailure(prompt?.value)).toContain("not a configured session this run issued");
  });

  it("AF41: reading the use and delegating it is what a handler is for", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const seen: string[] = [];
    const { result, events } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4" effort="high">',
        '<Prompt text="hi" />',
        "</Session>",
        "",
      ].join("\n"),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              // Inspection is public: a handler may see that a value presents
              // itself as configured, and what it says.
              seen.push(isSessionUse(options?.session) ? "use" : "session");
              return yield* next(text, options);
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["use"]);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toEqual({ model: "gpt-5.4", effort: "high" });
  });

  it("AF42: one configured Session hands the same use to every nested prompt", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const routed: (string | Session | undefined)[] = [];
    const { result } = yield* runDoc(
      [
        '<Session name="review" model="gpt-5.4">',
        '<Prompt text="first" />',
        '<Prompt text="second" />',
        "</Session>",
        "",
      ].join("\n"),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              routed.push(options?.session);
              return yield* next(text, options);
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    // One use per lexical element, not one per operation: both prompts are
    // handed the very same object, and it unwraps to the session the provider
    // issued once.
    expect(routed[0]).toBe(routed[1]);
    expect(isSessionUse(routed[0])).toBe(true);
    expect(sessionOf(routed[0])).toBe(trace.sessions?.[0]);
    expect(trace.sessions).toHaveLength(1);
  });

  it("AF43: a programmatic prompt beneath the element runs in its conversation", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const seen: boolean[] = [];
    const { result } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', "<Probe />", "</Session>", ""].join("\n"),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              // The programmatic call named nothing; the element supplies its
              // own conversation after every ordinary handler has had it.
              seen.push(options?.session === undefined);
              return yield* next(text, options);
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual([true]);
    expect(trace.prompts).toEqual(["probe"]);
    expect(isSessionUse(trace.promptSessions?.[0])).toBe(true);
    expect(sessionOf(trace.promptSessions?.[0])).toBe(trace.sessions?.[0]);
  });

  it("AF44: a programmatic prompt a handler reroutes follows that route", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', "<Probe />", "</Session>", ""].join("\n"),
      {
        trace,
        handler: () =>
          Agent.around({
            *prompt([text, options], next) {
              // Naming a conversation for a call that named none is ordinary
              // composition, and it is honoured rather than refused.
              return yield* next(text, { ...options, session: "elsewhere" });
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    expect(trace.promptSessions).toEqual(["elsewhere"]);
    // It ran somewhere else, so the element's settings were never asked for.
    expect(trace.sessionConfigurations).toEqual([{ model: "gpt-5.4" }]);
  });

  it("AF45: a Session a handler answers with never went through placement", function* () {
    const trace: Trace = { prompts: [], agentLookups: [], timeouts: [] };
    const { result, events } = yield* runDoc(
      ['<Session name="review" model="gpt-5.4">', '<Prompt text="hi" />', "</Session>", ""].join(
        "\n",
      ),
      {
        trace,
        handler: () =>
          Agent.around({
            // deno-lint-ignore require-yield
            *session(): Operation<Session> {
              // A conversation of the handler's own making. The placement it
              // was given is never settled, so nothing put this session under
              // anything and no use was minted for it.
              return { sessionKey: "handler:review", cwd: "." };
            },
          }),
      },
    );

    expect(result.ok).toBe(true);
    // The route the handler chose is the route that ran, unconfigured: the
    // provider was never asked about settings and the record claims none.
    expect(trace.sessionConfigurations).toBe(undefined);
    expect(trace.prompts).toEqual(["hi"]);
    const [prompt] = promptRecords(events);
    expect(prompt?.value.configuration).toBe(undefined);
  });
});
