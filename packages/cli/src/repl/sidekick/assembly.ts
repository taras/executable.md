/**
 * What the Sidekick's own conversations are built under (#883).
 *
 * The Sidekick is not an entry. An entry runs a document a person wrote and may
 * reasonably reach the tools that command was started with; a Sidekick
 * conversation is a chat about those documents, and what it is allowed to do is
 * this host's decision rather than an inheritance. So it installs a provider of
 * its own, and that provider is handed the constraints explicitly: no
 * coding-agent tools, no MCP servers, every native permission request denied
 * without asking anybody, and no customization of the agent's own system
 * prompt.
 *
 * Explicit, because an omitted option is not a constraint. A provider given no
 * tool list leaves the agent whatever tools it has, which is the opposite of
 * what this host means — and it is also unstatable, so a conversation that
 * compares what it was created under would have nothing to compare. Stating
 * them is what makes the configuration a fact the chat can be held to when it
 * is reopened.
 *
 * It reuses the command's resolved provider dependencies — the same runtime,
 * session store and registry the entry stack was assembled with — and replaces
 * only what the Sidekick decides. Nothing here changes what an entry, a Plan or
 * a raw programmatic session gets.
 */

import { installAgentComponents } from "@executablemd/core";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { PermissionMode } from "@executablemd/core";
import type { Operation } from "effection";
import { createAcpxProvider } from "@executablemd/acp";
import type { AcpxProviderDependencies } from "@executablemd/acp";

import type { SidekickAssembly } from "./owner.ts";

/**
 * How a Sidekick conversation answers a native permission request.
 *
 * `deny-all` and nothing else. There is no terminal in front of a Sidekick turn
 * — the person is reading a chat, not watching a document run — so a request
 * that asked would be a request nobody could answer.
 */
const PERMISSION_MODE: PermissionMode = "deny-all";

/**
 * Assemble the Sidekick's provider and the installation that installs it.
 *
 * One installation, carrying one root provider. It is the only thing a Sidekick
 * conversation's execution installs: the entry profile's vocabulary belongs to
 * entries, and a response is evaluated under the ceiling the evaluation was
 * handed rather than under whatever the command declared.
 */
export function sidekickAssembly(
  agent: string,
  dependencies: AcpxProviderDependencies,
): SidekickAssembly {
  const options = { defaultAgent: agent, permissionMode: PERMISSION_MODE };
  const factory = createAcpxProvider({
    ...dependencies,
    // Strict routing, so a request is answered here rather than composed
    // around by whatever an entry installed. The mode alone would not say
    // that, which is why the saved configuration carries all three.
    permissions: "strict",
    // Both lists stated. `[]` is this host configuring none, which is a
    // different fact from leaving the agent's own set in place.
    mcpServers: [],
    newSessionOptions: { allowedTools: [] },
  });
  const installation: ExecutionInstallation = {
    *install(): Operation<void> {
      yield* installAgentComponents({
        defaultAgent: agent,
        permissionMode: PERMISSION_MODE,
        rootProvider: { factory, options },
      });
    },
  };
  return { agent, installations: [installation] };
}
