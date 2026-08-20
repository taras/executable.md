/**
 * The first Issue adapter: GitHub repository issues, over REST.
 *
 * Everything provider-specific about `<Issue>` on GitHub is here — which
 * targets this adapter recognizes, where the credential comes from, what is
 * sent, and how an answer becomes one of a closed set of normalized shapes.
 * None of it is reachable from a document, from public Issue middleware or from
 * the journal: the host installs one of these for the `github` discriminator,
 * and it holds its endpoint, its credential and its ceiling in a closure of its
 * own.
 *
 * ## What is refused before HTTP exists
 *
 * A target this adapter does not recognize as a GitHub repository issue
 * collection, and a target outside the ceiling the host installed beside its
 * credentials. Both are answered from observation, before a URL is built and
 * long before one is sent — which is what makes a replaceable context a request
 * rather than a grant.
 *
 * ## The marker, and why the description is stored around it
 *
 * GitHub has nowhere to keep this run's natural key, so the key's own digest is
 * written into the issue body and searched for there. The description the
 * document wrote is the rest of the body, so the adapter appends the marker on
 * the way out and strips exactly that suffix on the way back. A body somebody
 * has edited no longer ends with it, which is not an error: the description
 * then differs from the request and the update path brings it back.
 *
 * ## What an answer may become
 *
 * Four shapes, and "I could not tell" is one of them. A transport failure, a
 * rate limit, an authentication failure, a 404 that is really a permission
 * check, a page that could not be followed and a body that could not be read
 * are all *unavailable*: none of them proves that no issue is there, and
 * treating any of them as absence is the one mistake that files a second issue
 * for one obligation.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { canonicalFingerprint } from "@executablemd/core";
import {
  authorizedHeaders,
  denoGitHubAccess,
  member,
  nextPage,
  nonEmpty,
  readJson,
  PAGE_LIMIT,
  PAGE_SIZE,
  type GitHubAccess,
  type GitHubHttpResponse,
} from "../composition/github.ts";
import type { IssueProvider } from "../../issue/api.ts";
import { IssueProviderError, IssueUnavailableError } from "../../issue/errors.ts";
import { withinIssueCeiling } from "../../issue/target.ts";
import {
  issueAgrees,
  issueNaturalKeyJson,
  issueObservationsJson,
  issuePreStateJson,
  issueRecordResultJson,
  normalizedTags,
  parseCompleteIssueRequest,
  parseIssueInputs,
  parseIssueNaturalKey,
  parseIssuePreState,
  sameIssueIdentity,
  type CompleteIssueRequest,
  type IssueCompletion,
  type IssueInputs,
  type IssueObservation,
  type IssueSnapshot,
} from "../../issue/records.ts";

/** The discriminator this adapter answers for. */
export const GITHUB = "github";

/** One repository whose issue collection this adapter addresses. */
export interface GitHubIssueRepository {
  readonly owner: string;
  readonly repository: string;
}

/**
 * The repository this canonical target names, or `undefined` for none.
 *
 * Two spellings, because both are things a person writes: the repository
 * itself, and its issue collection. Anything else — another host, a port, an
 * extra path segment, a name GitHub would not allow — is not a target this
 * adapter acts on.
 */
export function parseGitHubIssueTarget(target: string): GitHubIssueRepository | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "") {
    return undefined;
  }
  const segments = url.pathname.replace(/^\//, "").split("/");
  const tail = segments.length === 3 ? segments[2] : undefined;
  if (segments.length === 3 && tail !== "issues") {
    return undefined;
  }
  if (segments.length !== 2 && segments.length !== 3) {
    return undefined;
  }
  const owner = segments[0] ?? "";
  const repository = segments[1] ?? "";
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!NAME.test(owner) || !NAME.test(repository)) {
    return undefined;
  }
  return Object.freeze({ owner, repository });
}

/** The one provider-visible mark saying which position an issue records. */
export function issueOriginMarker(naturalKey: unknown): string {
  const key = parseIssueNaturalKey(naturalKey);
  const digest = key === undefined ? "unreadable" : canonicalFingerprint(issueNaturalKeyJson(key));
  return `<!-- executablemd-issue: ${digest} -->`;
}

/** The body GitHub holds for this request: the description, then the marker. */
export function issueBodyFor(inputs: IssueInputs, marker: string): string {
  return `${inputs.description}\n\n${marker}\n`;
}

/** The description inside a body this adapter wrote, or the body unchanged. */
function descriptionIn(body: string, marker: string): string {
  const suffix = `\n\n${marker}\n`;
  return body.endsWith(suffix) ? body.slice(0, -suffix.length) : body;
}

