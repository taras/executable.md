/**
 * One REPL entry's issues: what the entry executing right now may file and read.
 *
 * `provider.ts` beside this answers the same question for files and managed
 * checkouts. This one differs in what it reaches: an issue lives at a service
 * rather than in a checkout, so there is no discovery, no lease and no managed
 * root here at all — just the GitHub adapter this platform can talk to, and the
 * shared durable envelope in `issue/owned.ts` that makes one entry's issue work
 * answerable again after the person walks away from it.
 *
 * Installing it reaches nothing: no configuration, no token, no network, no Git
 * session, no ambient discovery, no checkout lease and no managed root. The
 * adapter reads what this deployment authorized when an invoked request turns
 * out to be its own, so an entry that writes no `<Issue>` obtains no credential,
 * and a passive view — a settled history, a frozen position — initializes
 * nothing.
 */
import { scoped } from "effection";
import type { Operation } from "effection";
import type { ExecutionInstallation, JournalAdmission } from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { issueDeclaration } from "@executablemd/git";
import type { BindOperations } from "@executablemd/git";
import { IssueOperations } from "@executablemd/git/api";
import type {
  IssueOperationsApi,
  IssueReadInvocation,
  IssueUpsertInvocation,
} from "@executablemd/git/api";
import { ISSUE_EFFECT } from "@executablemd/git";
import {
  issueRequestFingerprint,
  parseIssueDetails,
  parseIssueRecord,
  parseIssueRequest,
} from "@executablemd/git";
import type { IssueRequest } from "@executablemd/git";
import {
  liveIssueRead,
  liveIssueUpsert,
  ownedUpsertKey,
  readOwnedIssue,
  upsertOwnedIssue,
} from "@executablemd/git";
import { useDenoGitHubIssues } from "@executablemd/git/deno";
import type { GitHubIssuesOptions } from "@executablemd/git/deno";
import type { Around } from "@effectionx/context-api";

/** Why one entry's retained issue history cannot be continued. */
export type ReplIssueRefusal =
  /** A record of the Issue effect type that this host cannot read. */
  | "malformed-record"
  /** A record whose name is not the name of the request it carries. */
  | "request-fingerprint"
  /** A record naming a history that is not this entry's. */
  | "foreign-owner"
  /** A settled record whose retained value is not the result its operation returns. */
  | "malformed-result";

/**
 * A retained issue history this entry cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past.
 */
export class ReplIssueHistoryError extends StaleInputError {
  override name = "ReplIssueHistoryError";

  readonly reason: ReplIssueRefusal;

