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
 * This records file and directory work, the managed checkouts a document
 * selects to do it in, the three local Git operations — authored and generated
 * writes, authored deletions, the directory an authored `<Dir>` ensures, the
 * `<Repository>` and `<Worktree>` selections that say where, and `<Git.Add>`,
 * `<Git.Switch>` and `<Git.Commit>` in the checkout those select — the four
 * local Git reads `<Git.Files>`, `<Git.Changes>`, `<Git.Diff>` and
 * `<Git.File>`, and, for an entry whose capability was built per entry below,
 * the publication an authored `<Git.Push />` asks for.
 *
 * It also records what that entry asked a Git host for: the pull request an
 * authored `<PullRequest>` opens or brings up to date, and the snapshot each of
 * its three evidence reads was answered with. Those have their own protocol and
 * their own admission — a local result and a publication authorize neither, and
 * a pull request is admitted by this entry's own acknowledged publication of
 * the branch it names.
 *
 * ## Installing it reaches nothing
 *
 * No directory, no lease, no `git`, no filesystem read, no commit identity, no
 * managed root, no configuration, no credential and no remote. The ambient
 * checkout is discovered by the first mutation that needs to know whether it is
 * inside one, and an entry that mutates nothing never looks. The managed root is created by the first selection, and an entry
 * that selects nothing never makes one. The invoking person's author and
 * committer are read by the first live `<Git.Commit>`, and an entry that
 * commits nothing — or replays a completed commit — asks the host nothing about
 * who it is. Being outside a checkout is remembered as "there is none" rather
 * than refused, so an entry writing files beside the document runs exactly as it
 * would anywhere else.
 */

import { ensure, until, useScope } from "effection";
import type { Operation, Scope } from "effection";
import { realpath } from "node:fs/promises";
import { ensureDir } from "@effectionx/fs";
import { cwd, Files } from "@executablemd/runtime";
import type { HelperAssembly } from "@executablemd/git/credential-helper";
import { denoPullRequestOperations, useDenoRepositoryOperations } from "@executablemd/git/deno";
import type { DenoPullRequestOperations, DenoRepositoryOperations } from "@executablemd/git/deno";
import { Repository } from "@executablemd/git/api";
import type { RepositoryRequest, WorktreeRequest } from "@executablemd/git/api";
import type { RepositorySelection } from "@executablemd/git/api";
import { Git } from "@executablemd/git/api";
import type { AmbientRepository } from "@executablemd/git/deno";
import { captureCommitIdentity, denoIdentityReader } from "@executablemd/git/deno";
import type { GitCommitIdentity, IdentityReader } from "@executablemd/git/deno";
import { lazily } from "@executablemd/git/deno";
import { useLeases } from "@executablemd/git/deno";
import type { Leases, SlotKind } from "@executablemd/git/deno";
import type { RegisteredCheckout } from "@executablemd/git/deno";
import { selectionRegistry } from "@executablemd/git/deno";
import { holdManagedPlacement, useCommonDirectoryLease } from "./leases.ts";
import type { ReplAmbientCheckout } from "../records.ts";
import { currentCoroutine, selectedCheckout } from "./local.ts";
import { replFileMiddleware } from "./files.ts";
import type { ReplLocalRecorder, ReplManagedPlacement } from "./files.ts";
import { replGitMiddleware } from "./git.ts";
import type { ReplGitCheckout, ReplGitEntry } from "./git.ts";
import { replObservationMiddleware } from "./observations.ts";
import type { ReplObservationEntry } from "./observations.ts";
import { GitQuery } from "@executablemd/git/api";
import { replPushAdmission, replPushPolicy } from "./push.ts";
import type { ReplPushEntry } from "./push.ts";
import { replIssueAdmission, replIssuePolicy, useEntryIssueTransport } from "./issues.ts";
import { replPullRequestPolicy } from "./pull-request.ts";
import { replPullRequestReadAdmission, replPullRequestReadPolicy } from "./pull-request-reads.ts";
import { pushDeclaration } from "@executablemd/git";
import { issueDeclaration } from "@executablemd/git";
import { pullRequestDeclaration } from "@executablemd/git";
import { pullRequestReadDeclaration } from "@executablemd/git";
import { PULL_REQUEST_READ_KINDS } from "@executablemd/git";
import { Execution } from "@executablemd/core/api";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { IdentityComponent, JournalAdmission } from "@executablemd/core/host";
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
  readonly projectCwd?: string;
  readonly workspace?: string;
  /**
   * How this entry performs native repository work.
   *
   * Production states none and gets the platform's own, built from the helper
   * below. A suite states one so it can count, hold or refuse the twelve
   * credential-free methods without a `git` subprocess — and without ever
   * holding a session, an attachment or a credential, none of which crosses
   * this boundary any more.
   */
  readonly operations?: () => Operation<DenoRepositoryOperations>;
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
  /**
   * How this host reads the invoking person's effective Git identity.
   *
   * Absent uses native Git with the caller's own environment and the directory
   * the entry started in, which is the whole question. A suite substitutes it to
   * say what this host knows — including that it knows nothing — and to observe
   * that a completed Commit asks nothing at all. Nothing a document, a prop or a
   * Context value holds can select or replace it.
   */
  readonly identity?: IdentityReader;
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
export function useReplRepositoryRecording(options: ReplRecordingOptions = {}): Operation<void> {
  return initializeReplRepository(options);
}