/** One issue, read whole, before anything is decided about it. */
export interface GitHubIssueReading {
  readonly state: "open" | "closed";
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly assignee: string | null;
  readonly repository: string;
  readonly pullRequest: boolean;
}

function issueNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The labels this payload lists, as a normalized set. */
function labelsIn(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry : nonEmpty(member(entry, "name"));
    if (name === undefined) {
      return undefined;
    }
    names.push(name);
  }
  return normalizedTags(names);
}

/** The one assignee this payload names, or `null` when it names none. */
function assigneeIn(value: unknown): string | null | undefined {
  const listed = member(value, "assignees");
  if (!Array.isArray(listed)) {
    return undefined;
  }
  if (listed.length === 0) {
    return null;
  }
  // More than one assignee is a state this primitive cannot express, and
  // reading the first would report an issue as agreeing when it does not.
  if (listed.length > 1) {
    return undefined;
  }
  const login = nonEmpty(member(listed[0], "login"));
  return login === undefined ? undefined : login;
}

/** The issue this payload describes, or `undefined` when it describes none. */
export function readGitHubIssue(payload: unknown): GitHubIssueReading | undefined {
  const state = member(payload, "state");
  const providerId = nonEmpty(member(payload, "node_id"));
  const number = issueNumber(member(payload, "number"));
  const url = nonEmpty(member(payload, "html_url"));
  const title = nonEmpty(member(payload, "title"));
  const rawBody = member(payload, "body");
  // GitHub writes an absent body as `null`, and an absent body is an empty one.
  const body = rawBody === null ? "" : typeof rawBody === "string" ? rawBody : undefined;
  const tags = labelsIn(member(payload, "labels"));
  const assignee = assigneeIn(payload);
  const repository = nonEmpty(member(payload, "repository_url"));
  const pullRequest = member(payload, "pull_request");
  if (
    (state !== "open" && state !== "closed") ||
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    title === undefined ||
    body === undefined ||
    tags === undefined ||
    assignee === undefined ||
    repository === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    state,
    providerId,
    number,
    url,
    title,
    body,
    tags,
    assignee,
    repository,
    pullRequest: pullRequest !== undefined && pullRequest !== null,
  });
}

/** The snapshot this reading is, when it is of an open issue. */
function openSnapshot(reading: GitHubIssueReading, marker: string): IssueSnapshot | undefined {
  return reading.state === "open"
    ? Object.freeze({
        providerId: reading.providerId,
        url: reading.url,
        state: "open" as const,
        title: reading.title,
        description: descriptionIn(reading.body, marker),
        tags: reading.tags,
        assignee: reading.assignee,
      })
    : undefined;
}

export interface GitHubIssueProviderOptions {
  /**
   * The canonical targets this host authorizes, as containers.
   *
   * A request is admitted when its canonical target is one of these or sits
   * beneath one by whole path segments. Context and middleware narrow within
   * it; nothing they can express widens it.
   */
  readonly ceiling: readonly string[];
  readonly access?: GitHubAccess;
}

/**
 * The GitHub Issue provider, bound to one ceiling and one access.
 *
 * Every URL is built from the endpoint and the two parsed names; nothing a
 * response says is ever used as a place to go next except a `Link` header,
 * which is held to the endpoint's own origin before it is followed.
 */
