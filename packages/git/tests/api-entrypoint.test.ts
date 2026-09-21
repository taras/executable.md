/**
 * `@executablemd/git/api` is the one route to Git's contextual seams, on every
 * runtime that can run a document.
 *
 * An Api is a seam: a consumer reaches one to call an operation and replaces
 * one to answer it. Which means the value has to arrive — through the package
 * export map, under the bare specifier a consumer writes — and it has to
 * arrive from exactly one place. A seam reachable two ways is two contracts,
 * and the second one is whichever the author happened to import.
 *
 * Portable on purpose. The Deno-only companion in `public-entrypoint.test.ts`
 * reads `@executablemd/git/deno`, which reaches Workflow's storage adapter and
 * so `node:sqlite`; nothing here does, so all three runtimes can ask the
 * question that matters — does the export map admit this subpath — and answer
 * it the way their own resolver would. A subpath missing from `deno.json`
 * fails under Deno, one missing from `package.json` fails under Node and Bun,
 * and only running all three tells those apart.
 *
 * Read through `Reflect.get` rather than a cast: what a module exported is
 * whatever it exported, and the members below are proven present rather than
 * claimed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { until } from "effection";
import type { Operation } from "effection";

// The complete contract, type-imported. This is not decoration: a type that
// stopped being published fails the typecheck of this file, which is the only
// way an interface — having no runtime presence — can be held to the export
// map at all.
import type {
  CompleteGitHostEffectRequest,
  GitAddInvocation,
  GitAddResult,
  GitApi,
  GitCommitInvocation,
  GitCommitMessageSource,
  GitCommitResult,
  GitCompositionApi,
  GitHostApi,
  GitHostCall,
  GitHostCompletion,
  GitHostObservation,
  GitHostPhase,
  GitHostPhaseDetails,
  GitHostProvider,
  GitHostRoutingRequest,
  GitInvocationPlace,
  GitObjectFormat,
  GitPushInvocation,
  GitPushOutcome,
  GitSwitchInvocation,
  GitSwitchResult,
  IssueDetails,
  IssueInput,
  IssueOperation,
  IssueReadOptions,
  IssueReference,
  IssueTracker,
  IssueTrackerContextApi,
  IssueUpsertOptions,
  PullRequestApi,
  PullRequestInput,
  PullRequestOperation,
  PullRequestReadKind,
  PullRequestReadOptions,
  PullRequestReadResult,
  PullRequestResult,
  PullRequestUpsertOptions,
  RepositoryCompositionApi,
  RepositoryContextApi,
  RepositoryRequest,
  RepositorySelection,
  WorktreeRequest,
} from "@executablemd/git/api";

/**
 * The eight contextual Apis, by the name a consumer imports.
 *
 * Eight rather than "some": each is a separate seam with its own provider
 * story, and an Api that silently stopped being published is a consumer that
 * can no longer answer it.
 */
const CONTEXTUAL_APIS: readonly string[] = [
  "Git",
  "GitComposition",
  "GitHost",
  "IssueApi",
  "IssueTrackerContext",
  "PullRequestAPI",
  "RepositoryComposition",
  "RepositoryContext",
];

/**
 * What travels with them: the identity each Api was minted under, the refusal
 * a request nobody answered reaches, and the operations and accessors a
 * consumer calls directly.
 */
const COMPANIONS: readonly string[] = [
  "GIT_HOST_API",
  "ISSUE_API",
  "ISSUE_TRACKER_CONTEXT",
  "NoIssueProvider",
  "NoPullRequestProvider",
  "PULL_REQUEST_API",
  "currentIssueTracker",
  "currentRepository",
  "gitObjectFormat",
  "readGitObject",
  "reconcileGitHostEffect",
  "repositoryRoot",
  "revParse",
  "withGitHostProvider",
];

/**
 * Whether a published value is a contextual Api.
 *
 * A `createApi()` value carries `around` — how a provider replaces it — and
 * `operations` — how a caller reaches it. Recognized by that shape rather than
 * by a list of names, because a list only contains the seams somebody
 * remembered, and the point of the exclusivity check below is to catch the one
 * nobody did.
 */
function isApi(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const around: unknown = Reflect.get(value, "around");
  const operations: unknown = Reflect.get(value, "operations");
  return typeof around === "function" && typeof operations === "object" && operations !== null;
}

/** The names a module published, through the export map, under its bare specifier. */
function* published(specifier: string): Operation<string[]> {
  const namespace: unknown = yield* until(import(specifier));
  if (typeof namespace !== "object" || namespace === null) {
    return [];
  }
  return Object.keys(namespace);
}

