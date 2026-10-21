/**
 * How one REPL entry reads a pull request's evidence, and what it retains.
 *
 * An entry retains the provider's snapshot and nothing above it. Current URL
 * matching, the operator's read ceiling and target parsing still happen on
 * every read, live, because an operator who withdrew permission for a URL has
 * withdrawn it for the continuation too — and the semantic and transport
 * middleware outside retention still run, so an outer handler may transform
 * what a restored snapshot becomes. What is restored is what the host answered;
 * what the document binds is what the whole composition finished with.
 *
 * ## Each occurrence is its own
 *
 * Every invocation installs its own transport descriptor under the stable Api
 * name, in a scope of that one read's own, and that descriptor's default closes
 * over this invocation's owner and site. The shared middleware chain still
 * composes around it, and the chain ends in this read's own admitted callback
 * rather than in a shared one. Nothing is read from a "current read" variable,
 * a Context, a registry or a public read option: a nested read started by a
 * handler and two concurrent `<Spawn>` reads each carry their own callback,
 * their own site and their own coroutine position, so none of them can consume
 * another's.
 *
 * A wholly synthetic outer answer is ordinary composition. It reaches no
 * admitted transport, so it creates no snapshot and retains nothing — and the
 * shared body still validates it completely before an array binds.
 *
 * ## What is installed, and when
 *
 * The adapter's configuration and transport resolve once per entry and stay
 * inert until something needs a session. Installing them reads no
 * configuration and opens nothing, so an entry that reads nothing asks the host
 * nothing — and an entry with no managed root can still read an allowed URL,
 * because a read needs no Repository and no checkout.
 */

import { createApi } from "@effectionx/context-api";
import { scoped } from "effection";
import type { Operation } from "effection";
import { getExpansion } from "@executablemd/core";
import type { JournalAdmission } from "@executablemd/core/host";
import type { DurableEvent } from "@executablemd/durable-streams";
import { StaleInputError } from "@executablemd/durable-streams";
import type { BindOperations } from "@executablemd/git";
import { PULL_REQUEST_API } from "@executablemd/git/api";
import type {
  PullRequestApi,
  PullRequestInput,
  PullRequestReadOptions,
  PullRequestUpsertOptions,
} from "@executablemd/git/api";
import { NoPullRequestProvider } from "@executablemd/git/api";
import { PULL_REQUEST_OPERATIONS } from "@executablemd/git/api";
import type {
  PullRequestOperationsApi,
  PullRequestReadInvocation,
  PullRequestUpsertInvocation,
} from "@executablemd/git/api";
import { GitCompositionProviderError } from "@executablemd/git";
import { PULL_REQUEST_ELEMENT } from "@executablemd/git";
import {
  parseCompletePullRequestReadResult,
  PULL_REQUEST_READ_KINDS,
  readRequest,
} from "@executablemd/git";
import type { PullRequestReadKind, PullRequestReadResult } from "@executablemd/git/api";
import type { PullRequestResult } from "@executablemd/git";
import { canonicalPullRequestUrl, pullRequestProviderName } from "@executablemd/git";
import type { DenoPullRequestOperations } from "@executablemd/git/deno";
import { PULL_REQUEST_READ, retainPullRequestRead } from "@executablemd/git/deno";
import { gitOperationFingerprint } from "@executablemd/git/deno";

/** Why a retained read history cannot be continued. */
export type ReplPullRequestReadRefusal =
  /** A retained read this host cannot read back as the question it names. */
  | "malformed-record"
  /** A retained read written under another entry. */
  | "foreign-owner"
  /** A retained read whose stored question is not the question it is named by. */
  | "request-fingerprint"
  /** A retained success holding something other than the evidence it asked for. */
  | "malformed-evidence";

/**
 * A retained read history this entry cannot continue from.
 *
 * Fatal by construction: it extends `StaleInputError`, so it ends the attempt
 * rather than becoming a value a document can print away and carry on past. An
 * entry that cannot account for evidence it already bound must not bind it
 * again as though it could.
 */
export class ReplPullRequestReadHistoryError extends StaleInputError {
  override name = "ReplPullRequestReadHistoryError";

  readonly reason: ReplPullRequestReadRefusal;

  constructor(reason: ReplPullRequestReadRefusal, sentence: string) {
    super(sentence);
    this.reason = reason;
  }
}

/** The complete question one retained read states. */
interface RetainedReadQuestion {
  readonly owner: string;
  readonly site: string;
  readonly url: string;
  readonly provider: string | null;
  readonly kind: PullRequestReadKind;
}

export function replPullRequestReadAdmission(owner: string): JournalAdmission {
  return (retained) => admitReplPullRequestReads(owner, retained);
}

