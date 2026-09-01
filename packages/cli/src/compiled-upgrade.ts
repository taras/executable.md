/**
 * The installation authority behind `xmd upgrade`, for a compiled macOS or
 * Linux binary (specs/upgrade-command-spec.md).
 *
 * Everything a document must never be able to do lives here: opening the
 * installation, taking the lock that makes one attempt the only attempt,
 * reading GitHub, holding downloaded bytes, comparing a digest, running the
 * candidate, and committing one rename over the binary that is running.
 *
 * The document reaches these acts through four phases, and nothing else:
 *
 * ```text
 * <Upgrade.Releases requestedTag=… />  lstat, topology, lock, then the release
 *                                      listing — as detached facts and an
 *                                      opaque identity per release
 * <Upgrade.Download release=… />       only an admitted release; assets,
 *                                      bounded download, exclusive staging
 * <Upgrade.Verify   candidate=… />     only a downloaded candidate; checksum,
 *                                      executable mode, `--version`
 * <Upgrade.Replace  candidate=… />     only a verified candidate; one rename
 * ```
 *
 * Four rather than one because the document reports progress, and a reader
 * watching a binary be replaced deserves to see each step as it completes. The
 * split gives Markdown honest points to report at; it moves no authority.
 *
 * The identity is the whole of the authority boundary. A release fact is data —
 * a tag, two flags, a page URL, asset names — and holding it authorizes
 * nothing. What authorizes a phase is being in this invocation's private map,
 * in the state that phase accepts; nothing outside this closure can read,
 * extend or forge it. So the document may choose among the releases it was
 * shown and may not name another release, target, asset or destination, skip a
 * phase, or replay one.
 *
 * Two things are true of every path through here. Before the rename, the
 * installed binary is byte-identical to what it was — nothing opens it for
 * writing, and a candidate is staged beside it and thrown away. After the
 * rename, the candidate is authoritative and no cleanup, cancellation or
 * failure puts the old bytes back.
 */

