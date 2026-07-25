/**
 * Tier RP — root-provider lifecycle (specs/acp-client-spec.md §Provider
 * lifetime). Proves the public `rootProvider` seam that bridgeRootProvider
 * implements: the provider is active while the document runs, its Effection
 * finalizer runs exactly once after execution, completion awaits cleanup,
 * and teardown failures fold into the DocumentExecution completion. The
 * fake provider is an Effection resource whose finalizer is driven by scope
 * teardown — never a manual teardown call or a Promise.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { ensure } from "effection";
import type { Operation, Result, Stream } from "effection";
import { InMemoryStream } from "@executablemd/durable-streams";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { execute } from "../src/execute.ts";
import { Agent } from "../src/agent/agent-api.ts";
import type { AgentPromptEvent, PromptOptions, Session } from "../src/agent/agent-api.ts";
import { AgentPromptError } from "../src/agent/errors.ts";
import type { AgentProviderFactory, AgentProviderOptions } from "../src/agent/provider-seam.ts";
import { installAgentVocabulary } from "../src/agent/vocabulary.ts";

interface ProviderState {
  activeDuringPrompt: boolean;
  finalizeCount: number;
  cleanupDone: boolean;
  extraRan: boolean;
}

interface ProviderOpts {
  teardownError?: Error;
  extraFinalizer?: boolean;
  fail?: boolean;
}

function createProvider(opts: ProviderOpts = {}): {
  factory: AgentProviderFactory;
  state: ProviderState;
} {
  const state: ProviderState = {
    activeDuringPrompt: false,
    finalizeCount: 0,
    cleanupDone: false,
    extraRan: false,
  };
  let active = false;
  const factory: AgentProviderFactory = function* (options) {
    active = true;
    if (opts.extraFinalizer) {
      yield* ensure(() => {
        state.extraRan = true;
      });
    }
    yield* ensure(() => {
      state.finalizeCount++;
      state.cleanupDone = true;
      active = false;
      if (opts.teardownError) {
        throw opts.teardownError;
      }
    });
    yield* Agent.around(
      {
        // deno-lint-ignore require-yield
        *agent([name]) {
          return name ?? options.defaultAgent;
        },
        // deno-lint-ignore require-yield
        *session([name]) {
          return { sessionKey: `s:${name ?? "default"}`, cwd: "/" };
        },
        // deno-lint-ignore require-yield
        *prompt([content, promptOptions]) {
          return stubStream(state, () => active, content, promptOptions, opts.fail === true);
        },
      },
      { at: "min" },
    );
  };
  return { factory, state };
}

function stubStream(
  state: ProviderState,
  isActive: () => boolean,
  content: string,
  options: PromptOptions | undefined,
  fail: boolean,
): Stream<AgentPromptEvent, string> {
  return {
    *[Symbol.iterator]() {
      state.activeDuringPrompt = isActive();
      const session: Session =
        typeof options?.session === "object"
          ? options.session
          : { sessionKey: "s:default", cwd: "/" };
      const text = `[${content}]`;
      const terminal: AgentPromptEvent = fail
        ? { type: "terminal", status: "failed", stopReason: "refusal" }
        : { type: "terminal", status: "completed" };
      const events: AgentPromptEvent[] = [
        { type: "started", agent: options?.agent ?? "a", session },
        { type: "text_delta", text },
        terminal,
      ];
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

function* runDoc(doc: string): Operation<{ output: string; result: Result<string> }> {
  const dir = path.join(os.tmpdir(), `xmd-rp-test-${randomUUID()}`);
  yield* ensureDir(dir);
  try {
    const docPath = path.join(dir, "doc.md");
    yield* writeTextFile(docPath, doc);
    const execution = yield* execute({ docPath, stream: new InMemoryStream() });
    const subscription = yield* execution.output;
    let next = yield* subscription.next();
    while (!next.done) {
      next = yield* subscription.next();
    }
    const result = yield* execution;
    return { output: next.value, result };
  } finally {
    yield* rm(dir, { recursive: true, force: true });
  }
}

const OPTIONS: AgentProviderOptions = { defaultAgent: "a", permissionMode: "deny-all" };

describe("Tier RP — root-provider lifecycle", () => {
  it("RP1: provider is active during execution; its finalizer runs once, before completion settles", function* () {
    const { factory, state } = createProvider();
    yield* installAgentVocabulary({ rootProvider: { factory, options: OPTIONS } });
    const { output, result } = yield* runDoc('<Prompt prompt="hi" />\n');
    expect(result.ok).toBe(true);
    expect(output).toContain("[hi]");
    expect(state.activeDuringPrompt).toBe(true);
    expect(state.finalizeCount).toBe(1);
    // Completion only settled after cleanup ran.
    expect(state.cleanupDone).toBe(true);
  });

  it("RP2: a teardown failure still closes rendered output but makes completion an Err", function* () {
    const boom = new Error("teardown boom");
    const { factory } = createProvider({ teardownError: boom });
    yield* installAgentVocabulary({ rootProvider: { factory, options: OPTIONS } });
    const { output, result } = yield* runDoc('<Prompt prompt="hi" />\n');
    expect(output).toContain("[hi]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(boom);
    }
  });

  it("RP3: a prompt failure plus a teardown failure aggregate — primary first, every cleanup runs", function* () {
    const boom = new Error("teardown boom");
    const { factory, state } = createProvider({
      teardownError: boom,
      extraFinalizer: true,
      fail: true,
    });
    yield* installAgentVocabulary({ rootProvider: { factory, options: OPTIONS } });
    const { result } = yield* runDoc('<Prompt prompt="hi" />\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AggregateError);
      if (result.error instanceof AggregateError) {
        const errors = result.error.errors;
        expect(errors[0]).toBeInstanceOf(AgentPromptError);
        expect(errors[errors.length - 1]).toBe(boom);
        expect(result.error.message).toContain("agent prompt(s) failed");
        expect(result.error.message).toContain("teardown failed");
      }
    }
    // The non-throwing finalizer still ran despite the throwing one.
    expect(state.extraRan).toBe(true);
    expect(state.cleanupDone).toBe(true);
  });
});
