/**
 * Tier AF — agent flag parsing (specs/acp-client-spec.md
 * §Command-line configuration).
 *
 * `resolveAgentConfig` is a pure function over parsed flags: these tests
 * call it directly, with no Context Api, environment, or subprocess in
 * play. The environment fallback for the default agent is applied by the
 * CLI, not here.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { PermissionMode } from "@executablemd/core";
import { resolveAgentConfig } from "../src/agent-config.ts";
import type { AgentFlags } from "../src/agent-config.ts";

function flags(overrides: Partial<AgentFlags> = {}): AgentFlags {
  return {
    agentProvider: "acpx",
    defaultAgent: undefined,
    approveAll: false,
    approveReads: false,
    denyAll: false,
    ...overrides,
  };
}

describe("Tier AF — agent flag parsing", () => {
  it("AF1: no permission flag selects approve-reads", function* () {
    expect(resolveAgentConfig(flags())).toEqual({
      permissionMode: "approve-reads",
      defaultAgent: undefined,
    });
  });

  it("AF2: each explicit permission flag selects its own mode", function* () {
    const modes: [AgentFlags, PermissionMode][] = [
      [flags({ approveAll: true }), "approve-all"],
      [flags({ approveReads: true }), "approve-reads"],
      [flags({ denyAll: true }), "deny-all"],
    ];
    for (const [input, expected] of modes) {
      const config = resolveAgentConfig(input);
      expect("error" in config ? config.error : config.permissionMode).toBe(expected);
    }
  });

  it("AF3: more than one permission flag is an error", function* () {
    const combinations = [
      flags({ approveAll: true, denyAll: true }),
      flags({ approveReads: true, denyAll: true }),
      flags({ approveAll: true, approveReads: true }),
      flags({ approveAll: true, approveReads: true, denyAll: true }),
    ];
    for (const input of combinations) {
      const config = resolveAgentConfig(input);
      expect("error" in config).toBe(true);
      expect("error" in config ? config.error : "").toContain("mutually exclusive");
    }
  });

  it("AF4: the explicit default agent passes through untouched", function* () {
    const config = resolveAgentConfig(flags({ defaultAgent: "some-agent" }));
    expect("error" in config ? undefined : config.defaultAgent).toBe("some-agent");
  });

});
