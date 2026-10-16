/**
 * One REPL entry's issues: what the entry executing right now may file and read.
 *
 * `provider.ts` beside this answers the same question for files and managed
 * checkouts. This one is smaller and differs in what it reaches: an issue lives
 * at a service rather than in a checkout, so there is no discovery, no lease and
 * no managed root here at all — just the GitHub adapter this platform can talk
 * to, and the durable envelope that makes one entry's issue work answerable
 * again after the person walks away from it.
 *
 * ## What the entry owns, and what it cannot be told
 *
 * An entry's issue work is retained under an owner the CLI derives from the
 * execution and the entry key, and each invocation inside it is named by the
 * identity canonical core minted where it selected this exact implementation.
 * The factory closes over the owner and core delivers the identity
 * authenticator, so neither
 * arrives through a prop, a tracker, a Context, a middleware answer or a
 * registry: a party that could name either could file an issue under somebody
 * else's entry, or read back the result of one.
 *
 * ## One envelope, with live composition inside it
 *
 * The trusted body owns the one durable boundary. Inside a live attempt it
 * composes `IssueOperations` — so a document's own middleware still answers,
 * transforms, refuses and delegates exactly as it does anywhere else — over a
 * transport-facing default of its own that reaches `IssueApi` and adds no
 * second envelope. A completed replay invokes none of that: no middleware, no
 * transport, no configuration and no credential.
 *
 * The fallback is installed in a scope of the attempt's own and closes over that
 * attempt's idempotency key, so two concurrent `<Issue>` elements each dispatch
 * through their own and neither can present the other's key. Its lifetime ends
 * when the attempt's live operation returns, which is before the envelope
 * publishes anything.
 *
 * ## Installing it reaches nothing
 *
 * No configuration, no token, no network, no Git session, no ambient discovery,
 * no checkout lease and no managed root. The adapter reads what this deployment
 * authorized when an invoked request turns out to be its own, so an entry that
 * writes no `<Issue>` reads neither variable and obtains no credential, and a
 * passive view — a settled history, a frozen position — initializes nothing.
 */

import { scoped } from "effection";
import type { Operation } from "effection";
import { documented, formDispatcher } from "@executablemd/core";
import type { ComponentInvocation, FunctionComponent } from "@executablemd/core";
import type {
  ExecutionInstallation,
  IdentityClaimant,
  IdentityComponent,
  JournalAdmission,
} from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { COMPOSITION_ORIGIN } from "../../composition/definitions.ts";
import {
  documentation as issueDocumentation,
  issueMode,
  issueReadBinding,
  issueReadRequest,
  issueUpsertRequest,
  props as issueProps,
  returns as issueReturns,
} from "../../composition/components/Issue.ts";
import { IssueApi } from "../../issue/api.ts";
import type { IssueDetails, IssueReference } from "../../issue/api.ts";
import { IssueOperations } from "../../issue/operations.ts";
import type {
  IssueOperationsApi,
  IssueReadInvocation,
  IssueUpsertInvocation,
} from "../../issue/operations.ts";
import { IssueProtocolError } from "../../issue/errors.ts";
import { ISSUE_EFFECT } from "../../issue/effect-type.ts";
import {
  issueIdempotencyKey,
  issueRequestFingerprint,
  parseIssueDetails,
  parseIssueRecord,
  parseIssueRequest,
} from "../../issue/records.ts";
import type { IssueRequest } from "../../issue/records.ts";
import { readOwnedIssue, upsertOwnedIssue } from "../../issue/owned.ts";
import { useGitHubIssues } from "../issue/github.ts";
import type { GitHubIssuesOptions } from "../issue/github.ts";
import { denoGitHubSource } from "../composition/github-host.ts";
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
    components: [ownedIssueComponent(owner)],
    admissions: [ownedIssueAdmission(owner)],
    *install(): Operation<void> {
      // The platform's transport, handed to an adapter that knows the protocol
      // and not the platform. Naming it here is not building one: it is a
      // factory the adapter calls if and when a request turns out to be its own.
      yield* useGitHubIssues({ host: denoGitHubSource, ...options });
    },
  };
}

/**
 * The entry's own `Issue`, declared as an ordinary shadowable component.
 *
 * It shadows the inherited bundled default for this execution's scope without
 * registering two defaults in one scope and without touching that inherited
 * registration, so a repository-local `<Issue>` keeps its ordinary precedence
 * over both. The name is neither reserved nor protected: what a replacement
 * does not get is an identity authenticator, so it names no durable work of
 * this entry's.
 *
 * Inspection describes one `Issue` — the same origin, props, return contract
 * and prose the bundled registration carries — because it is the same component
 * with the entry's identity behind it.
 */
