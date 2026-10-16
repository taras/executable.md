/**
 * One REPL entry's recording: what the entry executing right now installs.
 *
 * `run-composition/provider.ts` answers the same question for `xmd run`, and the
 * two differ in exactly one way that matters here. An ordinary run's provider is
 * installed per execution and remembers nothing; an entry's is installed per
 * *entry* and retains what that entry did, so an entry interrupted partway
 * through can be reopened and continue instead of repeating itself.
 *
 * It is established inside the scope the invocation already owns, through
 * core's `Execution.init`, so everything it acquires belongs to that execution:
 * the Git session, its isolation directory, the ambient discovery and the lease
 * all end when the entry does. Establishing one while the command is still
 * assembling itself would make a passive view — a cold history somebody is only
 * reading — discover a checkout and take its lease, and a passive view reaches
 * no initialization at all.
 *
 * ## What it is not
 *
 * This increment records authored and generated file writes, authored deletions
 * and the directory an authored `<Dir>` ensures, in the checkout the person is
 * standing in. There is no managed checkout, no `<Repository>` or `<Worktree>`
 * selection, no local Git operation and nothing external. The components for
 * those stay declared where they already are and refuse through their own
 * unchanged missing-provider defaults.
 *
 * ## Installing it reaches nothing
 *
 * No directory, no lease, no `git`, no filesystem read. The ambient checkout is
 * discovered by the first mutation that needs to know whether it is inside one,
 * and an entry that mutates nothing never looks. Being outside a checkout is
 * remembered as "there is none" rather than refused, so an entry writing files
 * beside the document runs exactly as it would anywhere else.
 */

import { useScope } from "effection";
import type { Operation, Scope } from "effection";
import { cwd, Files } from "@executablemd/runtime";
import { denoRepositoryHost } from "../composition/host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { gitSession } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import { discoverAmbientCheckout } from "../run-composition/ambient.ts";
import { lazily } from "../run-composition/lazy.ts";
import { useCommonDirectoryLease } from "./leases.ts";
import type { ReplAmbientCheckout } from "../../saved-repository/records.ts";
import { currentCoroutine, selectedCheckout } from "./local.ts";
import { replFileMiddleware } from "./files.ts";
import type { ReplLocalRecorder } from "./files.ts";

/** What a caller may state about one entry's recording. */
export interface ReplRecordingOptions {
  /**
   * The host native Git runs through.
   *
   * Production states none and gets this platform's. A suite states one so it
   * can drive this exact assembly without a `git` subprocess.
   */
  readonly host?: RepositoryHost;
}

/**
 * Record this execution's file work in the checkout it is standing in.
 *
 * Called once per executing entry from core initialization, inside the scope
 * the invocation owns. It installs middleware and nothing else: the directory
 * discovery starts from is read here through the contextual environment Api
 * rather than from the process, because a session opened inside a checkout is
 * working in that one, and a nested execution that composed its own working
 * directory is discovered from that.
 */
export function* useReplRepositoryRecording(options: ReplRecordingOptions = {}): Operation<void> {
  const host = options.host ?? denoRepositoryHost();
  const directory = yield* cwd();

  // The entry task. Every capability below is acquired into it, so the session,
  // its directory and the lease last as long as the entry does rather than as
  // long as whichever element first needed them.
  const entry: Scope = yield* useScope();

  // The Git session's root is also `HOME`, so Git reads no configuration
  // belonging to whoever is running the command.
  const useGit = lazily(entry, function* (): Operation<GitSession> {
    return gitSession(host, yield* host.useDirectory());
  });

  const discover = lazily(entry, function* (): Operation<ReplAmbientCheckout | undefined> {
    return yield* discoverAmbientCheckout(yield* useGit(), directory);
  });

  // One lazy acquisition per shared Git directory, so the first mutation takes
  // the lease and every later one in this entry reuses it. A borrower cancelled
  // while waiting abandons its own wait and not the hold. Another live entry
  // opens its own descriptor and is refused by the operating system.
  const leases = new Map<string, () => Operation<void>>();

  // Remembered per durable coroutine, absence included, because that is the
  // grain the record has: the routing a coroutine saves sits at a position in
  // *that* coroutine, and replay consumes it from there.
  //
  // Remembering it per entry instead is a defect, and a reproduced one. Two
  // `<All>` branches can both reach their first mutation before either has
  // answered, so each saves routing at its own position — valid history. On
  // continuation the branch that replayed second would find the entry already
  // "knowing" where it was working, skip its own saved routing, and leave the
  // cursor pointing at a selection where its next result belongs. The journal
  // then refuses the whole continuation as divergent, and the work after the
  // questions never runs.
  //
  // What stays shared is the live discovery below, which is the part that costs
  // a `git` invocation.
  const selected = new Map<string, { readonly checkout: ReplAmbientCheckout | undefined }>();

  const recorder: ReplLocalRecorder = {
    *selection(): Operation<ReplAmbientCheckout | undefined> {
      const coroutine = yield* currentCoroutine();
      const remembered = selected.get(coroutine);
      if (remembered !== undefined) {
        return remembered.checkout;
      }
      const checkout = yield* selectedCheckout({ cwd: directory, discover });
      selected.set(coroutine, { checkout });
      return checkout;
    },
    *hold(commonDirectory: string): Operation<void> {
      let acquire = leases.get(commonDirectory);
      if (acquire === undefined) {
        acquire = lazily(entry, function* (): Operation<void> {
          yield* useCommonDirectoryLease(commonDirectory);
        });
        leases.set(commonDirectory, acquire);
      }
      yield* acquire();
    },
  };

  // The outermost band, so what is recorded is the result the whole composition
  // answered with rather than one layer's own.
  yield* Files.around(replFileMiddleware(recorder), { at: "max" });
}
