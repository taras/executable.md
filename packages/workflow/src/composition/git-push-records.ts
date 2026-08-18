/**
 * What one `<Git.Push>` asks for, and what its reconciliation retains.
 *
 * A Push publishes one commit to one branch on the Repository's canonical
 * origin. The remote owns that branch, so the effect is reconciled through the
 * shared Git-host state machine rather than committed with a Workspace
 * transaction — and what travels through that boundary is JSON a provider in
 * another package receives and a journal in this one keeps. None of it is this
 * module's word by the time it is read back, so every value is parsed exactly.
 *
 * ## The Repository travels filtered
 *
 * The whole retained `RepositoryRecord` is what the provider authenticates a
 * live invocation against, and it carries `checkoutPath` — a place inside the
 * run's own Workspace. A Git host has no business holding one, and the journal
 * has no reason to repeat it under a second name, so the identity that reaches
 * durable JSON is the record without it. Omitting it weakens nothing: the live
 * check still compares the complete record member for member, and the six
 * members that remain already discriminate every Repository this run can hold.
 *
 * ## The source commit is not part of the natural key
 *
 * The external resource a Push acts on is the Repository's origin branch, and
 * that resource is named by the Repository, the remote and the destination ref.
 * A changed source commit is a different *request* — the durable fingerprint
 * covers the complete request, so it diverges rather than consuming the
 * retained result — but it is not a different resource, and putting it in the
 * natural key would say a branch moved to another commit is somewhere else.
 */

import type { Json } from "@executablemd/durable-streams";
import type { GitHostDecision, GitHostReconciliationRecord } from "../git-host/records.ts";
import { members, optionalText, text } from "./parse.ts";
import { parseObjectFormat, type GitObjectFormat, type RepositoryRecord } from "./records.ts";

/** The Git-host effect kind one branch publication is reconciled under. */
export const GIT_PUSH = "git-push";

/** The one remote a Push publishes to. There is no prop that changes it. */
export const PUSH_REMOTE = "origin";

