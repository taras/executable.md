/**
 * GitHub repository issues, as `IssueApi` middleware.
 *
 * Everything provider-specific about `<Issue>` on GitHub is here — which
 * targets this adapter recognizes, where the credential comes from, what is
 * sent, and how an answer becomes one of a closed set of normalized shapes.
 * None of it is reachable from a document or from the journal: the host
 * installs this middleware, and it holds its endpoint, its credential, its
 * ceiling and every observe/adopt/create/update decision in a closure of its
 * own. What crosses `IssueApi` is the issue's URL.
 *
 * ## Matching, and what matching commits it to
 *
 * A tracker naming no discriminator is matched by URL: this middleware acts on
 * targets it recognizes as GitHub repository issue collections and delegates
 * everything else untouched. A tracker naming `github` is this middleware's
 * whether or not the URL looks like github.com, which is what makes a
 * self-hosted deployment addressable.
 *
 * Once it matches, it answers. A target outside the ceiling, a URL it cannot
 * parse and a tracker it cannot reach are refusals — not reasons to delegate,
 * because delegating after matching is how a document that named one service
 * quietly reaches another.
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

import type { Operation } from "effection";
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
import { IssueApi } from "../../issue/api.ts";
import type {
  IssueDetails,
  IssueInput,
  IssueReference,
  IssueUpsertOptions,
} from "../../issue/api.ts";
import {
  IssueAmbiguousError,
  IssueProtocolError,
  IssueConflictError,
  IssueUnavailableError,
} from "../../issue/errors.ts";
import { withinIssueCeiling } from "../../issue/tracker.ts";
import { normalizedTags } from "../../issue/records.ts";

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
 * itself, and its issue collection. Anything else — an extra path segment, a
 * name GitHub would not allow — is not a target this adapter acts on.
 *
 * The host is deliberately not part of this. Which URLs this adapter *matches*
 * is {@link recognizesGitHubUrl}, and it is `github.com`; which URLs it can
 * *act on* once it has been named outright is this, and a self-hosted
 * deployment has the same path shape under another host name. Folding the two
 * together is what would make an explicit discriminator useless for the one
 * case it exists for.
 */
export function parseGitHubIssueTarget(target: string): GitHubIssueRepository | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
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

/**
 * The one provider-visible mark saying which attempt an issue belongs to.
 *
 * A digest of the idempotency key rather than the key itself: the key is this
 * run's own identity, and a public issue body is not where a run identifier
 * belongs. What the marker has to be is stable and not producible by accident,
 * and a digest is both.
 */
export function issueOriginMarker(idempotencyKey: string): string {
  return `<!-- executablemd-issue: ${canonicalFingerprint(idempotencyKey)} -->`;
}

/** The body GitHub holds for this request: the description, then the marker. */
export function issueBodyFor(issue: IssueInput, marker: string): string {
  return `${issue.description}\n\n${marker}\n`;
}

/** The description inside a body this adapter wrote, or the body unchanged. */
function descriptionIn(body: string, marker: string): string {
  const suffix = `\n\n${marker}\n`;
  return body.endsWith(suffix) ? body.slice(0, -suffix.length) : body;
}

/** The marker's shape, for a read that has no key to rebuild it from. */
const ANY_MARKER = /\n\n<!-- executablemd-issue: [0-9a-f]+ -->\n?$/;

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

/** One open issue, normalized away from what GitHub calls its parts. */
export interface IssueSnapshot {
  readonly providerId: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly assignee: string | null;
}

/** The snapshot this reading is, when it is of an open issue. */
export function openSnapshot(
  reading: GitHubIssueReading,
  marker: string,
): IssueSnapshot | undefined {
  return reading.state === "open"
    ? Object.freeze({
        providerId: reading.providerId,
        url: reading.url,
        title: reading.title,
        description: descriptionIn(reading.body, marker),
        tags: reading.tags,
        assignee: reading.assignee,
      })
    : undefined;
}

/** One issue this middleware settled on, before it becomes a URL. */
interface Settled {
  readonly url: string;
}

/**
 * Whether this is a URL this adapter recognizes without being told.
 *
 * The public service, and only it. A tracker naming `github` reaches this
 * middleware whatever its host, which is how a self-hosted deployment is
 * addressed; a tracker naming nothing reaches it only for the host nobody has
 * to be told about.
 */
export function recognizesGitHubUrl(target: string): boolean {
  try {
    return new URL(target).hostname === "github.com";
  } catch {
    return false;
  }
}

