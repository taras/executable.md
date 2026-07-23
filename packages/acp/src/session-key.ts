/**
 * Session identity (specs/acp-client-spec.md §Session).
 *
 * Keys are namespaced `xmd:v1:` so they can never collide with sessions
 * owned by other ACPX consumers (ACPX's only key convention is an
 * optional `agent:<name>:` prefix, which this scheme avoids), and the
 * directory digest keeps keys short and filesystem-safe.
 *
 * Session resolution walks candidates from the contextual cwd toward the
 * Git repository root and reuses the nearest candidate whose record
 * already exists — checked through the ACPX session store, never through
 * `ensureSession()`, which would create one. ACPX only reuses a record
 * when the cwd matches, so the matched candidate's directory (not the
 * caller cwd) becomes the session cwd. When nothing exists yet, the
 * session is created for the exact contextual cwd.
 */

import { until } from "effection";
import type { Operation } from "effection";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { stat } from "@executablemd/runtime";
import type { AcpSessionStore } from "acpx/runtime";

export interface SessionCandidate {
  sessionKey: string;
  cwd: string;
}

export function deriveSessionKey(agentCommand: string, dir: string, name?: string): string {
  const digest = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);
  return [
    "xmd",
    "v1",
    encodeURIComponent(agentCommand),
    digest,
    encodeURIComponent(name ?? "default"),
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
 */
export function* resolveSessionPlacement(
  store: AcpSessionStore,
  agentCommand: string,
  cwdPath: string,
  name?: string,
): Operation<SessionCandidate> {
  const candidates = yield* sessionCandidates(agentCommand, cwdPath, name);
  for (const candidate of candidates) {
    const record = yield* until(store.load(candidate.sessionKey));
    if (
      record &&
      record.agentCommand === agentCommand &&
      resolve(record.cwd) === resolve(candidate.cwd)
    ) {
      return candidate;
    }
  }
  return candidates[0]!;
}