export function gitHubIssueProvider(options: GitHubIssueProviderOptions): IssueProvider {
  const access = options.access ?? denoGitHubAccess();

  interface Admitted {
    readonly request: CompleteIssueRequest;
    readonly inputs: IssueInputs;
    readonly marker: string;
    readonly issues: string;
    readonly home: string;
  }

  /** This request, once it is one this adapter may act on at all. */
  function admit(request: CompleteIssueRequest): Admitted | undefined {
    if (request.provider !== GITHUB) {
      return undefined;
    }
    if (!withinIssueCeiling(options.ceiling, request.target)) {
      return undefined;
    }
    const name = parseGitHubIssueTarget(request.target);
    const inputs = parseIssueInputs(request.inputs);
    if (name === undefined || inputs === undefined) {
      return undefined;
    }
    const home = `${access.endpoint}/repos/${name.owner}/${name.repository}`;
    return Object.freeze({
      request,
      inputs,
      marker: issueOriginMarker(request.naturalKey),
      issues: `${home}/issues`,
      home,
    });
  }

  function here(admitted: Admitted, reading: GitHubIssueReading): boolean {
    return reading.repository.toLowerCase() === admitted.home.toLowerCase();
  }

  /** Every issue in this repository carrying this marker, or unknown. */
  function* carrying(admitted: Admitted): Operation<GitHubIssueReading[] | undefined> {
    const sent = yield* authorizedHeaders(access, false);
    if (sent === undefined) {
      return undefined;
    }
    const query = new URLSearchParams({ state: "all", per_page: String(PAGE_SIZE) });
    let url = `${admitted.issues}?${query.toString()}`;
    const candidates: GitHubIssueReading[] = [];
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      let response: GitHubHttpResponse;
      try {
        response = yield* access.send({ method: "GET", url, headers: sent });
      } catch {
        // Whatever the transport raised stays here. It is not absence, and its
        // text is a provider's to keep.
        return undefined;
      }
      if (response.status !== 200) {
        return undefined;
      }
      const listed = readJson(response.body);
      if (!Array.isArray(listed)) {
        return undefined;
      }
      for (const candidate of listed) {
        const reading = readGitHubIssue(candidate);
        if (reading === undefined) {
          return undefined;
        }
        // GitHub lists a repository's pull requests among its issues, and a
        // pull request is not an issue this element ever acts on.
        if (!reading.pullRequest && reading.body.includes(admitted.marker)) {
          candidates.push(reading);
        }
      }
      const walk = nextPage(response.link, access.endpoint);
      if (walk.kind === "complete") {
        return candidates;
      }
      if (walk.kind === "unfollowable") {
        // A next page this adapter will not follow leaves the candidate set
        // unknown. Answering with what was collected would report absence on
        // the strength of a page nobody read.
        return undefined;
      }
      url = walk.url;
    }
    // More pages than this adapter will follow is not "no more pages".
    return undefined;
  }

  /** The open issue this number names here, or nothing provable. */
  function* lookup(admitted: Admitted, number: number): Operation<IssueSnapshot | undefined> {
    const sent = yield* authorizedHeaders(access, false);
    if (sent === undefined) {
      return undefined;
    }
    let response: GitHubHttpResponse;
    try {
      response = yield* access.send({
        method: "GET",
        url: `${admitted.issues}/${number}`,
        headers: sent,
      });
    } catch {
      return undefined;
    }
    if (response.status !== 200) {
      return undefined;
    }
    const found = readGitHubIssue(readJson(response.body));
    if (
      found === undefined ||
      found.pullRequest ||
      found.number !== number ||
      !here(admitted, found)
    ) {
      return undefined;
    }
    return openSnapshot(found, admitted.marker);
  }

  function completion(admitted: Admitted, issue: IssueSnapshot): IssueCompletion {
    return {
      observations: issueObservationsJson({ issue }),
      result: issueRecordResultJson({
        provider: GITHUB,
        target: admitted.request.target,
        providerId: issue.providerId,
        url: issue.url,
      }),
    };
  }

  /**
   * A pre-state that claims nothing.
   *
   * The refusing observations publish no record — the engine journals a
   * conflict, an ambiguity and an unavailability as the effect's failed result
   * and discards everything the observation carried — so what a refusal saw has
   * no reason to be described. An issue somebody else filed is their text.
   */
  const NOTHING_PROVEN = issuePreStateJson({ issue: null });

  return {
    *observe(request): Operation<Result<IssueObservation>> {
      const admitted = admit(request);
      if (admitted === undefined) {
        // Said from observation and before any remote work: a target this
        // adapter does not act on, or one the host never authorized. The target
        // is not repeated — a refusal that quoted it would publish the thing it
        // exists to withhold.
        return Err(
          new IssueProviderError(
            "this issue adapter creates issues only in GitHub repositories the host authorized",
          ),
        );
      }

      const found = yield* carrying(admitted);
      if (found === undefined) {
        return Err(new IssueUnavailableError());
      }
      if (found.length > 1) {
        // Even if one of them looks right. Two issues carrying one position's
        // marker is a state this effect cannot name, and naming it anyway would
        // adopt one of them arbitrarily.
        return Ok({ state: "ambiguous", preState: NOTHING_PROVEN });
      }
      const only = found[0];
      if (only === undefined) {
        return Ok({ state: "absent", preState: NOTHING_PROVEN });
      }
      if (!here(admitted, only) || only.state !== "open") {
        // This position's own marker, on an issue in another repository or on
        // one somebody has closed. Neither is absence and neither is something
        // to reopen or overwrite.
        return Ok({ state: "conflict", preState: NOTHING_PROVEN });
      }
      const issue = openSnapshot(only, admitted.marker);
      if (issue === undefined) {
        return Err(new IssueUnavailableError());
      }
      if (issueAgrees(issue, admitted.inputs)) {
        const adopted = completion(admitted, issue);
        return Ok({
          state: "compatible",
          preState: issuePreStateJson({ issue }),
          observations: adopted.observations,
          result: adopted.result,
        });
      }
      // The issue is there and says something else. Absent is the shared
      // machine's word for "the requested completion is not there", and the
      // pre-state is what is there instead — which is how a performed update
      // can describe what it acted on.
      return Ok({ state: "absent", preState: issuePreStateJson({ issue }) });
    },

    *perform(request, observation): Operation<Result<IssueCompletion>> {
      const admitted = admit(request);
      if (admitted === undefined) {
        return Err(new IssueUnavailableError());
      }
      const before = parseIssuePreState(observation.preState);
      if (before === undefined) {
        return Err(new IssueUnavailableError());
      }
      return before.issue === null
        ? yield* created(admitted)
        : yield* updated(admitted, before.issue);
    },
  };

  /** One creation, and one observation if its outcome is uncertain. */
  function* created(admitted: Admitted): Operation<Result<IssueCompletion>> {
    const sent = yield* authorizedHeaders(access, true);
    if (sent === undefined) {
      return Err(new IssueUnavailableError());
    }
    let response: GitHubHttpResponse;
    try {
      response = yield* access.send({
        method: "POST",
        url: admitted.issues,
        headers: sent,
        body: JSON.stringify({
          title: admitted.inputs.title,
          body: issueBodyFor(admitted.inputs, admitted.marker),
          labels: [...admitted.inputs.tags],
          assignees: admitted.inputs.assignee === null ? [] : [admitted.inputs.assignee],
        }),
      });
    } catch {
      return Err(new IssueUnavailableError());
    }
    if (response.status === 201) {
      const reading = readGitHubIssue(readJson(response.body));
      const issue = reading === undefined ? undefined : openSnapshot(reading, admitted.marker);
      if (reading !== undefined && here(admitted, reading) && issue !== undefined) {
        if (!issueAgrees(issue, admitted.inputs)) {
          return Err(new IssueUnavailableError());
        }
        return Ok(completion(admitted, issue));
      }
    }
    // A race, a rejection, an answer this adapter cannot read: what happened is
    // decided by observing once, never by a second attempt to create.
    const found = yield* carrying(admitted);
    const only = found?.length === 1 ? found[0] : undefined;
    if (only === undefined || !here(admitted, only)) {
      return Err(new IssueUnavailableError());
    }
    const issue = openSnapshot(only, admitted.marker);
    if (issue === undefined || !issueAgrees(issue, admitted.inputs)) {
      return Err(new IssueUnavailableError());
    }
    return Ok(completion(admitted, issue));
  }

  /** The required mutations, once, and the one observation that decides. */
  function* updated(admitted: Admitted, before: IssueSnapshot): Operation<Result<IssueCompletion>> {
    const sent = yield* authorizedHeaders(access, true);
    if (sent === undefined) {
      return Err(new IssueUnavailableError());
    }
    const number = numberOf(before.url);
    if (number === undefined) {
      return Err(new IssueUnavailableError());
    }

    // Every field this element owns, in one call, at most once. What the issue
    // holds afterwards is decided by the observation below rather than by what
    // this call said.
    const fields: Record<string, unknown> = {};
    if (before.title !== admitted.inputs.title) {
      fields["title"] = admitted.inputs.title;
    }
    if (before.description !== admitted.inputs.description) {
      fields["body"] = issueBodyFor(admitted.inputs, admitted.marker);
    }
    if (!sameTags(before.tags, admitted.inputs.tags)) {
      fields["labels"] = [...admitted.inputs.tags];
    }
    if (before.assignee !== admitted.inputs.assignee) {
      fields["assignees"] = admitted.inputs.assignee === null ? [] : [admitted.inputs.assignee];
    }
    if (Object.keys(fields).length > 0) {
      try {
        yield* access.send({
          method: "PATCH",
          url: `${admitted.issues}/${number}`,
          headers: sent,
          body: JSON.stringify(fields),
        });
      } catch {
        // Held, and answered by the observation below.
      }
    }

    const observed = yield* lookup(admitted, number);
    if (observed === undefined || !issueAgrees(observed, admitted.inputs)) {
      return Err(new IssueUnavailableError());
    }
    if (!sameIssueIdentity(before, observed)) {
      return Err(new IssueUnavailableError());
    }
    return Ok(completion(admitted, observed));
  }
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/** The issue number this GitHub URL ends with, or `undefined`. */
function numberOf(url: string): number | undefined {
  const found = /\/issues\/(\d+)$/.exec(url);
  const digits = found?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export { parseCompleteIssueRequest };
