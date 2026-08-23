/**
 * Tier WSL — what a run retains about its Agent sessions
 * (specs/workflow-workspace-spec.md §8.5).
 *
 * The mapping lives in the run's own database, so these drive the real table
 * through the real transaction. What is under test is the decision a second
 * attachment makes, and the rule it is made under: a session is continued from
 * one canonical, tagged provider assertion, never from the fact that a provider
 * is holding a key.
 *
 * Identity is the engine's. Within one run the mapping key is the Agent/Session
 * expansion identity alone; the provider and the resolved agent command travel
 * beside it as compatibility attributes, and changing either refuses rather than
 * selecting or creating a second mapping.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { exists, readdir, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { scoped } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle } from "../mod.ts";
import type { WorkflowRunDatabase } from "../mod.ts";
import {
  agentSessionKey,
  providerSessionDirectory,
  resolveAgentSession,
  transactAgentSessions,
  useEmptyDirectory,
  useProviderSessions,
  useWorkflowLifecycle,
  workflowProviderSessions,
  workflowRunPath,
} from "../deno.ts";
import type {
  AgentSessionIdentity,
  AgentSessionRecord,
  ProviderAssertion,
  ProviderSessionPaths,
} from "../deno.ts";
import {
  createRun,
  creation,
  useStorageRoot,
  withExecutorRun,
  withRunHost,
  withStorage,
} from "./support/storage.ts";

const PROVIDER = "acpx";
const AGENT = "codex-cmd";
const POLICY = "policy-digest-a";
const KIND = "acpx.agentSessionId";

/** Two `<Session>` elements the engine derived distinct identities for. */
const FIRST = "expansion:review-a";
const SECOND = "expansion:review-b";

function identity(overrides: Partial<AgentSessionIdentity> = {}): AgentSessionIdentity {
  return { provider: PROVIDER, agentCommand: AGENT, sessionIdentity: FIRST, ...overrides };
}