/**
 * The repository capability one REPL entry runs with, as a per-entry factory.
 *
 * Called by the CLI inside the entry task, for the exact execution and entry
 * key the owner was derived from. Calling it registers this entry's
 * `Execution.init` middleware in that task and answers with the declarations,
 * the admissions and the installation callback the execution runs in its own
 * scope. It acquires nothing and initializes nothing: no directory, no lease,
 * no `git`, no credential and no managed root.
 *
 * Registration belongs to the entry task and initialized state belongs to the
 * execution scope beneath it, which is why nothing here is wrapped in a scope
 * of its own: a scope that closed when this factory returned would take the
 * registration with it before the execution that needs it had started.
 *
 * ## One initializer, and one holder of what it makes
 *
 * The init middleware establishes the recording this host has always
 * established, and delivers the minimal private entry state into this closure.
 * Revocation is armed before that state can be used and runs on success,
 * failure and cancellation alike, including a partial initialization — so a
 * body that kept the accessor past its own entry reaches nothing. The state is
 * never returned to the CLI, published through Context or reachable from a
 * document.
 *
 * One entry declares the common vocabulary once, with this host's policy under
 * the two operations it retains and the ordinary policy under the rest. There
 * is no inherited executable default here for an entry registration to shadow:
 * the declarations an execution captures are these, and a host that recorded
 * nothing for an operation leaves that operation its own refusal.
 */
export function* replRepositoryInstallation(
  owner: string,
  options: ReplRecordingOptions = {},
): Operation<ExecutionInstallation> {
  const held: { entry?: ReplPushEntry } = {};
  let usable = false;

  yield* Execution.around({
    *init(_args, next): Operation<void> {
      // Armed before anything is delivered, and before `next()`: an execution
      // halted while it initializes revokes what it had, and one that failed
      // halfway through leaves nothing usable behind.
      yield* ensure(() => {
        usable = false;
        delete held.entry;
      });
      yield* initializeReplRepository(options, (entry) => {
        held.entry = entry;
        usable = true;
      });
      yield* next();
    },
  });

  // This entry's own pull-request transport state, built once and inert: naming
  // it reads no configuration, opens no session and acquires nothing. Its
  // configuration is the existing one this deployment already states, which is
  // why no recording option carries it.
  const pullRequests: DenoPullRequestOperations = denoPullRequestOperations();
  const access = () => (usable ? held.entry : undefined);

  // The six names this entry declares, and only those. Every name this
  // vocabulary has is already registered in the command's scope; what an entry
  // adds here is the policy it owns, attached to those same shared bodies from
  // inside its own execution.
  //
  // Retaining an operation is not by itself a reason to declare its name. This
  // entry retains the pages its four Git reads answer with and the file work
  // beneath them too, and both are middleware under the component rather than a
  // policy named after an invocation — so they keep the registered default and
  // appear nowhere here. These six need the invocation: a durable boundary that
  // has to enclose the public chain cannot be installed inside it, and each
  // evidence read is named after the occurrence that asked for it.
  const components: readonly IdentityComponent[] = [
    pushDeclaration(replPushPolicy(owner, access)),
    issueDeclaration(replIssuePolicy(owner)),
    pullRequestDeclaration(replPullRequestPolicy(owner, access, () => pullRequests)),
    ...PULL_REQUEST_READ_KINDS.map((kind) =>
      pullRequestReadDeclaration(
        kind,
        replPullRequestReadPolicy(owner, () => pullRequests),
      ),
    ),
  ];
  // The publication walk admits this entry's saved pull-request requests and
  // their outcomes beside its Push ones, so it is not asked twice. The read
  // admission is its own question: a retained read is named by a question
  // rather than paired with an outcome.
  const admissions: JournalAdmission[] = [
    replIssueAdmission(owner),
    replPushAdmission(owner),
    replPullRequestReadAdmission(owner),
  ];
  return {
    components,
    admissions,
    install: () => useEntryIssueTransport({}),
  };
}

