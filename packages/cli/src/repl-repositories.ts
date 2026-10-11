/**
 * How a REPL entry obtains repository operations, or does not.
 *
 * `run-repositories.ts` beside this one answers the same question for `xmd
 * run`, and the two differ in exactly one way that matters here: an ordinary
 * run's provider is installed per execution and remembers nothing, while an
 * entry's is installed per *entry* and retains what that entry did, so an
 * entry interrupted partway through repository work can be reopened and
 * continue instead of repeating it.
 *
 * What this module holds is the contract and nothing else. A factory rather
 * than a value, for the reason the ordinary installer is one and then some: the
 * host belongs to the executing entry's own task, holds that entry's owner,
 * selections, leases, credentials, lanes and publication permission, and ends
 * with it. Constructing one while the command is still assembling itself would
 * give every entry of the session the same owner and make a passive view — a
 * cold history somebody is only reading — acquire a lease and a checkout.
 *
 * Nothing here names a runtime. The shared command path cannot import the Deno
 * adapter at all: its module graph reaches `node:sqlite`, which Bun does not
 * have, so a static import would stop `xmd` loading there rather than refusing
 * a repository operation. The implementation lives beside the entrypoints that
 * can use it, in `deno-repositories.ts`, and a host that supplies none leaves
 * its entries refusing repository work before a lock, a credential, a
 * subprocess or a request exists.
 */

import type { Operation } from "effection";
import type { ExecutionInstallation, FragmentFileAccess } from "@executablemd/core/host";

/** What one entry tells its host about itself. */
export interface ReplEntryHostRequest {
  /**
   * The execution this entry belongs to, as the host established it.
   *
   * Opaque, and the first half of the owner every record this entry writes is
   * retained under. It is the identifier the history file is named by, so a
   * location reopens the entries of that execution and of no other.
   */
  readonly executionId: string;
  /**
   * This entry's own key, in the order the entries were admitted.
   *
   * Immutable once admitted, which is what makes the owner stable across
   * opens: the same entry of the same execution is the same owner however many
   * times it is reopened, and the entry after it is a different one however
   * identical its text.
   */
  readonly entryKey: string;
  /** The canonical identity of the source this entry is running. */
  readonly source: string;
}

/** What an entry's repository host offers the task that built it. */
export interface ReplEntryHost {
  /**
   * What this entry declares to its own execution.
   *
   * Its journal admission, its canonical file-mutation handlers and the
   * repository components it answers for — installed into that one execution
   * and nowhere else.
   */
  readonly installation: ExecutionInstallation;
  /**
   * The one captured file access this entry's generated fragments run on.
   *
   * Bound into the command's unchanged generated ceiling, so a fragment's write
   * inside a checkout this entry has selected is retained exactly as an
   * authored one is — and a fragment reaches it rather than `API.Files`, which
   * is what keeps a document, a repository component or middleware out from
   * between them.
   */
  readonly files: FragmentFileAccess;
}

/**
 * How one entry's repository host is built, when this runtime has one.
 *
 * Called by the sequential entry task, once per entry, with the trusted
 * execution identity and the admission-order key. Everything it acquires
 * belongs to that task.
 */
export type ReplEntryHostFactory = (request: ReplEntryHostRequest) => Operation<ReplEntryHost>;
