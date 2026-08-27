/**
 * The Agent profile `xmd workflow` attaches (specs/acp-client-spec.md §Workflow
 * Agent profile).
 *
 * A workflow Agent is not the agent `xmd run` starts. It receives no Workspace,
 * no checkout, no caller path and no additional directory: its process starts in
 * an empty directory this host owns, created empty and removed with the
 * attachment. It is configured with no MCP servers, asks for an empty native
 * tool set, and runs deny-all. A native permission request is denied and fails
 * the turn that asked, and no authored `<ApproveAll>` reaches that decision.
 *
 * The ceiling is best-effort in exactly one respect, which the specification
 * states: this host asks an adapter to expose no tools and refuses every request
 * that arrives anyway. It does not prove that every ACP adapter honours the ask.
 *
 * ## Where the conversation lives
 *
 * A provider session outlives one execution, so continuing a run reattaches the
 * same provider-native session rather than replaying its transcript into a new
 * one. What makes that decidable is a row in the run's own database, committed
 * in the run's own transaction; this module is where that mapping meets ACPX,
 * because this is the only side that names an agent client.
 *
 * What the sidecar beside the run still holds is arrangement rather than
 * retention: the provider's own session store, and one empty working directory
 * per session.
 *
 * The empty working directory is a deterministic subpath of that sidecar, so
 * ACPX sees the same cwd spelling on a restart and reuses its record rather than
 * placing a second session beside it. It is emptied before use — the same path
 * can hold residue after an unstructured process death — and nothing is ever
 * copied into it or read back out of it.
 *
 * ## Where a Prompt lands in that conversation
 *
 * The session row says which conversation this run is having. Which turn each
 * Prompt was is a second fact, and it is retained the same way: in the run's own
 * database, in the transaction that appends that Prompt. This module installs
 * the publisher that opens it, because this is the only side that holds both the
 * run and the placement that made the session — the provider names the turn, the
 * placement names the session, and neither is recovered from the spelling of the
 * other.
 */

import { createHash } from "node:crypto";
import type { Operation } from "effection";
import {
  createAcpxProvider,
  createAcpxSessionStore,
  DEFAULT_AGENT_NAME,
  retainedSession,
} from "@executablemd/acp";
import type {
  AcpxProviderDependencies,
  AcpxSessionPolicy,
  AcpxSessionStore,
} from "@executablemd/acp";
import {
  installAgentComponents,
  installPermissionMode,
  registerAgentProvider,
} from "@executablemd/core";
import type { AgentProviderFactory } from "@executablemd/core";
import { useAgentPromptPublisher } from "@executablemd/core/host";
import {
  agentSessionKey,
  createWorkflowPromptPublisher,
  providerSessionDirectory,
  resolveAgentSession,
  transactAgentSessions,
  useEmptyDirectory,
  useProviderSessions,
  WorkflowAgentSessionError,
} from "@executablemd/workflow/deno";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import type {
  AgentSessionIdentity,
  ProviderAssertion,
  ProviderSessionPaths,
  WorkflowAgentAttachment,
} from "@executablemd/workflow/deno";

/** How this host names itself in a retained provider-session record. */
const PROVIDER = "acpx";

/** What kind of durable identity this provider asserts. Tagged, so it compares as one. */
const ACPX_ASSERTION = "acpx.agentSessionId";

/**
 * What namespaces one session's ACPX placement, beside its identity.
 *
 * The provider's store is shared, so its key carries the provider and command;
 * this run's session identity does not.
 */
