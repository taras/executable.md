/**
 * Tier AE — embedded adapters on the run and plan paths
 * (specs/acp-client-spec.md §Command-line configuration, §The `xmd plan`
 * authorship profile).
 *
 * What a provider was built from is not observable through a provider: an agent
 * command reaches the disk only when something spawns it, and a case that
 * watched a turn fail would be reading whichever Codex or Claude the machine
 * running the suite happens to have. So these read the dependencies each path
 * hands `createAcpxProvider`, which is the decision this host makes and the one
 * that was missing (#672).
 *
 * Nothing here materializes anything. Every root is a temporary path, and the
 * resolutions asked for are settled by the bytes this build carries.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "@executablemd/runtime";
import { createEmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { EmbeddedAdapters } from "@executablemd/acp/embedded-adapters";
import type { Operation } from "effection";

import {
  DEFAULT_ADAPTER_ROOT,
  hostAcpDependencies,
  resolveAgentStack,
} from "../src/agent-stack.ts";
import type { AgentStack } from "../src/agent-stack.ts";
import { authorshipCeiling } from "../src/authorship-profile.ts";
import type { AuthorshipProfile, CandidateAssessment } from "../src/authorship-profile.ts";

/** The two agents this build carries a patched snapshot for. */
const EMBEDDED = ["codex", "claude"] as const;

/** A root under this machine's temporary tree, never written to. */
function adapterRoot(): string {
  return join(tmpdir(), `xmd-adapters-${randomUUID()}`);
}

function stackWith(adapters: EmbeddedAdapters): AgentStack {
  return { provider: "acpx", defaultAgent: "codex", permissionMode: "deny-all", adapters };
}

/** The profile `xmd plan` builds its ceiling from, with nothing else supplied. */
function profileWith(stack: AgentStack): AuthorshipProfile {
  return {
    request: "write a greeting",
    syntax: "",
    session: "xmd-plan:case",
    explicitSession: false,
    root: adapterRoot(),
    stack,
    // deno-lint-ignore require-yield
    *installElicitation(): Operation<void> {},
    // deno-lint-ignore require-yield
    *assess(): Operation<CandidateAssessment> {
      return { valid: true, diagnostics: {} };
    },
  };
}

describe("Tier AE — embedded adapters on the run and plan paths", () => {
  it("AE1: the run path resolves an embedded agent to this build's own adapter", function* () {
    const root = adapterRoot();
    const adapters = createEmbeddedAdapters(root);
    const registry = hostAcpDependencies(stackWith(adapters)).agentRegistry;
    if (registry === undefined) {
      throw new Error("the run path handed its provider no agent registry");
    }

    for (const agent of EMBEDDED) {
      const command = registry.resolve(agent);
      expect(command).toBe(adapters.command(agent));
      // The failure this replaces: ACPX's own table resolves both of these to
      // an `npx` of a published adapter, pinned by the version range that build
      // recorded rather than by the snapshot this one carries.
      expect(command).not.toContain("npx");
      expect(command).toContain(root);
    }
  });

  it("AE2: an agent this build carries no snapshot for resolves as it always did", function* () {
    const root = adapterRoot();
    const registry = hostAcpDependencies(stackWith(createEmbeddedAdapters(root))).agentRegistry;
    if (registry === undefined) {
      throw new Error("the run path handed its provider no agent registry");
    }

    // An overlay, not a replacement: carrying a Codex adapter is no reason to
    // stop a run from using Gemini, and ACPX's command for it is still the one
    // this host runs.
    expect(registry.resolve("gemini")).not.toContain(root);
    expect(registry.list()).toContain("gemini");
    for (const agent of EMBEDDED) {
      expect(registry.list()).toContain(agent);
    }
  });

  it("AE3: the plan path's ceiling hands its provider the same registry", function* () {
    const root = adapterRoot();
    const adapters = createEmbeddedAdapters(root);
    const stack = stackWith(adapters);
    const ceiling = authorshipCeiling(profileWith(stack), join(root, "workdir"));
    const registry = ceiling.agentRegistry;
    if (registry === undefined) {
      throw new Error("the plan path handed its provider no agent registry");
    }

    for (const agent of EMBEDDED) {
      expect(registry.resolve(agent)).toBe(adapters.command(agent));
      expect(registry.resolve(agent)).not.toContain("npx");
    }
    // Beside the clauses that make it a ceiling, not instead of them.
    expect(ceiling.mcpServers).toEqual([]);
    expect(ceiling.permissions).toBe("strict");
    expect(ceiling.newSessionOptions?.allowedTools).toEqual([]);
  });

  it("AE4: preparing an agent this build carries nothing for writes nothing", function* () {
    const root = adapterRoot();
    const prepare = hostAcpDependencies(stackWith(createEmbeddedAdapters(root))).prepareAgent;
    if (prepare === undefined) {
      throw new Error("the run path handed its provider no preparation");
    }

    yield* prepare("gemini");

    // Materialization is for an agent this build carries a snapshot for. Every
    // other name is already a command on this machine, and asking about one
    // creates no directory to install into.
    expect(yield* exists(root)).toBe(false);
  });

  it("AE5: a settled stack carries this host's own adapter root", function* () {
    yield* API.Env.around({
      // deno-lint-ignore require-yield
      *env(): Operation<string | undefined> {
        return undefined;
      },
    });
    const settled = yield* resolveAgentStack(
      {
        agentProvider: "acpx",
        defaultAgent: undefined,
        approveAll: false,
        approveReads: false,
        denyAll: false,
      },
      undefined,
    );
    if (!settled.ok) {
      throw settled.error;
    }

    // The resolution supplies them, so no consumer of the settled answer has a
    // registry to fall back to.
    for (const agent of EMBEDDED) {
      expect(settled.value.adapters.executablePath(agent)).toContain(DEFAULT_ADAPTER_ROOT);
    }
  });
});