/**
 * Establish one entry's recording, and hand its own private state to whoever
 * initialized it.
 *
 * The one initializer both routes use. `useReplRepositoryRecording()` above
 * takes no delivery and keeps its `void` contract, which is what the host-only
 * identity seam and every existing consumer are written against. The per-entry
 * factory below states one, and what it receives is the minimal set of
 * functions a publication needs: this entry's Git session and native host, its
 * private selection registry and registered checkouts, its single-flight slot
 * acquisition and its native turn.
 *
 * The delivery is a call rather than a value anything can read. Nothing is
 * returned, published through Context, or registered anywhere a document, a
 * prop, a plugin or middleware could reach: the only holder is the closure that
 * asked for it, and that closure is revoked with this execution.
 */
function* initializeReplRepository(
  options: ReplRecordingOptions,
  deliver?: (entry: ReplPushEntry) => void,
): Operation<void> {
  const directory = options.projectCwd ?? (yield* cwd());
  const configuredRoot = options.root;

  // The entry task. Every capability below is acquired into it, so the session,
  // its directory and the lease last as long as the entry does rather than as
  // long as whichever element first needed them.
  const entry: Scope = yield* useScope();

  // The Git session's root is also `HOME`, so Git reads no configuration
  // belonging to whoever is running the command.
  // The native work this entry asks for, built once in the entry's own scope.
  // Building it acquires nothing: no directory, no lock, no Git child, no
  // identity, no configuration and no credential. Whatever it lazily acquires
  // belongs to this scope, which is the execution that owns the entry.
  const operations = yield* (
    options.operations ?? (() => useDenoRepositoryOperations(options.helper))
  )();

  const discover = lazily(entry, function* (): Operation<ReplAmbientCheckout | undefined> {
    return yield* operations.ambientCheckout(directory);
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

  // The checkouts native Git may run in, which is a wider set than the one
  // above: the ambient owner a root `<Worktree>` recorded is a checkout this
  // entry can commit in, and it is deliberately not a managed placement for
  // file coverage — registering it there would shadow the saved ambient record a
  // coroutine consumes at its own cursor.
  const gitCheckouts: ReplGitCheckout[] = [];

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
  yield* Files.around(replFileMiddleware(recorder, options.workspace), { at: "max" });

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
  // One `Leases` per managed root, because a slot's lock sidecar lives under
  // the root that slot belongs to. A replayed placement names the root it was
  // selected under, which is not necessarily the one configured now — the same
  // configured path can resolve somewhere else — and locking a saved slot under
  // today's root would open a sidecar nobody else is holding.
  const roots = new Map<string, () => Operation<Leases>>();
  function useSlots(root: string): Operation<Leases> {
    let acquire = roots.get(root);
    if (acquire === undefined) {
      acquire = lazily(entry, function* (): Operation<Leases> {
        return yield* useLeases(root);
      });
      roots.set(root, acquire);
    }
    return acquire();
  }

  // Everything a Repository identity needs, and only a root `<Worktree>` needs
  // it. An entry that writes files and selects nothing keeps PR 1's smaller
  // discovery and never asks these questions.
  const useAmbientRepository = lazily(entry, function* (): Operation<
    AmbientRepository | undefined
  > {
    return yield* operations.ambientRepository(directory);
  });

  // One lazy acquisition per managed slot, so a slot taken by a live selection
  // is the same hold the first new file operation inside a restored placement
  // reacquires. Single-flight, because two concurrent first callers each
  // opening their own descriptor would be refused by the operating system for
  // contending with their own entry.
  const slots = new Map<string, () => Operation<void>>();
  function holdSlot(root: string, kind: SlotKind, path: string, subject: string): Operation<void> {
    // Keyed on the root as well as the slot: two placements of one entry may
    // name the same slot path under two roots, and they are two sidecars.
    const key = `${root}\u0000${kind}:${path}`;
    let acquire = slots.get(key);
    if (acquire === undefined) {
      acquire = lazily(entry, function* (): Operation<void> {
        yield* (yield* useSlots(root)).hold(kind, path, subject);
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
    operations,
    root: useRoot,
    ambient: useAmbientRepository,
    holdSlot,
    holdCommon: (commonDirectory: string) => holdCommon(commonDirectory),
    serialize,
    selections,
    remember(registration: ReplPlacementRegistration): void {
      // Every successfully parsed placement, the ambient owner included: a
      // Repository this entry authenticated is one its Git operations may run
      // in, whether or not a managed root placed it.
      rememberGitCheckout(registration);
      const slot = registration.slot;
      // The root this placement recorded, not the one configured now: a
      // restored placement's slot belongs to the root it was selected under,
      // and that is the sidecar an ordinary owner of it holds.
      const placedRoot = registration.placement.managedRoot;
      if (slot === undefined || placedRoot === undefined) {
        // The ambient owner is a routing answer rather than a managed
        // placement, and has neither a slot nor a root. Registering it for file
        // coverage would shadow the saved ambient record a coroutine consumes
        // at its own cursor.
        return;
      }
      const checkoutRoot = registration.placement.checkoutRoot;
      const existing = placements.findIndex((placed) => placed.checkoutRoot === checkoutRoot);
      const subject = placementSubject(registration.placement);
      const placed: ReplManagedPlacement = {
        checkoutRoot,
        commonDirectory: registration.placement.commonDirectory,
        own(): Operation<void> {
          return holdManagedPlacement(() => holdSlot(placedRoot, slot.kind, slot.path, subject));
        },
      };
      if (existing < 0) {
        placements.push(placed);
        return;
      }
      placements[existing] = placed;
    },
  };

  /**
   * Remember where native Git may run, replacing an earlier registration of
   * the same checkout.
   *
   * Routing data only, derived from the placement rather than read out of the
   * journal: the repository's own name, the Worktree's display name for a
   * linked checkout and `null` otherwise. No origin, because a local result
   * confers no publication evidence and this provider publishes nothing.
   *
   * Repeated registration replaces equivalent routing data and never suppresses
   * a durable call: which operations happened is the journal's answer, and this
   * is only where they are allowed to happen.
   */
  function rememberGitCheckout(registration: ReplPlacementRegistration): void {
    const placement = registration.placement;
    const checkout: RegisteredCheckout = Object.freeze({
      root: placement.checkoutRoot,
      identity: placement.identity,
      repositoryName: placement.identity.name,
      worktreeName: placement.kind === "worktree" ? placement.displayName : null,
      origin: undefined,
    });
    const held: ReplGitCheckout = Object.freeze({ checkout, registration });
    const existing = gitCheckouts.findIndex((entry_) => entry_.checkout.root === checkout.root);
    if (existing < 0) {
      gitCheckouts.push(held);
      return;
    }
    gitCheckouts[existing] = held;
  }

  // From the trusted host: the four strings a commit records about who made it,
  // read from the directory this entry started in. A host that cannot say is
  // remembered as not saying for the rest of the entry, and only `<Git.Commit>`
  // refuses — so the read happens when a commit needs it, not before, and a
  // completed Commit's replay never reaches it.
  const useIdentity = lazily(entry, function* (): Operation<GitCommitIdentity | undefined> {
    return yield* captureCommitIdentity(options.identity ?? denoIdentityReader(directory));
  });

  const gitEntry: ReplGitEntry = {
    operations,
    identity: useIdentity,
    holdSlot,
    holdCommon: (commonDirectory: string) => holdCommon(commonDirectory),
    serialize,
    selections,
    checkouts: () => gitCheckouts,
  };

  // Repository selection and the three local operations, and nothing else this
  // package can do. Installing the ordinary all-feature provider here would
  // enable publication and the external workers, neither of which this delivery
  // retains.
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

  // The implementation slot, where the ordinary provider installs its own, so
  // middleware a document or a host puts above this composes exactly as it does
  // in an ordinary run.
  yield* Git.around(replGitMiddleware(gitEntry), { at: "min" });

  // The four reads, at the same slot and on the same terms. They share this
  // entry's registry, its registered checkouts, its slot acquisition and its
  // native turn, and take no mutation lease: a read changes nothing, so there
  // is nothing for one to protect.
  const observationEntry: ReplObservationEntry = {
    operations,
    holdSlot,
    serialize,
    selections,
    checkouts: () => gitCheckouts,
  };
  yield* GitQuery.around(replObservationMiddleware(observationEntry), { at: "min" });

  // Last, and only for the route that asked: everything above is in place, so
  // what a publication reaches is an initialized entry rather than a
  // half-assembled one. An entry with no managed root returns before this,
  // which is what leaves `<Git.Push />` the same missing-provider refusal it
  // reaches when nothing selected a checkout.
  deliver?.({
    operations,
    holdSlot,
    serialize,
    selections,
    checkouts: () => gitCheckouts,
  });
}