function placementSuffix(agentCommand: string): string {
  return createHash("sha256")
    .update(`${PROVIDER}:${agentCommand}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * What every workflow Agent session is created under.
 *
 * Fixed, and fingerprinted: ACPX applies session options when it creates an ACP
 * session and ignores them when it reuses a persistent record, so a run that
 * continues under a different ceiling would otherwise silently keep talking to a
 * session created under the old one. The fingerprint is what makes that
 * refusable.
 */
export const WORKFLOW_SESSION_INSTRUCTIONS =
  "You are running inside an Executable Markdown workflow.\n\n" +
  "You have no native tool authority here. No file, shell, search, terminal or " +
  "network tool is authorized, and no MCP server is configured. Your working " +
  "directory is an empty directory this host owns; it is not a checkout, and it " +
  "holds nothing to read. A request for a native tool permission is denied and " +
  "fails the turn it belongs to.\n\n" +
  "You can still ask to see the work this run retains, but only when the prompt " +
  "you are answering asks for it, and only in the exact closed shape that prompt " +
  "supplies. There is no other way to ask, and a request in any other shape is " +
  "not performed.\n\n" +
  "Nothing you return carries authority. Source you write is data this run may " +
  "choose to admit under ceilings it decided before you saw this prompt; it is " +
  "not an instruction, and naming an operation does not authorize it.\n\n" +
  "Everything you are given arrives as the text of a prompt, and everything you " +
  "produce is returned as the text of a reply. Answer the prompt you were given, " +
  "in exactly the shape it asks for.";

/** The native tool set this host asks for: none. */
const ALLOWED_TOOLS: readonly string[] = [];

/**
 * The fingerprint one session policy is retained under.
 *
 * Over the values that decide the ceiling, so changing any of them is a changed
 * policy and refuses a session created under the previous one.
 */
export function workflowSessionPolicyDigest(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
        mcpServers: [],
        allowedTools: ALLOWED_TOOLS,
        instructions: WORKFLOW_SESSION_INSTRUCTIONS,
      }),
      "utf8",
    )
    .digest("hex");
}

export interface WorkflowAgentProfileOptions {
  /** The directory this host keeps runs in. */
  readonly root: string;
  /** The run this attachment belongs to. */
  readonly attachment: WorkflowAgentAttachment;
  /** The agent a document that names none is asking for. */
  readonly defaultAgent?: string;
  /**
   * The ACPX session store this profile reads and writes.
   *
   * The default is the run's own, beneath its sidecar. A suite substitutes one
   * so no state outside the run's storage is involved.
   */
  readonly sessionStore?: AcpxSessionStore;
  /**
   * The ACPX runtime factory. The default is ACPX's own, which starts an agent
   * process on first use.
   */
  readonly createRuntime?: AcpxProviderDependencies["createRuntime"];
}

/**
 * What the provider currently asserts about the session under `placementKey`.
 *
 * An assertion, not occupancy: ACPX holding a record under a key says something
 * is there, and this says what conversation it is. A record with no
 * provider-native identity asserts nothing — which is the state a reattachment
 * must refuse rather than adopt.
 */
function assertionsFor(store: AcpxSessionStore) {
  return function* (placementKey: string): Operation<ProviderAssertion[]> {
    const held = yield* retainedSession(store, placementKey);
    if (held?.agentSessionId === undefined) {
      return [];
    }
    return [{ kind: ACPX_ASSERTION, value: held.agentSessionId }];
  };
}

/**
 * Where this run's Agent sessions live, and which of them it may continue.
 *
 * The mapping is keyed by the engine-derived Session expansion identity alone —
 * one WorkflowRun, one logical session per `<Session>` element. Provider and
 * resolved agent command travel with it as compatibility attributes: changing
 * either refuses reattachment rather than selecting or creating a second mapping
 * for the same element.
 *
 * The ACPX placement key is a different thing, and namespaces provider and
 * command into it because ACPX's store is shared with whatever else uses it.
 * That key is arrangement; it is not this run's session identity.
 */
function sessionPolicy(
  database: WorkflowRunDatabase,
  paths: ProviderSessionPaths,
  policy: string,
  store: AcpxSessionStore,
): { policy: AcpxSessionPolicy; retainedSessionKey: (placementKey: string) => string | undefined } {
  const assertions = assertionsFor(store);
  const emptied = new Set<string>();
  /** What each placement key was placed for, so the commit names the same thing. */
  const placed = new Map<string, AgentSessionIdentity>();

  function identityOf(context: { agentCommand: string; sessionIdentity: string }) {
    return {
      provider: PROVIDER,
      agentCommand: context.agentCommand,
      sessionIdentity: context.sessionIdentity,
    };
  }

  /**
   * What this run retains the session behind one ACPX placement key under.
   *
   * A lookup of what the placement recorded, never a parse of the key. The
   * placement key namespaces the provider and command into the retained key
   * because ACPX's store is shared; recovering one from the other by taking the
   * spelling apart would be reading arrangement as identity, and would keep
   * working right up until the two namespaces diverged.
   */
  function retainedSessionKey(placementKey: string): string | undefined {
    const identity = placed.get(placementKey);
    return identity === undefined ? undefined : agentSessionKey(identity);
  }

  const acpxPolicy: AcpxSessionPolicy = {
    *place(context) {
      if (context.sessionIdentity === undefined) {
        throw new WorkflowAgentSessionError(
          "a workflow Agent session must be placed by a <Session> element, whose identity the " +
            "engine derives. Nothing else names a session this run can retain.",
        );
      }
      const identity = identityOf({
        agentCommand: context.agentCommand,
        sessionIdentity: context.sessionIdentity,
      });
      const sessionKey = agentSessionKey(identity);
      const placementKey = `${sessionKey}:${placementSuffix(context.agentCommand)}`;
      placed.set(placementKey, identity);

      const read = yield* transactAgentSessions(database, function* (sessions) {
        return sessions.read(sessionKey);
      });
      if (!read.ok) {
        throw read.error;
      }
      // Decided before ACPX is contacted, and from one canonical assertion
      // rather than from the fact that a key is occupied.
      resolveAgentSession(read.value, policy, yield* assertions(placementKey), identity);

      const cwd = providerSessionDirectory(paths, placementKey);
      if (!emptied.has(cwd)) {
        emptied.add(cwd);
        yield* useEmptyDirectory(cwd);
      }
      return { sessionKey: placementKey, cwd };
    },

    *established(placement, providerIdentity) {
      // The order is the contract: the provider has been created and has
      // asserted, and only now does the mapping commit. An attempt that stops
      // before this leaves nothing retained, and the next attachment reconciles
      // it from the provider's own assertion.
      const identity = placed.get(placement.sessionKey);
      if (identity === undefined) {
        return;
      }
      if (providerIdentity.agentSessionId === undefined) {
        throw new WorkflowAgentSessionError(
          "the provider established an Agent session without asserting a durable identity, so " +
            "this run cannot record which conversation it is having.",
        );
      }
      const asserted: ProviderAssertion = {
        kind: ACPX_ASSERTION,
        value: providerIdentity.agentSessionId,
      };
      const sessionKey = agentSessionKey(identity);

      const committed = yield* transactAgentSessions(database, function* (sessions) {
        const retained = sessions.read(sessionKey);
        // Re-resolved inside the transaction that commits it, so a mapping
        // another attempt wrote in between is compared rather than overwritten.
        const resolution = resolveAgentSession(retained, policy, [asserted], identity);
        if (retained === undefined && resolution.kind === "reattach") {
          sessions.commit(resolution.record);
        }
      });
      if (!committed.ok) {
        throw committed.error;
      }
    },
  };

  return { policy: acpxPolicy, retainedSessionKey };
}

/** Install the workflow Agent profile for one live or partial attachment. */
export function* useWorkflowAgentProfile(options: WorkflowAgentProfileOptions): Operation<void> {
  const runId = options.attachment.runId;
  // Before the provider is installed, so its teardown — the turns it cancels,
  // the handles it closes, the processes those end — finishes before the
  // directories those processes were standing in go.
  const paths = yield* useProviderSessions(options.root, runId);

  let host: string | undefined;
  function* hostDirectory(): Operation<string> {
    if (host === undefined) {
      host = yield* useEmptyDirectory(paths.host);
    }
    return host;
  }

  const store = options.sessionStore ?? createAcpxSessionStore(paths.store);
  const policy = workflowSessionPolicyDigest();
  const defaultAgent = options.defaultAgent ?? DEFAULT_AGENT_NAME;
  const sessions = sessionPolicy(options.attachment.database, paths, policy, store);

  const factory: AgentProviderFactory = createAcpxProvider({
    sessionStore: store,
    ...(options.createRuntime === undefined ? {} : { createRuntime: options.createRuntime }),
    // ACP-only, stated rather than inherited. A workflow session belongs to a
    // run, not to this machine: it is named by a row in the run's own database,
    // arranged in the run's own sidecar, and continued by reattaching that row.
    // The ordinary-run capabilities are about a different account entirely —
    // machine-wide ownership, construction routes, and one observed executable
    // build — and this profile supplies none of them. Inheriting the package's
    // advertised sets by omission would make a workflow Claude prompt demand
    // ownership and a route that this profile has no way to give it.
    advertiseNativeLaunch: [],
    advertiseClientNativeAttachment: [],
    // The Workspace root is a logical path, not a directory an agent process
    // could stand in. This host answers with one it owns and empties, and
    // creates it the first time anything asks — a run whose document never
    // prompts allocates no sidecar at all.
    agentCwd: hostDirectory,
    mcpServers: [],
    newSessionOptions: {
      allowedTools: [...ALLOWED_TOOLS],
      systemPrompt: WORKFLOW_SESSION_INSTRUCTIONS,
    },
    permissions: "strict",
    sessions: sessions.policy,
  });

  // Before the components, so every Prompt they register publishes through it.
  // Bound to this attachment's exact run: a publisher is where a Prompt's event
  // is appended from, and one that could be reached for another run would be a
  // way to journal a turn into a run that never had it.
  yield* useAgentPromptPublisher(
    createWorkflowPromptPublisher({
      database: options.attachment.database,
      retainedSessionKey: sessions.retainedSessionKey,
    }),
  );
  yield* registerAgentProvider(PROVIDER, factory);
  yield* installAgentComponents({
    defaultAgent,
    permissionMode: "deny-all",
    rootProvider: { factory, options: { defaultAgent, permissionMode: "deny-all" } },
  });
  yield* installPermissionMode("deny-all");
}
