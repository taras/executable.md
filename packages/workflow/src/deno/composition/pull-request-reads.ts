/**
 * One pull-request evidence read, retained.
 *
 * A read changes nothing, so it is an ordinary durable effect rather than a
 * reconciled one. `<PullRequest>` routes through the Git-host reconciliation
 * engine because it mutates a remote and must adopt an interrupted attempt
 * rather than repeat it; there is nothing here to adopt, no natural key and no
 * pre-state. What that buys is the ordinary durability contract: an interrupted
 * attempt may send its requests again, which is safe for a GET in the way it is
 * not for a POST, and a completed one restores its array without opening an
 * authentication session or contacting anything.
 *
 * The effect is named after the invocation that made it, the way every other
 * composition effect is, with the repository, the number and the collection in
 * its configuration. Two reads of the same collection at two places in a
 * document are two effects — which is what lets a revision loop read the
 * reviews again after it pushed a new head, instead of restoring the answer the
 * previous iteration got.
 *
 * ## Nothing public reaches this
 *
 * There is no Api operation for it. The three components are built over this
 * terminal by the host that has the run's storage and its Git-host source, and
 * the closure they capture is the only route to it. An operation on a public
 * Api would be one anything in scope could answer without delegating, and the
 * fabricated collection it answered with would be what a document bound and the
 * journal retained.
 *
 * The attachment arrives here directly from the component and stops here. The
 * whole Repository record and the working directory are what select a checkout
 * and resolve a locator; neither is part of a request, so neither is ever
 * offered to middleware.
 */

import { getExpansion, sourceDescription } from "@executablemd/core";
import { createDurableOperation } from "@executablemd/durable-streams";
import type { EffectDescription, Json as DurableJson } from "@executablemd/durable-streams";
import type { Operation } from "effection";
import { scoped } from "effection";
import { gitOperationFingerprint, selectGitCheckout } from "./operations.ts";
import { transactWorkspaceRoots } from "../workspace/private.ts";
import type { WorkflowRunDatabase } from "../../storage/api.ts";
import { parseJsonValue } from "../../storage/members.ts";
import { PullRequestReadError } from "../../composition/errors.ts";
import {
  parsePullRequestReadResult,
  pullRequestReadEnvelopeJson,
  pullRequestReadRequestJson,
} from "../../composition/pull-request-read-records.ts";
import type {
  PullRequestReadAttachment,
  PullRequestReadRequest,
  PullRequestReadResult,
} from "../../composition/pull-request-read-records.ts";
import { isReadRequestFor } from "../../composition/pull-request-read-terminal.ts";
import { parseGitHubRepository } from "./github.ts";
import type { GitHubSource } from "./github.ts";
import { denoGitHubSource } from "./github.ts";
import { readPullRequestEvidence as readEvidence } from "./pull-request-evidence.ts";
import { formDispatcher } from "@executablemd/core";
import type { FunctionComponent, PropsSchema, ReturnsSchema } from "@executablemd/core";
import {
  checksReturns,
  commentsReturns,
  props as pullRequestReadProps,
  pullRequestReadForms,
  reviewsReturns,
} from "../../composition/components/PullRequestReads.ts";
import type { PullRequestReadTerminal } from "../../composition/components/PullRequestReads.ts";
import { COMPOSITION_ORIGIN } from "../../composition/definitions.ts";

/** The durable effect type one evidence read is retained under. */
export const PULL_REQUEST_READ = "pull_request_read";

/** Which element a refusal names, by the collection it was reading. */
const ELEMENT: Readonly<Record<PullRequestReadRequest["kind"], string>> = Object.freeze({
  reviews: "<PullRequest.Reviews>",
  comments: "<PullRequest.Comments>",
  checks: "<PullRequest.Checks>",
});

/**
 * What this read is, in the journal.
 *
 * The complete normalized request is the effect's `input` rather than a digest
 * of it, because a reader of the history needs to know what was asked; the
 * fingerprint beside it is taken over the same members, so a document edited to
 * read another number or another collection in the same place is a different
 * effect and diverges rather than replaying the first one's answer. Neither
 * carries the locator or the checkout path: the fingerprint already names the
 * one, and the other is this machine's.
 */
function* describeRead(request: PullRequestReadRequest): Operation<EffectDescription> {
  const expansion = yield* getExpansion();
  const inputs = request;
  const configuration = gitOperationFingerprint([
    inputs.repository.name,
    inputs.repository.locatorFingerprint,
    inputs.repository.requestedBase,
    inputs.repository.creationCommit,
    inputs.repository.primaryBranch,
    inputs.repository.objectFormat,
    inputs.kind,
    String(inputs.number),
  ]);
  return {
    type: PULL_REQUEST_READ,
    name: `${expansion.id}:${inputs.repository.name}:${configuration}`,
    input: pullRequestReadRequestJson(inputs),
    configuration,
    ...sourceDescription(expansion.position),
  };
}

