/**
 * `<Issue>` — read one issue by URL, or upsert one in the tracker a lexical
 * context names (specs/workflow-workspace-spec.md §10.3).
 *
 * Two forms, and the syntax chooses between them before anything is routed.
 *
 * ```md
 * <Issue url={finding.issueUrl} as="found" />
 *
 * {found.title}: {found.description}
 * ```
 *
 * ```md
 * <IssueTracker url={props.tracker}>
 *   <Issue title="Retry the publish step" tags={["reliability"]} as="filed">
 * The publish step failed twice in a row on 503.
 *   </Issue>
 * </IssueTracker>
 *
 * Filed {filed.url}.
 * ```
 *
 * ## Why the two are one component
 *
 * They are the same subject at the same altitude: an issue, named
 * provider-neutrally. What differs is which question is being asked, and that
 * is exactly what the syntax already says — a self-closing element with a `url`
 * is asking about an issue that exists, and a paired element with a `title` is
 * asking for one to exist saying something.
 *
 * So the form decides the operation, and a form that is neither is refused
 * before a tracker is read and before `IssueApi` is invoked. A `url` with
 * content, a `title` without content, content without a title, `tags` on a
 * read: each is a document asking for something this element does not do, and
 * being told so is better than having one of the two guessed for it.
 *
 * ## Read needs no tracker
 *
 * The URL is the identity, so there is nothing for a container to add. A read
 * therefore never consults the tracker context — writing one around a read
 * changes nothing about it, which is what makes reading an issue from anywhere
 * a document happens to be safe.
 *
 * `provider` is permitted on a read for the same reason it is permitted on a
 * tracker: a self-hosted URL nobody recognizes still has to be addressable.
 *
 * ## Upsert takes its description from what it renders
 *
 * The content is the description, verbatim after expansion. There is no
 * `description` prop, because the thing a person writes at length belongs in
 * the document where it can be read, interpolated and reviewed — not squeezed
 * into an attribute.
 *
 * ## What each produces
 *
 * A read binds the fields every provider has: URL, title, description, tags and
 * assignee. An upsert binds exactly `{ url }`. Neither carries a provider's own
 * identity, a number, a workflow state or a payload, because a document that
 * branched on one of those would stop being portable across providers — which
 * is the whole point of this primitive.
 *
 * ## Failure
 *
 * A form that is neither read nor upsert, a missing tracker on an upsert, and a
 * URL that is not a credential-free container are decided here, before the
 * boundary exists in the story. What a provider answers — a conflict, an
 * ambiguity, an unavailability, a target outside its ceiling — is the
 * provider's own closed vocabulary.
 */

import { content, hasContent } from "@executablemd/core";
import type { PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";
import type { Json } from "@executablemd/durable-streams";
import { currentIssueTracker } from "../../issue/context.ts";
import {
  canonicalIssueTarget,
  issueProviderName,
  resolveIssueDestination,
} from "../../issue/tracker.ts";
import { readIssue, upsertIssue } from "../../issue/effect.ts";
import type { IssueInput } from "../../issue/api.ts";
import { normalizedTags } from "../../issue/records.ts";
import { IssueContentError, IssueProtocolError, IssueTrackerError } from "../../issue/errors.ts";

/** The component name, as a document writes it and as a refusal names it. */
export const ISSUE_ELEMENT = "<Issue>";

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
type Mode = "read" | "upsert";

/**
 * Which of the two this invocation is, or the refusal that says why neither.
 *
 * Decided from the props and the shape alone, before a tracker is read and
 * before the boundary is reached. Every branch names what to write instead,
 * because each of them is a document that meant one of the two forms.
 */
function mode(props: Record<string, Json>, paired: boolean): Mode {
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

export default function* Issue(props: Record<string, Json>): Operation<Json> {
  // The shape first, and locally. Everything after this depends on which of the
  // two questions is being asked, and a document that asked neither must not
  // have one of them chosen for it.
  const asked = mode(props, yield* hasContent());
  return asked === "read" ? yield* read(props) : yield* upsert(props);
}

function* read(props: Record<string, Json>): Operation<Json> {
  const url = canonicalIssueTarget(props.url);
  if (url === undefined) {
    throw new IssueTrackerError(
      "invalid-tracker-url",
      "the url it was given is not an http or https URL naming one issue, free of credentials, " +
        "query and fragment.",
    );
  }
  const provider = named(props.provider);
  // No tracker is consulted. The URL is the identity, so a tracker written
  // around a read has nothing to add to it and changes nothing about it.
  const details = yield* readIssue({ url, provider });
  return {
    url: details.url,
    title: details.title,
    description: details.description,
    tags: [...details.tags],
    assignee: details.assignee,
  };
}

function* upsert(props: Record<string, Json>): Operation<Json> {
  // The description before the destination, so a body that failed to render
  // stops this element before a tracker is read.
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

  const reference = yield* upsertIssue({
    target: destination.target,
    provider: destination.provider,
    issue,
  });
  return { url: reference.url };
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