import { ensure, Err, Ok, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { lstat, rm } from "@effectionx/fs";
import { exec, Stdio } from "@effectionx/process";
import { timebox } from "@effectionx/timebox";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
// `@effectionx/fs` covers the reads and the removal; it offers no `open`,
// `rename`, `chmod` or writable-mode `access`, so those four stay adapted from
// the runtime's own asynchronous primitives.
import { access, chmod, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Json } from "@executablemd/core";
import type { IdentityComponent } from "@executablemd/core/host";

import { releaseTargetFor } from "./release-targets.ts";
import type { ReleaseTarget } from "./release-targets.ts";
import type { UpgradeAssembly, UpgradeCommand } from "./upgrade.ts";

/** The one repository a self-upgrade will read or download from. */
const OWNER_REPO = "taras/executable.md";
const RELEASES_API = `https://api.github.com/repos/${OWNER_REPO}/releases`;
const ASSET_PATH_PREFIX = `/${OWNER_REPO}/releases/download/`;
const CHECKSUMS_ASSET = "checksums.txt";

/** The exact hosts a download may reach, and nothing that merely resembles one. */
const METADATA_HOST = "api.github.com";
const ASSET_HOST = "github.com";
const ASSET_DELIVERY_HOST = "release-assets.githubusercontent.com";

/** GitHub refuses an anonymous API request that names no client. */
const USER_AGENT = "xmd-upgrade";

/**
 * What one command may read, download and wait for.
 *
 * Real numbers rather than round ones: the v0.10.2 binaries are 121–158 MB and
 * `checksums.txt` is 469 bytes, so the binary bound has headroom over a real
 * artifact and the checksum bound is three orders of magnitude above a real
 * checksum set. A bound chosen for a small CLI would refuse the release it is
 * supposed to install.
 */
export interface UpgradeBounds {
  /** How many 100-release pages a listing may read before it is incomplete. */
  metadataPages: number;
  /** How many bytes of release metadata one command may read in total. */
  metadataBytes: number;
  /** How large `checksums.txt` may be. */
  checksumBytes: number;
  /** How large the release binary may be. */
  binaryBytes: number;
  /** How many redirects one download may follow. */
  redirects: number;
  /** How long the staged candidate has to report its version. */
  candidateMilliseconds: number;
}

export const UPGRADE_BOUNDS: UpgradeBounds = {
  metadataPages: 32,
  metadataBytes: 8 * 1024 * 1024,
  checksumBytes: 64 * 1024,
  binaryBytes: 256 * 1024 * 1024,
  redirects: 10,
  candidateMilliseconds: 30_000,
};

/** One HTTPS read, as much of it as this module uses. */
export interface UpgradeResponse {
  readonly status: number;
  /** The `Location` header, when the response carries one. */
  readonly location: string | undefined;
  /** The advertised length, when it parses as a non-negative integer. */
  readonly contentLength: number | undefined;
  readonly body: ReadableStream<Uint8Array> | undefined;
  /** Release this response without reading it. */
  cancel(): Operation<void>;
}

/** What one bounded read asks for. No caller header ever reaches it. */
export interface UpgradeRequest {
  readonly url: string;
  readonly accept: string;
}

export interface UpgradeTransport {
  (request: UpgradeRequest): Operation<UpgradeResponse>;
}

/** What a staged candidate said when it was asked for its version. */
export interface CandidateReport {
  readonly code: number;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface CandidateProbe {
  (path: string, bound: number): Operation<CandidateReport>;
}

export interface CommitReplacement {
  (staged: string, destination: string): Operation<void>;
}

/**
 * The seams a harness may stand in front of.
 *
 * Transport, the candidate process, the commit and the bounds — the four places
 * a deterministic failure cannot be produced any other way. Nothing here
 * weakens a check: every validation below runs against whatever these return,
 * which is what makes a scripted redirect, a short body or a failing rename
 * evidence about production rather than about a test mode.
 */
export interface CompiledUpgradeDependencies {
  transport?: UpgradeTransport;
  probe?: CandidateProbe;
  commit?: CommitReplacement;
  bounds?: Partial<UpgradeBounds>;
  /**
   * Where the candidate is staged, given the installed path.
   *
   * A fault point, and the only way to make the exclusive create collide on
   * purpose: production names a random sibling nothing can predict, which is
   * exactly what makes the collision unreachable from a test otherwise.
   */
  stage?: (destination: string) => string;
  /** The same, for the two names the topology probe creates. */
  probeStage?: (parent: string) => string;
  /**
   * The staged candidate's file, wrapped.
   *
   * The fault point for a write that fails part-way through a real download,
   * and the only way to observe that the descriptor is closed rather than
   * merely that its path is gone.
   */
  sink?: (file: CandidateFile) => CandidateFile;
}

/** What the compiled entrypoint states about the installation it is running as. */
export interface CompiledUpgradeFacts {
  /** The executable path this process was invoked as, spelled exactly. */
  readonly executablePath: string;
  /** The version this binary reports. */
  readonly currentVersion: string;
  /** The release row for this machine. */
  readonly target: ReleaseTarget;
}

/** What a compiled binary observes about itself, at the entrypoint that knows. */
export interface CompiledHost {
  /** The executable path this process was invoked as, spelled exactly. */
  readonly executablePath: string;
  /** Node's `process.platform`. */
  readonly platform: string;
  /** Node's `process.arch`. */
  readonly architecture: string;
  /** The version this binary reports, from the manifest it was built with. */
  readonly currentVersion: string;
}

/**
 * What a compiled `xmd` states about upgrading itself.
 *
 * Authority is granted on two facts and nothing else: this is not Windows, and
 * the release publishes a binary for this platform. Neither is a guess about
 * how the file arrived — a compiled binary somebody copied, extracted, built or
 * installed is the same file to this command, and replacing it is the same act.
 *
 * A compiled Windows binary and a compiled binary for a platform no release
 * targets both come back without an authority, so the document has no component
 * to reach and stops at its own refusal.
 */
export function compiledUpgradeAssembly(
  host: CompiledHost,
  dependencies?: CompiledUpgradeDependencies,
): UpgradeAssembly {
  const target = releaseTargetFor(host.platform, host.architecture);
  const stated = {
    currentVersion: host.currentVersion,
    executablePath: host.executablePath,
    platform: host.platform,
    architecture: host.architecture,
    ...(target === undefined ? {} : { target: target.target }),
  };
  if (host.platform === "win32") {
    return { provenance: "compiled-windows", ...stated };
  }
  if (target === undefined) {
    return { provenance: "compiled", ...stated };
  }
  const facts: CompiledUpgradeFacts = {
    executablePath: host.executablePath,
    currentVersion: host.currentVersion,
    target,
  };
  return {
    provenance: "compiled",
    ...stated,
    authority: (command) => compiledUpgradeAuthority(facts, command, dependencies),
  };
}

/** A refusal with the code the document presents it by. */
class UpgradeFailure extends Error {
  override name = "UpgradeFailure";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A release as this command retains it, and the identity that authorizes it. */
interface NormalizedRelease {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly url: string;
  readonly assets: readonly string[];
  readonly identity: string;
}

/**
 * The open lock file this host holds, as much of it as this module uses.
 *
 * Named here rather than as `Deno.FsFile` because this file typechecks under
 * the Node project too, and that project has no `Deno` namespace to name.
 */
interface AdvisoryLockFile {
  tryLockSync(exclusive: boolean): boolean;
  unlockSync(): void;
  close(): void;
}

interface LockingRuntime {
  openSync(
    path: string,
    options: { read: boolean; write: boolean; create: boolean },
  ): AdvisoryLockFile;
}

/** Whether the global this host found is one that opens files. */
function opensFiles(candidate: unknown): candidate is LockingRuntime {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof Reflect.get(candidate, "openSync") === "function"
  );
}

/**
 * One staged candidate, and how far this invocation has taken it.
 *
 * The phase is what makes the three components a sequence rather than three
 * separate powers: `Upgrade.Verify` accepts only a downloaded candidate and
 * `Upgrade.Replace` only a verified one, so a document cannot skip verification
 * or replay a phase, whatever identity it presents.
 */
interface StagedCandidate {
  readonly identity: string;
  readonly release: NormalizedRelease;
  readonly asset: string;
  readonly version: string;
  readonly staged: string;
  readonly digest: string;
  /** The published checksum file, which never crosses to the document. */
  readonly checksums: string;
  phase: "downloaded" | "verified" | "committed";
}

/** What one invocation holds and has to give back. */
interface InvocationState {
  lock: AdvisoryLockFile | undefined;
  /** Staging paths this invocation created and has not committed. */
  scratch: string[];
}

const RELEASE_FACT_SCHEMA: Record<string, Json> = {
  type: "object",
  properties: {
    tag: { type: "string" },
    draft: { type: "boolean" },
    prerelease: { type: "boolean" },
    url: { type: "string" },
    identity: { type: "string" },
    assets: { type: "array", items: { type: "string" } },
  },
  required: ["tag", "draft", "prerelease", "url", "identity", "assets"],
  additionalProperties: false,
};

const FAILURE_SCHEMA: Record<string, Json> = {
  type: ["object", "null"],
  properties: { code: { type: "string" } },
  required: ["code"],
  additionalProperties: false,
};

/**
 * Every phase's declaration, exported so nothing has to restate it.
 *
 * The document's policy suite stands deterministic components in exactly these
 * places, and a fake that declared its own shapes would let the two drift: the
 * policy would keep passing against a contract production no longer has.
 */
export const UPGRADE_RELEASES_PROPS: Record<string, Json> = {
  type: "object",
  properties: { requestedTag: { type: ["string", "null"] } },
  required: ["requestedTag"],
  additionalProperties: false,
};

export const UPGRADE_RELEASES_RETURNS: Record<string, Json> = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: FAILURE_SCHEMA,
    value: {
      type: ["object", "null"],
      properties: { releases: { type: "array", items: RELEASE_FACT_SCHEMA } },
      required: ["releases"],
      additionalProperties: false,
    },
  },
  required: ["ok", "error", "value"],
  additionalProperties: false,
};

export const UPGRADE_DOWNLOAD_PROPS: Record<string, Json> = {
  type: "object",
  properties: { release: { type: "string" } },
  required: ["release"],
  additionalProperties: false,
};

export const UPGRADE_DOWNLOAD_RETURNS: Record<string, Json> = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: FAILURE_SCHEMA,
    value: {
      type: ["object", "null"],
      properties: { asset: { type: "string" }, candidate: { type: "string" } },
      required: ["asset", "candidate"],
      additionalProperties: false,
    },
  },
  required: ["ok", "error", "value"],
  additionalProperties: false,
};

export const UPGRADE_CANDIDATE_PROPS: Record<string, Json> = {
  type: "object",
  properties: { candidate: { type: "string" } },
  required: ["candidate"],
  additionalProperties: false,
};

export const UPGRADE_VERIFY_RETURNS: Record<string, Json> = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: FAILURE_SCHEMA,
    value: {
      type: ["object", "null"],
      properties: { candidate: { type: "string" }, version: { type: "string" } },
      required: ["candidate", "version"],
      additionalProperties: false,
    },
  },
  required: ["ok", "error", "value"],
  additionalProperties: false,
};

