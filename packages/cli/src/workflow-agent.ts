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
 * one. What makes that decidable is retained in the run's own provider-session
 * sidecar, which `@executablemd/workflow/deno` owns; this module is where that
 * sidecar meets ACPX, because this is the only side that names an agent client.
 *
 * The empty working directory is a deterministic subpath of that sidecar, so
 * ACPX sees the same cwd spelling on a restart and reuses its record rather than
 * placing a second session beside it. It is emptied before use — the same path
 * can hold residue after an unstructured process death — and nothing is ever
 * copied into it or read back out of it.
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
import {
  providerSessionDirectory,
  resolveProviderSession,
  retainProviderSessionIdentity,
  useEmptyDirectory,
  useProviderSessions,
  writeProviderSession,
} from "@executablemd/workflow/deno";
import type {
  ProviderSessionPaths,
  ProviderSessionState,
  WorkflowAgentAttachment,
} from "@executablemd/workflow/deno";

/** How this host names itself in a retained provider-session record. */
const PROVIDER = "acpx";

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
 * What the provider still holds for one of its own session keys.
 *
 * Read from the ACPX store rather than from `ensureSession()`, which would
 * create the session this asks about.
 */
function probeFor(store: AcpxSessionStore) {
  return function* (sessionKey: string): Operation<ProviderSessionState | undefined> {
    const held = yield* retainedSession(store, sessionKey);
    if (held === undefined) {
      return undefined;
    }
    const state: ProviderSessionState = { agentCommand: held.agentCommand };
    return held.agentSessionId === undefined
      ? state
      : { ...state, nativeSessionId: held.agentSessionId };
  };
}

/**
 * Where this run's Agent sessions live, and which of them it may continue.
 *
 * Placement is the linearization point for both decisions: it happens before
 * ACPX is contacted, so a retained session this host cannot continue is refused
 * before a turn could start against a replacement.
 */
function sessionPolicy(
  paths: ProviderSessionPaths,
  runId: string,
  policy: string,
  store: AcpxSessionStore,
): AcpxSessionPolicy {
  const probe = probeFor(store);
  /**
   * The directories this attachment has already emptied.
   *
   * Once per session, not once per turn: a placement happens for every prompt,
   * and emptying a directory an agent process is standing in would be this
   * host removing the ground under its own child.
   */
  const emptied = new Set<string>();
  return {
    *place(context) {
      const resolved = yield* resolveProviderSession(
        paths,
        {
          runId,
          provider: PROVIDER,
          agentCommand: context.agentCommand,
          ...(context.session === undefined ? {} : { session: context.session }),
        },
        policy,
        probe,
      );
      if (!resolved.ok) {
        throw resolved.error;
      }
      const { record } = resolved.value;
      // Retained before ACPX is contacted, so an attempt interrupted between
      // creating the session and recording it leaves the key resolvable rather
      // than ambiguous: the next attachment finds a record with no native
      // identity yet, which is the state that adopts whichever one the provider
      // is still holding.
      if (resolved.value.kind === "create") {
        yield* writeProviderSession(paths, record);
      }
      // Emptied once per attachment, reattachment included: ACPX reuses a
      // record only for the same cwd spelling, and an agent standing in a
      // directory holding residue is reading something no attachment put there.
      const cwd = providerSessionDirectory(paths, record.sessionKey);
      if (!emptied.has(cwd)) {
        emptied.add(cwd);
        yield* useEmptyDirectory(cwd);
      }
      return { sessionKey: record.sessionKey, cwd };
    },
    *established(placement, identity) {
      if (identity.agentSessionId === undefined) {
        // The adapter asserted no native identity. There is nothing to retain,
        // and nothing a later attachment could be held to.
        return;
      }
      const retained = yield* retainProviderSessionIdentity(
        paths,
        placement.sessionKey,
        identity.agentSessionId,
      );
      if (!retained.ok) {
        throw retained.error;
      }
    },
  };
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

  const factory: AgentProviderFactory = createAcpxProvider({
    sessionStore: store,
    ...(options.createRuntime === undefined ? {} : { createRuntime: options.createRuntime }),
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
    sessions: sessionPolicy(paths, runId, policy, store),
  });

  yield* registerAgentProvider(PROVIDER, factory);
  yield* installAgentComponents({
    defaultAgent,
    permissionMode: "deny-all",
    rootProvider: { factory, options: { defaultAgent, permissionMode: "deny-all" } },
  });
  yield* installPermissionMode("deny-all");
}