/**
 * Read one collection and retain it, or restore what is retained.
 *
 * The locator never leaves this closure: what the journal holds is the
 * fingerprint that already named it, the collection, the number and the
 * normalized evidence.
 */
function readEvidenceFor(
  database: WorkflowRunDatabase,
  source: GitHubSource,
  invocation: string,
  request: PullRequestReadRequest,
  attachment: PullRequestReadAttachment,
): Operation<PullRequestReadResult> {
  const element = ELEMENT[request.kind];

  return scoped(function* () {
    // The exact-invocation terminal. Whatever reached this provider has to be
    // the object this host minted for the invocation now running: a request
    // rebuilt from the same members, one another invocation issued, or one a
    // handler kept from an earlier read is not it, and performing under one
    // would be letting a caller choose whose evidence a document binds.
    if (!isReadRequestFor(invocation, request)) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "the request that reached the provider is not the one the engine issued for this " +
          "invocation, so there is no invocation to read on behalf of.",
      );
    }
    const admitted = request;
    const description = yield* describeRead(admitted);

    // The locator is retained state, not something the component carried: a
    // `RepositoryRecord` holds the fingerprint that already named it. Reading it
    // back is also the authority check — a Repository this run never retained
    // under that name, or one whose record has moved, is refused before a
    // credential is read. The transaction closes before anything is sent; a
    // network round trip must never hold the run's database.
    const located = yield* transactWorkspaceRoots(database, function* (workspace) {
      return selectGitCheckout(workspace.metadata, element, {
        repository: attachment.repository,
        workingDirectory: attachment.workingDirectory,
      }).repository.locator;
    });
    if (!located.ok) {
      throw located.error;
    }
    const locator = located.value;

    const stored = yield createDurableOperation<DurableJson>(
      description,
      function* (): Operation<DurableJson> {
        const name = parseGitHubRepository(locator);
        if (name === undefined) {
          throw new PullRequestReadError(
            "unavailable",
            element,
            "this Repository is not one the shipped Git-host adapter recognizes, so there is " +
              "nowhere authorized to read it from.",
          );
        }

        const access = yield* source.open();
        const reading = yield* readEvidence(access, name, admitted.number, admitted.kind);
        if (reading.state === "unavailable") {
          throw new PullRequestReadError(
            "unavailable",
            element,
            "the Git host did not answer with the complete collection. None of what it did " +
              "answer is evidence that there is nothing there.",
          );
        }
        if (reading.state === "protocol-invalid") {
          throw new PullRequestReadError(
            "protocol",
            element,
            "the Git host answered about a different subject, or with an item outside the " +
              "evidence contract. A well-formed answer to another question is still the wrong " +
              "answer.",
          );
        }
        return pullRequestReadEnvelopeJson(reading.result);
      },
    );

    const result = parsePullRequestReadResult(
      parseJsonValue(
        stored,
        "$",
        (reason, path) =>
          new PullRequestReadError(
            "protocol",
            element,
            `what this run retained for it is not a value it can carry: ${reason} at ${path}.`,
          ),
      ),
    );
    if (result === undefined || result.kind !== admitted.kind) {
      throw new PullRequestReadError(
        "protocol",
        element,
        "what this run retained for it is not the evidence that read produces.",
      );
    }
    return result;
  });
}

/**
 * The three components, built over this host's terminal.
 *
 * Registered by the attachment rather than by the provider-neutral installer,
 * because the terminal needs the run's storage and its Git-host source. Nothing
 * else can reach it: what the components capture is a closure, not a name.
 */
export function pullRequestReadComponents(
  database: WorkflowRunDatabase,
  source: GitHubSource = denoGitHubSource(),
): readonly {
  readonly name: string;
  readonly origin: string;
  readonly props: PropsSchema;
  readonly returns: ReturnsSchema;
  readonly fn: FunctionComponent;
}[] {
  const terminal: PullRequestReadTerminal = {
    read(invocation, request, attachment) {
      return readEvidenceFor(database, source, invocation, request, attachment);
    },
  };
  const forms = pullRequestReadForms(terminal);
  return [
    { name: "PullRequest.Reviews", returns: reviewsReturns, form: forms.reviews },
    { name: "PullRequest.Comments", returns: commentsReturns, form: forms.comments },
    { name: "PullRequest.Checks", returns: checksReturns, form: forms.checks },
  ].map((entry) => ({
    name: entry.name,
    origin: COMPOSITION_ORIGIN,
    props: pullRequestReadProps,
    returns: entry.returns,
    fn: formDispatcher(entry.form),
  }));
}
