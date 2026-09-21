/**
 * The profile-level Issue Api: what `<Issue>` asks, before any transport hears
 * about it.
 *
 * `IssueApi` is the transport surface — GitHub's middleware recognizes its own
 * URLs, holds a target to the host's ceiling, and normalizes what comes back.
 * This is the layer above it, and what it owns is *lifecycle*: whether one
 * question is asked once and retained, or asked once per run.
 *
 * The two profiles answer that differently, which is why the seam exists. A
 * workflow run wraps each operation in a durable effect keyed by its WorkflowRun
 * and expansion, so a replayed read hands back the snapshot it saw and a
 * replayed upsert reaches no service. An ordinary `xmd run` has no WorkflowRun
 * to key anything by and retains nothing: each execution derives a fresh opaque
 * invocation identity, presents it as the upsert's idempotency key, and asks the
 * same configured transport a new question. A second run is a second question,
 * never a resumption of the first.
 *
 * The default handler throws. `<Issue>` under a host that installed neither
 * profile must be told there is no provider, rather than reaching a transport
 * whose lifecycle nobody decided.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";
import type { IssueDetails, IssueInput, IssueReference } from "./api.ts";

/** The stable name every loaded copy composes through. */
export const ISSUE_OPERATIONS = "executablemd.workflow.composition.issue-operations";

/** What one read asks for. */
export interface IssueReadInvocation {
  /** The canonical issue URL. */
  readonly url: string;
  /** The explicit discriminator, or `undefined` when the document named none. */
  readonly provider: string | undefined;
}

/** What one upsert asks for. */
export interface IssueUpsertInvocation {
  /** The canonical container URL. */
  readonly target: string;
  /** The explicit discriminator, or `undefined` when the tracker named none. */
  readonly provider: string | undefined;
  readonly issue: IssueInput;
}

/** No profile installed an Issue lifecycle in this scope. */
export class IssueOperationsProviderError extends Error {
  override name = "IssueOperationsProviderError";

  constructor(operation: string) {
    super(
      `no Issue provider is installed, so ${operation} cannot answer. The Deno and compiled ` +
        "`xmd run` entrypoints install the ordinary one; a workflow host installs the retained " +
        "one for a live or partial execution.",
    );
  }
}

export interface IssueOperationsApi {
  /** Read the issue this URL names, as the fields every provider has. */
  read(invocation: IssueReadInvocation): Operation<IssueDetails>;

  /** Create or bring up to date one issue in the tracker this invocation names. */
  upsert(invocation: IssueUpsertInvocation): Operation<IssueReference>;
}

export const IssueOperations: Api<IssueOperationsApi> = createApi<IssueOperationsApi>(
  ISSUE_OPERATIONS,
  {
    // deno-lint-ignore require-yield
    *read(_invocation: IssueReadInvocation): Operation<IssueDetails> {
      throw new IssueOperationsProviderError("<Issue url=… />");
    },
    // deno-lint-ignore require-yield
    *upsert(_invocation: IssueUpsertInvocation): Operation<IssueReference> {
      throw new IssueOperationsProviderError("<Issue title=…>…</Issue>");
    },
  },
);
