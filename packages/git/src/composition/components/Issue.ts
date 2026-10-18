/**
 * Read an issue by URL or upsert one in a lexical tracker
 * (specs/workflow-workspace-spec.md §10.3).
 *
 * `<Issue url={finding.issueUrl} as="found" />` reads without consulting tracker
 * context and binds URL, title, description, tags and assignee. Optional `provider`
 * addresses a URL the installed adapters do not otherwise recognize.
 *
 * `<Issue title="Retry" tags={["reliability"]} as="filed">…</Issue>` upserts in
 * the enclosing IssueTracker, using its completely rendered content verbatim as
 * the description, and binds exactly `{ url }`. Provider ids, issue numbers,
 * workflow state and raw payloads are absent from both results.
 *
 * Form/input mismatches refuse before tracker lookup or IssueApi: URL with
 * content, title without content, content without title and tags on reads are
 * invalid. Upsert content must render non-empty before the destination is read.
 * Invalid invocation, missing tracker and non-credential-free URLs are local
 * refusals; provider conflicts, ambiguity, availability and ceiling failures keep
 * the provider's own vocabulary.
 *
 * Which form this is comes from canonical dispatch rather than from the
 * invocation: an irreversible external effect is not something a composable
 * `hasContent()` answer may select. What a read asks for and what an upsert
 * asks for are decided from the props alone, before a tracker is read and
 * before the boundary is reached — and the host beneath this component decides
 * how the operation it asks for is performed, retained and replayed.
 */

import { content, documented, formDispatcher } from "@executablemd/core";
import type {
  ComponentRegistration,
  FirstPartyDocumentation,
  FunctionComponent,
  PropsSchema,
  ReturnsSchema,
} from "@executablemd/core";
import type { IdentityClaimant, IdentityComponent } from "@executablemd/core/host";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { COMPOSITION_ORIGIN } from "../definitions.ts";
import { boundComponent, unboundComponent } from "../invocation-binding.ts";
import type { BindOperations, ComponentBody, InvocationGate } from "../invocation-binding.ts";
import { currentIssueTracker } from "../../issue/context.ts";
import {
  canonicalIssueTarget,
  issueProviderName,
  resolveIssueDestination,
} from "../../issue/tracker.ts";
import type {
  IssueOperationsApi,
  IssueReadInvocation,
  IssueUpsertInvocation,
} from "../../issue/operations.ts";
import type { IssueDetails, IssueInput } from "../../issue/api.ts";
import { normalizedTags } from "../../issue/records.ts";
import { IssueContentError, IssueProtocolError, IssueTrackerError } from "../../issue/errors.ts";

/** The component name, as a document writes it and as a refusal names it. */
const ISSUE_ELEMENT = "<Issue>";

export const props: PropsSchema = {
  type: "object",
  properties: {
    /** The issue to read. Its presence is what selects the read form. */
    url: { type: "string", minLength: 1 },
    /** The issue's title. Its presence is what selects the upsert form. */
    title: { type: "string", minLength: 1 },
    /**
     * A set, written as a list.
     *
     * Order is not issue identity, so the request normalizes it: duplicates
     * removed, sorted by code point. A document that reorders its own list is
     * asking the same question.
     */
    tags: { type: "array", items: { type: "string", minLength: 1 } },
    /**
     * An opaque provider account identifier.
     *
     * No provider translates it through another directory: what a GitHub
     * adapter receives is a GitHub login and what an Atlassian adapter receives
     * is an Atlassian account id, and deciding which is the document's.
     */
    assignee: { type: "string", minLength: 1 },
    /**
     * The only provider allowed to handle a read.
     *
     * On a read alone: an upsert takes its discriminator from the tracker,
     * which is where a deployment's choice belongs. Saying it twice would be
     * two places to keep in agreement.
     */
    provider: { type: "string" },
  },
  additionalProperties: false,
};