export const UPGRADE_REPLACE_RETURNS: Record<string, Json> = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: FAILURE_SCHEMA,
    value: {
      type: ["object", "null"],
      properties: {
        previousVersion: { type: "string" },
        installedVersion: { type: "string" },
        executablePath: { type: "string" },
        releaseUrl: { type: "string" },
      },
      required: ["previousVersion", "installedVersion", "executablePath", "releaseUrl"],
      additionalProperties: false,
    },
  },
  required: ["ok", "error", "value"],
  additionalProperties: false,
};

/** The origin every phase declares, so a catalog says where it came from. */
export const UPGRADE_ORIGIN = "xmd upgrade";

/**
 * Build the four phases one `xmd upgrade` invocation may reach.
 *
 * Called inside the command's own scope. The lock release and the staging
 * cleanup are registered here, before anything can be acquired or created, so
 * an ending of any kind — a refusal, a failure, a cancellation, a killed
 * process — gives back everything this invocation took.
 */
export function* compiledUpgradeAuthority(
  facts: CompiledUpgradeFacts,
  command: UpgradeCommand,
  dependencies: CompiledUpgradeDependencies = {},
): Operation<readonly IdentityComponent[]> {
  const bounds: UpgradeBounds = { ...UPGRADE_BOUNDS, ...dependencies.bounds };
  const transport = dependencies.transport ?? httpsRead;
  const probe = dependencies.probe ?? runCandidate;
  const commit = dependencies.commit ?? renameOver;
  const stage = dependencies.stage ?? defaultStagePath;
  const probeStage = dependencies.probeStage ?? defaultProbePath;
  const sink = dependencies.sink ?? ((file: CandidateFile) => file);

  const admitted = new Map<string, NormalizedRelease>();
  const candidates = new Map<string, StagedCandidate>();
  const state: InvocationState = { lock: undefined, scratch: [] };
  let attempted = false;
  const install: InstallDependencies = { transport, probe, commit, bounds, stage, sink };

  // Registered in this order so teardown runs the other way round: the staging
  // this invocation created is removed while it still holds the lock, and the
  // lock goes back last.
  yield* ensure(() => releaseLock(state));
  yield* ensure(() => discardScratch(state));

  const releases: IdentityComponent = {
    name: "Upgrade.Releases",
    origin: UPGRADE_ORIGIN,
    forms: ["self-closing"],
    props: UPGRADE_RELEASES_PROPS,
    returns: UPGRADE_RELEASES_RETURNS,
    factory: () =>
      function* upgradeReleases(props: Record<string, Json>) {
        const requestedTag = typeof props.requestedTag === "string" ? props.requestedTag : null;

        // Status reads and reports. It opens nothing, locks nothing and leaves
        // no probe behind, which is what lets it be run while another upgrade
        // is in progress.
        if (!command.status) {
          const opened = yield* openInstallation(facts, state, probeStage);
          if (!opened.ok) {
            return refusal(opened.error);
          }
        }

        const read = yield* readReleases(requestedTag, transport, bounds);
        if (!read.ok) {
          return refusal(read.error);
        }
        for (const release of read.value) {
          admitted.set(release.identity, release);
        }
        return {
          ok: true,
          error: null,
          value: { releases: read.value.map(publish) },
        };
      },
  };

  /**
   * What every phase after the listing checks first.
   *
   * A value nothing admitted, a candidate from another invocation, and a
   * candidate presented out of order are all the same thing: a claim of
   * authority that was never granted. None is a failure code, because
   * answering with an outcome would make a forged capability indistinguishable
   * from a release this command could not install.
   */
  const refuseClaim = (element: string, why: string): never => {
    throw new Error(
      `<${element}> was given ${why}, so nothing further was done and xmd was not changed`,
    );
  };

  const ownedCandidate = (element: string, props: Record<string, Json>, phase: string) => {
    const held = typeof props.candidate === "string" ? candidates.get(props.candidate) : undefined;
    if (held === undefined) {
      return refuseClaim(element, "a candidate this invocation never staged");
    }
    if (held.phase !== phase) {
      return refuseClaim(element, `a candidate that is ${held.phase} rather than ${phase}`);
    }
    return held;
  };

  const download: IdentityComponent = {
    name: "Upgrade.Download",
    origin: UPGRADE_ORIGIN,
    forms: ["self-closing"],
    props: UPGRADE_DOWNLOAD_PROPS,
    returns: UPGRADE_DOWNLOAD_RETURNS,
    factory: () =>
      function* upgradeDownload(props: Record<string, Json>) {
        const release = typeof props.release === "string" ? admitted.get(props.release) : undefined;
        if (release === undefined) {
          return refuseClaim("Upgrade.Download", "a release this invocation never admitted");
        }
        // One installation attempt per invocation, spent before the first asset
        // request. A second download is refused whether it names the same
        // release or another one.
        if (attempted) {
          return refuseClaim("Upgrade.Download", "a second installation attempt");
        }
        attempted = true;

        const staged = yield* downloadRelease(release, facts, state, install);
        if (!staged.ok) {
          return refusal(staged.error);
        }
        candidates.set(staged.value.identity, staged.value);
        return {
          ok: true,
          error: null,
          value: { asset: staged.value.asset, candidate: staged.value.identity },
        };
      },
  };

  const verify: IdentityComponent = {
    name: "Upgrade.Verify",
    origin: UPGRADE_ORIGIN,
    forms: ["self-closing"],
    props: UPGRADE_CANDIDATE_PROPS,
    returns: UPGRADE_VERIFY_RETURNS,
    factory: () =>
      function* upgradeVerify(props: Record<string, Json>) {
        const candidate = ownedCandidate("Upgrade.Verify", props, "downloaded");
        const verified = yield* verifyCandidate(candidate, install);
        if (!verified.ok) {
          return refusal(verified.error);
        }
        candidate.phase = "verified";
        return {
          ok: true,
          error: null,
          value: { candidate: candidate.identity, version: candidate.version },
        };
      },
  };

  const replace: IdentityComponent = {
    name: "Upgrade.Replace",
    origin: UPGRADE_ORIGIN,
    forms: ["self-closing"],
    props: UPGRADE_CANDIDATE_PROPS,
    returns: UPGRADE_REPLACE_RETURNS,
    factory: () =>
      function* upgradeReplace(props: Record<string, Json>) {
        const candidate = ownedCandidate("Upgrade.Replace", props, "verified");
        const replaced = yield* replaceCandidate(candidate, facts, state, install);
        if (!replaced.ok) {
          return refusal(replaced.error);
        }
        candidate.phase = "committed";
        return { ok: true, error: null, value: replaced.value };
      },
  };

  return [releases, download, verify, replace];
}

/** One admitted release as the document sees it. Nothing private crosses. */
function publish(release: NormalizedRelease): Json {
  return {
    tag: release.tag,
    draft: release.draft,
    prerelease: release.prerelease,
    url: release.url,
    identity: release.identity,
    assets: [...release.assets],
  };
}