export interface GitHubIssuesOptions {
  /**
   * The canonical targets this host authorizes, as containers.
   *
   * A request is admitted when its canonical target is one of these or sits
   * beneath one by whole path segments. A tracker narrows within it; nothing a
   * document can write widens it.
   */
  readonly ceiling: readonly string[];
  readonly access?: GitHubAccess;
}

/**
 * Install GitHub issue handling for the current scope and below.
 *
 * Ordinary middleware: it looks at the destination, handles the ones that are
 * its own, and delegates the rest untouched. Installing a second adapter beside
 * it needs no coordination between them, and installing none leaves
 * `IssueApi`'s own base error to report that nothing handled the request.
 */
export function* useGitHubIssues(options: GitHubIssuesOptions): Operation<void> {
  const access = options.access ?? denoGitHubAccess();

  yield* IssueApi.around(
    {
      *read([url, read], next): Operation<IssueDetails> {
        const issue = parseGitHubIssueUrl(url);
        // Matched by discriminator, or — with no discriminator — by URL.
        const mine =
          read.provider === undefined ? recognizesGitHubUrl(url) : read.provider === GITHUB;
        if (!mine) {
          return yield* next(url, read);
        }
        // From here this middleware owns the answer, and the ceiling is asked
        // before anything is built: a URL a document wrote is not a place this
        // host authorized until the ceiling says so.
        if (!withinIssueCeiling(options.ceiling, url)) {
          throw new IssueUnavailableError();
        }
        if (issue === undefined) {
          throw new IssueUnavailableError();
        }
        return yield* observed(access, issue, url);
      },

      *upsert([issue, upsert], next): Operation<IssueReference> {
        // Matched by discriminator, or — with no discriminator — by URL.
        const mine =
          upsert.provider === undefined
            ? recognizesGitHubUrl(upsert.url)
            : upsert.provider === GITHUB;
        if (!mine) {
          return yield* next(issue, upsert);
        }
        // From here this middleware owns the answer. A refusal is the end of
        // the request rather than a reason to let somebody else try.
        if (!withinIssueCeiling(options.ceiling, upsert.url)) {
          throw new IssueUnavailableError();
        }
        // Named outright but not a repository issue collection: this adapter
        // owns the answer, and the answer is that it cannot act on that URL.
        const name = parseGitHubIssueTarget(upsert.url);
        if (name === undefined) {
          throw new IssueUnavailableError();
        }
        return yield* reconcile(access, name, issue, upsert);
      },
    },
    { at: "min" },
  );
}

/**
 * Observe, then decide once.
 *
 * The whole of what this adapter knows about not creating an issue twice. One
 * attempt observes before it mutates; proven absence creates once, a proven
 * compatible issue is adopted, an issue that has moved is brought back with one
 * update and one confirming read, and everything else refuses. Nothing here
 * loops: a second attempt is something the document asks for, starting again at
 * observation.
 */
function* reconcile(
  access: GitHubAccess,
  name: GitHubIssueRepository,
  issue: IssueInput,
  upsert: IssueUpsertOptions,
): Operation<Settled> {
  const marker = issueOriginMarker(upsert.idempotencyKey);
  const home = `${access.endpoint}/repos/${name.owner}/${name.repository}`;
  const issues = `${home}/issues`;

  const found = yield* carrying(access, issues, marker);
  if (found === undefined) {
    throw new IssueUnavailableError();
  }
  if (found.length > 1) {
    // Even if one of them looks right. Two issues carrying one key's marker is
    // a state this request cannot name, and naming it anyway would adopt one
    // of them arbitrarily.
    throw new IssueAmbiguousError();
  }
  const only = found[0];
  if (only === undefined) {
    return yield* created(access, issues, home, issue, marker);
  }
  if (only.repository.toLowerCase() !== home.toLowerCase() || only.state !== "open") {
    // This key's own marker, on an issue in another repository or on one
    // somebody has closed. Neither is absence, and neither is something to
    // reopen or overwrite.
    throw new IssueConflictError();
  }
  const snapshot = openSnapshot(only, marker);
  if (snapshot === undefined) {
    throw new IssueUnavailableError();
  }
  return agrees(snapshot, issue)
    ? { url: snapshot.url }
    : yield* updated(access, issues, home, issue, marker, only.number, snapshot);
}

/** Whether this issue already says what the request asks for. */
function agrees(snapshot: IssueSnapshot, issue: IssueInput): boolean {
  return (
    snapshot.title === issue.title &&
    snapshot.description === issue.description &&
    snapshot.assignee === issue.assignee &&
    snapshot.tags.length === issue.tags.length &&
    snapshot.tags.every((tag, index) => tag === issue.tags[index])
  );
}

