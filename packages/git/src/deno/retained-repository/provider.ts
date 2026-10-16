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
 * This records file and directory work and the managed checkouts a document
 * selects to do it in: authored and generated writes, authored deletions, the
 * directory an authored `<Dir>` ensures, and the `<Repository>` and
 * `<Worktree>` selections that say where. There is no local Git operation —
 * no Add, Switch, Commit or Push — and nothing external. The components for
 * those stay declared where they already are and refuse through their own
 * unchanged missing-provider defaults, and the selection handlers installed
 * here are not the ordinary all-feature provider, which would enable them.
 *
 * ## Installing it reaches nothing
 *
 * No directory, no lease, no `git`, no filesystem read, and no managed root.
 * The ambient checkout is discovered by the first mutation that needs to know
 * whether it is inside one, and an entry that mutates nothing never looks. The
 * managed root is created by the first selection, and an entry that selects
 * nothing never makes one. Being outside a checkout is remembered as "there is
 * none" rather than refused, so an entry writing files beside the document runs
 * exactly as it would anywhere else.
 */

import { until, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { realpath } from "node:fs/promises";
import { ensureDir } from "@effectionx/fs";
import { cwd, Files } from "@executablemd/runtime";
import { denoRepositoryHost } from "../composition/host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { gitSession } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import type { HelperAssembly } from "../composition/credential-helper.ts";
import type { GitAuthentication } from "../composition/authentication.ts";
import { Repository } from "../../composition/api.ts";
import type { RepositoryRequest, WorktreeRequest } from "../../composition/api.ts";
import type { RepositorySelection } from "../../composition/selection.ts";
import { discoverAmbientCheckout, discoverAmbientRepository } from "../run-composition/ambient.ts";
import type { AmbientRepository } from "../run-composition/ambient.ts";
import { lazily } from "../run-composition/lazy.ts";
import { useLeases } from "../run-composition/leases.ts";
import type { Leases, SlotKind } from "../run-composition/leases.ts";
import { selectionRegistry } from "../selections.ts";
import { holdManagedPlacement, useCommonDirectoryLease } from "./leases.ts";
import type { ReplAmbientCheckout } from "../../retained-repository/records.ts";
import { currentCoroutine, selectedCheckout } from "./local.ts";
import { replFileMiddleware } from "./files.ts";
import type { ReplLocalRecorder, ReplManagedPlacement } from "./files.ts";
import {
  placementSubject,
  selectReplAmbientOwner,
  selectReplRepository,
  selectReplWorktree,
  slotTurns,
} from "./selections.ts";
import type { ReplPlacementRegistration, ReplSelectionEntry } from "./selections.ts";

/** What a caller may state about one entry's recording. */
export interface ReplRecordingOptions {
  /**
   * The host native Git runs through.
   *
   * Production states none and gets this platform's. A suite states one so it
   * can drive this exact assembly without a `git` subprocess.
   */
  readonly host?: RepositoryHost;
  /**
   * Where managed checkouts live.
   *
   * Stated by the selected REPL host, which is the one place that names
   * `~/.xmd/repositories`. An entry with no managed root records file work and
   * installs no selector at all, so `<Repository>` and `<Worktree>` reach their
   * ordinary missing-provider refusal rather than a half-configured one.
   */
  readonly root?: string;
  /** How this host writes and starts its own credential helper for a clone. */
  readonly helper?: HelperAssembly;
  /** What this host lends a clone that needs to prove who it is. */
  readonly authentication?: GitAuthentication;
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
  const host =
    options.host ??
    denoRepositoryHost({
      ...(options.authentication === undefined ? {} : { authentication: options.authentication }),
      ...(options.helper === undefined ? {} : { helper: options.helper }),
    });
  const directory = yield* cwd();
  const configuredRoot = options.root;

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

  // Registered by a completed or live selection and kept for the rest of the
  // entry, so a self-closing `<Worktree>` can bind a path a later `<Dir>`
  // sibling renders at. Empty for an entry with no managed root, which is what
  // leaves PR 1's ambient routing the only route there.
  const placements: ReplManagedPlacement[] = [];

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
    hold: (commonDirectory: string) => holdCommon(commonDirectory),
    placements: () => placements,
  };

  function holdCommon(commonDirectory: string): Operation<void> {
    let acquire = leases.get(commonDirectory);
    if (acquire === undefined) {
      acquire = lazily(entry, function* (): Operation<void> {
        yield* useCommonDirectoryLease(commonDirectory);
      });
      leases.set(commonDirectory, acquire);
    }
    return acquire();
  }

  // The outermost band, so what is recorded is the result the whole composition
  // answered with rather than one layer's own.
  yield* Files.around(replFileMiddleware(recorder), { at: "max" });

  // A recorder with no managed root records file work and installs no selector,
  // so `<Repository>` and `<Worktree>` reach their ordinary missing-provider
  // refusal. Nothing below this line is reached, named or acquired by such an
  // entry.
  if (configuredRoot === undefined) {
    return;
  }
  const root = configuredRoot;

  // Created before it is canonicalized, and canonicalized once, exactly as the
  // ordinary provider does it. A path that does not exist yet resolves to
  // itself, so a root canonicalized before it was made would be one spelling on
  // the entry that created it and another on every entry afterwards — two
  // spellings, two digests, two slots for one Repository, and no lock between
  // them.
  const useRoot = lazily(entry, function* (): Operation<string> {
    yield* ensureDir(root);
    try {
      return yield* until(realpath(root));
    } catch {
      return root;
    }
  });
  const useSlots = lazily(entry, function* (): Operation<Leases> {
    return yield* useLeases(yield* useRoot());
  });

  // Everything a Repository identity needs, and only a root `<Worktree>` needs
  // it. An entry that writes files and selects nothing keeps PR 1's smaller
  // discovery and never asks these questions.
  const useAmbientRepository = lazily(entry, function* (): Operation<
    AmbientRepository | undefined
  > {
    return yield* discoverAmbientRepository(yield* useGit(), directory);
  });

  // One lazy acquisition per managed slot, so a slot taken by a live selection
  // is the same hold the first new file operation inside a restored placement
  // reacquires. Single-flight, because two concurrent first callers each
  // opening their own descriptor would be refused by the operating system for
  // contending with their own entry.
  const slots = new Map<string, () => Operation<void>>();
  function holdSlot(kind: SlotKind, path: string, subject: string): Operation<void> {
    const key = `${kind}:${path}`;
    let acquire = slots.get(key);
    if (acquire === undefined) {
      acquire = lazily(entry, function* (): Operation<void> {
        yield* (yield* useSlots()).hold(kind, path, subject);
      });
      slots.set(key, acquire);
    }
    return acquire();
  }

  // This entry's own registry and its own registered placements. Neither is a
  // prop, a Context value, a middleware answer or a journal event, and neither
  // survives the entry: membership is rebuilt from the placements this
  // execution parsed, and rebuilding it acquires nothing.
  const selections = selectionRegistry<ReplPlacementRegistration>();
  const serialize = slotTurns();

  const selectionEntry: ReplSelectionEntry = {
    host,
    git: useGit,
    root: useRoot,
    ambient: useAmbientRepository,
    holdSlot,
    holdCommon: (commonDirectory: string) => holdCommon(commonDirectory),
    serialize,
    selections,
    remember(registration: ReplPlacementRegistration): void {
      const slot = registration.slot;
      if (slot === undefined) {
        // The ambient owner is a routing answer rather than a managed
        // placement. Registering it for file coverage would shadow the saved
        // ambient record a coroutine consumes at its own cursor.
        return;
      }
      const checkoutRoot = registration.placement.checkoutRoot;
      const existing = placements.findIndex((placed) => placed.checkoutRoot === checkoutRoot);
      const subject = placementSubject(registration.placement);
      const placed: ReplManagedPlacement = {
        checkoutRoot,
        commonDirectory: registration.placement.commonDirectory,
        own(): Operation<void> {
          return holdManagedPlacement(() => holdSlot(slot.kind, slot.path, subject));
        },
      };
      if (existing < 0) {
        placements.push(placed);
        return;
      }
      placements[existing] = placed;
    },
  };

  // Repository selection, and nothing else this package can do. Installing the
  // ordinary all-feature provider here would enable local Git, publication and
  // external workers, none of which this delivery retains.
  yield* Repository.around(
    {
      select: ([request]: [RepositoryRequest]): Operation<RepositorySelection> =>
        selectReplRepository(selectionEntry, request),

      worktree: ([repository, request]: [
        RepositorySelection,
        WorktreeRequest,
      ]): Operation<RepositorySelection> => selectReplWorktree(selectionEntry, repository, request),

      ambient: (): Operation<RepositorySelection | undefined> =>
        selectReplAmbientOwner(selectionEntry, directory),
    },
    { at: "min" },
  );
}
