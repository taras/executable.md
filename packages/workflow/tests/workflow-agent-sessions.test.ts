/**
 * Tier WSL — what a run retains about its Agent sessions
 * (specs/workflow-workspace-spec.md §8.5).
 *
 * A provider session outlives one execution, so these are about the decision a
 * second attachment makes: continue the conversation this run was having, or
 * refuse. Nothing here starts an agent — the provider side is Tier WAP — and the
 * provider is represented by exactly what this host can ask it, which is what it
 * still holds for a session key.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { join } from "node:path";
import { scoped } from "effection";
import type { Operation } from "effection";
import { WorkflowLifecycle } from "../mod.ts";
import {
  providerSessionDirectory,
  providerSessionKey,
  providerSessionMappingPath,
  readProviderSession,
  resolveProviderSession,
  retainProviderSessionIdentity,
  useEmptyDirectory,
  useProviderSessions,
  useWorkflowLifecycle,
  workflowProviderSessions,
  workflowRunPath,
  writeProviderSession,
} from "../deno.ts";
import type { ProviderSessionPaths, ProviderSessionState } from "../deno.ts";
import { creation, useStorageRoot, withExecutorRun, withRunHost } from "./support/storage.ts";

const RUN = "release-1.4";
const PROVIDER = "acpx";
const AGENT = "codex-cmd";
const POLICY = "policy-digest-a";
const NATIVE = "agent-session:alpha";

const IDENTITY = { runId: RUN, provider: PROVIDER, agentCommand: AGENT } as const;

/**
 * A provider holding exactly these sessions.
 *
 * The whole of what this host may ask one: `ensureSession()` would create the
 * session the question is about, so continuation is decided from what the
 * provider's own store already holds.
 */
function heldSessions(sessions: Record<string, ProviderSessionState>) {
  // deno-lint-ignore require-yield
  return function* (sessionKey: string): Operation<ProviderSessionState | undefined> {
    return sessions[sessionKey];
  };
}

/** No session at all, which is where a run that never prompted starts. */
const holdingNothing = heldSessions({});

function withLifecycle<T>(root: string, body: () => Operation<T>): Operation<T> {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* body();
  });
}

/** One run's sidecar, prepared as an attachment prepares it. */
function withSidecar<T>(
  root: string,
  body: (paths: ProviderSessionPaths) => Operation<T>,
): Operation<T> {
  return scoped(function* () {
    return yield* body(yield* useProviderSessions(root, RUN));
  });
}