function ownedIssueComponent(owner: string): IdentityComponent {
  return {
    name: "Issue",
    origin: COMPOSITION_ORIGIN,
    props: issueProps,
    returns: issueReturns,
    forms: ["self-closing", "paired"],
    ...documented(issueDocumentation),
    factory: (claim: IdentityClaimant) =>
      // Canonical form dispatch, so which of the two external effects this
      // element asks for is settled by the scan before the body runs. A
      // contextual `hasContent()` answer cannot select it: the chain that
      // answers one is composed by whoever installed a handler, and an
      // irreversible effect is not something a handler may choose.
      formDispatcher({
        forms: "both",
        "self-closing": readingBody(owner, claim),
        paired: upsertingBody(owner, claim),
      }),
  };
}

function readingBody(owner: string, claim: IdentityClaimant): FunctionComponent {
  return function* Issue(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
    // The same input checks the ordinary component makes, for the form that was
    // dispatched here. Which of the two this is was decided by the engine, so
    // the answer is not read back: what is wanted from this call is its
    // refusals, which are the component's settled sentences.
    issueMode(props, false);
    const site = yield* claim(invocation);
    const request = issueReadRequest(props);
    const details = yield* readOwnedIssue({ owner, site, request }, liveRead(request));
    return issueReadBinding(details);
  };
}

function upsertingBody(owner: string, claim: IdentityClaimant): FunctionComponent {
  return function* Issue(
    props: Record<string, Json>,
    invocation: ComponentInvocation,
  ): Operation<Json> {
    issueMode(props, true);
    // Before this element projects its own content, because an invocation names
    // nothing while it is expanding what is inside it — and after it would be
    // naming the identity from a frame the children have already left.
    const site = yield* claim(invocation);
    // The description is rendered here, outside the envelope below. A child
    // `<Issue>` or any other durable operation inside this content therefore
    // finishes at its own journal position, before this upsert is offered.
    const request = yield* issueUpsertRequest(props);
    const reference = yield* upsertOwnedIssue(
      { owner, site, request },
      liveUpsert(
        request,
        issueIdempotencyKey({ runId: owner, expansionId: site }, "upsert", request.target),
      ),
    );
    return { url: reference.url };
  };
}

/**
 * One live read attempt: the composed `IssueOperations` question, answered
 * beneath by this entry's transport-facing default.
 *
 * Scoped, so the default is gone before the envelope publishes anything, and
 * installed at `min`, so every public handler a document or a plugin composed
 * still wraps the dispatch.
 */
function liveRead(request: IssueReadInvocation): () => Operation<unknown> {
  return () =>
    scoped(function* (): Operation<unknown> {
      yield* IssueOperations.around(transportRead(), { at: "min" });
      return yield* IssueOperations.operations.read(request);
    });
}

/** One live upsert attempt, on the same terms, under this attempt's own key. */
function liveUpsert(request: IssueUpsertInvocation, key: string): () => Operation<unknown> {
  return () =>
    scoped(function* (): Operation<unknown> {
      yield* IssueOperations.around(transportUpsert(key), { at: "min" });
      return yield* IssueOperations.operations.upsert(request);
    });
}

function transportRead(): Partial<Around<IssueOperationsApi>> {
  return {
    *read([invocation]: [IssueReadInvocation]): Operation<IssueDetails> {
      const answered = yield* IssueApi.operations.read(invocation.url, {
        ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
      });
      const details = parseIssueDetails(answered);
      if (details === undefined) {
        throw new IssueProtocolError(
          "the issue provider answered a read with something that is not an issue's shared " +
            "fields",
        );
      }
      return details;
    },
  };
}

/**
 * The transport-facing default for one upsert attempt.
 *
 * The key is this attempt's, derived from the complete request's own identity
 * and target before any middleware saw it. A handler that transformed the
 * issue, the target or the discriminator changes what is sent — that is what
 * middleware is for — and changes nothing about which attempt this is.
 */
function transportUpsert(key: string): Partial<Around<IssueOperationsApi>> {
  return {
    *upsert([invocation]: [IssueUpsertInvocation]): Operation<IssueReference> {
      const answered = yield* IssueApi.operations.upsert(invocation.issue, {
        url: invocation.target,
        ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
        idempotencyKey: key,
      });
      const record = parseIssueRecord(answered);
      if (record === undefined) {
        throw new IssueProtocolError(
          "the issue provider answered an upsert with something that is not a URL",
        );
      }
      return record;
    },
  };
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
function ownedIssueAdmission(owner: string): JournalAdmission {
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
