/**
 * `<PullRequest>` — read one pull request by URL, or create or update one for
 * the branch this run published (specs/workflow-workspace-spec.md §7.5).
 *
 * ```md
 * <PullRequest url={url} as="pr" />
 * <PullRequest url={url} yq=".body" as="description" />
 * <Repository name="project" url={props.repository}>
 *   <Git.Switch branch="release/1.4" />
 *   <Git.Add paths="release/notes.md" />
 *   <Git.Commit message="Prepare 1.4" as="commit" />
 *   <Git.Push />
 *   <PullRequest number={props.pullRequestNumber} title="Prepare 1.4" as="pullRequest">
 *     Prepared from commit {commit}.
 *   </PullRequest>
 * </Repository>
 * ```
 *
 * The authored form chooses the operation. A self-closing element reads: it names
 * a pull request by its canonical URL and binds that record, selected by `yq` and
 * paged, or renders it as JSON without `as`. It needs no Repository, no working
 * directory and no Push evidence, and it never creates or updates anything. A
 * paired element writes: its rendered content is the pull request's body, and it
 * creates or brings up to date one pull request for the branch this run
 * published. An empty pair is an intentional write. The form comes from the
 * engine's recorded invocation through `formDispatcher`, never from rendered
 * text, child count or a `hasContent()` answer.
 *
 * The write is a statement about a branch that already exists at the Git host, so
 * the run must already hold `<Git.Push />`'s own successful result for this exact
 * Repository, head, destination ref and commit. Direct remote observation is not a
 * substitute: a branch found at the host may have been put there by anything, and
 * opening a pull request for it would be publishing somebody else's work under
 * this run's name.
 */
import { cwd } from "@executablemd/runtime";
import { content, documented, formDispatcher, hasBinding } from "@executablemd/core";
import type {
  ComponentRegistration,
  FirstPartyDocumentation,
  FunctionComponent,
  PropsSchema,
} from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { PullRequestOperations } from "../pull-request-operations.ts";
import type { PullRequestOperationsApi } from "../pull-request-operations.ts";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { selectedRepository } from "../context.ts";
import {
  PullRequestAdmissionError,
  PullRequestContentError,
  PullRequestReadError,
} from "../errors.ts";
import { pullRequestResultJson } from "../pull-request-records.ts";
import { parseCompletePullRequestReadResult } from "../pull-request-read-records.ts";
import { canonicalPullRequestUrl, pullRequestProviderName } from "../pull-request-target.ts";
import { selectPullRequestDetailsPage } from "../pull-request-details-page.ts";
import { boundComponent } from "../invocation-binding.ts";
import type { BindOperations, ComponentBody } from "../invocation-binding.ts";

export const PULL_REQUEST_ELEMENT = "<PullRequest>";

/**
 * Every prop either form may receive, closed.
 *
 * Which of them a form requires or refuses is decided in its own body, before any
 * child or provider work, because one schema cannot say "url or title, never
 * both". `as` is Core's binding syntax and is not a prop.
 */
export const props: PropsSchema = {
  type: "object",
  properties: {
    /** The pull request a read names, by canonical URL. */
    url: { type: "string", minLength: 1 },
    /** The only provider allowed to handle a read. */
    provider: { type: "string", minLength: 1 },
    /** The selection a read binds, over the complete record; omitted means `.`. */
    yq: { type: "string" },
    /** An explicit UTF-8 byte budget for one page, navigation included. */
    maxBytes: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    /** The pull request to bring up to date. Absent asks for one to exist. */
    number: { type: "integer", minimum: 1 },
    /** The title a write sets. */
    title: { type: "string", minLength: 1 },
    /** The base branch a write names; the Repository's primary branch when absent. */
    base: { type: "string", minLength: 1 },
    /** Whether a write creates the pull request as a draft. */
    draft: { type: "boolean" },
  },
  additionalProperties: false,
};

