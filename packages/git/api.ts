/**
 * @module
 *
 * Every contextual Api this package owns, and the contract each is written in.
 *
 * A contextual Api is a seam: a consumer reaches one to *call* an operation,
 * and replaces one — `Git.around({…}, { at: "min" })` — to *answer* it. Both
 * sides need the same value, so both sides need one place to import it from.
 * Mixed in among records, errors, parsers and component definitions on the
 * package root, that value was indistinguishable from data, and which names
 * were replaceable seams was something a reader had to already know.
 *
 * So this is the consumer route, and the only one. Eight Apis live here with
 * their named interfaces, the identity each was minted under, the base refusal
 * each falls back to when nobody answered, the direct operations and accessors
 * consumers actually call, and every type those interfaces are spelled in. A
 * name here is something you can implement.
 *
 * Each name says what its operations do. `Repository` selects a checkout,
 * `Git` performs the four authored durable transitions behind `<Git.*>`, and
 * `GitQuery` asks read-only questions of the checkout the contextual working
 * directory is in. The last two are never the same seam: replacing `GitQuery`
 * answers questions and moves no branch.
 *
 * ```ts
 * import { GitQuery, Repository } from "@executablemd/git/api";
 *
 * // Call one.
 * const ambient = yield* Repository.operations.ambient();
 *
 * // Or answer it. Providers install at `min` so a nested replacement wins
 * // rather than being shadowed by an outer handler.
 * yield* GitQuery.around({ *resolve(revision) { … } }, { at: "min" });
 * ```
 *
 * The types travel with the Apis because an interface you cannot spell is one
 * you cannot implement. They stay exported from the package root as well: a
 * record that appears in an Api signature is still an ordinary record when a
 * consumer only wants to read one, and that is an additive re-export rather
 * than a second home.
 *
 * What is *not* here: the Plugin value and its profile predicate, the
 * component registrations and definitions, the workflow installation, the
 * durable effect identifiers, the error classes and the record parsers. Those
 * describe what was said, not who answers. The runtime providers that
 * implement these seams are not here either — they live behind
 * `@executablemd/git/deno`, because which host can answer is a different
 * question from what the question is.
 */

// The read-only Git questions, and the four operations pre-bound for callers
// who want the operation rather than the seam.
export {
  gitObjectFormat,
  GitQuery,
  gitRoot,
  readGitObject,
  resolveGitRevision,
} from "./src/git.ts";
export type { GitObjectFormat, GitQueryApi } from "./src/git.ts";

// Repository selection: what a `<Repository>` or `<Worktree>` selects, and the
// credential-free selection it hands back.
export { Repository } from "./src/composition/api.ts";
export type { RepositoryApi, RepositoryRequest, WorktreeRequest } from "./src/composition/api.ts";
export type { RepositorySelection } from "./src/composition/selection.ts";

// Which repository is lexically in scope, and the accessor that reads it.
export { currentRepository, RepositoryContext } from "./src/composition/context.ts";
export type { RepositoryContextApi } from "./src/composition/context.ts";

// The authored local Git transitions — switch, add, commit, push — with the
// places they are invoked at and the results they record.
export { Git } from "./src/composition/git-api.ts";
export type {
  GitAddInvocation,
  GitApi,
  GitCommitInvocation,
  GitInvocationPlace,
  GitPushInvocation,
  GitSwitchInvocation,
} from "./src/composition/git-api.ts";
export type {
  GitAddResult,
  GitCommitMessageSource,
  GitCommitResult,
  GitSwitchResult,
} from "./src/composition/git-records.ts";
export type { GitPushOutcome } from "./src/composition/git-push-records.ts";

// Pull requests, with the identity the Api was minted under and the refusal a
// request nobody answered reaches.
export {
  NoPullRequestProvider,
  PULL_REQUEST_API,
  PullRequestAPI,
} from "./src/composition/pull-request-api.ts";
export type {
  PullRequestApi,
  PullRequestInput,
  PullRequestOperation,
  PullRequestReadOptions,
  PullRequestUpsertOptions,
} from "./src/composition/pull-request-api.ts";
export type {
  PullRequestReadKind,
  PullRequestReadResult,
} from "./src/composition/pull-request-read-records.ts";
export type { PullRequestResult } from "./src/composition/pull-request-records.ts";

// Issues, on the same terms: middleware matches its own targets, and a request
// everyone delegated reaches `NoIssueProvider` unchanged.
export { ISSUE_API, IssueApi, NoIssueProvider } from "./src/issue/api.ts";
export type {
  IssueDetails,
  IssueInput,
  IssueOperation,
  IssueReadOptions,
  IssueReference,
  IssueUpsertOptions,
} from "./src/issue/api.ts";

// The nearest lexical `<IssueTracker>`, the accessor that reads it, and the
// tracker value itself.
export {
  currentIssueTracker,
  ISSUE_TRACKER_CONTEXT,
  IssueTrackerContext,
} from "./src/issue/context.ts";
export type { IssueTrackerContextApi } from "./src/issue/context.ts";
export type { IssueTracker } from "./src/issue/tracker.ts";

// The Git host the pull-request and issue providers reconcile through, with
// the durable reconciliation a provider takes part in.
export { GIT_HOST_API, GitHost } from "./src/git-host/api.ts";
export type {
  GitHostApi,
  GitHostCall,
  GitHostPhase,
  GitHostPhaseDetails,
  GitHostProvider,
  GitHostRoutingRequest,
} from "./src/git-host/api.ts";
export { reconcileGitHostEffect, withGitHostProvider } from "./src/git-host/effect.ts";
export type {
  CompleteGitHostEffectRequest,
  GitHostCompletion,
  GitHostObservation,
} from "./src/git-host/records.ts";