/**
 * Hold every retained read to the question it was made under.
 *
 * Runs with this entry's other trusted admissions, before replay. Each record
 * states its complete question, names this entry's owner, and is journaled
 * under the name that exact question produces — recomputed here through the
 * delivered recipe rather than compared against whatever the record carries. A
 * success additionally holds the evidence of the collection it asked for, with
 * every check item naming its envelope's head; a failed read has the same
 * complete question and no array, and validating the question without inventing
 * an outcome is the whole of it.
 */
function* admitReplPullRequestReads(
  owner: string,
  retained: readonly DurableEvent[],
): Operation<void> {
  for (const event of retained) {
    if (event.type !== "yield" || event.description.type !== PULL_REQUEST_READ) {
      continue;
    }
    const question = parseRetainedQuestion(event.description.input);
    if (question === undefined) {
      throw new ReplPullRequestReadHistoryError(
        "malformed-record",
        "a retained pull-request read in this entry's history does not state the complete " +
          "question it was made under, so what it asked the Git host is unknown.",
      );
    }
    if (question.owner !== owner) {
      throw new ReplPullRequestReadHistoryError(
        "foreign-owner",
        "a retained pull-request read in this entry's history was made under another owner, so " +
          "the evidence it holds was not read by this entry.",
      );
    }
    const configuration = readConfiguration(question);
    if (
      event.description.configuration !== configuration ||
      event.description.name !== `${question.site}:${configuration}`
    ) {
      throw new ReplPullRequestReadHistoryError(
        "request-fingerprint",
        "a retained pull-request read is journaled under a name its own question does not " +
          "produce, so the record and the read it describes do not match.",
      );
    }
    if (event.result.status !== "ok") {
      continue;
    }
    if (parseCompletePullRequestReadResult(event.result.value, question.kind) === undefined) {
      throw new ReplPullRequestReadHistoryError(
        "malformed-evidence",
        "a retained pull-request read holds a value that is not the evidence the collection it " +
          "asked for produces, so what it says the Git host answered is unknown.",
      );
    }
  }
}

/**
 * The exact configuration fingerprint one question produces.
 *
 * The delivered recipe, unchanged: the operation, the canonical URL, the
 * explicit discriminator or its absence, and the collection. The owner and the
 * site are deliberately outside it, which is what keeps a Workflow fork's
 * inherited read the same effect — so this reader recomputes it rather than
 * believing a stored value, and an empty one is no admission at all.
 */
function readConfiguration(question: RetainedReadQuestion): string {
  return gitOperationFingerprint(["read", question.url, question.provider, question.kind]);
}

/** The complete question one retained read states, or `undefined`. */
function parseRetainedQuestion(value: unknown): RetainedReadQuestion | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  // Totally: every read of a journal-controlled value is the value's own to
  // refuse, and a refusal of any of them is the same answer.
  try {
    const operation = Reflect.get(value, "operation");
    const url = Reflect.get(value, "url");
    const kind = Reflect.get(value, "kind");
    const owner = Reflect.get(value, "runId");
    const site = Reflect.get(value, "expansionId");
    const provider = Reflect.get(value, "provider");
    if (operation !== "read" || typeof owner !== "string" || owner === "") {
      return undefined;
    }
    if (typeof site !== "string" || site === "") {
      return undefined;
    }
    if (typeof url !== "string" || canonicalPullRequestUrl(url) !== url) {
      return undefined;
    }
    const collection = PULL_REQUEST_READ_KINDS.find((known) => known === kind);
    if (collection === undefined) {
      return undefined;
    }
    if (
      provider !== null &&
      (typeof provider !== "string" || pullRequestProviderName(provider) !== provider)
    ) {
      return undefined;
    }
    return { owner, site, url, provider, kind: collection };
  } catch {
    return undefined;
  }
}

/**
 * How this entry performs its three evidence reads.
 *
 * The policy the common declarations are built with. Each is called once per
 * invocation, with the site the binding authenticated, and what it answers with
 * is that invocation's own read operation.
 */
export function replPullRequestReadPolicy(
  owner: string,
  pullRequests: () => DenoPullRequestOperations,
): BindOperations<PullRequestOperationsApi["read"]> {
  return (site: string) => (invocation: PullRequestReadInvocation) =>
    read(owner, site, pullRequests, invocation);
}

/**
 * One read, through both ordinary chains and this invocation's own transport.
 *
 * Two layers, because the public vocabulary has two and an entry read composes
 * through the same ones every other profile composes through. The semantic
 * `PullRequestOperations` chain decides *whether* this host answers at all and
 * owns lifecycle and admission; the `PullRequestAPI` chain beneath it is
 * transport. A document or a plugin may compose a handler at either, and both
 * see this read exactly as they would see an ordinary run's.
 *
 * Each layer's terminal is this invocation's own and is installed in a scope of
 * this read's own, so what either establishes does not outlive the invocation
 * that made it. The transport terminal is the adapter's own handler — matching,
 * the host ceiling and target parsing unchanged — and what it is handed is a
 * callback closed over this entry's owner and this invocation's site, so the
 * question a read is named by is this entry's while the adapter stays as free
 * of owner and site as it is of a run and an expansion.
 *
 * Nothing is reached below the semantic layer until the semantic layer
 * delegates. A handler there that answers without delegating has answered the
 * document; it opens no session, admits no read and retains nothing — which is
 * what makes a synthetic semantic answer ordinary composition rather than a
 * second way to write history.
 */
