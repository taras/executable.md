/**
 * Retained mappings, as one invocation on the runner sees them.
 *
 * The runner has no database. What it has is the coherent snapshot the owner
 * admitted this invocation from, and whatever this invocation has staged since.
 * That is enough to answer every question the shared composition rules ask,
 * because those rules only ever read a mapping back and compare it — and this
 * answers with the retained row when there is one, and with what this
 * invocation staged when there is not.
 *
 * Read-your-writes without durability. A document that creates a Repository and
 * then asks for it again is asking about its own work, and must see it; nothing
 * about that makes it committed. Only the exact list handed through the live
 * enlistment capability reaches an intent, and only the owner's transaction
 * makes any of it authoritative.
 *
 * The reconciliation rules are not restated here. A same-name Repository is
 * compared by the composition provider that already knows what compatible
 * means, and an Agent session by `resolveAgentSession()`; this module decides
 * only where a record comes from and what a new one stages.
 */

import {
  type AgentSessionRecord,
  type AgentSessions,
  WorkflowAgentSessionError,
} from "../storage/agent-session.ts";
import type { WorktreeRecord } from "../composition/records.ts";
import { parseCheckoutPath } from "../composition/records.ts";
import { locatorFingerprintOf } from "../composition/locator.ts";
import type { StoredRepository, WorkspaceMetadata } from "../workspace/metadata.ts";
import type { RemoteInvocationSnapshot } from "./records.ts";
import type { RetainedMapping } from "./publication.ts";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";

/** The most mappings one invocation may stage before it is refused. */
const MAX_STAGED_MAPPINGS = 256;

/** The most serialized bytes one invocation may stage before it is refused. */
const MAX_STAGED_BYTES = 256 * 1024;

/**
 * What an invocation may reach, and what it has decided to retain.
 *
 * `deltas()` is the whole of what may be enlisted. It is a fresh array each
 * time, deterministically ordered, so the caller cannot reach back into what
 * the view is still holding.
 */
export interface InvocationMappings {
  readonly metadata: WorkspaceMetadata;
  readonly agentSessions: AgentSessions;
  deltas(): readonly RetainedMapping[];
}

function refuse(reason: string): never {
  throw new WorkflowRecordMalformedError("this run's retained mappings", reason);
}

/**
 * A copy that shares nothing with what it was given.
 *
 * These records are handed to a document and staged for a commit, and both hold
 * them for longer than the call. A structural clone is what makes "the delta is
 * what was staged" true rather than a description of what nobody mutated.
 */
function detach<T>(value: T): T {
  return structuredClone(value) as T;
}

