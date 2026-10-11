/**
 * One REPL entry's retained repository host.
 *
 * Everything an entry needs to do repository work and be able to resume it
 * lives in the closure this builds: the owner it retains under, the checkouts
 * it has selected, the lane that serializes each shared Git directory, and the
 * history its own admission read. None of it is installed in a context, none of
 * it is reachable from a document, and all of it ends with the entry.
 *
 * The admission is where a resume is decided. It runs inside canonical core's
 * own journal read, on the exact snapshot every later phase consumes, before
 * any document code exists — so by the time the first element expands, this
 * host already knows which effects completed and which one was interrupted. A
 * history it cannot read completely refuses there, with nothing yet attached
 * and nothing yet touched.
 *
 * Selection is lazy and never implicit. Installing this host opens no
 * repository, takes no lease and reads no checkout; an entry that writes no
 * file inside a repository has done no repository work, and its history says
 * so by being empty.
 */

import { Err, Ok, ensure, scoped, useScope } from "effection";
import type { Operation, Result } from "effection";
import { isAbsolute, relative, resolve } from "node:path";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import type { FragmentFileAccess } from "@executablemd/core/host";
import { ensureDir } from "@effectionx/fs";
import { dirname } from "node:path";
import { API, cwd } from "@executablemd/runtime";
import type { FilePathInput, FilesHandler, FileWriteInput, GlobInput } from "@executablemd/runtime";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import { PullRequestOperations } from "../../composition/pull-request-operations.ts";
import type { PullRequestReadInvocation } from "../../composition/pull-request-operations.ts";
import type { PullRequestReadResult } from "../../composition/pull-request-read-records.ts";
import { admitRetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import { retainedRepositoryOwner } from "../../retained-repository/records.ts";
import type { RetainedRepositorySite } from "../../retained-repository/records.ts";
import type { RetainedAmbientSelection } from "../../retained-repository/requests.ts";
import { gitSession } from "../composition/git.ts";
import type { GitSession } from "../composition/git.ts";
import type { GitHubAccess } from "../composition/github.ts";
import { denoGitHubSource } from "../composition/github-host.ts";
import type { RepositoryHost } from "../composition/host.ts";
import { useOwnedPullRequestReads } from "../composition/pull-request-operations.ts";
import {
  gitHubPullRequestAccess,
  useGitHubPullRequestReads,
} from "../composition/pull-request-reads.ts";
import type { GitHubPullRequestsOptions } from "../composition/pull-request-reads.ts";
import { useGitHubIssues } from "../issue/github.ts";
import type { GitHubIssuesOptions } from "../issue/github.ts";
import { discoverAmbientRepository } from "../run-composition/ambient.ts";
import { useLeases } from "../run-composition/leases.ts";
import type { Leases } from "../run-composition/leases.ts";
import { canonicalPath, lazily } from "../run-composition/provider.ts";
import { retainedGitComponents } from "./components.ts";
import { retainedExternalComponents } from "./external.ts";
import type { RetainedExternalHost } from "./external.ts";
import { retainedFileMutations } from "./files.ts";
import type { CheckoutPublication, RetainedFileHost, SelectedCheckout } from "./files.ts";
import { admitOwnedObservations } from "./observations.ts";
import { FrontierError, holdCommonDirectory, recorded } from "./local.ts";
import { admittedPublications, ambientPublication, ambientSelection } from "./publication.ts";
import type { RetainedPublication } from "./publication.ts";
import {
  parseSelectionResult,
  retainedRepository,
  retainedWorktree,
  selectedFrom,
  selectionResultJson,
} from "./selections.ts";
import type { RetainedSelectionHost } from "./selections.ts";

/** What the command tells this entry about itself. */
export interface RetainedEntryRequest {
  /** The execution this entry belongs to, as the host established it. */
  readonly executionId: string;
  /** This entry's own key, in the order the entries were admitted. */
  readonly entryKey: string;
  /** The canonical identity of the source this entry is running. */
  readonly source: string;
  /** Where the entry started, which is where an ambient checkout is looked for. */
  readonly cwd: string;
  /** The trusted root this entry's managed checkouts are placed under. */
  readonly managedRoot: string;
  readonly host: RepositoryHost;
  /** Ordinary file behavior, for everything outside a selected checkout. */
  readonly files: FilesHandler;
  /** What issue handling this entry installs, and what it may reach. */
  readonly gitHubIssues?: GitHubIssuesOptions;
  /** The pull-request destinations this entry allows a document to read. */
  readonly gitHubPullRequests?: GitHubPullRequestsOptions;
}

/** An ambient checkout this entry works in, and the directory that identifies it. */
interface AmbientSelection {
  /** The repository discovery found, as the ambient selection describes it. */
  readonly selection: RetainedAmbientSelection;
  readonly common: string;
  /** The checkout whose administration that shared directory belongs to. */
  readonly repositoryDirectory: string;
}

/** What one entry's host offers the command that built it. */
export interface RetainedEntryHost {
  /** The owner every record this entry writes is retained under. */
  readonly owner: string;
  readonly installation: ExecutionInstallation;
  /** The one captured file access this entry's evaluation profile is bound to. */
  readonly files: FragmentFileAccess;
  /** What its admitted history holds, once the admission has run. */
  history(): RetainedRepositoryHistory | undefined;
  /** The checkouts it has selected so far. */
  selections(): readonly SelectedCheckout[];
}

/**
 * Build one entry's host.
 *
 * Nothing here reaches the filesystem. The lanes, the selection table and the
 * handler set are closures, and the first thing that touches a checkout is a
 * mutation an admitted element asked for.
 */
export function* useRetainedRepositoryEntry(
  request: RetainedEntryRequest,
): Operation<RetainedEntryHost> {
  const owner = retainedRepositoryOwner({
    executionId: request.executionId,
    entryKey: request.entryKey,
  });
  // One counter per shared Git directory, advanced as this entry attempts
  // operations. A resume attempts the same ones in the same order, so the
  const selected = new Map<string, SelectedCheckout>();
  // What this entry has published, in the order it published it: rebuilt from
  // its accepted history when the admission runs, and appended to by every
  // push this entry verifies. Nothing else may add to it, and another entry
  // constructs its own — which is what makes "this entry published that
  // branch" mean this entry.
  const published: RetainedPublication[] = [];
  // The occurrence an evidence read is being performed for, for the length of
  // that one read. Reads are expanded one at a time, and the retaining
  // middleware sits beneath the adapter that admits them — where there is no
  // occurrence to be had — so this is how the claimed one reaches it.
  let reading: string | undefined;
  const git = gitSession(request.host, request.cwd);
  // The scope this entry's placement infrastructure belongs to: created once,
  // released with the entry.
  const entry = yield* useScope();
  /**
   * Where managed placements live, as one canonical path.
   *
   * Created and then canonicalized, in that order and once. A root reached
   * through a symlink is still one directory, and every identity this host
   * derives from it has to be derived from the same spelling: the slot a
   * `<Repository>` is placed in, the common directory its worktrees key on, the
   * key its selection is remembered under, and the lock that keeps a second
   * process out. A write inside a selected checkout arrives as the path the
   * filesystem answers with, so a selection remembered under the other spelling
   * does not cover it — the write goes out as an ordinary one, and the next
   * operation finds a checkout in a state this entry's history cannot account
   * for.
   *
   * Lazily, because it is infrastructure for an entry that asks for a managed
   * placement and nothing for an entry that does not: a cold view, a preflight
   * and an ordinary unselected entry each reach none of this. Creating the root
   * is not creating a destination — no slot, checkout or metadata is touched
   * here, and a placement's own creation still happens inside its acknowledged
   * intent.
   */
  const useRoot = lazily(entry, function* (): Operation<string> {
    yield* ensureDir(request.managedRoot);
    return yield* canonicalPath(request.managedRoot);
  });
  // Rooted at that same canonical path: a lease taken under one spelling of a
  // root excludes nobody holding the other. The root is handed over as the way
  // to get one rather than as a path, so an entry whose only lease is a shared
  // Git directory — every ambient one — still creates no placement root.
  const useSlots = lazily(entry, function* (): Operation<Leases> {
    return yield* useLeases(useRoot);
  });
  // The checkout a `<Worktree>` is a worktree of: the last one selected, which
  // is the one its content is written inside.
  let enclosing: SelectedCheckout | undefined;
  let admitted: RetainedRepositoryHistory | undefined;
  let ambient: SelectedCheckout | undefined;
  let discovered = false;

  /**
   * The checkout covering this path, discovering the ambient one on first ask.
   *
   * Lazy on purpose, and asked once: an entry that never writes inside a
   * repository never looks for one, and one that does looks exactly where it
   * started rather than wherever the document has since moved.
   */
  function* covering(path: string): Operation<SelectedCheckout | undefined> {
    for (const checkout of selected.values()) {
      if (within(checkout.directory, path)) {
        return checkout;
      }
    }
    if (discovered) {
      return undefined;
    }
    discovered = true;
    ambient = yield* selectAmbient();
    if (ambient === undefined) {
      return undefined;
    }
    selected.set(ambient.checkout, ambient);
    return within(ambient.directory, path) ? ambient : undefined;
  }

  /**
   * The ambient checkout this entry works in, selected once.
   *
   * A resume takes the root its own history recorded rather than looking
   * again: an entry reopened from somewhere else on the disk is still the
   * entry that selected that checkout, and rediscovering would quietly make it
   * a different one.
   *
   * A first selection is itself retained. It changes nothing, so the state it
   * starts from and the state it leaves are the same — but it is the record
   * that says this entry works here, and every mutation after it is held to
   * following it.
   */
  function* selectAmbient(): Operation<SelectedCheckout | undefined> {
    // What the entry asked for is "work here". Which repository that is — its
    // name, its origin, the commit its identity is pinned at — is what asking
    // resolved to, and a continuation reads that back from its own record
    // rather than discovering it again: an entry reopened while HEAD has moved
    // is still the entry that selected this checkout.
    const site = Object.freeze({ source: request.source, occurrence: "ambient" });
    // Asked of this entry's own history first, and of the filesystem only when
    // the history has nothing to say: a continuation reads back the repository
    // it selected, and an entry standing nowhere near a checkout selects
    // nothing rather than recording that it found none.
    const saved = admitted?.results.find((result) => result.operation === "ambient");
    const discovered = saved === undefined ? yield* discoveredSelection() : undefined;
    if (saved === undefined && discovered === undefined) {
      return undefined;
    }
    const produced = yield* recorded({
      owner,
      site,
      operation: "ambient",
      request: { ambient: request.cwd },
      *perform(): Operation<Result<Json>> {
        if (discovered === undefined) {
          return Err(
            new FrontierError(
              `${request.cwd} is not inside a Git checkout, so there is no ambient repository ` +
                "for this entry to work in.",
            ),
          );
        }
        const held = discovered.selection;
        return Ok(
          selectionResultJson("ambient", {
            checkout: held.root,
            common: discovered.common,
            identity: held.identity,
            origin: held.origin,
            // An ambient entry started inside a linked worktree publishes from
            // the repository whose administration that worktree shares.
            repositoryDirectory: discovered.repositoryDirectory,
            repositoryName: held.identity.name,
            worktreeName: null,
          }),
        );
      },
    });
    if (!produced.ok) {
      throw produced.error;
    }
    const selection = parseSelectionResult(produced.value);
    if (selection === undefined) {
      throw new FrontierError(
        "this entry's own ambient selection is not one this host can read, so which repository " +
          "it works in is not something this history says.",
      );
    }
    // The shared Git directory is leased before this entry reads a byte of it.
    // Selecting is where that happens, because selecting is what makes this
    // entry the one doing repository work here — and a second process holding
    // the same directory has to refuse before anything is performed.
    yield* holdCommonDirectory(selection.common, owner);
    yield* (yield* useSlots()).holdAll([
      {
        kind: "common",
        slot: selection.common,
        subject: "the Git directory of the checkout this entry started in",
      },
    ]);
    // What this entry resolved when it first selected this checkout, read back
    // from its own record on a resume. Discovering it again would pin the
    // identity at whatever HEAD is now, and a push after a commit would then
    // name a repository this history never recorded.
    const publication: CheckoutPublication = Object.freeze({
      identity: selection.identity,
      origin: selection.origin,
      repositoryDirectory: selection.repositoryDirectory,
    });
    return selectedFrom(selection, git, function* () {
      return Ok(publication);
    });
  }

  /** The checkout this entry started in, when it started in one. */
  function* discoveredSelection(): Operation<AmbientSelection | undefined> {
    const found = yield* discoverAmbientRepository(git, request.cwd);
    if (found === undefined) {
      return undefined;
    }
    return {
      selection: ambientSelection(found),
      common: found.commonDirectory,
      // An entry started inside a linked worktree publishes from the
      // repository whose administration that worktree shares, which is the
      // directory holding that administration.
      repositoryDirectory: dirname(found.commonDirectory),
    };
  }

  const fileHost: RetainedFileHost = {
    owner,
    covering: (path) => covering(path),
    ordinary: request.files,
    site: (occurrence): RetainedRepositorySite =>
      Object.freeze({ source: request.source, occurrence }),
  };

  const selectionHost: RetainedSelectionHost = {
    files: fileHost,
    repository: request.host,
    root: useRoot,
    slots: useSlots,
    select: (checkout) => {
      selected.set(checkout.checkout, checkout);
      enclosing = checkout;
    },
    owner: () => enclosing,
  };

  const admission: JournalAdmission = function* (retained: readonly DurableEvent[]) {
    const read = yield* admitRetainedRepositoryHistory(retained, owner);
    if (!read.ok) {
      // Fails the continuation where it is read, with nothing attached and
      // nothing touched.
      throw read.error;
    }
    // The observations beside them, which are held to this owner here because
    // their own durable names deliberately are not.
    const observed = admitOwnedObservations(retained, owner);
    if (!observed.ok) {
      throw observed.error;
    }
    admitted = read.value;
    // Publication admission, rebuilt into this closure from the accepted
    // records of the segment that owns it. A record this scan cannot read
    // refuses here, where nothing has been contacted.
    published.push(...admittedPublications(retained, read.value));
  };

  // The pull-request transport, asked of the adapter that owns it and opened
  // once. Where the API lives is configuration, and an entry that opens no pull
  // request reads none of it.
  const access = gitHubPullRequestAccess({
    host: denoGitHubSource,
    ...request.gitHubPullRequests,
  });
  let opened: GitHubAccess | undefined;

  const externalHost: RetainedExternalHost = {
    files: fileHost,
    repository: request.host,
    *pullRequests(): Operation<GitHubAccess> {
      if (opened === undefined) {
        opened = yield* (yield* access()).open();
      }
      return opened;
    },
    published: (publication) => {
      published.push(publication);
    },
    publications: () => published,
    reading: <T>(occurrence: string, read: () => Operation<T>): Operation<T> =>
      // Scoped to the one read, and registered before the slot is taken: a
      // read that is cancelled or refused leaves no occurrence standing for
      // whatever asks next.
      scoped(function* (): Operation<T> {
        yield* ensure(() => {
          reading = undefined;
        });
        reading = occurrence;
        return yield* read();
      }),
    enclosing: (path) => selectedCheckoutFor([...selected.values()], path),
  };

  // The mutations this entry retains have to reach their own terminals, and a
  // host that answers them is what stops them. `useHostFiles()` — which every
  // entrypoint installs, because `API.Files` has no host default — answers a
  // write, a deletion and a directory ensure outright, and the canonical
  // terminal core builds for an authored mutation sits *inside* that. So this
  // entry installs a layer of its own, nearer the terminal, that delegates
  // exactly those three: the request still passes every middleware a document
  // or a package installed, and what settles it is the terminal rather than the
  // host handler. Everything else — reading, globbing, checking a path, a
  // temporary directory — is not handled here at all and falls through to the
  // host as it always did.
  //
  // The ordinary behavior is not lost: it is what this entry's own handlers
  // perform directly, through the `files` handler they were given, for every
  // path outside a selected checkout. Performing it through the public chain
  // instead would be this layer delegating into itself.
  yield* API.Files.around({
    *writeTextFile([input], next) {
      return yield* next(input);
    },
    *deleteFile([input], next) {
      return yield* next(input);
    },
    *ensureDirectory([input], next) {
      return yield* next(input);
    },
  });

  // The transport middlewares, installed into this entry's own scope. Each one
  // matches a request against its own target first, so absent configuration
  // authorizes nothing and a document naming an unreachable destination reaches
  // the surface's own refusal.
  yield* useGitHubIssues({ host: denoGitHubSource, ...request.gitHubIssues });
  yield* useGitHubPullRequestReads({ host: denoGitHubSource, ...request.gitHubPullRequests });
  // Beneath the adapter, so a target this host never authorized leaves no
  // retained record of a question this entry was not permitted to ask.
  yield* useOwnedPullRequestReads({ owner, site: () => reading });
  yield* PullRequestOperations.around(
    {
      // Straight through to the transport: which provider answers, and what a
      // credential may see, belong to the adapters above, and the retaining
      // middleware beneath them is what makes an admitted read this entry's.
      *read([invocation]: [PullRequestReadInvocation]): Operation<PullRequestReadResult> {
        return yield* PullRequestAPI.operations.read(invocation.url, {
          kind: invocation.kind,
          ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
        });
      },
    },
    { at: "min" },
  );

  return {
    owner,
    installation: {
      admissions: [admission],
      fileMutations: retainedFileMutations(fileHost),
      // Declared, not registered: each one is minted a domain so its body can
      // authenticate its own invocation before it routes anything.
      components: [
        ...retainedGitComponents(fileHost),
        ...retainedExternalComponents(externalHost),
        retainedRepository(selectionHost),
        retainedWorktree(selectionHost),
      ],
    },
    files: capturedFiles(request.files),
    history: () => admitted,
    selections: () => [...selected.values()],
  };
}

/**
 * The one captured file access this entry's fragments run on.
 *
 * Its mutations are the ones canonical core routes past it, straight to the
 * handler set above, so what remains here is everything a fragment may do that
 * is not a mutation — and the ordinary mutation behavior for a host that was
 * given no handlers at all.
 */
function capturedFiles(files: FilesHandler): FragmentFileAccess {
  return {
    checkFilePath: (input: FilePathInput) => files.checkFilePath(input),
    readTextFile: (input: FilePathInput) => files.readTextFile(input),
    globFiles: (input: GlobInput) => files.globFiles(input),
    writeTextFile: (input: FileWriteInput) => files.writeTextFile(input),
    deleteFile: (input: FilePathInput) => files.deleteFile(input),
    ensureDirectory: (input: FilePathInput) => files.ensureDirectory(input),
    /**
     * The directory a fragment resolves its own relative paths against.
     *
     * Read when the fragment runs, not frozen when this access was captured.
     * An `<Evaluate>` inside a `<Repository>` or a `<Worktree>` is standing in
     * that checkout — the selection composed the working directory for its
     * content — and a fragment it produced has to resolve `generated.md` to the
     * same file the authored `<File>` beside it resolves. Freezing the entry's
     * own starting directory here sent every generated write to wherever the
     * command happened to be started, which is a different checkout with a
     * different selection and a different lane.
     *
     * The callable is what is captured. Core reads it once per fragment into
     * that fragment's own cursor and restores the cursor afterwards, so one
     * answer per fragment is exactly the grain this needs: the directory the
     * element that produced it was standing in.
     */
    workingDirectory: () => cwd(),
  };
}

/**
 * Whether this absolute path is this checkout, or somewhere in it.
 *
 * The checkout's own root counts. A `<Git.Add>` written at the top of a
 * checkout is working in that checkout, and asking whether the root is
 * *strictly inside* itself is a different question — the one a file target is
 * held to, where the root is not a file anybody can write.
 */
function within(directory: string, path: string): boolean {
  const at = relative(resolve(directory), resolve(path));
  return !at.startsWith("..") && !isAbsolute(at);
}

/** Another entry's checkout is not this one's, whatever the path says. */
export function selectedCheckoutFor(
  selections: readonly SelectedCheckout[],
  path: string,
): SelectedCheckout | undefined {
  return selections.find((checkout) => within(checkout.directory, path));
}
