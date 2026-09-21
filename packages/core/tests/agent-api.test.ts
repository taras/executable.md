/**
 * Tier AA — base Agent Api (specs/acp-client-spec.md).
 *
 * With no provider installed: agent()/session() throw a "no provider"
 * error, prompt() is cold (the stream is returned but subscribing throws),
 * and the default requestPermission denies. The error text references only
 * the provider-factory seam: registering a provider makes a factory
 * resolvable, but installing one into the Agent Api is what these
 * operations need, so the message must not point at the registry or a CLI
 * flag.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { Agent } from "../src/agent/agent-api.ts";
import type {
  AgentOptions,
  PermissionRequest,
  Session,
  SessionConfiguration,
} from "../src/agent/agent-api.ts";

function assertNoProviderError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain("no provider");
  // Must not point at provider-selection APIs or CLI flags: resolving a
  // provider is not installing one.
  expect(message).not.toContain("AgentProvider");
  expect(message).not.toContain("registerAgentProvider");
  expect(message).not.toContain("--agent-provider");
}

function request(options: PermissionRequest["options"]): PermissionRequest {
  return {
    session: { sessionKey: "s", cwd: "/" },
    toolCall: { toolCallId: "t1" },
    options,
  };
}

describe("Tier AA — base Agent Api", () => {
  it("AA1: agent() without a provider throws the adapted no-provider error", function* () {
    let caught: unknown;
    try {
      yield* Agent.operations.agent();
    } catch (error) {
      caught = error;
    }
    assertNoProviderError(caught);
  });

  it("AA2: session() without a provider throws the adapted no-provider error", function* () {
    let caught: unknown;
    try {
      yield* Agent.operations.session();
    } catch (error) {
      caught = error;
    }
    assertNoProviderError(caught);
  });

  it("AA3: prompt() is cold — dispatch returns the stream, subscribing throws", function* () {
    // Dispatch must not start a turn or throw.
    const stream = yield* Agent.operations.prompt("hello");
    // Subscribing to the cold stream is where the missing provider surfaces.
    let caught: unknown;
    try {
      yield* stream;
    } catch (error) {
      caught = error;
    }
    assertNoProviderError(caught);
  });

  it("AA4: default requestPermission prefers reject_once, then reject_always, else cancels", function* () {
    const both = yield* Agent.operations.requestPermission(
      request([
        { optionId: "ra", name: "Reject always", kind: "reject_always" },
        { optionId: "ro", name: "Reject once", kind: "reject_once" },
        { optionId: "ao", name: "Allow once", kind: "allow_once" },
      ]),
    );
    expect(both).toEqual({ outcome: "selected", optionId: "ro" });

    const alwaysOnly = yield* Agent.operations.requestPermission(
      request([
        { optionId: "ao", name: "Allow once", kind: "allow_once" },
        { optionId: "ra", name: "Reject always", kind: "reject_always" },
      ]),
    );
    expect(alwaysOnly).toEqual({ outcome: "selected", optionId: "ra" });

    const noRejection = yield* Agent.operations.requestPermission(
      request([{ optionId: "ao", name: "Allow once", kind: "allow_once" }]),
    );
    expect(noRejection).toEqual({ outcome: "cancelled" });
  });

  it("AA5: options() without a provider throws the adapted no-provider error", function* () {
    let caught: unknown;
    try {
      yield* Agent.operations.options("codex");
    } catch (error) {
      caught = error;
    }
    assertNoProviderError(caught);
  });
});

describe("Tier AA — configuration and option discovery compose", () => {
  const CHOICES: AgentOptions = {
    agent: "codex",
    model: {
      selected: "gpt-5.4",
      options: [
        { id: "gpt-5.4", name: "GPT-5.4", description: null, group: null },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: null, group: null },
      ],
    },
    effort: {
      selected: "medium",
      options: [{ id: "medium", name: "Medium", description: null, group: null }],
    },
  };

  it("AA6: a provider answers options() with provider-neutral choices", function* () {
    const asked: [string | undefined, string | undefined][] = [];
    const answered = yield* scoped(function* (): Operation<AgentOptions> {
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *options([agent, request]) {
            asked.push([agent, request?.model]);
            return CHOICES;
          },
        },
        { at: "min" },
      );
      return yield* Agent.operations.options("codex", { model: "gpt-5.4" });
    });

    expect(asked).toEqual([["codex", "gpt-5.4"]]);
    expect(answered).toEqual(CHOICES);
  });

  it("AA7: session middleware receives the placement and nothing else", function* () {
    // Model and effort are settings a `<Session>` supplies, not inputs a
    // handler composes. Routing them here would make them a value every
    // handler could edit, and the conversation would run under the last thing
    // anybody wrote — so the route carries a name, and what a conversation runs
    // under travels on the value that names it.
    const routed: unknown[][] = [];
    yield* scoped(function* (): Operation<void> {
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *session(args): Operation<Session> {
            routed.push([...args]);
            return { sessionKey: "s", cwd: "/" };
          },
        },
        { at: "min" },
      );
      yield* Agent.operations.session("review");
      yield* Agent.operations.session();
    });

    // One argument when a name was given, and none when it was not: an absent
    // name routed as an explicit undefined would read as an ask of its own.
    expect(routed).toEqual([["review"], []]);
  });

  it("AA8: a wrapper that delegates hands the placement on unchanged", function* () {
    const seen: unknown[][] = [];
    yield* scoped(function* (): Operation<void> {
      yield* Agent.around(
        {
          // deno-lint-ignore require-yield
          *session(args): Operation<Session> {
            seen.push([...args]);
            return { sessionKey: "s", cwd: "/" };
          },
        },
        { at: "min" },
      );
      yield* Agent.around({
        *session(args, next): Operation<Session> {
          return yield* next(...args);
        },
      });
      yield* Agent.operations.session("review");
      yield* Agent.operations.session();
    });

    expect(seen).toEqual([["review"], []]);
  });
});