function asserted(value: string): ProviderAssertion {
  return { kind: KIND, value };
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  const base = identity();
  return {
    sessionKey: agentSessionKey(base),
    ...base,
    policy: POLICY,
    assertion: asserted("agent-session:alpha"),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** What one resolution did, as a value rather than a throw. */
function attempt(
  retained: AgentSessionRecord | undefined,
  policy: string,
  assertions: readonly ProviderAssertion[],
  who: AgentSessionIdentity,
): { kind?: string; refusal?: string } {
  try {
    return { kind: resolveAgentSession(retained, policy, assertions, who).kind };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

/** One read of this run's mapping table, inside the run's own transaction. */
function readMapping(
  database: WorkflowRunDatabase,
  key: string,
): Operation<AgentSessionRecord | undefined> {
  return (function* () {
    const result = yield* transactAgentSessions(database, function* (sessions) {
      return sessions.read(key);
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  })();
}

/** One commit, in the run's own transaction. */
function commitMapping(database: WorkflowRunDatabase, entry: AgentSessionRecord): Operation<void> {
  return (function* () {
    const result = yield* transactAgentSessions(database, function* (sessions) {
      sessions.commit(entry);
    });
    if (!result.ok) {
      throw result.error;
    }
  })();
}

function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* body();
  });
}

describe("Tier WSL — retained workflow Agent sessions", () => {
  it("WSL1: the mapping key is the engine identity alone", function* () {
    // Two sibling `<Session name="review">` elements: same authored name, same
    // provider, same agent, different engine identity. Two sessions.
    const first = agentSessionKey(identity());
    const second = agentSessionKey(identity({ sessionIdentity: SECOND }));
    expect(first).not.toBe(second);

    // Provider and command are compatibility attributes, not part of the key —
    // changing one refuses rather than addressing a different mapping.
    expect(agentSessionKey(identity({ agentCommand: "claude-cmd" }))).toBe(first);
    expect(agentSessionKey(identity({ provider: "other" }))).toBe(first);
  });

  it("WSL2: a session is created only when neither side holds anything", function* () {
    expect(attempt(undefined, POLICY, [], identity())).toEqual({ kind: "create" });
  });

  it("WSL3: an interruption before the commit reconciles from one canonical assertion", function* () {
    // The pre-commit window: the provider was created and asserted, and the
    // mapping never committed. Exactly one canonical assertion reconciles it.
    expect(attempt(undefined, POLICY, [asserted("agent-session:alpha")], identity())).toEqual({
      kind: "reattach",
    });

    const ambiguous = attempt(
      undefined,
      POLICY,
      [asserted("agent-session:alpha"), asserted("agent-session:beta")],
      identity(),
    );
    expect(ambiguous.kind).toBe(undefined);
    expect(ambiguous.refusal).toContain("more than one durable identity");
  });

  it("WSL4: missing, mismatched, replaced, changed and ambiguous each refuse", function* () {
    const cases = [
      {
        name: "the provider asserts nothing for a session this run retained",
        assertions: [] as ProviderAssertion[],
        who: identity(),
        says: "asserts no durable identity",
      },
      {
        name: "the provider asserts a different identity",
        assertions: [asserted("agent-session:replacement")],
        who: identity(),
        says: "different durable identity",
      },
      {
        name: "the assertion is a different kind of thing",
        assertions: [{ kind: "acp.sessionId", value: "agent-session:alpha" }],
        who: identity(),
        says: "different durable identity",
      },
      {
        name: "the agent command changed",
        assertions: [asserted("agent-session:alpha")],
        who: identity({ agentCommand: "claude-cmd" }),
        says: "different provider, agent or session policy",
      },
      {
        name: "the provider changed",
        assertions: [asserted("agent-session:alpha")],
        who: identity({ provider: "other" }),
        says: "different provider, agent or session policy",
      },
      {
        name: "the session policy changed",
        assertions: [asserted("agent-session:alpha")],
        who: identity(),
        policy: "policy-digest-b",
        says: "different provider, agent or session policy",
      },
      {
        name: "more than one assertion",
        assertions: [asserted("agent-session:alpha"), asserted("agent-session:beta")],
        who: identity(),
        says: "more than one durable identity",
      },
    ];

    for (const scenario of cases) {
      const outcome = attempt(
        record(),
        scenario.policy ?? POLICY,
        scenario.assertions,
        scenario.who,
      );
      expect(`${scenario.name}: ${outcome.kind ?? "refused"}`).toBe(`${scenario.name}: refused`);
      expect(`${scenario.name}: ${outcome.refusal}`).toContain(scenario.says);
    }
  });

  it("WSL5: a matching assertion reattaches the retained mapping unchanged", function* () {
    const retained = record();
    const outcome = resolveAgentSession(
      retained,
      POLICY,
      [asserted("agent-session:alpha")],
      identity(),
    );
    expect(outcome.kind).toBe("reattach");
    expect(outcome.kind === "reattach" ? outcome.record : undefined).toBe(retained);
  });

  it("WSL6: the mapping commits in the run's own transaction and reads back per Session", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const key = agentSessionKey(identity());

      // The table exists because the run's schema declares it — created by the
      // same initialization that created every other table, in one transaction.
      expect(yield* readMapping(database, key)).toBe(undefined);

      yield* commitMapping(database, record());

      const back = yield* readMapping(database, key);
      expect(back?.assertion).toEqual(asserted("agent-session:alpha"));
      expect(back?.sessionIdentity).toBe(FIRST);
      // The sibling Session has its own mapping, and does not see this one.
      const sibling = agentSessionKey(identity({ sessionIdentity: SECOND }));
      expect(yield* readMapping(database, sibling)).toBe(undefined);
    });
  });

  it("WSL6: a transaction that fails commits no mapping", function* () {
    const root = yield* useStorageRoot();
    yield* withStorage(root, function* () {
      const database = yield* createRun();
      const key = agentSessionKey(identity());

      const result = yield* transactAgentSessions(database, function* (sessions) {
        sessions.commit(record());
        throw new Error("the attempt failed after writing the mapping");
      });
      expect(result.ok).toBe(false);

      // Rolled back with everything else the attempt did: an interruption
      // between the provider's assertion and this run recording it leaves
      // nothing retained, which is the state the pre-commit rule reconciles.
      expect(yield* readMapping(database, key)).toBe(undefined);
    });
  });

  it("WSL7: every attachment gets an empty directory, and none of them outlives it", function* () {
    const root = yield* useStorageRoot();
    let sessionCwd = "";
    let hostCwd = "";

    yield* scoped(function* () {
      const paths: ProviderSessionPaths = yield* useProviderSessions(root, "directories");
      hostCwd = paths.host;
      // Owning the sidecar allocates none of it.
      expect(yield* exists(paths.sidecar)).toBe(false);
      expect(yield* readdir(yield* useEmptyDirectory(paths.host))).toEqual([]);

      sessionCwd = yield* useEmptyDirectory(providerSessionDirectory(paths, "placement-key"));
      yield* writeTextFile(join(sessionCwd, "residue.txt"), "left by a dead process");
      const again = yield* useEmptyDirectory(providerSessionDirectory(paths, "placement-key"));
      expect(again).toBe(sessionCwd);
      expect(yield* readdir(again)).toEqual([]);
    });

    expect(yield* exists(sessionCwd)).toBe(false);
    expect(yield* exists(hostCwd)).toBe(false);
  });

  it("WSL8: deletion reports and removes the provider sessions, and a live run keeps them", function* () {
    const root = yield* useStorageRoot();
    const runId = "delete-with-sessions";

    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(
        transitions,
        { runId, action: "start", creation: creation() },
        function* (begun, executorLock) {
          const settled = yield* transitions.settle(executorLock, {
            executionId: begun.execution.executionId,
            status: "completed",
          });
          if (!settled.ok) {
            throw settled.error;
          }
        },
      );
    });

    const sidecar = workflowProviderSessions(root, runId);
    yield* scoped(function* () {
      const paths = yield* useProviderSessions(root, runId);
      yield* useEmptyDirectory(paths.store);
    });
    expect(yield* exists(sidecar)).toBe(true);

    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(transitions, { runId, action: "resume" }, function* () {
        const refused = yield* WorkflowLifecycle.operations.delete(runId);
        expect(refused.ok).toBe(false);
      });
    });
    expect(yield* exists(workflowRunPath(root, runId))).toBe(true);
    expect(yield* exists(sidecar)).toBe(true);

    yield* withLifecycle(root, function* () {
      const removed = yield* WorkflowLifecycle.operations.delete(runId);
      if (!removed.ok) {
        throw removed.error;
      }
      expect(removed.value.removed).toEqual(["run-storage", "provider-sessions"]);
    });
    expect(yield* exists(workflowRunPath(root, runId))).toBe(false);
    expect(yield* exists(sidecar)).toBe(false);
  });
});