/** The full destination ref a branch of this name is published to. */
export function destinationRefFor(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The refspec one push hands Git: an exact commit, and an exact destination. */
export function refspecFor(sourceCommit: string, destinationRef: string): string {
  return `${sourceCommit}:${destinationRef}`;
}

/**
 * The Repository identity durable Push JSON carries.
 *
 * The retained creation record without its Workspace checkout path.
 */
export interface GitPushRepositoryIdentity {
  readonly name: string;
  readonly locatorFingerprint: string;
  readonly requestedBase: string | null;
  readonly creationCommit: string;
  readonly primaryBranch: string;
  readonly objectFormat: GitObjectFormat;
}

/** What a `<Git.Push>` invocation asks the provider to do. */
export interface GitPushRequest {
  /** The whole Repository record the component observed, to be compared. */
  readonly repository: RepositoryRecord;
  /** The logical working directory the component observed. */
  readonly workingDirectory: string;
}

/** The filtered inputs one Push reconciliation acts on. */
export interface GitPushInputs {
  readonly repository: GitPushRepositoryIdentity;
  readonly remote: string;
  readonly branch: string;
  readonly destinationRef: string;
  readonly sourceCommit: string;
}

/** What the provider looks a Push up by: the branch on the remote, and nothing else. */
export interface GitPushNaturalKey {
  readonly repository: GitPushRepositoryIdentity;
  readonly remote: string;
  readonly destinationRef: string;
}

/** What the destination ref held before this attempt, as far as it was proven. */
export interface GitPushPreState {
  /** The commit the destination named, or `null` when it was proven absent. */
  readonly remoteCommit: string | null;
}

/** What the destination ref holds now. */
export interface GitPushObservations {
  readonly remoteCommit: string;
}

/** What a reconciled Push retains. */
export interface GitPushResult {
  readonly repository: GitPushRepositoryIdentity;
  readonly remote: string;
  readonly branch: string;
  readonly destinationRef: string;
  readonly refspec: string;
  readonly sourceCommit: string;
  readonly observedRemoteCommit: string;
}

/** One reconciled Push: what the shared engine decided, and what it retains. */
export interface GitPushOutcome {
  readonly decision: GitHostDecision;
  readonly result: GitPushResult;
}

const IDENTITY_MEMBERS = [
  "name",
  "locatorFingerprint",
  "requestedBase",
  "creationCommit",
  "primaryBranch",
  "objectFormat",
] as const;

const INPUT_MEMBERS = ["repository", "remote", "branch", "destinationRef", "sourceCommit"] as const;

const NATURAL_KEY_MEMBERS = ["repository", "remote", "destinationRef"] as const;

const PRE_STATE_MEMBERS = ["remoteCommit"] as const;

const OBSERVATION_MEMBERS = ["remoteCommit"] as const;

const RESULT_MEMBERS = [
  "repository",
  "remote",
  "branch",
  "destinationRef",
  "refspec",
  "sourceCommit",
  "observedRemoteCommit",
] as const;

/**
 * An object id in the algorithm this repository names its objects with.
 *
 * Width and case both. A value that is merely a non-empty string is not an
 * object id, and reading one as an id is how a retained result that names
 * nothing passes for one that names a commit.
 */
export function gitObjectId(value: unknown, format: GitObjectFormat): string | undefined {
  const candidate = text(value);
  const width = format === "sha1" ? 40 : 64;
  return candidate !== undefined && new RegExp(`^[0-9a-f]{${width}}$`).test(candidate)
    ? candidate
    : undefined;
}

/** The retained record, filtered to what durable Push JSON may carry. */
export function filteredRepositoryIdentity(record: RepositoryRecord): GitPushRepositoryIdentity {
  return Object.freeze({
    name: record.name,
    locatorFingerprint: record.locatorFingerprint,
    requestedBase: record.requestedBase,
    creationCommit: record.creationCommit,
    primaryBranch: record.primaryBranch,
    objectFormat: record.objectFormat,
  });
}

export function gitPushRepositoryIdentityJson(identity: GitPushRepositoryIdentity): Json {
  return {
    name: identity.name,
    locatorFingerprint: identity.locatorFingerprint,
    requestedBase: identity.requestedBase,
    creationCommit: identity.creationCommit,
    primaryBranch: identity.primaryBranch,
    objectFormat: identity.objectFormat,
  };
}

export function gitPushInputsJson(inputs: GitPushInputs): Json {
  return {
    repository: gitPushRepositoryIdentityJson(inputs.repository),
    remote: inputs.remote,
    branch: inputs.branch,
    destinationRef: inputs.destinationRef,
    sourceCommit: inputs.sourceCommit,
  };
}

export function gitPushNaturalKeyJson(key: GitPushNaturalKey): Json {
  return {
    repository: gitPushRepositoryIdentityJson(key.repository),
    remote: key.remote,
    destinationRef: key.destinationRef,
  };
}

export function gitPushPreStateJson(preState: GitPushPreState): Json {
  return { remoteCommit: preState.remoteCommit };
}

export function gitPushObservationsJson(observations: GitPushObservations): Json {
  return { remoteCommit: observations.remoteCommit };
}

export function gitPushResultJson(result: GitPushResult): Json {
  return {
    repository: gitPushRepositoryIdentityJson(result.repository),
    remote: result.remote,
    branch: result.branch,
    destinationRef: result.destinationRef,
    refspec: result.refspec,
    sourceCommit: result.sourceCommit,
    observedRemoteCommit: result.observedRemoteCommit,
  };
}

/** The filtered Repository identity this value describes, or `undefined`. */
export function parseGitPushRepositoryIdentity(
  value: unknown,
): GitPushRepositoryIdentity | undefined {
  const record = members(value, IDENTITY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const name = text(record.name);
  const locatorFingerprint = text(record.locatorFingerprint);
  const requestedBase = optionalText(record.requestedBase);
  const creationCommit = text(record.creationCommit);
  const primaryBranch = text(record.primaryBranch);
  const objectFormat = parseObjectFormat(record.objectFormat);
  if (
    name === undefined ||
    locatorFingerprint === undefined ||
    !/^[0-9a-f]{64}$/.test(locatorFingerprint) ||
    requestedBase === undefined ||
    creationCommit === undefined ||
    primaryBranch === undefined ||
    objectFormat === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    name,
    locatorFingerprint,
    requestedBase,
    creationCommit,
    primaryBranch,
    objectFormat,
  });
}

/** Whether two filtered identities name the same Repository. */
export function sameRepositoryIdentity(
  left: GitPushRepositoryIdentity,
  right: GitPushRepositoryIdentity,
): boolean {
  return IDENTITY_MEMBERS.every((member) => left[member] === right[member]);
}

/**
 * What a Push result is read back for.
 *
 * The branch and the commit this exact invocation admitted, plus the identity
 * it admitted them against. A result is read for one request, so a parser that
 * could be called without one would be checking a value against itself.
 */
export interface GitPushExpectation {
  readonly repository: GitPushRepositoryIdentity;
  readonly branch: string;
  readonly destinationRef: string;
  readonly sourceCommit: string;
}

/** The expectation these admitted inputs describe. */
export function pushExpectation(inputs: GitPushInputs): GitPushExpectation {
  return Object.freeze({
    repository: inputs.repository,
    branch: inputs.branch,
    destinationRef: inputs.destinationRef,
    sourceCommit: inputs.sourceCommit,
  });
}

/** The Push inputs this value describes, or `undefined` when it describes none. */
export function parseGitPushInputs(value: unknown): GitPushInputs | undefined {
  const record = members(value, INPUT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const remote = text(record.remote);
  const branch = text(record.branch);
  const destinationRef = text(record.destinationRef);
  if (repository === undefined || remote === undefined || branch === undefined) {
    return undefined;
  }
  const sourceCommit = gitObjectId(record.sourceCommit, repository.objectFormat);
  if (
    sourceCommit === undefined ||
    remote !== PUSH_REMOTE ||
    destinationRef !== destinationRefFor(branch)
  ) {
    return undefined;
  }
  return Object.freeze({ repository, remote, branch, destinationRef, sourceCommit });
}

/** The Push natural key this value describes, or `undefined`. */
export function parseGitPushNaturalKey(value: unknown): GitPushNaturalKey | undefined {
  const record = members(value, NATURAL_KEY_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const remote = text(record.remote);
  const destinationRef = text(record.destinationRef);
  if (
    repository === undefined ||
    remote !== PUSH_REMOTE ||
    destinationRef === undefined ||
    !destinationRef.startsWith("refs/heads/")
  ) {
    return undefined;
  }
  return Object.freeze({ repository, remote, destinationRef });
}

/** The pre-state this value describes, or `undefined` when it describes none. */
export function parseGitPushPreState(
  value: unknown,
  format: GitObjectFormat,
): GitPushPreState | undefined {
  const record = members(value, PRE_STATE_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  if (record.remoteCommit === null) {
    return Object.freeze({ remoteCommit: null });
  }
  const remoteCommit = gitObjectId(record.remoteCommit, format);
  return remoteCommit === undefined ? undefined : Object.freeze({ remoteCommit });
}

/** The observations this value describes, or `undefined`. */
export function parseGitPushObservations(
  value: unknown,
  format: GitObjectFormat,
): GitPushObservations | undefined {
  const record = members(value, OBSERVATION_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const remoteCommit = gitObjectId(record.remoteCommit, format);
  return remoteCommit === undefined ? undefined : Object.freeze({ remoteCommit });
}

/**
 * The Push result this value describes for this request, or `undefined`.
 *
 * Exact about membership and closed about meaning. Beyond the shape it refuses
 * a result naming another Repository, another remote, another branch, a
 * destination that is not that branch's ref, a refspec that is not this exact
 * commit published to that destination, and an observed commit that is not the
 * one this attempt asked the remote to hold. A Push that succeeded left the
 * destination naming its source, so a retained result saying anything else
 * describes an outcome this operation does not produce.
 */
export function parseGitPushResult(
  value: unknown,
  expected: GitPushExpectation,
): GitPushResult | undefined {
  const record = members(value, RESULT_MEMBERS);
  if (record === undefined) {
    return undefined;
  }
  const format = expected.repository.objectFormat;
  const repository = parseGitPushRepositoryIdentity(record.repository);
  const remote = text(record.remote);
  const branch = text(record.branch);
  const destinationRef = text(record.destinationRef);
  const refspec = text(record.refspec);
  const sourceCommit = gitObjectId(record.sourceCommit, format);
  const observedRemoteCommit = gitObjectId(record.observedRemoteCommit, format);
  if (
    repository === undefined ||
    remote === undefined ||
    branch === undefined ||
    destinationRef === undefined ||
    refspec === undefined ||
    sourceCommit === undefined ||
    observedRemoteCommit === undefined
  ) {
    return undefined;
  }

  if (
    !sameRepositoryIdentity(repository, expected.repository) ||
    remote !== PUSH_REMOTE ||
    branch !== expected.branch ||
    destinationRef !== expected.destinationRef ||
    destinationRef !== destinationRefFor(branch) ||
    sourceCommit !== expected.sourceCommit ||
    refspec !== refspecFor(sourceCommit, destinationRef) ||
    observedRemoteCommit !== sourceCommit
  ) {
    return undefined;
  }

  return Object.freeze({
    repository,
    remote,
    branch,
    destinationRef,
    refspec,
    sourceCommit,
    observedRemoteCommit,
  });
}

/**
 * The Push this reconciliation record describes, or `undefined`.
 *
 * The shared engine has already held the record's request to the request being
 * made and parsed the record's own shape. What is decided here is everything
 * effect-specific: that each of the three JSON members is a Push shape, that
 * the two readings agree, and that the decision is one the pre-state supports.
 *
 * The decision and the pre-state are one fact. `performed` means this run found
 * the destination absent and published to it; `adopted` means the destination
 * already named this exact commit. A record pairing either word with the other
 * word's pre-state describes a reconciliation the state machine cannot reach.
 */
export function parseGitPushRecord(
  record: GitHostReconciliationRecord,
  expected: GitPushExpectation,
): GitPushOutcome | undefined {
  const format = expected.repository.objectFormat;
  const preState = parseGitPushPreState(record.preState, format);
  const observations = parseGitPushObservations(record.observations, format);
  const result = parseGitPushResult(record.result, expected);
  if (preState === undefined || observations === undefined || result === undefined) {
    return undefined;
  }
  if (observations.remoteCommit !== result.observedRemoteCommit) {
    return undefined;
  }
  const supported =
    record.decision === "performed"
      ? preState.remoteCommit === null
      : preState.remoteCommit === result.sourceCommit;
  return supported ? Object.freeze({ decision: record.decision, result }) : undefined;
}
