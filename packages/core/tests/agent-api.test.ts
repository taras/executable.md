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
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { Agent } from "../src/agent/agent-api.ts";
import type { PermissionRequest } from "../src/agent/agent-api.ts";

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
});