export const documentation: FirstPartyDocumentation = {
  description:
    'Read or write a pull request. `<PullRequest url={url} as="pr" />` reads one; ' +
    '`<PullRequest title="Prepare 1.4" as="pr">…</PullRequest>` writes its body after ' +
    "`<Git.Push />`.",
  as:
    "Optional for a read: binds value, next, prev and last instead of rendering JSON. " +
    "Required for a paired write: binds its settled PR identity.",
  context: "The paired write's body. An empty pair writes an empty body.",
};

/** Props a read refuses, because they describe a write. */
const WRITE_PROPS = ["title", "number", "base", "draft"] as const;

/** Props a write refuses, because they describe a read. */
const READ_PROPS = ["url", "provider", "yq", "maxBytes"] as const;

/** Whether a prop is present on this invocation. */
function given(props: Record<string, Json>, name: string): boolean {
  return props[name] !== undefined;
}

/** A form or prop refusal, decided before any child, credential or provider is touched. */
function refuseForm(sentence: string): PullRequestContentError {
  return new PullRequestContentError(`${PULL_REQUEST_ELEMENT} ${sentence}`);
}

/**
 * The read this element names, read back and checked before anything is asked.
 *
 * Self-closing without a url would be a write with no pull request to name, and a
 * write prop beside a url would ask the provider to change what it was asked to
 * read. Both are local refusals.
 */
function readProps(props: Record<string, Json>): void {
  if (!given(props, "url")) {
    throw refuseForm(
      "with no content reads an existing pull request, so it needs url. To write one, write " +
        "<PullRequest title=… as=…>…</PullRequest>.",
    );
  }
  for (const name of WRITE_PROPS) {
    if (given(props, name)) {
      throw refuseForm(
        `with url reads a pull request and changes nothing about it, so ${name} does not ` +
          "apply. Write <PullRequest title=… as=…>…</PullRequest> to set it.",
      );
    }
  }
}

/** The write's own refusal, decided before its children run or a provider is asked. */
function writeProps(props: Record<string, Json>): void {
  for (const name of READ_PROPS) {
    if (given(props, name)) {
      throw refuseForm(
        `with content writes a pull request, so ${name} does not apply. Read one with ` +
          '<PullRequest url=… as="pr" />.',
      );
    }
  }
  if (!given(props, "title")) {
    throw refuseForm(
      "with content writes a pull request, which needs title. Write " +
        "<PullRequest title=…>…</PullRequest>.",
    );
  }
}

/**
 * Read the pull request this URL names, select the record, and page it.
 *
 * Nothing here consults the Repository, the working directory or Push evidence:
 * a read is complete from its URL alone.
 */
const readBody: ComponentBody<PullRequestOperationsApi> = function* PullRequest(
  props: Record<string, Json>,
  operations: PullRequestOperationsApi,
): Operation<Json> {
  readProps(props);
  // Asked before the provider, because the answer belongs to how the element was
  // written and a selection refused below must not reach a provider at all.
  const bound = yield* hasBinding();

  const url = canonicalPullRequestUrl(props.url);
  if (url === undefined) {
    throw new PullRequestReadError(
      "invalid-url",
      PULL_REQUEST_ELEMENT,
      "its `url` is not the plain canonical address of a pull request. A credential, a query " +
        "or a fragment makes it something else, and none of them is stripped.",
    );
  }
  const provider =
    props.provider === undefined ? undefined : pullRequestProviderName(props.provider);
  if (props.provider !== undefined && provider === undefined) {
    throw new PullRequestReadError(
      "invalid-provider",
      PULL_REQUEST_ELEMENT,
      "its `provider` is not a provider name: lower case, starting with a letter.",
    );
  }
  const yq = typeof props.yq === "string" ? props.yq : ".";
  if (yq.trim() === "") {
    throw new PullRequestReadError(
      "invalid-query",
      PULL_REQUEST_ELEMENT,
      "its `yq` is empty. Omit yq to read the whole record, or write an expression that " +
        'yields one value, such as ".body".',
    );
  }
  const maxBytes = typeof props.maxBytes === "number" ? props.maxBytes : undefined;

  const result = yield* operations.read({ url, kind: "details", provider });
  const evidence = parseCompletePullRequestReadResult(result, "details");
  if (evidence === undefined || evidence.kind !== "details") {
    throw new PullRequestReadError(
      "protocol",
      PULL_REQUEST_ELEMENT,
      "what this element was finally answered with is not the pull request record that read " +
        "produces.",
    );
  }

  const page = yield* selectPullRequestDetailsPage(
    PULL_REQUEST_ELEMENT,
    { yq, maxBytes },
    url,
    evidence.details,
  );
  const json: Json = {
    value: page.value,
    next: page.next,
    prev: page.prev,
    last: page.last,
  };
  // Without `as` the page is the answer rendered as JSON; with it, the bound data.
  return bound ? json : JSON.stringify(json, null, 2);
};