/** Every issue in this repository carrying this marker, or unknown. */
function* carrying(
  access: GitHubAccess,
  issues: string,
  marker: string,
): Operation<GitHubIssueReading[] | undefined> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return undefined;
  }
  const query = new URLSearchParams({ state: "all", per_page: String(PAGE_SIZE) });
  let url = `${issues}?${query.toString()}`;
  const candidates: GitHubIssueReading[] = [];
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    let response: GitHubHttpResponse;
    try {
      response = yield* access.send({ method: "GET", url, headers: sent });
    } catch {
      // Whatever the transport raised stays here. It is not absence, and its
      // text is this middleware's to keep.
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
      // GitHub lists a repository's pull requests among its issues, and a pull
      // request is not an issue this element ever acts on.
      if (!reading.pullRequest && reading.body.includes(marker)) {
        candidates.push(reading);
      }
    }
    const walk = nextPage(response.link, access.endpoint);
    if (walk.kind === "complete") {
      return candidates;
    }
    if (walk.kind === "unfollowable") {
      // A next page this adapter will not follow leaves the candidate set
      // unknown. Answering with what was collected would report absence on the
      // strength of a page nobody read.
      return undefined;
    }
    url = walk.url;
  }
  // More pages than this adapter will follow is not "no more pages".
  return undefined;
}

/** One creation, and one observation if its outcome is uncertain. */
function* created(
  access: GitHubAccess,
  issues: string,
  home: string,
  issue: IssueInput,
  marker: string,
): Operation<Settled> {
  const sent = yield* authorizedHeaders(access, true);
  if (sent === undefined) {
    throw new IssueUnavailableError();
  }
  let response: GitHubHttpResponse;
  try {
    response = yield* access.send({
      method: "POST",
      url: issues,
      headers: sent,
      body: JSON.stringify({
        title: issue.title,
        body: issueBodyFor(issue, marker),
        labels: [...issue.tags],
        assignees: issue.assignee === null ? [] : [issue.assignee],
      }),
    });
  } catch {
    throw new IssueUnavailableError();
  }
  if (response.status === 201) {
    const reading = readGitHubIssue(readJson(response.body));
    const snapshot = reading === undefined ? undefined : openSnapshot(reading, marker);
    if (
      reading !== undefined &&
      snapshot !== undefined &&
      reading.repository.toLowerCase() === home.toLowerCase() &&
      agrees(snapshot, issue)
    ) {
      return { url: snapshot.url };
    }
  }
  // A race, a rejection, an answer this adapter cannot read: what happened is
  // decided by observing once, never by a second attempt to create.
  const found = yield* carrying(access, issues, marker);
  const only = found?.length === 1 ? found[0] : undefined;
  if (only === undefined || only.repository.toLowerCase() !== home.toLowerCase()) {
    throw new IssueUnavailableError();
  }
  const snapshot = openSnapshot(only, marker);
  if (snapshot === undefined || !agrees(snapshot, issue)) {
    throw new IssueUnavailableError();
  }
  return { url: snapshot.url };
}

/** The required mutations, once, and the one observation that decides. */
function* updated(
  access: GitHubAccess,
  issues: string,
  home: string,
  issue: IssueInput,
  marker: string,
  number: number,
  before: IssueSnapshot,
): Operation<Settled> {
  const sent = yield* authorizedHeaders(access, true);
  if (sent === undefined) {
    throw new IssueUnavailableError();
  }

  // Every field this element owns, in one call, at most once. What the issue
  // holds afterwards is decided by the observation below rather than by what
  // this call said.
  const fields: Record<string, unknown> = {};
  if (before.title !== issue.title) {
    fields["title"] = issue.title;
  }
  if (before.description !== issue.description) {
    fields["body"] = issueBodyFor(issue, marker);
  }
  if (!sameTags(before.tags, issue.tags)) {
    fields["labels"] = [...issue.tags];
  }
  if (before.assignee !== issue.assignee) {
    fields["assignees"] = issue.assignee === null ? [] : [issue.assignee];
  }
  if (Object.keys(fields).length > 0) {
    try {
      yield* access.send({
        method: "PATCH",
        url: `${issues}/${number}`,
        headers: sent,
        body: JSON.stringify(fields),
      });
    } catch {
      // Held, and answered by the observation below.
    }
  }

  const observed = yield* lookup(access, issues, home, marker, number);
  if (observed === undefined || !agrees(observed, issue)) {
    throw new IssueUnavailableError();
  }
  if (observed.providerId !== before.providerId) {
    throw new IssueUnavailableError();
  }
  return { url: observed.url };
}