/**
 * The evidence a document binds, exactly: one of two closed shapes.
 *
 * A read hands back the fields every provider has; an upsert hands back the URL
 * and nothing else. They are different questions, so they are different shapes,
 * and a single shape with members that were sometimes absent would make a
 * document read `undefined` where a title was promised.
 */
export const returns: ReturnsSchema = {
  oneOf: [
    {
      type: "object",
      properties: { url: { type: "string", minLength: 1 } },
      required: ["url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string", minLength: 1 } },
        assignee: { type: ["string", "null"] },
      },
      required: ["url", "title", "description", "tags", "assignee"],
      additionalProperties: false,
    },
  ],
};

/** What the shape of this invocation asks for. */
type IssueMode = "read" | "upsert";

/**
 * Which of the two this invocation is, or the refusal that says why neither.
 *
 * Decided from the props and the shape alone, before a tracker is read and
 * before the boundary is reached. Every branch names what to write instead,
 * because each of them is a document that meant one of the two forms.
 *
 * `paired` is how the element was written. Canonical form dispatch enters the
 * body for the form the scan recorded, and that body states it here — so the
 * fact is established somewhere nothing composable can answer for it.
 */
function issueMode(props: Record<string, Json>, paired: boolean): IssueMode {
  const url = typeof props.url === "string" && props.url !== "";
  const title = typeof props.title === "string" && props.title !== "";

  if (url && title) {
    throw new IssueContentError(
      `${ISSUE_ELEMENT} reads an issue with url, or files one with title, and cannot do both ` +
        "at once. Write two elements.",
    );
  }
  if (url) {
    if (paired) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} with a url reads an existing issue and renders nothing, so it takes ` +
          "no content. Write it as <Issue url=… as=… />.",
      );
    }
    for (const inapplicable of ["tags", "assignee"]) {
      if (props[inapplicable] !== undefined) {
        throw new IssueContentError(
          `${ISSUE_ELEMENT} with a url reads an issue and changes nothing about it, so ` +
            `${inapplicable} does not apply. Write an upsert to set it.`,
        );
      }
    }
    return "read";
  }
  if (title) {
    if (props.provider !== undefined) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} takes its provider from the enclosing <IssueTracker> when it files an ` +
          "issue, so provider does not apply here.",
      );
    }
    if (!paired) {
      throw new IssueContentError(
        `${ISSUE_ELEMENT} files the issue its content describes, so it needs content. Write it ` +
          "as <Issue title=…>…</Issue>.",
      );
    }
    return "upsert";
  }
  throw new IssueContentError(
    `${ISSUE_ELEMENT} either reads an issue — <Issue url=… as=… /> — or files one — ` +
      "<Issue title=…>…</Issue>. This is neither.",
  );
}

/**
 * What this read asks for: a canonical issue URL, and a discriminator or none.
 *
 * No tracker is consulted. The URL is the identity, so a tracker written
 * around a read has nothing to add to it and changes nothing about it.
 */
function issueReadRequest(props: Record<string, Json>): IssueReadInvocation {
  const url = canonicalIssueTarget(props.url);
  if (url === undefined) {
    throw new IssueTrackerError(
      "invalid-tracker-url",
      "the url it was given is not an http or https URL naming one issue, free of credentials, " +
        "query and fragment.",
    );
  }
  return { url, provider: named(props.provider) };
}

/**
 * What this upsert asks for: the rendered description, the destination the
 * enclosing tracker names, and the normalized issue.
 *
 * The description before the destination, so a body that failed to render stops
 * this element before a tracker is read. Rendering it is this element's own
 * content projection and belongs outside whatever durable boundary the caller
 * puts around the request: a child that retains work of its own finishes in its
 * own order, before this request exists.
 */