  constructor(reason: ReplIssueRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/**
 * The issue capability one REPL entry runs with, as inert code.
 *
 * Called by the CLI for the exact execution and entry it derived the owner
 * from, and called nowhere else. Building it performs nothing: what it carries
 * is a component declaration, a refusal-only admission and an installation that
 * registers middleware.
 */
export function replIssueInstallation(
  owner: string,
  options: GitHubIssuesOptions = {},
): ExecutionInstallation {
  return {
    // The one operation this entry retains. Every other name stays the
    // registered default, so `<Git.Push />` and `<PullRequest>` in an entry
    // whose host recorded only issues reach their own unchanged
    // missing-provider refusals.
    components: [issueDeclaration(replIssuePolicy(owner))],
    admissions: [replIssueAdmission(owner)],
    install: () => useEntryIssueTransport(options),
  };
}

/**
 * The platform's transport, installed without this entry naming its source.
 *
 * Naming it is not building one: the adapter opens a session if and when a
 * request turns out to be its own. Which concrete transport that is, and the
 * credential behind it, stay inside the domain — this entry states only what a
 * caller overrode, and overrides nothing itself.
 */
export function useEntryIssueTransport(options: GitHubIssuesOptions): Operation<void> {
  return useDenoGitHubIssues(options);
}

/**
 * How this entry performs one `<Issue>`, in either of its two forms.
 *
 * The owner is closed over and the site arrives as the argument the authenticated
 * binding hands in, so neither reaches here through a prop, a tracker, a Context,
 * a middleware answer or a registry: a party that could name either could file an
 * issue under somebody else's entry, or read back the result of one.
 *
 * This is a policy rather than `IssueOperations` middleware — which is where the
 * workflow profile installs the same envelope — because an entry's envelope has
 * to enclose the public chain rather than sit beneath it. A handler that answers
 * a read itself is retained as this entry's answer, and a completed replay
 * invokes no handler at all.
 */
export function replIssuePolicy(owner: string): BindOperations<IssueOperationsApi> {
  return (site: string) => ({
    read: (invocation: IssueReadInvocation) =>
      readOwnedIssue({ owner, site, request: invocation }, () =>
        attempted({ read: ([request]) => liveIssueRead(request) }, () =>
          IssueOperations.operations.read(invocation),
        ),
      ),
    upsert: (invocation: IssueUpsertInvocation) => {
      const key = ownedUpsertKey(owner, site, invocation.target);
      return upsertOwnedIssue({ owner, site, request: invocation }, () =>
        attempted({ upsert: ([request]) => liveIssueUpsert(request, key) }, () =>
          IssueOperations.operations.upsert(invocation),
        ),
      );
    },
  });
}

/**
 * One live attempt: the public `IssueOperations` chain, over a transport-facing
 * default of this attempt's own.
 *
 * Scoped, so the default is gone before the envelope publishes anything, and
 * installed at `min`, so every public handler a document or a plugin composed
 * still wraps the dispatch. The default closes over this attempt's key, so two
 * concurrent `<Issue>` elements each dispatch through their own and neither can
 * present the other's.
 */
function attempted(
  transport: Partial<Around<IssueOperationsApi>>,
  ask: () => Operation<unknown>,
): Operation<unknown> {
  return scoped(function* (): Operation<unknown> {
    yield* IssueOperations.around(transport, { at: "min" });
    return yield* ask();
  });
}

/**
 * What this entry requires of the issue records its history holds.
 *
 * Three questions, and only three. **Integrity**: every settled Issue record
 * parses, is named by the request it carries, and holds a value that is the
 * result its own operation returns. **Ownership**: every one of them names this
 * entry's owner. **Nothing else**: no service is reached, no issue is read and
 * no result is handed out — replaying a completed operation is the durable
 * engine's own positional matching, and this runs before any of it.
 *
 * Ownership is asked here because an owner is what the durable name and the
 * idempotency key are derived from. A record naming another entry's owner would
 * replay under a key this entry never presented, so a history carrying one is
 * refused rather than continued — and borrowing it is exactly what is not
 * allowed, however the record came to be in this segment.
 */
export function replIssueAdmission(owner: string): JournalAdmission {
  return function* (retained: readonly DurableEvent[]): Operation<void> {
    for (const event of retained) {
      if (event.type !== "yield" || event.description.type !== ISSUE_EFFECT) {
        continue;
      }
      if (event.result.status !== "ok") {
        // A failed Issue effect retains no result of its own: its outcome is
        // the durable operation's failed result, and there is nothing in it to
        // hold to a request.
        continue;
      }
      const request = parseIssueRequest(event.description["request"]);
      if (request === undefined) {
        throw refusal(
          "malformed-record",
          "an issue record in this entry's history is not one this host can read, so what it " +
            "says about work already done is unknown.",
        );
      }
      if (request.identity.runId !== owner) {
        throw refusal(
          "foreign-owner",
          "an issue record in this entry's history was written under another owner, so the " +
            "work it describes was not done by this entry and its key is not one this entry " +
            "can present again.",
        );
      }
      if (event.description.name !== (yield* issueRequestFingerprint(request))) {
        throw refusal(
          "request-fingerprint",
          "a retained issue record is journaled under a name that is not the name its own " +
            "request produces, so the record and the operation it claims to be do not match.",
        );
      }
      if (!settles(request, event.result.value)) {
        throw refusal(
          "malformed-result",
          "a retained issue record holds a value that is not the result its own operation " +
            "answers with, so what it says was filed or read is unknown.",
        );
      }
    }
  };
}

/** Whether this retained value is the result this request's operation returns. */
function settles(request: IssueRequest, value: unknown): boolean {
  return request.operation === "read"
    ? parseIssueDetails(value) !== undefined
    : parseIssueRecord(value) !== undefined;
}

function refusal(reason: ReplIssueRefusal, sentence: string): ReplIssueHistoryError {
  return new ReplIssueHistoryError(reason, sentence);
}
