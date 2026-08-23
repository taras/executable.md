/**
 * Where a run keeps the disposable arrangement its Agent sessions need.
 *
 * Two things, and neither is retained state: the provider's own persistent
 * session store, and one empty working directory per session. What a
 * continuation is decided from is not here at all — it is a row in the run's own
 * database (`workspace/agent-sessions.ts`), because a mapping and the run it
 * belongs to are one fact.
 *
 * The paths sit under a name the run-discovery pattern — `<hash>.sqlite`
 * exactly — cannot match, so nothing discovers them and no run id resolves to
 * one. `WorkflowDeletion` reserves the `provider-sessions` category for them.
 *
 * The working directories are emptied before use and removed with the
 * attachment. Nothing is ever copied into them, and nothing is read back out.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensure } from "effection";
import type { Operation } from "effection";
import { ensureDir, remove, stat } from "@executablemd/runtime";
import { hashRunId } from "./path.ts";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * Where one run's provider sessions live.
 *
 * A suffix in the same namespace as the run's lock and fork staging, so the
 * `<hash>.sqlite` candidate pattern excludes it by construction: nothing
 * discovers it, nothing lists it, and no run id resolves to it.
 */
export function workflowProviderSessions(root: string, runId: string): string {
  return join(root, `${hashRunId(runId)}.sessions`);
}

/** Every path one run's provider sessions occupy, derived from the sidecar. */
export interface ProviderSessionPaths {
  /** The sidecar itself. Nothing below resolves outside it. */
  readonly sidecar: string;
  /** The provider's own persistent session store. */
  readonly store: string;
  /** The runtime's working directory: provider-owned, and empty. */
  readonly host: string;
  /** The provider-owned working directories, one per logical key. */
  readonly directories: string;
}

export function providerSessionPaths(root: string, runId: string): ProviderSessionPaths {
  const sidecar = workflowProviderSessions(root, runId);
  return {
    sidecar,
    store: join(sidecar, "store"),
    host: join(sidecar, "host"),
    directories: join(sidecar, "cwd"),
  };
}

/** The provider-owned working directory one logical session runs in. */
export function providerSessionDirectory(paths: ProviderSessionPaths, key: string): string {
  return join(paths.directories, digest(key));
}

/**
 * The provider-owned working directory for this key, empty.
 *
 * Emptied rather than reused: the same path can hold residue after an
 * unstructured process death, and an Agent that starts in one is reading
 * something no attachment put there.
 */
export function* useEmptyDirectory(path: string): Operation<string> {
  yield* remove(path, { recursive: true, force: true });
  yield* ensureDir(path);
  return path;
}

/**
 * Own this run's provider-session sidecar for one attachment.
 *
 * It creates nothing. A run whose document never prompts an Agent allocates no
 * sidecar at all, which is what keeps "this run had no agent" a fact about the
 * filesystem rather than a claim: the directories below appear when a session is
 * placed and a record is written, and not before.
 *
 * What it does own is the end. The retained half — the mapping records and the
 * provider's own session store — outlives the attachment, because that is what a
 * continuation reads. The working directories do not, and their removal is
 * registered before anything is installed over this, so it runs after provider
 * teardown: whatever was standing in them has stopped by then.
 */
export function* useProviderSessions(root: string, runId: string): Operation<ProviderSessionPaths> {
  const paths = providerSessionPaths(root, runId);
  yield* ensure(function* () {
    yield* remove(paths.directories, { recursive: true, force: true });
    yield* remove(paths.host, { recursive: true, force: true });
  });
  return paths;
}

/** Remove one run's provider sessions, and say whether there were any. */
export function* removeProviderSessions(root: string, runId: string): Operation<boolean> {
  const sidecar = workflowProviderSessions(root, runId);
  const present = yield* stat(sidecar);
  if (!present.exists) {
    return false;
  }
  yield* remove(sidecar, { recursive: true, force: true });
  return true;
}