function* issueUpsertRequest(props: Record<string, Json>): Operation<IssueUpsertInvocation> {
  const description = yield* content();
  if (description === "") {
    throw new IssueContentError(
      `${ISSUE_ELEMENT} files the issue its content describes, and this content rendered ` +
        "nothing. An issue with no description is not one this element files.",
    );
  }

  const destination = resolveIssueDestination(yield* currentIssueTracker());
  const tags = normalizedTags(props.tags);
  if (tags === undefined) {
    throw new IssueProtocolError(
      "the tags this invocation was given are not a list of non-empty strings",
    );
  }
  const issue: IssueInput = Object.freeze({
    title: typeof props.title === "string" ? props.title : "",
    description,
    tags,
    // One spelling of absence, from here to the journal.
    assignee: typeof props.assignee === "string" && props.assignee !== "" ? props.assignee : null,
  });

  return { target: destination.target, provider: destination.provider, issue };
}

/** What the catalog says about `<Issue>`. */
export const documentation: FirstPartyDocumentation = {
  description:
    `Read or file an issue. \`<Issue url={finding.issueUrl} as="found" />\` reads one. ` +
    `\`<Issue title="Retry the publish step">…</Issue>\` files its content in the issue tracker ` +
    `in scope.`,
  as: "Required for a read, which binds url, title, description, tags and assignee. A file binds the url alone.",
  context: "The issue's description, for the form that files one.",
};

/** What a read binds, as a document reads it. */
function issueReadBinding(details: IssueDetails): Json {
  return {
    url: details.url,
    title: details.title,
    description: details.description,
    tags: [...details.tags],
    assignee: details.assignee,
  };
}

/**
 * The one read implementation, whatever host performs it.
 *
 * Entered by canonical dispatch for the self-closing form, so the props checks
 * below are this element's refusals rather than a second decision about which
 * of the two questions is being asked.
 */
const readBody: ComponentBody<IssueOperationsApi> = function* Issue(
  props: Record<string, Json>,
  operations: IssueOperationsApi,
): Operation<Json> {
  issueMode(props, false);
  const details = yield* operations.read(issueReadRequest(props));
  return issueReadBinding(details);
};

/** The one upsert implementation, on the same terms. */
const upsertBody: ComponentBody<IssueOperationsApi> = function* Issue(
  props: Record<string, Json>,
  operations: IssueOperationsApi,
): Operation<Json> {
  issueMode(props, true);
  // Rendered here, so a child that retains work of its own finishes at its own
  // journal position before this upsert is offered to the host beneath.
  const request = yield* issueUpsertRequest(props);
  const reference = yield* operations.upsert(request);
  return { url: reference.url };
};

/** What a catalog says about this component, whichever path declares it. */
const METADATA = {
  name: "Issue",
  origin: COMPOSITION_ORIGIN,
  props,
  returns,
  forms: ["self-closing", "paired"] as const,
  ...documented(documentation),
};

/**
 * Canonical form dispatch, so which of the two external effects this element
 * asks for is settled by the scan before the body runs.
 */
function dispatched(read: FunctionComponent, upsert: FunctionComponent): FunctionComponent {
  return formDispatcher({ forms: "both", "self-closing": read, paired: upsert });
}

/** `Issue` as an ordinary registered default, over the public IssueOperations Api. */
export function issueRegistration(
  operations: (gate: InvocationGate) => IssueOperationsApi,
): ComponentRegistration {
  return {
    ...METADATA,
    fn: dispatched(
      unboundComponent(ISSUE_ELEMENT, operations, readBody),
      unboundComponent(ISSUE_ELEMENT, operations, upsertBody),
    ),
  };
}

/** `Issue` as a declaration, for a host that supplies its own policy. */
export function issueDeclaration(bind: BindOperations<IssueOperationsApi>): IdentityComponent {
  return {
    ...METADATA,
    factory: (claim: IdentityClaimant) =>
      dispatched(
        boundComponent(claim, { element: ISSUE_ELEMENT, bind, body: readBody }),
        boundComponent(claim, { element: ISSUE_ELEMENT, bind, body: upsertBody }),
      ),
  };
}

/** The discriminator this prop names, or `undefined` when it names none. */
function named(value: Json | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = issueProviderName(value);
  if (name === undefined) {
    throw new IssueTrackerError(
      "invalid-provider",
      "a provider discriminator is a stable lower-case name, and that is not one.",
    );
  }
  return name;
}