function* read(
  owner: string,
  site: string,
  pullRequests: () => DenoPullRequestOperations,
  invocation: PullRequestReadInvocation,
): Operation<PullRequestReadResult> {
  return yield* scoped(function* (): Operation<PullRequestReadResult> {
    // One invocation-local default under the stable semantic name: the
    // document's own lifecycle handlers still compose around this read, and the
    // chain ends in this invocation's own admitted dispatch rather than in the
    // public no-profile default.
    const local = createApi<PullRequestOperationsApi>(PULL_REQUEST_OPERATIONS, {
      read: (request: PullRequestReadInvocation) => admitted(owner, site, pullRequests, request),
      // The upsert keeps a refusal. It is unreachable through this descriptor —
      // the only call made on it is the read below — and declaring it any other
      // way would make this read's private terminal answer for an operation it
      // owns nothing about.
      upsert: refusingUpsertOperation(),
    });
    return yield* local.operations.read(invocation);
  });
}

/**
 * The read the semantic chain delegated, through this invocation's transport.
 *
 * Reached only once the layer above has decided this host answers. The
 * configuration and the position are read here rather than above, so a read the
 * semantic chain answered itself asks this entry's transport nothing.
 */
function* admitted(
  owner: string,
  site: string,
  pullRequests: () => DenoPullRequestOperations,
  invocation: PullRequestReadInvocation,
): Operation<PullRequestReadResult> {
  // Built once per entry and inert until something needs a session, so there is
  // always one here: an entry with no managed root still reads an allowed URL,
  // because a read needs no Repository and no checkout.
  const domain = pullRequests();
  const expansion = yield* getExpansion();

  return yield* scoped(function* (): Operation<PullRequestReadResult> {
    // One invocation-local descriptor under the stable transport name: the
    // document's own transport handlers still compose around this read, and the
    // chain ends in this invocation's own admitted callback rather than a
    // shared one. What the domain is handed is that callback; what it keeps is
    // the configuration, the endpoint and the credential.
    //
    // This descriptor is the end of the chain, so a read this host declines has
    // nothing below it to continue into and the public surface's own answer is
    // what it gets. That answer is raised from here rather than by asking
    // `PullRequestAPI.operations.read` again: re-entering the chain from the
    // top would run every outer handler a second time before the refusal, and
    // an outer handler that counts or rewrites the URL would see one read
    // twice.
    const local = createApi<PullRequestApi>(PULL_REQUEST_API, {
      read: (url: string, options: PullRequestReadOptions) =>
        domain.read(
          url,
          options,
          (admittedRead, perform) =>
            retainPullRequestRead(
              readRequest(admittedRead.url, admittedRead.kind, admittedRead.provider, owner, site),
              expansion.position,
              perform,
            ),
          declinedRead,
        ),
      upsert: refusingUpsert(),
    });
    return yield* local.operations.read(invocation.url, {
      kind: invocation.kind,
      ...(invocation.provider === undefined ? {} : { provider: invocation.provider }),
    });
  });
}

/** The same refusal the upsert's own descriptor gives the member it never routes. */
function refusingUpsertOperation(): (
  invocation: PullRequestUpsertInvocation,
) => Operation<PullRequestResult> {
  // deno-lint-ignore require-yield
  return function* (): Operation<PullRequestResult> {
    throw new GitCompositionProviderError(PULL_REQUEST_ELEMENT);
  };
}

/**
 * The public surface's own answer, for a read this host does not handle.
 *
 * The same error `PullRequestAPI`'s no-profile default raises, raised where the
 * chain actually ends. Nothing is retained and nothing was contacted: a URL
 * this adapter declined was refused before a session or a request existed.
 */
function declinedRead(
  url: string,
  options: PullRequestReadOptions,
): Operation<PullRequestReadResult> {
  // deno-lint-ignore require-yield
  return (function* (): Operation<PullRequestReadResult> {
    throw new NoPullRequestProvider("read", url, options.provider);
  })();
}

/** The public default's own refusal, for the member this descriptor never routes. */
function refusingUpsert(): (
  pullRequest: PullRequestInput,
  options: PullRequestUpsertOptions,
) => Operation<PullRequestResult> {
  // deno-lint-ignore require-yield
  return function* (
    _pullRequest: PullRequestInput,
    options: PullRequestUpsertOptions,
  ): Operation<PullRequestResult> {
    throw new NoPullRequestProvider("upsert", options.repository.name, options.provider);
  };
}