/** Every published name that is a contextual Api, sorted. */
function* seams(specifier: string): Operation<string[]> {
  const namespace: unknown = yield* until(import(specifier));
  if (typeof namespace !== "object" || namespace === null) {
    return [];
  }
  return Object.keys(namespace)
    .filter((name) => isApi(Reflect.get(namespace, name)))
    .sort();
}

describe("the @executablemd/git/api entrypoint", () => {
  it("resolves through the package export map", function* () {
    // The positive control for everything below: an import that failed, or a
    // namespace with nothing in it, would satisfy every membership check by
    // having no names to contradict them.
    const names = yield* published("@executablemd/git/api");
    expect(names.length > 0).toBe(true);
  });

  it("publishes all eight contextual Apis", function* () {
    const names = yield* published("@executablemd/git/api");
    expect(CONTEXTUAL_APIS.filter((name) => !names.includes(name))).toEqual([]);
    // And each is genuinely a seam rather than a same-named value: a plain
    // record exported under `Git` would satisfy the membership above.
    const recognized = yield* seams("@executablemd/git/api");
    expect(CONTEXTUAL_APIS.filter((name) => !recognized.includes(name))).toEqual([]);
  });

  it("publishes the identities, refusals and operations that travel with them", function* () {
    const names = yield* published("@executablemd/git/api");
    expect(COMPANIONS.filter((name) => !names.includes(name))).toEqual([]);
  });

  /**
   * The exclusivity half: one route, not a preferred one.
   *
   * `@executablemd/git` publishes the Plugin, the records, the parsers and the
   * errors — plenty of names — so this is not asserting that the root is
   * empty. It is asserting that nothing there is a seam.
   */
  it("is the only entrypoint publishing a contextual Api", function* () {
    // The detector has to be working, or the absence below proves nothing.
    const recognized = yield* seams("@executablemd/git/api");
    expect(recognized.length).toBe(CONTEXTUAL_APIS.length);

    const rootNames = yield* published("@executablemd/git");
    expect(rootNames.length > 0).toBe(true);
    const leaked = yield* seams("@executablemd/git");
    expect(`root: ${leaked.join(",")}`).toBe("root: ");
  });

  /**
   * The type contract, held to the export map.
   *
   * A type has no runtime presence, so the type-import above is what pins it —
   * this case exists to give those imports a use, so that a removed type is a
   * typecheck failure rather than an unused import somebody deletes.
   */
  it("publishes the complete type contract", function* () {
    const format: GitObjectFormat = "sha1";
    const phase: GitHostPhase = "observe";
    const operation: IssueOperation = "read";
    const pullRequest: PullRequestOperation = "read";
    const readKind: PullRequestReadKind = "reviews";

    expect(`${format} ${phase} ${operation} ${pullRequest} ${readKind}`).toBe(
      "sha1 observe read read reviews",
    );

    // The interfaces and records, named in positions that require them to
    // exist. `undefined` is a legal value for each binding, so nothing here
    // constructs a shape this file would have to keep in step with.
    const contract: {
      git?: GitApi;
      repository?: RepositoryCompositionApi;
      repositoryContext?: RepositoryContextApi;
      composition?: GitCompositionApi;
      pull?: PullRequestApi;
      tracker?: IssueTrackerContextApi;
      host?: GitHostApi;
      request?: RepositoryRequest;
      worktree?: WorktreeRequest;
      selection?: RepositorySelection;
      place?: GitInvocationPlace;
      switchInvocation?: GitSwitchInvocation;
      addInvocation?: GitAddInvocation;
      commitInvocation?: GitCommitInvocation;
      pushInvocation?: GitPushInvocation;
      switchResult?: GitSwitchResult;
      addResult?: GitAddResult;
      commitResult?: GitCommitResult;
      messageSource?: GitCommitMessageSource;
      pushOutcome?: GitPushOutcome;
      pullInput?: PullRequestInput;
      pullRead?: PullRequestReadOptions;
      pullUpsert?: PullRequestUpsertOptions;
      pullReadResult?: PullRequestReadResult;
      pullResult?: PullRequestResult;
      issueInput?: IssueInput;
      issueUpsert?: IssueUpsertOptions;
      issueReference?: IssueReference;
      issueDetails?: IssueDetails;
      issueRead?: IssueReadOptions;
      issueTracker?: IssueTracker;
      routing?: GitHostRoutingRequest;
      details?: GitHostPhaseDetails;
      call?: GitHostCall;
      provider?: GitHostProvider;
      complete?: CompleteGitHostEffectRequest;
      observation?: GitHostObservation;
      completion?: GitHostCompletion;
    } = {};

    expect(Object.keys(contract)).toEqual([]);
  });
});