describe("Tier WSL — retained workflow Agent sessions", () => {
  it("WSL1: a run with no retained session creates one, and retains what the provider asserted", function* () {
    const root = yield* useStorageRoot();
    yield* withSidecar(root, function* (paths) {
      const key = providerSessionKey(IDENTITY);

      const resolved = yield* resolveProviderSession(paths, IDENTITY, POLICY, holdingNothing);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        return;
      }
      expect(resolved.value.kind).toBe("create");
      expect(resolved.value.record).toMatchObject({
        version: 1,
        runId: RUN,
        provider: PROVIDER,
        agentCommand: AGENT,
        // The unnamed session keeps a literal marker rather than an empty part.
        session: "default",
        sessionKey: key,
        policy: POLICY,
      });
      // Nothing native is claimed before the provider asserted one.
      expect(resolved.value.record.nativeSessionId).toBe(undefined);

      yield* writeProviderSession(paths, resolved.value.record);
      expect(yield* exists(providerSessionMappingPath(paths, key))).toBe(true);

      const retained = yield* retainProviderSessionIdentity(paths, key, NATIVE);
      expect(retained.ok).toBe(true);

      const read = yield* readProviderSession(paths, key);
      expect(read.ok && read.value?.nativeSessionId).toBe(NATIVE);
      // No prompt text, and no transcript.
      const stored = JSON.parse(yield* readTextFile(providerSessionMappingPath(paths, key)));
      expect(Object.keys(stored).sort()).toEqual([
        "agentCommand",
        "nativeSessionId",
        "policy",
        "provider",
        "runId",
        "session",
        "sessionKey",
        "version",
      ]);
    });
  });

  it("WSL1: a named Session is a different logical session from the unnamed one", function* () {
    const unnamed = providerSessionKey(IDENTITY);
    const named = providerSessionKey({ ...IDENTITY, session: "review" });
    const other = providerSessionKey({ ...IDENTITY, agentCommand: "claude-cmd" });
    const elsewhere = providerSessionKey({ ...IDENTITY, runId: "release-1.5" });
    expect(new Set([unnamed, named, other, elsewhere]).size).toBe(4);
    // Bounded and file-safe however long the inputs are.
    expect(providerSessionKey({ ...IDENTITY, session: "x".repeat(4096) })).toMatch(
      /^xmd:workflow:v1:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}$/,
    );
  });

  it("WSL2: a new process over the retained sidecar reattaches the same native session", function* () {
    const root = yield* useStorageRoot();
    const key = providerSessionKey(IDENTITY);

    // One process establishes the session and retains what the provider said.
    yield* withSidecar(root, function* (paths) {
      const resolved = yield* resolveProviderSession(paths, IDENTITY, POLICY, holdingNothing);
      if (!resolved.ok) {
        throw resolved.error;
      }
      yield* writeProviderSession(paths, resolved.value.record);
      const retained = yield* retainProviderSessionIdentity(paths, key, NATIVE);
      expect(retained.ok).toBe(true);
    });

    // Another one, over the state the first left behind.
    yield* withSidecar(root, function* (paths) {
      const holding = heldSessions({ [key]: { agentCommand: AGENT, nativeSessionId: NATIVE } });
      const resolved = yield* resolveProviderSession(paths, IDENTITY, POLICY, holding);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        return;
      }
      // Reattached, under the same logical key and the same native identity —
      // and never re-created, which is what a reconstructed transcript would be.
      expect(resolved.value.kind).toBe("reattach");
      expect(resolved.value.record.sessionKey).toBe(key);
      expect(resolved.value.record.nativeSessionId).toBe(NATIVE);

      // The provider asserting the same identity again changes nothing.
      const again = yield* retainProviderSessionIdentity(paths, key, NATIVE);
      expect(again.ok).toBe(true);
    });
  });

  it("WSL3: every attachment gets an empty directory, and none of them outlives it", function* () {
    const root = yield* useStorageRoot();
    const key = providerSessionKey(IDENTITY);
    let sessionCwd = "";
    let hostCwd = "";
    let mappings = "";

    yield* withSidecar(root, function* (paths) {
      hostCwd = paths.host;
      mappings = paths.mappings;
      // Nothing yet: owning the sidecar allocates none of it, so a run whose
      // document never prompts leaves no trace of an agent it never had.
      expect(yield* exists(paths.sidecar)).toBe(false);

      // What the profile's own directory resolver does on first use.
      expect(yield* readdir(yield* useEmptyDirectory(paths.host))).toEqual([]);

      sessionCwd = yield* useEmptyDirectory(providerSessionDirectory(paths, key));
      expect(yield* readdir(sessionCwd)).toEqual([]);
      // Whatever an interrupted attempt left behind.
      yield* writeTextFile(join(sessionCwd, "residue.txt"), "left by a dead process");
      yield* writeTextFile(join(paths.host, "residue.txt"), "left by a dead process");

      // A second attachment over the same deterministic path starts empty
      // again, and the path itself is unchanged so the provider reuses its
      // record rather than placing a second session beside it.
      const again = yield* useEmptyDirectory(providerSessionDirectory(paths, key));
      expect(again).toBe(sessionCwd);
      expect(yield* readdir(again)).toEqual([]);

      const resolved = yield* resolveProviderSession(paths, IDENTITY, POLICY, holdingNothing);
      if (!resolved.ok) {
        throw resolved.error;
      }
      yield* writeProviderSession(paths, resolved.value.record);
    });

    // The disposable half is gone; the retained half is exactly what a
    // continuation reads.
    expect(yield* exists(sessionCwd)).toBe(false);
    expect(yield* exists(hostCwd)).toBe(false);
    expect(yield* exists(mappings)).toBe(true);
    expect(yield* exists(workflowProviderSessions(root, RUN))).toBe(true);
  });

  it("WSL4: retained state this host cannot continue refuses, and starts no replacement", function* () {
    const root = yield* useStorageRoot();
    const key = providerSessionKey(IDENTITY);
    const holding = heldSessions({ [key]: { agentCommand: AGENT, nativeSessionId: NATIVE } });

    const cases = [
      {
        name: "an unreadable record",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* ensureDir(paths.mappings);
          yield* writeTextFile(providerSessionMappingPath(paths, key), "{ not json");
        },
        probe: holding,
      },
      {
        name: "a record from a version this host does not have",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* ensureDir(paths.mappings);
          yield* writeTextFile(
            providerSessionMappingPath(paths, key),
            JSON.stringify({ version: 99, runId: RUN, sessionKey: key }),
          );
        },
        probe: holding,
      },
      {
        name: "a session created under a different policy",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* writeProviderSession(paths, {
            version: 1,
            runId: RUN,
            provider: PROVIDER,
            agentCommand: AGENT,
            session: "default",
            sessionKey: key,
            policy: "policy-digest-b",
            nativeSessionId: NATIVE,
          });
        },
        probe: holding,
      },
      {
        name: "a session created for a different agent",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* writeProviderSession(paths, {
            version: 1,
            runId: RUN,
            provider: PROVIDER,
            agentCommand: "claude-cmd",
            session: "default",
            sessionKey: key,
            policy: POLICY,
            nativeSessionId: NATIVE,
          });
        },
        probe: holding,
      },
      {
        name: "a provider that no longer holds the session",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* writeProviderSession(paths, {
            version: 1,
            runId: RUN,
            provider: PROVIDER,
            agentCommand: AGENT,
            session: "default",
            sessionKey: key,
            policy: POLICY,
            nativeSessionId: NATIVE,
          });
        },
        probe: holdingNothing,
      },
      {
        name: "an adapter that cannot resume the retained native session",
        *plant(paths: ProviderSessionPaths): Operation<void> {
          yield* writeProviderSession(paths, {
            version: 1,
            runId: RUN,
            provider: PROVIDER,
            agentCommand: AGENT,
            session: "default",
            sessionKey: key,
            policy: POLICY,
            nativeSessionId: NATIVE,
          });
        },
        probe: heldSessions({
          [key]: { agentCommand: AGENT, nativeSessionId: "agent-session:replacement" },
        }),
      },
    ];

    for (const scenario of cases) {
      const runRoot = yield* useStorageRoot();
      yield* withSidecar(runRoot, function* (paths) {
        yield* scenario.plant(paths);
        const resolved = yield* resolveProviderSession(paths, IDENTITY, POLICY, scenario.probe);
        expect(`${scenario.name}: ${resolved.ok}`).toBe(`${scenario.name}: false`);
        if (resolved.ok) {
          return;
        }
        expect(`${scenario.name}: ${resolved.error.name}`).toBe(
          `${scenario.name}: WorkflowAgentSessionError`,
        );
        // Never a replacement: the refusal is the whole answer, and no branch
        // of it reports a session this host may create.
        expect(`${scenario.name}: ${resolved.error.message}`).toContain(
          "rather than continuing this one",
        );
      });
    }

    // And the same for an identity a provider asserted that this run retains
    // nothing about: it is refused rather than adopted.
    yield* withSidecar(root, function* (paths) {
      const retained = yield* retainProviderSessionIdentity(paths, key, NATIVE);
      expect(retained.ok).toBe(false);
    });
  });

  it("WSL5: deletion removes the provider sessions it reports, and a live run keeps both", function* () {
    const root = yield* useStorageRoot();
    const runId = "delete-with-sessions";
    const identity = { ...IDENTITY, runId };
    const key = providerSessionKey(identity);

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

    const paths = yield* scoped(function* () {
      const prepared = yield* useProviderSessions(root, runId);
      yield* writeProviderSession(prepared, {
        version: 1,
        runId,
        provider: PROVIDER,
        agentCommand: AGENT,
        session: "default",
        sessionKey: key,
        policy: POLICY,
        nativeSessionId: NATIVE,
      });
      return prepared;
    });
    expect(yield* exists(paths.sidecar)).toBe(true);

    // A live workflow executor is refused, and neither category goes.
    yield* withRunHost(root, function* (transitions) {
      yield* withExecutorRun(transitions, { runId, action: "resume" }, function* () {
        const refused = yield* WorkflowLifecycle.operations.delete(runId);
        expect(refused.ok).toBe(false);
      });
    });
    expect(yield* exists(workflowRunPath(root, runId))).toBe(true);
    expect(yield* exists(paths.sidecar)).toBe(true);

    yield* withLifecycle(root, function* () {
      const removed = yield* WorkflowLifecycle.operations.delete(runId);
      if (!removed.ok) {
        throw removed.error;
      }
      // Exactly the categories that went — and this run retained both.
      expect(removed.value.removed).toEqual(["run-storage", "provider-sessions"]);
    });
    expect(yield* exists(workflowRunPath(root, runId))).toBe(false);
    expect(yield* exists(paths.sidecar)).toBe(false);
  });

  it("WSL5: a run that retained no provider session reports only its storage", function* () {
    const root = yield* useStorageRoot();
    const runId = "delete-without-sessions";
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

    yield* withLifecycle(root, function* () {
      const removed = yield* WorkflowLifecycle.operations.delete(runId);
      if (!removed.ok) {
        throw removed.error;
      }
      expect(removed.value.removed).toEqual(["run-storage"]);
    });
  });
});