/**
 * Create or bring up to date one pull request for the selected checkout.
 *
 * The write's form, props and `as` are refused before the body reaches its own
 * content: an invalid pair ran no child and asked no provider.
 */
const upsertBody: ComponentBody<PullRequestOperationsApi> = function* PullRequest(
  props: Record<string, Json>,
  operations: PullRequestOperationsApi,
): Operation<Json> {
  writeProps(props);
  if (!(yield* hasBinding())) {
    throw refuseForm(
      "with content writes a pull request and binds the identity it settled, so it must be " +
        'invoked with `as`. Write <PullRequest title=… as="pr">…</PullRequest>.',
    );
  }

  // Before a Repository is observed, a checkout selected or retained Push
  // evidence read: a body that never finished rendering must not become one
  // that was published, and a child that retains work of its own finishes at
  // its own journal position first.
  const body = yield* content();

  const repository = yield* selectedRepository();
  if (repository === undefined) {
    throw new PullRequestAdmissionError(
      "no-repository-context",
      "it is written outside a lexical <Repository>, so there is no repository in scope for a " +
        "pull request to be opened in.",
    );
  }

  const result = yield* operations.upsert({
    pullRequest: {
      // Absence is `null` from here on: the durable request is JSON, and a
      // member that is sometimes missing would be a second shape.
      number: typeof props.number === "number" ? props.number : null,
      title: typeof props.title === "string" ? props.title : "",
      // Verbatim: trimming or reflowing it would publish something nobody wrote.
      body,
      draft: props.draft === true,
      // The Repository's own initial branch, pinned when it was selected,
      // rather than whatever its default branch is at the host right now.
      base:
        typeof props.base === "string" && props.base !== ""
          ? props.base
          : repository.identity.primaryBranch,
    },
    repository,
    workingDirectory: yield* cwd(),
  });
  return pullRequestResultJson(result);
};

const METADATA = {
  name: "PullRequest",
  origin: COMPOSITION_ORIGIN,
  props,
  forms: ["self-closing", "paired"] as const,
  ...documented(documentation),
};

/**
 * Which operation this element asks for comes from the scan's recorded form, not
 * from a contextual answer: an irreversible write is not something an installed
 * handler may select, and a read must not turn into one.
 */
function dispatched(read: FunctionComponent, write: FunctionComponent): FunctionComponent {
  return formDispatcher({ forms: "both", "self-closing": read, paired: write });
}

/** An ordinary registered default, over whichever provider the host installed. */
export const pullRequestRegistration: ComponentRegistration = {
  ...METADATA,
  fn: dispatched(
    (props) => readBody(props, PullRequestOperations.operations),
    (props) => upsertBody(props, PullRequestOperations.operations),
  ),
};

/**
 * A declaration, for an execution that owns this element's policy.
 *
 * The site is authenticated in the frame the engine entered, before the body
 * reaches any content of its own — so a projecting ancestor is ineligible for
 * one, and the children a write encloses still finish at their own journal
 * positions before the upsert is asked for. Both operations are bound, because
 * both forms are declared.
 */
export function pullRequestDeclaration(
  bind: BindOperations<PullRequestOperationsApi>,
): IdentityComponent {
  return {
    ...METADATA,
    factory: (claim: IdentityClaimant) =>
      dispatched(boundComponent(claim, bind, readBody), boundComponent(claim, bind, upsertBody)),
  };
}
