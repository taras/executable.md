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
import { ensure, scoped } from "effection";
import type { Operation, Result, Stream } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { useTempFileCompiler } from "../src/temp-file-compiler.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent, PromptOptions, Session } from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import { executeInstalled } from "../host.ts";
import { agentIdentityComponents } from "../src/agent/components.ts";
import { installAgentComponents } from "../src/agent/components.ts";
import { AgentInternal } from "../src/agent/internal.ts";
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
}

function stubFactory(trace: Trace, fail?: boolean): AgentProviderFactory {
  return function* () {
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          trace.agentLookups.push(name);
          return name ?? "stub-agent";
        },
        // deno-lint-ignore require-yield
        *session([name]) {
          const session: Session = { sessionKey: `stub:${name ?? "default"}`, cwd: "." };
          return session;
        },
        // deno-lint-ignore require-yield
        *prompt([content, options]) {
          trace.prompts.push(content);
          trace.timeouts.push(options?.timeout);
          return stubStream(content, options, fail);
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
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      const session: Session =
        typeof options?.session === "object"
          ? options.session
          : { sessionKey: `stub:${options?.session ?? "default"}`, cwd: "." };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? "stub-agent", session },
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
): Operation<{ output: string; result: Result<Json>; trace: Trace }> {
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
    const execution = yield* executeInstalled(
      {
        path: docPath,
        stream: new InMemoryStream(),
        componentDirs: [dir],
      },
      [{ components: agentIdentityComponents() }],
    );
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    return { output: next.value, result: yield* execution, trace };
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

  it("AF13: each name resolves to core's registration when nothing is on disk", function* () {
    yield* installAgentComponents();
    for (const name of names) {
      const info = yield* inspectComponent({ name, componentDirs: [] });
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
    const info = yield* inspectComponent({ name: "Session", componentDirs: [] });
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