/**
 * A narrowed failure as the closed data the document branches on.
 *
 * An error this module did not raise carries no code, and `unexpected` is not
 * in any of the document's tables — so it reaches the fallback message rather
 * than being presented as a defect somebody could act on.
 */
function refusal(error: Error): Json {
  return {
    ok: false,
    error: { code: error instanceof UpgradeFailure ? error.code : "unexpected" },
    value: null,
  };
}

/**
 * Prove this installation can be replaced, then make this the only attempt.
 *
 * In this order, because each step would otherwise be answered about the wrong
 * file: a link is refused rather than resolved, the directory is proven to
 * accept the create-and-rename the commit depends on, and only then is the lock
 * taken — beside the exact executable, so two upgrades of two installations
 * never contend and two upgrades of one always do.
 */
function* openInstallation(
  facts: CompiledUpgradeFacts,
  state: InvocationState,
  probeStage: (parent: string) => string,
): Operation<Result<void>> {
  const path = facts.executablePath;
  let link: { isSymbolicLink(): boolean; isFile(): boolean };
  try {
    link = yield* lstat(path);
  } catch {
    return Err(
      new UpgradeFailure("unsupported-filesystem", `${path} could not be read as a regular file`),
    );
  }
  if (link.isSymbolicLink()) {
    return Err(new UpgradeFailure("symbolic-link", `${path} is a symbolic link`));
  }
  if (!link.isFile()) {
    return Err(new UpgradeFailure("unsupported-filesystem", `${path} is not a regular file`));
  }

  const parent = dirname(path);
  try {
    yield* until(access(parent, constants.W_OK));
  } catch {
    return Err(new UpgradeFailure("unwritable-parent", `${parent} is not writable`));
  }

  if (!(yield* renamesInPlace(parent, probeStage))) {
    return Err(
      new UpgradeFailure("unsupported-filesystem", `${parent} does not support atomic replacement`),
    );
  }

  let held: boolean;
  try {
    held = takeInstallationLock(path, state);
  } catch {
    // A host with no lock to take cannot promise that one attempt owns this
    // installation, and proceeding without that promise is the one thing this
    // command must not do. Reported as the destination being unable to support
    // the replacement, because that is what it means for the person here.
    return Err(
      new UpgradeFailure("unsupported-filesystem", `${path} could not be locked for replacement`),
    );
  }
  if (!held) {
    return Err(new UpgradeFailure("busy", `another upgrade holds ${path}`));
  }
  return Ok(undefined);
}

/**
 * Whether this directory supports the create-then-rename the commit performs.
 *
 * Asked with the operations the commit uses rather than inferred from a
 * filesystem name, and asked before the network so a destination that cannot
 * be replaced costs no download. Both probe paths are this invocation's own and
 * are removed however the question is answered.
 */
function renamesInPlace(
  parent: string,
  probeStage: (parent: string) => string,
): Operation<boolean> {
  return scoped(function* (): Operation<boolean> {
    const probe = probeStage(parent);
    const moved = `${probe}.moved`;
    // Only names this call exclusively created go in here, and the removal
    // reads the list rather than the two names. A name that already belonged to
    // somebody else is never in it, so cleanup cannot delete their file — the
    // same rule the staged candidate follows, for the same reason.
    const owned: string[] = [];
    yield* ensure(() => discardAll(owned));

    if (!(yield* createOwned(probe))) {
      return false;
    }
    owned.push(probe);

    // The destination is created exclusively too, rather than being renamed
    // over blind. That is both halves of what the commit later does — an
    // exclusive create and a rename over an existing file — and it means a
    // destination name somebody else holds is refused instead of replaced.
    if (!(yield* createOwned(moved))) {
      return false;
    }
    owned.push(moved);

    try {
      yield* until(rename(probe, moved));
    } catch {
      return false;
    }
    return true;
  });
}

/**
 * Create one file exclusively, and close its descriptor before returning.
 *
 * The descriptor belongs to this scope, so it is closed whether the create
 * succeeded, the close failed, or the whole thing was cancelled — leaving the
 * path behind for the caller to record as owned and remove.
 */
function createOwned(path: string): Operation<boolean> {
  return scoped(function* (): Operation<boolean> {
    let handle: FileHandle;
    try {
      handle = yield* until(open(path, "wx", 0o600));
    } catch {
      return false;
    }
    yield* ensure(() => closeQuietly(handle));
    return true;
  });
}

/**
 * Where the topology probe writes, given the installation directory.
 *
 * Random, because it must not collide with anything; the second name extends
 * the first so both are recognizably this command's.
 */
function defaultProbePath(parent: string): string {
  return join(parent, `.xmd-upgrade-probe-${randomUUID()}`);
}

/** Close a handle, tolerating one that is already closed. */
function* closeQuietly(file: { close(): Promise<void> }): Operation<void> {
  try {
    yield* until(file.close());
  } catch {
    // Already closed, or closed by the operation that failed.
  }
}

function* discardAll(paths: readonly string[]): Operation<void> {
  for (const path of paths) {
    yield* discard(path);
  }
}

/**
 * Take the exclusive lock beside this exact executable, or report contention.
 *
 * Synchronous, and the one site in this package that is. The descriptor and the
 * ownership of the lock it carries have to become this invocation's in one
 * uninterrupted step: suspending between the open and the record of who holds
 * it would leave a locked descriptor nothing releases, and blocking the
 * interpreter on the lock would stop the cancellation that is the only thing
 * left to end the wait. The release is registered before this is ever called.
 *
 * The sidecar is created and then left. Unlinking a locked path lets the next
 * caller create and lock a different file at the same name while this lock is
 * still held, which is two owners of one installation.
 */
function takeInstallationLock(executablePath: string, state: InvocationState): boolean {
  const path = `${executablePath}.upgrade-lock`;
  // oxlint-disable-next-line local/no-sync-filesystem
  const file = locking().openSync(path, { read: true, write: true, create: true });
  let locked = false;
  try {
    locked = file.tryLockSync(true);
  } catch (error) {
    file.close();
    throw error;
  }
  if (!locked) {
    file.close();
    return false;
  }
  state.lock = file;
  return true;
}

function locking(): LockingRuntime {
  const runtime: unknown = Reflect.get(globalThis, "Deno");
  if (!opensFiles(runtime)) {
    throw new Error(
      "xmd upgrade takes the installation lock through the Deno runtime, and no Deno runtime " +
        "that opens files is present",
    );
  }
  return runtime;
}

function releaseLock(state: InvocationState): void {
  const file = state.lock;
  if (file === undefined) {
    return;
  }
  state.lock = undefined;
  try {
    file.unlockSync();
  } finally {
    file.close();
  }
}

/** Remove whatever staging this invocation created and never committed. */
function* discardScratch(state: InvocationState): Operation<void> {
  const remaining = state.scratch.splice(0, state.scratch.length);
  for (const path of remaining) {
    yield* discard(path);
  }
}

