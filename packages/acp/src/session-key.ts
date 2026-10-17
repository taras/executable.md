/**
 * Session identity (specs/acp-client-spec.md §Session).
 *
 * `xmd:v1:` separates these keys from other ACPX consumers. Variable-length
 * agent-command, directory and explicit-name inputs are digested so a store may
 * encode the key again as a bounded filesystem-safe filename.
 *
 * Resolution reuses the nearest existing ACPX record between contextual cwd and
 * the repository root, without calling `ensureSession()` and creating one. ACPX
 * requires matching cwd, so the selected candidate's directory becomes session
 * cwd. With no record, placement uses the exact contextual cwd.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stat } from "@executablemd/runtime";
import type { AcpSessionStore } from "./acpx-runtime.ts";

export interface SessionCandidate {
  sessionKey: string;
  cwd: string;
}

/**
 * One candidate, and whether a session already lives there.
 *
 * `new` means this key names where a session will be, and nothing has created
 * one yet. `existing` means a durable record already stands behind it —
 * including a record written before deferred creation existed, which carries
 * no marker and asserted its identity when it was created.
 */
export interface SessionDetails extends SessionCandidate {
  state: "new" | "existing";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function deriveSessionKey(agentCommand: string, dir: string, name?: string): string {
  // The unnamed session keeps a literal marker so it stays recognisable
  // and distinct from any given name.
  return [
    "xmd",
    "v1",
    digest(agentCommand),
    digest(resolve(dir)),
    name === undefined ? "default" : digest(name),
  ].join(":");
}

/**
 * One candidate per directory from the contextual cwd up to the Git
 * repository root, nearest first. `.git` may be a directory or a file
 * (worktrees). Outside a repository the exact cwd is the only candidate.
 */
export function* sessionCandidates(
  agentCommand: string,
  cwdPath: string,
  name?: string,
): Operation<SessionCandidate[]> {
  const start = resolve(cwdPath);
  const chain: string[] = [];
  let gitRoot: string | undefined;
  let current = start;
  while (true) {
    chain.push(current);
    const dotGit = yield* stat(join(current, ".git"));
    if (dotGit.exists) {
      gitRoot = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const dirs = gitRoot === undefined ? [start] : chain;
  return dirs.map((dir) => ({ sessionKey: deriveSessionKey(agentCommand, dir, name), cwd: dir }));
}

/**
 * Select where a session lives: the nearest candidate whose ACPX record
 * exists for the same agent command and directory, or the exact
 * contextual cwd when none does.
 *
 * A record still marked pending is occupancy rather than a conversation — its
 * first turn was never accepted — so the details it answers with say new too,
 * and the next operation creates rather than continues.
 *
 * `pending` on the stored marker is ACPX's own spelling, which this reads and
 * never rewrites; the value this answers with is the translated one.
 */
export function* resolveSessionDetails(
  store: AcpSessionStore,
  agentCommand: string,
  cwdPath: string,
  name?: string,
): Operation<SessionDetails> {
  const candidates = yield* sessionCandidates(agentCommand, cwdPath, name);
  for (const candidate of candidates) {
    const record = yield* until(store.load(candidate.sessionKey));
    if (
      record &&
      record.agentCommand === agentCommand &&
      resolve(record.cwd) === resolve(candidate.cwd)
    ) {
      return {
        ...candidate,
        state: record.sessionMaterialization?.state === "pending" ? "new" : "existing",
      };
    }
  }
  return { ...candidates[0]!, state: "new" };
}
