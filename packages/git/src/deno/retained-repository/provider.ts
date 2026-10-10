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

import { Err, Ok, ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { isAbsolute, relative, resolve } from "node:path";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import type { FragmentFileAccess } from "@executablemd/core/host";
import type { FilePathInput, FilesHandler, FileWriteInput, GlobInput } from "@executablemd/runtime";
import { PullRequestAPI } from "../../composition/pull-request-api.ts";
import { PullRequestOperations } from "../../composition/pull-request-operations.ts";
import type { PullRequestReadInvocation } from "../../composition/pull-request-operations.ts";
import type { PullRequestReadResult } from "../../composition/pull-request-read-records.ts";
import { admitRetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import type { RetainedRepositoryHistory } from "../../retained-repository/admission.ts";
import {
  retainedRepositoryOwner,
  sameRetainedFrontier,
  withSharedRefs,
} from "../../retained-repository/records.ts";
import type {
  RetainedFrontier,
  RetainedRepositorySite,
} from "../../retained-repository/records.ts";
import {
  parseRetainedAmbientSelection,
  retainedAmbientSelectionJson,
} from "../../retained-repository/requests.ts";
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
import { retainedGitComponents } from "./components.ts";
import { retainedExternalComponents } from "./external.ts";
import type { RetainedExternalHost } from "./external.ts";
import { retainedFileMutations } from "./files.ts";
import type { CheckoutPublication, RetainedFileHost, SelectedCheckout } from "./files.ts";
import { FrontierError, inventoryFrontier } from "./frontier.ts";
import { admitOwnedObservations } from "./observations.ts";
import { holdRetainedLanes, retain, retainedLanes, retainedResume } from "./local.ts";
import type { RetainedResume } from "./local.ts";
import { admittedPublications, ambientPublication, ambientSelection } from "./publication.ts";
import type { RetainedPublication } from "./publication.ts";
import { retainedRepository, retainedWorktree } from "./selections.ts";
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
  readonly selection: RetainedAmbientSelection;
  readonly common: string;
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
  const lanes = retainedLanes();
  // One counter per shared Git directory, advanced as this entry attempts
  // operations. A resume attempts the same ones in the same order, so the
  // numbers line up and a replayed intent carries the identity it was written
  // under.
  const positions = new Map<string, number>();
  const position = (common: string) => {
    const next = positions.get(common) ?? 0;
    positions.set(common, next + 1);
    return next;
  };
  const selected = new Map<string, SelectedCheckout>();
  // What this entry expects each checkout it has touched to be in: the state
  // its history authenticated when the checkout was attached, advanced by every
  // operation this entry has since had acknowledged. A new operation is held to
  // this rather than to the snapshot the entry opened with, because the entry's
  // own completed work is part of what its history accounts for.
  const expected = new Map<string, RetainedFrontier>();
  const attached = new Set<string>();
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
  // Acquired into this entry's own scope, so every slot it holds is released
  // when the entry ends, however it ends.
  const leases = yield* useLeases(request.managedRoot);
  // The checkout a `<Worktree>` is a worktree of: the last one selected, which
  // is the one its content is written inside.
  let enclosing: SelectedCheckout | undefined;
  let admitted: RetainedRepositoryHistory | undefined;
  let resume: RetainedResume = retainedResume([]);
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
        yield* attach(checkout);
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
    const retained = admitted?.completed.find((effect) => effect.intent.operation === "ambient");
    const ambientSelected =
      retained === undefined ? yield* discoveredSelection() : savedSelection(retained);
    if (ambientSelected === undefined) {
      return undefined;
    }
    const common = ambientSelected.common;
    const held = ambientSelected.selection;
    const checkout: SelectedCheckout = Object.freeze({
      checkout: held.root,
      directory: held.root,
      common,
      git,
      // What this entry resolved when it first selected this checkout, read
      // back from its own record on a resume. Discovering it again would pin
      // the identity at whatever HEAD is now, and a push after a commit would
      // then name a repository this history never recorded.
      // deno-lint-ignore require-yield
      *publication(): Operation<Result<CheckoutPublication>> {
        return Ok(ambientPublication(held, common));
      },
    });
    // The shared Git directory is leased before this entry reads a byte of it.
    // Selecting is where that happens, because selecting is what makes this
    // entry the one doing repository work here — and a second process holding
    // the same directory has to refuse before anything is inventoried, not
    // after an operation has already frozen a state the other one is moving.
    yield* holdRetainedLanes(leases, [
      {
        kind: "common",
        slot: checkout.common,
        subject: "the Git directory of the checkout this entry started in",
      },
    ]);
    // Authenticated before its own selection is replayed: a resume that
    // answered with the root it recorded while the checkout there has been
    // changed would be selecting a checkout that is no longer the one it chose.
    yield* attach(checkout);
    const selection = yield* retain(
      {
        owner,
        site: Object.freeze({
          source: request.source,
          occurrence: `ambient:${checkout.checkout}`,
        }),
        operation: "ambient",
        checkout: checkout.checkout,
        common: checkout.common,
        position: position(checkout.common),
        candidates: () => {
          const held = expected.get(checkout.checkout);
          return held === undefined ? [] : [held];
        },
        settled: (frontier) => settledAt(checkout.checkout, frontier),
        selection: { checkout: checkout.checkout },
        request: { ambient: checkout.checkout },
        inventory: () =>
          inventoryFrontier({
            git,
            checkout: checkout.checkout,
            directory: checkout.directory,
          }),
        // deno-lint-ignore require-yield
        *prepare(preState) {
          // Selecting changes nothing: the two ends of this transition are one
          // state, and what the record is for is saying which checkout.
          //
          // Ambient selection never creates anything — it found a checkout that
          // was already there — so it has a state to start from by
          // construction, and an absent one here would mean this host had
          // discovered a repository that does not exist.
          if (preState === null) {
            return Err(
              new Error(
                "ambient selection has no absent state: the checkout it selected was found, " +
                  "not created.",
              ),
            );
          }
          return Ok({
            postState: preState,
            // The resolved identity travels with the preparation, not with the
            // request: what the entry asked for is "work here", and what it
            // resolved from that is which repository this checkout is of.
            prepared: retainedAmbientSelectionJson(held),
            evidence: { type: "ambient", checkout: checkout.checkout },
          });
        },
        // deno-lint-ignore require-yield
        *perform() {
          return Ok({ type: "ambient", checkout: checkout.checkout });
        },
      },
      resume,
      lanes,
    );
    if (!selection.ok) {
      throw selection.error;
    }
    return checkout;
  }

  /**
   * Authenticate a checkout against what this entry's history accounts for.
   *
   * Once per checkout, before anything is replayed, performed or expanded in
   * it. What the history holds is its folded final state and the two ends of
   * any mutation of it left unresolved; the checkout is in one of those, or it
   * has been changed by something this entry did not record — and a replay
   * answering with its saved results anyway would be answering about a
   * checkout that is no longer there.
   *
   * A checkout the history says nothing about is a first selection and needs
   * no authentication: there is nothing yet for it to disagree with.
   */
  function* attach(checkout: SelectedCheckout): Operation<void> {
    if (attached.has(checkout.checkout)) {
      return;
    }
    attached.add(checkout.checkout);
    const candidates = admitted?.attachments.find(
      (attachment) => attachment.checkout === checkout.checkout,
    )?.candidates;
    if (candidates === undefined || candidates.length === 0) {
      return;
    }
    const live = yield* inventoryFrontier({
      git: checkout.git,
      checkout: checkout.checkout,
      directory: checkout.directory,
    });
    if (!live.ok) {
      // A checkout this history established, and this host cannot describe.
      // The commonest way for that to happen is for it not to be there any
      // more, which is the one state none of the candidates can be: a
      // destination that has gone is not a state to replay saved results
      // against, and nothing here puts it back.
      throw new FrontierError(
        `${checkout.checkout} is a checkout this entry's history established and this host ` +
          `cannot read now, so what has happened to it is not recorded here: ` +
          `${live.error.message}`,
      );
    }
    if (!candidates.some((candidate) => sameRetainedFrontier(candidate, live.value))) {
      throw new FrontierError(
        `${checkout.checkout} is not in any state this entry's history accounts for, so what ` +
          "has happened to it since is not recorded here.",
      );
    }
    expected.set(checkout.checkout, live.value);
  }

  /**
   * Hold this checkout to what an acknowledged operation left it in.
   *
   * The refs reach every sibling of the same administration too: a commit in
   * one linked worktree moves a branch every checkout of that repository can
   * see, and a sibling still expecting the old ref list would refuse the next
   * thing written in it.
   */
  function settledAt(checkout: string, frontier: RetainedFrontier): void {
    expected.set(checkout, frontier);
    attached.add(checkout);
    for (const [other, held] of expected) {
      if (other === checkout || held.administration.common !== frontier.administration.common) {
        continue;
      }
      expected.set(other, withSharedRefs(held, frontier.refs));
    }
  }

  /** The checkout this entry started in, when it started in one. */
  function* discoveredSelection(): Operation<AmbientSelection | undefined> {
    const found = yield* discoverAmbientRepository(git, request.cwd);
    if (found === undefined) {
      return undefined;
    }
    return { selection: ambientSelection(found), common: found.commonDirectory };
  }

  /**
   * The ambient selection this entry's own record froze.
   *
   * A record whose preparation this host cannot read, or whose root is not the
   * checkout its completion established, says nothing about which repository
   * this entry selected — and answering with the root alone would publish
   * under an identity nothing recorded.
   */
  function savedSelection(effect: {
    readonly intent: { readonly prepared: Json };
    readonly completion: { readonly frontier: RetainedFrontier };
  }): AmbientSelection {
    const saved = parseRetainedAmbientSelection(effect.intent.prepared);
    if (saved === undefined || saved.root !== effect.completion.frontier.checkout) {
      throw new FrontierError(
        "this entry's own ambient selection does not say which repository it selected, so what " +
          "it would publish from is not recorded here.",
      );
    }
    return { selection: saved, common: effect.completion.frontier.administration.common };
  }

  const fileHost: RetainedFileHost = {
    owner,
    covering: (path) => covering(path),
    ordinary: request.files,
    lanes,
    resume: {
      pending: (fingerprint) => resume.pending(fingerprint),
      completed: (fingerprint) => resume.completed(fingerprint),
    },
    position,
    attach: (checkout) => attach(checkout),
    candidates: (checkout) => {
      // What this entry expects, once the checkout has been attached. The
      // admitted snapshot answers only before that, which is the window in
      // which attachment itself decides.
      const held = expected.get(checkout);
      return held === undefined
        ? (admitted?.attachments.find((attachment) => attachment.checkout === checkout)
            ?.candidates ?? [])
        : [held];
    },
    settled: settledAt,
    expected: (checkout) => expected.get(checkout),
    site: (occurrence): RetainedRepositorySite =>
      Object.freeze({ source: request.source, occurrence }),
  };

  const selectionHost: RetainedSelectionHost = {
    files: fileHost,
    repository: request.host,
    managedRoot: request.managedRoot,
    leases,
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
    resume = retainedResume(read.value.pending, read.value.completed);
    // Publication admission, rebuilt into this closure from the accepted
    // records of the segment that owns it. A record this scan cannot read
    // refuses here, where nothing has been attached and nothing contacted.
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
        ...retainedGitComponents(fileHost, request.host),
        ...retainedExternalComponents(externalHost),
        retainedRepository(selectionHost),
        retainedWorktree(selectionHost),
      ],
    },
    files: capturedFiles(request.files, request.cwd),
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
function capturedFiles(files: FilesHandler, cwd: string): FragmentFileAccess {
  return {
    checkFilePath: (input: FilePathInput) => files.checkFilePath(input),
    readTextFile: (input: FilePathInput) => files.readTextFile(input),
    globFiles: (input: GlobInput) => files.globFiles(input),
    writeTextFile: (input: FileWriteInput) => files.writeTextFile(input),
    deleteFile: (input: FilePathInput) => files.deleteFile(input),
    ensureDirectory: (input: FilePathInput) => files.ensureDirectory(input),
    // deno-lint-ignore require-yield
    *workingDirectory(): Operation<string> {
      return cwd;
    },
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