function* discard(path: string): Operation<void> {
  try {
    yield* rm(path, { force: true });
  } catch {
    // A path something else already removed is the outcome this wanted.
  }
}

/**
 * The releases this command may choose among.
 *
 * An exact tag reads the one endpoint that names it, and a listing reads pages
 * of 100 until a short page proves it reached the end. Running out of pages or
 * of byte budget is a failure rather than an answer: a partial list that looked
 * complete would let "there is no stable release" be reported about a release
 * that exists.
 */
function* readReleases(
  requestedTag: string | null,
  transport: UpgradeTransport,
  bounds: UpgradeBounds,
): Operation<Result<NormalizedRelease[]>> {
  if (requestedTag !== null) {
    const read = yield* readMetadata(
      `${RELEASES_API}/tags/${encodeURIComponent(requestedTag)}`,
      bounds.metadataBytes,
      transport,
    );
    if (!read.ok) {
      return read;
    }
    // A tag GitHub does not publish is not a metadata defect. The document says
    // what a missing release means, and it can only say it about an empty list.
    if (read.value.absent) {
      return Ok([]);
    }
    const one = normalizeRelease(read.value.body);
    if (one === undefined) {
      return Err(malformedMetadata());
    }
    return Ok([one]);
  }

  const collected: NormalizedRelease[] = [];
  let budget = bounds.metadataBytes;
  for (let page = 1; page <= bounds.metadataPages; page += 1) {
    const read = yield* readMetadata(
      `${RELEASES_API}?per_page=100&page=${page}`,
      budget,
      transport,
    );
    if (!read.ok) {
      return read;
    }
    if (read.value.absent) {
      return Err(malformedMetadata());
    }
    budget -= read.value.bytes;
    const entries = read.value.body;
    if (!Array.isArray(entries)) {
      return Err(malformedMetadata());
    }
    for (const entry of entries) {
      const release = normalizeRelease(entry);
      if (release === undefined) {
        return Err(malformedMetadata());
      }
      collected.push(release);
    }
    if (entries.length < 100) {
      return Ok(collected);
    }
  }
  return Err(
    new UpgradeFailure(
      "metadata-incomplete",
      `the release listing did not end within ${bounds.metadataPages} pages`,
    ),
  );
}

function malformedMetadata(): UpgradeFailure {
  return new UpgradeFailure("metadata-invalid", "GitHub release metadata could not be validated");
}

interface MetadataRead {
  /** The parsed body, when GitHub answered with one. */
  body: unknown;
  /** Whether GitHub answered that there is no such release. */
  absent: boolean;
  bytes: number;
}

/**
 * One bounded anonymous read of release metadata.
 *
 * The endpoint is built here from constants, so no response decides where the
 * next request goes: a redirect is a non-2xx answer and ends the read. Nothing
 * is sent but an accept header and a client name — there is no token to leak.
 */
function* readMetadata(
  url: string,
  bound: number,
  transport: UpgradeTransport,
): Operation<Result<MetadataRead>> {
  if (bound <= 0) {
    return Err(
      new UpgradeFailure("metadata-incomplete", "the release metadata budget was exhausted"),
    );
  }
  if (!isMetadataEndpoint(url)) {
    return Err(malformedMetadata());
  }
  return yield* withResponse(
    transport,
    { url, accept: "application/vnd.github+json" },
    malformedMetadata(),
    function* (response): Operation<Result<MetadataRead>> {
      if (response.status === 404) {
        return Ok({ body: null, absent: true, bytes: 0 });
      }
      if (response.status !== 200) {
        return Err(malformedMetadata());
      }
      const chunks: Uint8Array[] = [];
      const read = yield* consume(
        response,
        bound,
        // deno-lint-ignore require-yield
        function* (chunk) {
          chunks.push(chunk);
          return Ok(undefined);
        },
      );
      if (!read.ok) {
        return read;
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(concat(chunks, read.value)));
      } catch {
        return Err(malformedMetadata());
      }
      return Ok({ body, absent: false, bytes: read.value });
    },
  );
}

/**
 * One release, read structurally.
 *
 * The page URL is GitHub's own, held to this repository's releases path rather
 * than assembled from a tag: a value that reaches the reader must be proven to
 * be about this project, and proving is cheaper than escaping. Two assets of
 * one name is an inconsistent release rather than a choice to make later.
 */
function normalizeRelease(value: unknown): NormalizedRelease | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const tag = Reflect.get(value, "tag_name");
  const draft = Reflect.get(value, "draft");
  const prerelease = Reflect.get(value, "prerelease");
  const url = Reflect.get(value, "html_url");
  const assets = Reflect.get(value, "assets");
  if (typeof tag !== "string" || tag.length === 0) {
    return undefined;
  }
  if (typeof draft !== "boolean" || typeof prerelease !== "boolean") {
    return undefined;
  }
  if (typeof url !== "string" || !describesTag(url, tag)) {
    return undefined;
  }
  if (!Array.isArray(assets)) {
    return undefined;
  }
  const names: string[] = [];
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) {
      return undefined;
    }
    const name = Reflect.get(asset, "name");
    if (typeof name !== "string" || name.length === 0 || names.includes(name)) {
      return undefined;
    }
    names.push(name);
  }
  return { tag, draft, prerelease, url, assets: names, identity: randomUUID() };
}

/**
 * Whether this page URL is this repository's page for this exact tag.
 *
 * The prefix alone is not enough. A payload naming one tag and linking another
 * release's page would put the wrong URL in front of a person deciding whether
 * to install — and that URL is the one thing in a release fact a reader is
 * invited to go and check. The last segment is decoded before comparison,
 * because GitHub percent-encodes a tag that needs it and the tag itself does
 * not carry the encoding.
 */
function describesTag(url: string, tag: string): boolean {
  const parsed = parseHttps(url);
  if (parsed === undefined || parsed.hostname !== ASSET_HOST) {
    return false;
  }
  return decodePath(parsed.pathname) === `/${OWNER_REPO}/releases/tag/${tag}`;
}

interface InstallDependencies {
  transport: UpgradeTransport;
  probe: CandidateProbe;
  commit: CommitReplacement;
  bounds: UpgradeBounds;
  stage: (destination: string) => string;
  sink: (file: CandidateFile) => CandidateFile;
}

/** What a completed installation reports. Every field is already public. */
interface InstalledRelease extends Record<string, Json> {
  previousVersion: string;
  installedVersion: string;
  executablePath: string;
  releaseUrl: string;
}

/**
 * Download and stage one admitted release's binary.
 *
 * The first of three phases, and the one that spends this invocation's single
 * installation attempt. What it hands back is a public asset name and an opaque
 * identity; the staging path, the bytes, the digest and the checksum file stay
 * here.
 */