/** The open issue this number names here, or nothing provable. */
function* lookup(
  access: GitHubAccess,
  issues: string,
  home: string,
  marker: string,
  number: number,
): Operation<IssueSnapshot | undefined> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    return undefined;
  }
  let response: GitHubHttpResponse;
  try {
    response = yield* access.send({ method: "GET", url: `${issues}/${number}`, headers: sent });
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
    found.repository.toLowerCase() !== home.toLowerCase()
  ) {
    return undefined;
  }
  return openSnapshot(found, marker);
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/** One issue on GitHub, as a URL addresses it. */
export interface GitHubIssueLocation {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * The issue this canonical URL names, or `undefined` for none.
 *
 * `…/{owner}/{repository}/issues/{number}`, and the host is deliberately not
 * part of it for the same reason it is not part of a target: which URLs this
 * adapter recognizes unasked is {@link recognizesGitHubUrl}, and a self-hosted
 * deployment has the same path shape under another host name.
 */
export function parseGitHubIssueUrl(url: string): GitHubIssueLocation | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") {
    return undefined;
  }
  const segments = parsed.pathname.replace(/^\//, "").split("/");
  if (segments.length !== 4 || segments[2] !== "issues") {
    return undefined;
  }
  const owner = segments[0] ?? "";
  const repository = segments[1] ?? "";
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!NAME.test(owner) || !NAME.test(repository)) {
    return undefined;
  }
  const digits = segments[3] ?? "";
  if (!/^[1-9][0-9]*$/.test(digits)) {
    return undefined;
  }
  const number = Number(digits);
  return Number.isSafeInteger(number) ? Object.freeze({ owner, repository, number }) : undefined;
}

/**
 * One authenticated read, and the fields every provider has.
 *
 * A closed issue reads exactly like an open one: reading is not reconciling,
 * and refusing to report a closed issue would be inventing a state the document
 * did not ask about. A pull request is refused, though — GitHub answers for one
 * through the same Issues endpoint, and reporting it as an issue would let a
 * document read a pull request's body as an issue description.
 *
 * The requested URL is the identity of the read, and it stays the identity of
 * the answer. What comes back is checked against what was asked for, and what
 * is published is the URL the document wrote — never one the response supplied.
 * Otherwise a service that answered with a different issue would decide what a
 * document read, and the answer would be retained under the requested URL while
 * describing something else. The ceiling was admitted against the requested URL
 * too, so a response cannot reach past it by naming somewhere else.
 */
function* observed(
  access: GitHubAccess,
  issue: GitHubIssueLocation,
  requested: string,
): Operation<IssueDetails> {
  const sent = yield* authorizedHeaders(access, false);
  if (sent === undefined) {
    throw new IssueUnavailableError();
  }
  const url = `${access.endpoint}/repos/${issue.owner}/${issue.repository}/issues/${issue.number}`;
  let response: GitHubHttpResponse;
  try {
    response = yield* access.send({ method: "GET", url, headers: sent });
  } catch {
    // Whatever the transport raised stays here. A 404 is the same answer: it is
    // what GitHub says for an issue that is not there and for one this
    // credential may not see, and neither authorizes reading anything.
    throw new IssueUnavailableError();
  }
  if (response.status !== 200) {
    throw new IssueUnavailableError();
  }
  const reading = readGitHubIssue(readJson(response.body));
  if (reading === undefined) {
    throw new IssueUnavailableError();
  }
  if (reading.pullRequest) {
    throw new IssueConflictError();
  }
  // The same identity check the upsert lookup makes, for the same reason: a
  // well-formed payload for another issue is well-formed, and shape alone
  // cannot tell it from the one that was asked for.
  const home = `${access.endpoint}/repos/${issue.owner}/${issue.repository}`;
  if (reading.number !== issue.number || reading.repository.toLowerCase() !== home.toLowerCase()) {
    throw new IssueProtocolError(
      "the issue tracker answered a read with a different issue than the one requested",
    );
  }
  return Object.freeze({
    url: requested,
    title: reading.title,
    // Any marker this adapter wrote is its own bookkeeping and not something a
    // document asked to read, so it comes off whichever attempt put it there.
    description: withoutMarker(reading.body),
    tags: reading.tags,
    assignee: reading.assignee,
  });
}

/** The body with any origin marker this adapter wrote removed. */
function withoutMarker(body: string): string {
  return body.replace(ANY_MARKER, "");
}