export function createInvocationMappings(
  snapshot: RemoteInvocationSnapshot,
  live: () => void,
): InvocationMappings {
  const repositories = new Map<string, StoredRepository>();
  const worktrees = new Map<string, WorktreeRecord>();
  const sessions = new Map<string, AgentSessionRecord>();
  for (const stored of snapshot.repositories) {
    repositories.set(stored.record.name, stored);
  }
  for (const record of snapshot.worktrees) {
    worktrees.set(worktreeKey(record.repositoryName, record.name), record);
  }
  for (const record of snapshot.agentSessions) {
    sessions.set(record.sessionKey, record);
  }

  const staged: RetainedMapping[] = [];
  function stage(mapping: RetainedMapping): void {
    if (staged.length >= MAX_STAGED_MAPPINGS) {
      refuse("this invocation stages more retained mappings than one commit may carry");
    }
    const next = [...staged, mapping];
    if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_STAGED_BYTES) {
      refuse("this invocation stages more retained mapping bytes than one commit may carry");
    }
    staged.push(mapping);
  }

  return {
    metadata: {
      readRepository(name: string): StoredRepository | undefined {
        live();
        const found = repositories.get(name);
        return found === undefined ? undefined : detach(found);
      },

      readRepositories(): StoredRepository[] {
        live();
        return [...repositories.values()]
          .toSorted((left, right) => compare(left.record.name, right.record.name))
          .map(detach);
      },

      insertRepository(stored: StoredRepository): void {
        live();
        if (locatorFingerprintOf(stored.locator) !== stored.record.locatorFingerprint) {
          refuse("a Repository was retained with a fingerprint its locator does not produce");
        }
        if (parseCheckoutPath(stored.record.checkoutPath) === undefined) {
          refuse("a Repository was retained with a checkout path this build does not admit");
        }
        const existing = repositories.get(stored.record.name);
        if (existing !== undefined) {
          // The same insert twice in one invocation is the same fact stated
          // twice. Anything else is a conflict, and a conflict never replaces
          // what is already there.
          if (!sameRepository(existing, stored)) {
            refuse("a Repository name was retained twice under different identities");
          }
          // Either the owner already holds it, or this invocation staged it
          // earlier. Both mean there is nothing new to retain: a snapshot row
          // re-sent as a mutation would ask the owner to insert what it has.
          return;
        }
        const admitted = detach(stored);
        repositories.set(admitted.record.name, admitted);
        stage({ kind: "repository", record: admitted.record, locator: admitted.locator });
      },

      readWorktree(repositoryName: string, name: string): WorktreeRecord | undefined {
        live();
        const found = worktrees.get(worktreeKey(repositoryName, name));
        return found === undefined ? undefined : detach(found);
      },

      readWorktreesForRepository(repositoryName: string): WorktreeRecord[] {
        live();
        return [...worktrees.values()]
          .filter((record) => record.repositoryName === repositoryName)
          .toSorted((left, right) => compare(left.name, right.name))
          .map(detach);
      },

      insertWorktree(record: WorktreeRecord): void {
        live();
        if (parseCheckoutPath(record.checkoutPath) === undefined) {
          refuse("a Worktree was retained with a checkout path this build does not admit");
        }
        if (!repositories.has(record.repositoryName)) {
          refuse("a Worktree was retained for a Repository this run does not hold");
        }
        const key = worktreeKey(record.repositoryName, record.name);
        const existing = worktrees.get(key);
        if (existing !== undefined) {
          if (!sameWorktree(existing, record)) {
            refuse("a Worktree name was retained twice under different identities");
          }
          return;
        }
        const admitted = detach(record);
        worktrees.set(key, admitted);
        stage({ kind: "worktree", record: admitted });
      },
    },

    agentSessions: {
      read(sessionKey: string): AgentSessionRecord | undefined {
        live();
        const found = sessions.get(sessionKey);
        return found === undefined ? undefined : detach(found);
      },

      commit(record: AgentSessionRecord): void {
        live();
        const existing = sessions.get(record.sessionKey);
        if (existing !== undefined) {
          if (!sameSession(existing, record)) {
            throw new WorkflowAgentSessionError(
              "this run already retains a different Agent session under this identity, and a " +
                "session established under one ceiling is not continued under another.",
            );
          }
          return;
        }
        const admitted = detach(record);
        sessions.set(admitted.sessionKey, admitted);
        stage({ kind: "agent-session", record: admitted });
      },
    },

    deltas(): readonly RetainedMapping[] {
      // Parents before children, then by name: the owner applies them in
      // dependency order, and a deterministic list is what makes one
      // invocation's proposal the same proposal on a retry.
      const order = { repository: 0, worktree: 1, "agent-session": 2 } as const;
      return staged
        .map((mapping, index) => ({ mapping, index }))
        .toSorted((left, right) => {
          const kinds = order[left.mapping.kind] - order[right.mapping.kind];
          return kinds !== 0 ? kinds : left.index - right.index;
        })
        .map((entry) => detach(entry.mapping));
    },
  };
}

function worktreeKey(repositoryName: string, name: string): string {
  return `${repositoryName}\u0000${name}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameRepository(left: StoredRepository, right: StoredRepository): boolean {
  return (
    left.locator === right.locator &&
    left.record.locatorFingerprint === right.record.locatorFingerprint &&
    left.record.requestedBase === right.record.requestedBase &&
    left.record.creationCommit === right.record.creationCommit &&
    left.record.primaryBranch === right.record.primaryBranch &&
    left.record.objectFormat === right.record.objectFormat &&
    left.record.checkoutPath === right.record.checkoutPath
  );
}

function sameWorktree(left: WorktreeRecord, right: WorktreeRecord): boolean {
  return (
    left.requestedBranch === right.requestedBranch &&
    left.requestedBase === right.requestedBase &&
    left.creationCommit === right.creationCommit &&
    left.checkoutPath === right.checkoutPath
  );
}

function sameSession(left: AgentSessionRecord, right: AgentSessionRecord): boolean {
  return (
    left.provider === right.provider &&
    left.agentCommand === right.agentCommand &&
    left.sessionIdentity === right.sessionIdentity &&
    left.policy === right.policy &&
    left.assertion.kind === right.assertion.kind &&
    left.assertion.value === right.assertion.value
  );
}