function* downloadRelease(
  release: NormalizedRelease,
  facts: CompiledUpgradeFacts,
  state: InvocationState,
  deps: InstallDependencies,
): Operation<Result<StagedCandidate>> {
  const asset = facts.target.artifact;
  if (!release.assets.includes(asset)) {
    return Err(new UpgradeFailure("asset-missing", `${release.tag} has no ${asset}`));
  }
  if (!release.assets.includes(CHECKSUMS_ASSET)) {
    return Err(new UpgradeFailure("checksums-missing", `${release.tag} has no ${CHECKSUMS_ASSET}`));
  }
  const version = releaseVersion(release.tag);
  if (version === undefined) {
    // The document refuses anything but an exact tag long before this, so this
    // carries a code no table maps: the honest answer for a state nothing can
    // reach is the general one, not a sentence about a missing asset that would
    // send somebody to look at a release for the wrong reason.
    return Err(new UpgradeFailure("tag-unusable", `${release.tag} is not an exact release tag`));
  }

  const checksums = yield* readChecksums(release.tag, deps);
  if (!checksums.ok) {
    return checksums;
  }

  const staged = deps.stage(facts.executablePath);
  // The path is recorded as this invocation's only once the exclusive create
  // has made it ours, which `stageBinary` does.
  const downloaded = yield* stageBinary(release.tag, asset, staged, state, deps);
  if (!downloaded.ok) {
    return downloaded;
  }

  return Ok({
    identity: randomUUID(),
    release,
    asset,
    version,
    staged,
    digest: downloaded.value,
    checksums: checksums.value,
    phase: "downloaded",
  });
}

/**
 * Verify one staged candidate against the release's own record, then against
 * itself.
 *
 * Nothing here touches the installation. The candidate becomes executable only
 * after its digest matches, and it is run only once it is executable — so bytes
 * nobody vouched for are never asked to identify themselves.
 */
function* verifyCandidate(
  candidate: StagedCandidate,
  deps: InstallDependencies,
): Operation<Result<void>> {
  const expected = checksumFor(candidate.checksums, candidate.asset);
  if (!expected.ok) {
    return expected;
  }
  if (candidate.digest !== expected.value) {
    return Err(
      new UpgradeFailure(
        "checksum-mismatch",
        `${candidate.asset} did not match its published checksum`,
      ),
    );
  }

  try {
    yield* until(chmod(candidate.staged, 0o755));
  } catch {
    return Err(
      new UpgradeFailure("replacement-failed", `${candidate.staged} could not be made executable`),
    );
  }

  let reported: CandidateReport;
  try {
    reported = yield* deps.probe(candidate.staged, deps.bounds.candidateMilliseconds);
  } catch {
    // A candidate that could not even be started did not report its version,
    // which is exactly what the answer below says. A raw spawn error would end
    // the document before it could say it.
    reported = { code: -1, stdout: "", timedOut: false };
  }
  if (
    reported.timedOut ||
    reported.code !== 0 ||
    trimTerminator(reported.stdout) !== candidate.version
  ) {
    return Err(
      new UpgradeFailure(
        "candidate-version-mismatch",
        `the candidate did not report ${candidate.version}`,
      ),
    );
  }
  return Ok(undefined);
}

/** Commit one verified candidate over the installed binary, with one rename. */
function* replaceCandidate(
  candidate: StagedCandidate,
  facts: CompiledUpgradeFacts,
  state: InvocationState,
  deps: InstallDependencies,
): Operation<Result<InstalledRelease>> {
  try {
    yield* deps.commit(candidate.staged, facts.executablePath);
  } catch {
    return Err(
      new UpgradeFailure(
        "replacement-failed",
        `${candidate.staged} could not replace ${facts.executablePath}`,
      ),
    );
  }
  // Committed. The candidate is the installed binary now, so it leaves the list
  // of things this invocation still has to remove — nothing after this point
  // deletes it or puts the old bytes back.
  state.scratch = state.scratch.filter((path) => path !== candidate.staged);

  return Ok({
    previousVersion: facts.currentVersion,
    installedVersion: candidate.version,
    executablePath: facts.executablePath,
    releaseUrl: candidate.release.url,
  });
}

/**
 * The version an exact release tag names, or `undefined`.
 *
 * The document already refused anything else, and this asks again: what is
 * about to be built into a download URL and compared against a candidate's
 * output must be proven here, where the URL is assembled.
 */
function releaseVersion(tag: string): string | undefined {
  if (!/^v[0-9A-Za-z.-]+$/.test(tag)) {
    return undefined;
  }
  return tag.slice(1);
}

function trimTerminator(output: string): string {
  return output.replace(/\r?\n$/, "");
}

function* readChecksums(tag: string, deps: InstallDependencies): Operation<Result<string>> {
  const chunks: Uint8Array[] = [];
  const read = yield* download(
    tag,
    CHECKSUMS_ASSET,
    deps.bounds.checksumBytes,
    deps,
    // deno-lint-ignore require-yield
    function* (chunk) {
      chunks.push(chunk);
      return Ok(undefined);
    },
  );
  if (!read.ok) {
    return read;
  }
  return Ok(new TextDecoder().decode(concat(chunks, read.value)));
}

/**
 * The one digest this checksum set records for this asset.
 *
 * GNU `sha256sum` format, and exactly one matching entry: none is a release
 * that cannot be verified, and two is a release whose own record disagrees with
 * itself. Neither is something to resolve by picking one.
 */
function checksumFor(checksums: string, asset: string): Result<string> {
  const digests: string[] = [];
  for (const line of checksums.split("\n")) {
    const entry = /^([0-9a-fA-F]{64})[ ][ *](.+)$/.exec(line.replace(/\r$/, ""));
    if (entry !== null && entry[2] === asset) {
      digests.push((entry[1] ?? "").toLowerCase());
    }
  }
  if (digests.length === 0) {
    return Err(
      new UpgradeFailure("checksum-entry-missing", `${CHECKSUMS_ASSET} does not name ${asset}`),
    );
  }
  if (digests.length > 1) {
    return Err(
      new UpgradeFailure(
        "checksum-entry-duplicate",
        `${CHECKSUMS_ASSET} names ${asset} ${digests.length} times`,
      ),
    );
  }
  return Ok(digests[0] ?? "");
}

/**
 * Stream the release binary into private staging and answer with its digest.
 *
 * Exclusively created and not executable: until the digest matches, this is
 * bytes from the network sitting in a file nobody can run. The complete
 * candidate is flushed before it is closed, so the rename that follows commits
 * a file the operating system has already written out.
 */
function stageBinary(
  tag: string,
  asset: string,
  staged: string,
  state: InvocationState,
  deps: InstallDependencies,
): Operation<Result<string>> {
  return scoped(function* (): Operation<Result<string>> {
    let opened: FileHandle;
    try {
      opened = yield* until(open(staged, "wx", 0o600));
    } catch {
      // The path is not recorded as this invocation's scratch, because the
      // exclusive create is what would have made it ours. A path that already
      // existed belongs to somebody else, and teardown must not remove it.
      return Err(new UpgradeFailure("replacement-failed", `${staged} could not be created`));
    }
    // Owned from here: the create succeeded, so this file is this invocation's
    // to remove, and the descriptor is this scope's to close however it ends.
    state.scratch.push(staged);
    const file = deps.sink(opened);
    yield* ensure(() => closeQuietly(file));

    const digest = createHash("sha256");
    const written = yield* download(tag, asset, deps.bounds.binaryBytes, deps, function* (chunk) {
      digest.update(chunk);
      return yield* writeAll(file, chunk);
    });

    const settled = yield* settleCandidate(file, written.ok);
    if (!written.ok) {
      return written;
    }
    if (!settled.ok) {
      return settled;
    }
    return Ok(digest.digest("hex"));
  });
}

/** As much of a file handle as writing a candidate uses. */
export interface ChunkSink {
  write(chunk: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/** The staged candidate's file, as much of it as this module touches. */
export interface CandidateFile extends ChunkSink {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Write one chunk completely.
 *
 * `write` may store fewer bytes than it was given, and a candidate missing the
 * remainder is a file whose digest is computed over bytes that never reached
 * the disk — it would fail its checksum, but for a reason that says nothing
 * about the release. Looping on `bytesWritten` is what makes the digest and the
 * file describe the same thing.
 */
export function* writeAll(file: ChunkSink, chunk: Uint8Array): Operation<Result<void>> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    let stored: { bytesWritten: number };
    try {
      stored = yield* until(file.write(chunk, offset, chunk.byteLength - offset));
    } catch {
      return Err(
        new UpgradeFailure("replacement-failed", "the candidate could not be written completely"),
      );
    }
    if (stored.bytesWritten <= 0) {
      return Err(new UpgradeFailure("replacement-failed", "the candidate stopped accepting bytes"));
    }
    offset += stored.bytesWritten;
  }
  return Ok(undefined);
}

/** Flush and close the staged candidate, reporting only what still matters. */
function* settleCandidate(file: CandidateFile, flush: boolean): Operation<Result<void>> {
  let failure: UpgradeFailure | undefined;
  if (flush) {
    try {
      yield* until(file.sync());
    } catch {
      failure = new UpgradeFailure("replacement-failed", "the candidate could not be flushed");
    }
  }
  try {
    yield* until(file.close());
  } catch {
    failure =
      failure ?? new UpgradeFailure("replacement-failed", "the candidate could not be closed");
  }
  return failure === undefined ? Ok(undefined) : Err(failure);
}

function assetUrl(tag: string, asset: string): string {
  return `https://${ASSET_HOST}${ASSET_PATH_PREFIX}${tag}/${asset}`;
}

/**
 * Read one release asset, following GitHub's own redirects and nothing else.
 *
 * Every hop is validated before it is requested, and the last one as strictly
 * as the first: a `Location` is a suggestion from a server, and a suggestion
 * that leaves the two exact hosts GitHub serves releases from ends the
 * download rather than being followed to find out.
 */
function* download(
  tag: string,
  asset: string,
  bound: number,
  deps: InstallDependencies,
  onChunk: (chunk: Uint8Array) => Operation<Result<void>>,
): Operation<Result<number>> {
  let current = assetUrl(tag, asset);
  for (let hop = 0; hop <= deps.bounds.redirects; hop += 1) {
    if (!isAssetEndpoint(current, tag, asset)) {
      return Err(
        new UpgradeFailure("redirect-refused", `${current} is outside the release boundary`),
      );
    }
    const step = yield* withResponse(
      deps.transport,
      { url: current, accept: "application/octet-stream" },
      new UpgradeFailure("download-failed", `${current} could not be reached`),
      function* (response): Operation<Result<{ next?: string; bytes?: number }>> {
        if (isRedirect(response.status)) {
          const location = response.location;
          if (location === undefined) {
            return Err(new UpgradeFailure("download-failed", "a redirect named no location"));
          }
          const next = resolveLocation(current, location);
          if (next === undefined || !isAssetEndpoint(next, tag, asset)) {
            return Err(
              new UpgradeFailure("redirect-refused", `${location} is outside the release boundary`),
            );
          }
          return Ok({ next });
        }
        if (response.status !== 200) {
          return Err(
            new UpgradeFailure("download-failed", `the download answered ${response.status}`),
          );
        }
        if (response.contentLength !== undefined && response.contentLength > bound) {
          return Err(
            new UpgradeFailure(
              "download-failed",
              `the download advertised ${response.contentLength} bytes, over its ${bound} bound`,
            ),
          );
        }
        const read = yield* consume(response, bound, onChunk);
        if (!read.ok) {
          return read;
        }
        return Ok({ bytes: read.value });
      },
    );
    if (!step.ok) {
      return step;
    }
    if (step.value.next === undefined) {
      return Ok(step.value.bytes ?? 0);
    }
    current = step.value.next;
  }
  return Err(
    new UpgradeFailure(
      "download-failed",
      `the download exceeded ${deps.bounds.redirects} redirects`,
    ),
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * A `Location` resolved against the request it answered, or `undefined`.
 *
 * A relative location is ordinary and resolving it is the only way to judge it;
 * one that does not parse at all is refused rather than guessed at.
 */
function resolveLocation(from: string, location: string): string | undefined {
  try {
    return new URL(location, from).href;
  } catch {
    return undefined;
  }
}

/** Whether this is the release metadata endpoint, exactly. */
function isMetadataEndpoint(url: string): boolean {
  const parsed = parseHttps(url);
  if (parsed === undefined) {
    return false;
  }
  return (
    parsed.hostname === METADATA_HOST && parsed.pathname.startsWith(`/repos/${OWNER_REPO}/releases`)
  );
}

/**
 * Whether this URL may be requested while downloading one exact asset.
 *
 * On `github.com` the path has to be *this* release's *this* asset, spelled
 * exactly — not merely somewhere under the repository's download path. A
 * redirect to another tag or another asset in the same repository would still
 * be GitHub, still be this project, and still be the wrong bytes: the checksum
 * set names one file, and a download that quietly became a different one is
 * exactly what verification is unable to notice afterwards.
 *
 * GitHub's signed delivery host serves an opaque path it constructs itself, so
 * there is nothing there to bind to; the binding that matters already happened
 * on the hop that produced the redirect.
 */
function isAssetEndpoint(url: string, tag: string, asset: string): boolean {
  const parsed = parseHttps(url);
  if (parsed === undefined) {
    return false;
  }
  if (parsed.hostname === ASSET_HOST) {
    return decodePath(parsed.pathname) === `${ASSET_PATH_PREFIX}${tag}/${asset}`;
  }
  return parsed.hostname === ASSET_DELIVERY_HOST;
}

/** One URL path, decoded, or the raw path when it does not decode. */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * A URL that is HTTPS, on the default port, naming nobody.
 *
 * Userinfo and an explicit port are refused rather than ignored, because both
 * are ways to write a host that reads like one of ours and resolves elsewhere.
 */
function parseHttps(url: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") {
    return undefined;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return undefined;
  }
  return parsed;
}

/**
 * Hold one response for the length of one question, however it is answered.
 *
 * The release is registered before the body is touched, so a refusal, a
 * validation failure and a cancellation all close the connection — a body left
 * open is a socket nothing owns.
 */
function withResponse<T>(
  transport: UpgradeTransport,
  request: UpgradeRequest,
  failure: UpgradeFailure,
  body: (response: UpgradeResponse) => Operation<Result<T>>,
): Operation<Result<T>> {
  return scoped(function* (): Operation<Result<T>> {
    let response: UpgradeResponse;
    try {
      response = yield* transport(request);
    } catch {
      // A refused connection, a DNS failure and a TLS error are all things this
      // command has an answer for. Letting one raise would end the document
      // before its own table could turn it into a sentence, and the person
      // would read a stack trace instead of what to do next.
      return Err(failure);
    }
    // Teardown is guarded too: an `ensure` handler that raised would propagate
    // out of this scope after the answer was already decided, turning a settled
    // failure into an exception nothing has a message for.
    yield* ensure(() => releaseResponse(response));
    try {
      return yield* body(response);
    } catch {
      // Nothing in the body is supposed to raise — a sink reports failure as a
      // result — but a response object is not this module's, and one that
      // raises while being read must still end in the document's own answer.
      return Err(failure);
    }
  });
}

/** Give a response back, tolerating one whose own release raises. */
function* releaseResponse(response: UpgradeResponse): Operation<void> {
  try {
    yield* response.cancel();
  } catch {
    // Already released, or a response that refuses to be. Either way there is
    // nothing further this command can do about it and nothing to report.
  }
}

/** The reader one response body hands out. */
type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/** Read a response body to its end, refusing the first byte over the bound. */
function* consume(
  response: UpgradeResponse,
  bound: number,
  onChunk: (chunk: Uint8Array) => Operation<Result<void>>,
): Operation<Result<number>> {
  const body = response.body;
  if (body === undefined) {
    return Err(new UpgradeFailure("download-failed", "the response carried no body"));
  }
  const reader = body.getReader();
  yield* ensure(() => cancelReader(reader));

  let total = 0;
  for (;;) {
    const step = yield* readChunk(reader);
    if (!step.ok) {
      return step;
    }
    const chunk = step.value;
    if (chunk === undefined) {
      return Ok(total);
    }
    total += chunk.byteLength;
    if (total > bound) {
      return Err(
        new UpgradeFailure("download-failed", `the download exceeded its ${bound} byte bound`),
      );
    }
    // A sink that cannot take the bytes ends the download the same way a
    // truncated body does — as this function's own result. Raising here would
    // leave the calling phase with an exception instead of a closed failure,
    // and the document would never render its answer for it.
    const stored = yield* onChunk(chunk);
    if (!stored.ok) {
      return stored;
    }
  }
}

/** The next chunk, or `undefined` at the end of a body that completed. */
function* readChunk(reader: BodyReader): Operation<Result<Uint8Array | undefined>> {
  try {
    const step = yield* until(reader.read());
    return Ok(step.done ? undefined : step.value);
  } catch {
    return Err(new UpgradeFailure("download-failed", "the download ended before it completed"));
  }
}

function* cancelReader(reader: BodyReader): Operation<void> {
  try {
    yield* until(reader.cancel());
  } catch {
    // A stream that already ended has nothing left to cancel.
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * One anonymous HTTPS read.
 *
 * `redirect: "manual"` because following one is a decision this command makes
 * against its own allowlist rather than one the platform makes for it. Nothing
 * of the caller's crosses: the two headers are built here, and there is no
 * credential to forward.
 */
function* httpsRead(request: UpgradeRequest): Operation<UpgradeResponse> {
  // Established before the promise starts, which is the whole point: `until()`
  // stops *waiting* for a fetch, and a fetch nobody signalled keeps running
  // after this command has let go of it. The abort is registered before the
  // request so a cancellation anywhere downstream reaches the socket.
  const controller = new AbortController();
  yield* ensure(() => {
    controller.abort();
  });
  const response = yield* until(
    fetch(request.url, {
      redirect: "manual",
      headers: { accept: request.accept, "user-agent": USER_AGENT },
      signal: controller.signal,
    }),
  );
  const body = response.body ?? undefined;
  return {
    status: response.status,
    location: response.headers.get("location") ?? undefined,
    contentLength: readLength(response.headers.get("content-length")),
    body,
    *cancel(): Operation<void> {
      if (body === undefined || body.locked) {
        return;
      }
      try {
        yield* until(body.cancel());
      } catch {
        // The body is already released.
      }
    },
  };
}

function readLength(header: string | null): number | undefined {
  if (header === null || !/^[0-9]+$/.test(header)) {
    return undefined;
  }
  return Number(header);
}

/**
 * Ask the staged candidate what version it is.
 *
 * The candidate is run rather than inspected, because what has to be true is
 * that this file, on this machine, is the `xmd` the release says it is. Its own
 * chatter is not this command's output, and the deadline is cancellation — an
 * expired probe leaves no process behind.
 */
function* runCandidate(path: string, bound: number): Operation<CandidateReport> {
  const boxed = yield* timebox(bound, function* () {
    yield* Stdio.around({
      *stdout() {},
      *stderr() {},
    });
    return yield* exec(path, { arguments: ["--version"] }).join();
  });
  if (boxed.timeout) {
    return { code: -1, stdout: "", timedOut: true };
  }
  // A process that produced no status did not exit zero, and reporting it as
  // zero would let a candidate nobody could observe replace the installation.
  return { code: boxed.value.code ?? -1, stdout: boxed.value.stdout, timedOut: false };
}

/**
 * Where a candidate is staged: a random sibling of the installed binary.
 *
 * Random because it must not exist, and beside the destination because the
 * commit is a same-directory rename.
 */
function defaultStagePath(destination: string): string {
  return join(dirname(destination), `.${basename(destination)}.upgrade-${randomUUID()}`);
}

/** Commit the verified candidate with one same-directory rename. */
function* renameOver(staged: string, destination: string): Operation<void> {
  yield* until(rename(staged, destination));
}
