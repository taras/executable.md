/**
 * The first Git-host adapter: pull requests on `github.com`, over REST.
 *
 * Everything provider-specific about `<PullRequest>` is here — which locators
 * this adapter recognizes, where the credential comes from, what is sent, and
 * how an answer becomes one of a closed set of normalized shapes. None of it is
 * reachable from a document, from public Git-host middleware or from the
 * journal: a live invocation builds one of these, holds it in the provider
 * closure §10.2 describes, and disposes it with that invocation.
 *
 * There is no provider registry and no negotiation. One adapter is selected by
 * the retained locator, and a locator this adapter does not recognize is
 * answered as an unsupported effect kind before anything is sent — which is
 * exactly what a plain Git server that supports pushing and nothing else says.
 *
 * ## What is refused before HTTP exists
 *
 * The admitted locator forms are the credential-free ones that unambiguously
 * name `github.com/<owner>/<repository>`. A local path, a `git://` or `file://`
 * URL, another host, an extra path segment, an empty owner or repository, a
 * port, a query and a fork-head spelling are all refused here, before a URL is
 * built and long before one is sent. The locator itself never leaves this
 * module: what the journal and every public surface hold is the fingerprint
 * that already named it.
 *
 * ## What an answer may become
 *
 * Four shapes, and "I could not tell" is one of them. A transport failure, a
 * rate limit, an authentication failure, a 404 that is really a permission
 * check, a page that could not be followed and a body that could not be read
 * are all *unavailable*: none of them proves that no pull request is there, and
 * treating any of them as absence is the one mistake that creates a second pull
 * request for the same branch.
 */

import { ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { tmpdir } from "node:os";
import process from "node:process";
import { runProcess } from "./subprocess.ts";
import { gitObjectId } from "../../composition/git-push-records.ts";
import type { GitObjectFormat } from "../../composition/records.ts";
import { OPEN, pullRequestNumber } from "../../composition/pull-request-records.ts";
import type {
  PullRequestInputs,
  PullRequestSnapshot,
} from "../../composition/pull-request-records.ts";

/** Where GitHub's REST API lives, when nothing substitutes one for a test. */
export const GITHUB_API = "https://api.github.com";

/** The media type and API version this adapter speaks, pinned. */
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/** How this adapter names itself. GitHub refuses a request without one. */
const USER_AGENT = "executablemd-workflow";

/** How many pages of candidates are followed before the answer is "unknown". */
export const PAGE_LIMIT = 32;

/** How many candidates a page is asked for. */
export const PAGE_SIZE = 100;

/** One repository on `github.com`, as this adapter addresses it. */
export interface GitHubRepositoryName {
  readonly owner: string;
  readonly repository: string;
}

/** One request this adapter makes, as an injectable transport receives it. */
export interface GitHubHttpRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** One answer, as this adapter reads it. */
export interface GitHubHttpResponse {
  readonly status: number;
  readonly body: string;
  /** The `Link` header, when there is one. Pagination is read from it. */
  readonly link?: string;
}

/**
 * The two host-owned things this adapter needs, and nothing else.
 *
 * Injectable so a suite can drive the whole adapter against a local server or a
 * fake without a public contextual surface existing for anyone else to install,
 * observe or route through. The default reaches the platform's own `fetch` and
 * the process environment.
 */
export interface GitHubAccess {
  /** The REST origin every request is built against. */
  readonly endpoint: string;
  /** The credential, read no earlier than the first request that needs one. */
  token(): Operation<string | undefined>;
  send(request: GitHubHttpRequest): Operation<GitHubHttpResponse>;
}

/** The GitHub repository this locator names, or `undefined` when it names none. */
export function parseGitHubRepository(locator: string): GitHubRepositoryName | undefined {
  const scpLike = /^git@github\.com:(.+)$/.exec(locator);
  if (scpLike !== null) {
    return repositoryPath(scpLike[1] ?? "");
  }
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    return undefined;
  }
  // A credential in the locator, a port, a query and a fragment each make this
  // something other than the plain name of a repository, and none of them is
  // guessed at or stripped. `git@` in an SSH URL is the one userinfo that is
  // not a credential — it is the account every SSH clone of github.com uses,
  // and it is the same thing the scp-like spelling above writes.
  const user = url.protocol === "ssh:" && url.username === "git" ? "" : url.username;
  if (
    user !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  if (url.hostname !== "github.com") {
    return undefined;
  }
  return repositoryPath(url.pathname.replace(/^\//, ""));
}

/** `owner/repository` with an optional terminal `.git`, and nothing else. */
function repositoryPath(path: string): GitHubRepositoryName | undefined {
  const segments = path.split("/");
  if (segments.length !== 2) {
    return undefined;
  }
  const owner = segments[0] ?? "";
  const repository = (segments[1] ?? "").replace(/\.git$/, "");
  // The names GitHub itself allows. Holding them to it here is also what keeps
  // a segment from being anything but one segment of the URL built below.
  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!NAME.test(owner) || !NAME.test(repository)) {
    return undefined;
  }
  return Object.freeze({ owner, repository });
}

/** The Git-host login this machine already has, asked for what it holds. */
export interface GitHubLogin {
  token(): Operation<string | undefined>;
}

/** The hostname the shipped login is asked about, fixed. */
const GITHUB_HOST = "github.com";

/**
 * The GitHub CLI's own stored credential.
 *
 * The third source, and the one that makes an already authenticated machine
 * work without a second setup: `gh auth login` is what a person on this host
 * has almost certainly already done, and asking `gh` for the token is asking
 * the same broker every other tool on that machine asks.
 *
 * It is asked about `github.com` outright rather than about whatever endpoint
 * an adapter was built with. A substituted endpoint is a test's local server,
 * and handing a real host's credential to one would be the accident this whole
 * boundary exists to prevent.
 *
 * A `gh` that is absent, unauthenticated or unreadable is no credential. None
 * of those is an error to raise: they are answers the caller already has a word
 * for, and what `gh` printed about it travels nowhere.
 */
export function denoGitHubLogin(
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): GitHubLogin {
  return {
    *token(): Operation<string | undefined> {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(ambient)) {
        if (value !== undefined) {
          env[name] = value;
        }
      }
      let outcome: { code: number; stdout: string };
      try {
        outcome = yield* runProcess({
          command: "gh",
          args: ["auth", "token", "--hostname", GITHUB_HOST],
          cwd: tmpdir(),
          env,
        });
      } catch {
        // A `gh` that is not on this machine at all.
        return undefined;
      }
      if (outcome.code !== 0) {
        return undefined;
      }
      const printed = outcome.stdout.trim();
      // One word, or nothing. A token with a space in it is not one this
      // adapter puts in a header, and anything `gh` printed around one is not
      // something to guess the shape of.
      return printed === "" || /\s/.test(printed) ? undefined : printed;
    },
  };
}

/**
 * Where a live invocation gets its access, without holding one.
 *
 * A source is credential-free and long-lived: an installed middleware or a
 * provider module may hold one for as long as it likes, because there is nothing
 * in one to retain. A *session* is what has an identity, and one is opened per
 * live invocation — after that invocation's ceiling and local authority checks
 * — and disposed with it. Two calls are two sessions, so an observation and the
 * mutation it decided go out under one identity while two unrelated invocations
 * never share one.
 */
export interface GitHubSource {
  readonly endpoint: string;
  open(): Operation<GitHubAccess>;
}

/**
 * One invocation's access over this source.
 *
 * The credential is read no earlier than the first request that needs one, and
 * then not again: every request this invocation makes carries the identity its
 * first one established. Nothing outlives the session — the next invocation
 * reads whatever the host holds then, which is what makes an interrupted attempt
 * reacquire rather than resume under an identity nobody re-proved.
 */
function accessSession(access: GitHubAccess): GitHubAccess {
  let read = false;
  let held: string | undefined;
  return {
    endpoint: access.endpoint,
    *token(): Operation<string | undefined> {
      if (!read) {
        held = yield* access.token();
        read = true;
      }
      return held;
    },
    send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      return access.send(request);
    },
  };
}

/** A source over one access, opening a session per invocation. */
export function gitHubSource(access: GitHubAccess): GitHubSource {
  return {
    endpoint: access.endpoint,
    open(): Operation<GitHubAccess> {
      return resource(function* (provide) {
        // A resource rather than a value, so the session ends with the scope
        // that opened it whether that scope returned, refused or was cancelled.
        yield* provide(accessSession(access));
      });
    },
  };
}

/** The shipped source: the platform's transport and this host's credentials. */
export function denoGitHubSource(
  endpoint: string = GITHUB_API,
  options: GitHubAccessOptions = {},
): GitHubSource {
  return gitHubSource(denoGitHubAccess(endpoint, options));
}

export interface GitHubAccessOptions {
  /** Where the two explicit variables are read from. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** The Git-host login consulted when neither variable names a credential. */
  readonly login?: GitHubLogin;
}

/**
 * The platform's own transport and environment.
 *
 * The request is aborted when the scope around it ends, so a cancelled
 * invocation tears its HTTP down rather than leaving it to finish somewhere
 * nobody is listening.
 */
export function denoGitHubAccess(
  endpoint: string = GITHUB_API,
  options: GitHubAccessOptions = {},
): GitHubAccess {
  const environment = options.environment ?? process.env;
  const login = options.login ?? denoGitHubLogin(environment);
  return {
    endpoint,
    *token(): Operation<string | undefined> {
      // Three sources, in this order. The two variables are what a caller says
      // outright, and they are answered without consulting anything else — an
      // empty one included, because a variable set to nothing is an explicit
      // "no credential" rather than an invitation to look elsewhere. Only when
      // neither is set at all is the machine's own login asked.
      const supplied = environment["GH_TOKEN"] ?? environment["GITHUB_TOKEN"];
      if (supplied !== undefined) {
        return supplied === "" ? undefined : supplied;
      }
      return yield* login.token();
    },
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      return yield* scoped(function* () {
        const controller = new AbortController();
        yield* ensure(() => controller.abort());
        const response = yield* until(
          fetch(request.url, {
            method: request.method,
            headers: { ...request.headers },
            body: request.body,
            signal: controller.signal,
          }),
        );
        const body = yield* until(response.text());
        const link = response.headers.get("link");
        return { status: response.status, body, link: link === null ? undefined : link };
      });
    },
  };
}

/**
 * The headers every authenticated call carries, or nothing when there is no
 * credential.
 *
 * The credential is read here and only here, no earlier than the first request
 * that needs one. An absent one is not an error to raise: it is a call that
 * cannot be made, which every caller already has a word for.
 */
export function* authorizedHeaders(
  access: GitHubAccess,
  json: boolean,
): Operation<Record<string, string> | undefined> {
  const token = yield* access.token();
  if (token === undefined) {
    return undefined;
  }
  return {
    Accept: ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/** What one observation of a Git host proved, from a closed set of five. */
export type GitHubObservation =
  | { readonly state: "absent" }
  | { readonly state: "found"; readonly pullRequest: PullRequestSnapshot }
  | { readonly state: "conflict" }
  | { readonly state: "ambiguous" }
  | { readonly state: "unavailable" };

/** What one mutation attempt produced, from a closed set of three. */
export type GitHubMutation =
  | { readonly state: "settled"; readonly pullRequest: PullRequestSnapshot }
  | { readonly state: "uncertain" }
  | { readonly state: "unreadable" };

const UNAVAILABLE: GitHubObservation = Object.freeze({ state: "unavailable" });
const AMBIGUOUS: GitHubObservation = Object.freeze({ state: "ambiguous" });
const CONFLICT: GitHubObservation = Object.freeze({ state: "conflict" });
const ABSENT: GitHubObservation = Object.freeze({ state: "absent" });

/**
 * Where a page walk stands, said explicitly.
 *
 * "There is no next page" and "there is a next page I will not follow" are
 * different answers, and collapsing them is how an incomplete walk becomes a
 * complete one. Only `complete` may be read as the whole candidate set.
 */
export type PageWalk =
  | { readonly kind: "complete" }
  | { readonly kind: "next"; readonly url: string }
  | { readonly kind: "unfollowable" };

const COMPLETE: PageWalk = Object.freeze({ kind: "complete" });
const UNFOLLOWABLE: PageWalk = Object.freeze({ kind: "unfollowable" });

/** The pull-request half of this adapter, bound to one repository. */
export interface GitHubPullRequests {
  /** What is there now for the resource these inputs name. */
  observe(inputs: PullRequestInputs): Operation<GitHubObservation>;
  /** Create the pull request these inputs describe. */
  create(inputs: PullRequestInputs): Operation<GitHubMutation>;
  /**
   * Bring an existing pull request to what these inputs say.
   *
   * `before` is the snapshot the observation proved, so this knows which
   * mutations are required. Each required one is issued at most once, and one
   * exact observation afterwards is what decides the outcome — never the status
   * of a mutation, which cannot say what the pull request now holds.
   */
  update(inputs: PullRequestInputs, before: PullRequestSnapshot): Operation<GitHubMutation>;
}

/**
 * The adapter for one repository, over one access.
 *
 * Every URL is built from the endpoint and the two parsed names; nothing a
 * response says is ever used as a place to go next except a `Link` header,
 * which is held to the endpoint's own origin before it is followed.
 */
export function gitHubPullRequests(
  access: GitHubAccess,
  name: GitHubRepositoryName,
  format: GitObjectFormat,
): GitHubPullRequests {
  const pulls = `${access.endpoint}/repos/${name.owner}/${name.repository}/pulls`;
  const graphql = `${access.endpoint}/graphql`;
  const full = `${name.owner}/${name.repository}`;

  function headers(json: boolean): Operation<Record<string, string> | undefined> {
    return authorizedHeaders(access, json);
  }

  /**
   * Every direct candidate the filtered listing holds, or `undefined` when the
   * set is unknown.
   *
   * Each member is read before anything is counted. A member this adapter
   * cannot read leaves the set unknown — a listing is not "one candidate" or
   * "several" until every one of them has been understood, and counting
   * unreadable members would turn a host that answered badly into an ambiguity
   * or a conflict. Readable candidates outside the supported natural key — a
   * fork head, a pull request based somewhere else — are excluded here rather
   * than counted, because they are not pull requests this adapter acts on.
   */
  function* list(
    inputs: PullRequestInputs,
    state: "open" | "all",
  ): Operation<GitHubReading[] | undefined> {
    const sent = yield* headers(false);
    if (sent === undefined) {
      return undefined;
    }
    const query = new URLSearchParams({
      state,
      head: `${name.owner}:${inputs.headBranch}`,
      base: inputs.baseBranch,
      per_page: String(PAGE_SIZE),
    });
    let url = `${pulls}?${query.toString()}`;
    const candidates: GitHubReading[] = [];
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
        const reading = readPullRequest(candidate, format);
        if (reading === undefined) {
          return undefined;
        }
        if (sameRepository(reading, full)) {
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

  /** The pull request this number names, judged against these inputs. */
  function* lookup(inputs: PullRequestInputs, number: number): Operation<GitHubObservation> {
    const sent = yield* headers(false);
    if (sent === undefined) {
      return UNAVAILABLE;
    }
    let response: GitHubHttpResponse;
    try {
      response = yield* access.send({ method: "GET", url: `${pulls}/${number}`, headers: sent });
    } catch {
      return UNAVAILABLE;
    }
    if (response.status !== 200) {
      // A 404 here is "missing, and I cannot prove it": GitHub answers one for
      // a pull request that is not there and for one this credential may not
      // see. Neither authorizes anything.
      return UNAVAILABLE;
    }
    const found = readPullRequest(readJson(response.body), format);
    if (found === undefined) {
      // Including a payload that says only that something is closed. A pull
      // request this adapter could not read is a host it could not understand,
      // and that is never a conflict — it is not an answer at all.
      return UNAVAILABLE;
    }
    if (
      found.number !== number ||
      !sameRepository(found, full) ||
      found.headBranch !== inputs.headBranch ||
      found.headSha !== inputs.headSha
    ) {
      // Another number, another repository, a fork head, a head branch this
      // element does not move, or a head commit this run did not publish. Each
      // is a conflict rather than a rewrite onto unrelated state — proven from
      // the response itself, before its state is read.
      return CONFLICT;
    }
    if (found.state === "closed") {
      // Proven to be this pull request, and no longer open. Nothing here
      // reopens one.
      return CONFLICT;
    }
    const pullRequest = openSnapshot(found);
    if (pullRequest === undefined) {
      return UNAVAILABLE;
    }
    return Object.freeze({ state: "found", pullRequest });
  }

  return {
    *observe(inputs: PullRequestInputs): Operation<GitHubObservation> {
      if (inputs.number !== null) {
        return yield* lookup(inputs, inputs.number);
      }

      const open = yield* list(inputs, OPEN);
      if (open === undefined) {
        return UNAVAILABLE;
      }
      if (open.length > 1) {
        // Even if one of them looks right. Two open pull requests for one
        // branch pair is a state this effect cannot name, and naming it anyway
        // would adopt one of them arbitrarily.
        return AMBIGUOUS;
      }
      if (open.length === 1) {
        const only = open[0];
        const pullRequest = only === undefined ? undefined : openSnapshot(only);
        return pullRequest === undefined
          ? UNAVAILABLE
          : Object.freeze({ state: "found", pullRequest });
      }
      // An empty open listing is not yet absence: a pull request this run
      // already created and somebody has since closed or merged still means
      // this branch pair has one, and creating a second would be the duplicate
      // the whole reconciliation exists to prevent.
      const every = yield* list(inputs, "all");
      if (every === undefined) {
        return UNAVAILABLE;
      }
      return every.length === 0 ? ABSENT : CONFLICT;
    },

    *create(inputs: PullRequestInputs): Operation<GitHubMutation> {
      const sent = yield* headers(true);
      if (sent === undefined) {
        return { state: "uncertain" };
      }
      let response: GitHubHttpResponse;
      try {
        response = yield* access.send({
          method: "POST",
          url: pulls,
          headers: sent,
          body: JSON.stringify({
            title: inputs.title,
            head: inputs.headBranch,
            base: inputs.baseBranch,
            body: inputs.body,
            draft: inputs.draft,
          }),
        });
      } catch {
        return { state: "uncertain" };
      }
      if (response.status !== 201) {
        // A race, a rejection and a failure this adapter has no word for are
        // the same thing here: what happened is not decided from a status, it
        // is decided by observing once more.
        return { state: "uncertain" };
      }
      const created = readPullRequest(readJson(response.body), format);
      if (created === undefined || !sameRepository(created, full)) {
        // A creation this adapter cannot read, or one naming a repository other
        // than the selected one, is not a completion it may publish.
        return { state: "unreadable" };
      }
      const pullRequest = openSnapshot(created);
      return pullRequest === undefined
        ? { state: "unreadable" }
        : { state: "settled", pullRequest };
    },

    *update(inputs: PullRequestInputs, before: PullRequestSnapshot): Operation<GitHubMutation> {
      const sent = yield* headers(true);
      if (sent === undefined) {
        return { state: "uncertain" };
      }

      // Each required mutation, at most once. A failure of one does not repeat
      // it and does not cancel the other: what the pull request holds after
      // this is decided by the observation below, not by what any call said.
      const fields: Record<string, string> = {};
      if (before.title !== inputs.title) {
        fields["title"] = inputs.title;
      }
      if (before.body !== inputs.body) {
        fields["body"] = inputs.body;
      }
      if (before.baseBranch !== inputs.baseBranch) {
        fields["base"] = inputs.baseBranch;
      }
      if (Object.keys(fields).length > 0) {
        try {
          yield* access.send({
            method: "PATCH",
            url: `${pulls}/${before.number}`,
            headers: sent,
            body: JSON.stringify(fields),
          });
        } catch {
          // Held, and answered by the observation below.
        }
      }

      if (before.draft !== inputs.draft) {
        // Draft state is not a REST field on this resource. GraphQL owns the
        // two transitions, and each is its own mutation over the node id the
        // observation already proved.
        const mutation = inputs.draft
          ? "convertPullRequestToDraft"
          : "markPullRequestReadyForReview";
        try {
          yield* access.send({
            method: "POST",
            url: graphql,
            headers: sent,
            body: JSON.stringify({
              query:
                `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) ` +
                "{ pullRequest { id } } }",
              variables: { id: before.providerId },
            }),
          });
        } catch {
          // Held, as above.
        }
      }

      // One exact observation, whatever happened. It is the only thing that can
      // say what the pull request now holds, and a partial update reaches it
      // the same way a complete one does.
      const observed = yield* lookup(inputs, before.number);
      if (observed.state !== "found") {
        return { state: "uncertain" };
      }
      return { state: "settled", pullRequest: observed.pullRequest };
    },
  };
}

export function readJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Where the page walk stands after this response.
 *
 * A `Link` header that declares a next relation this adapter cannot follow —
 * off the endpoint's own origin, or not a URL at all — leaves the walk
 * incomplete, and says so. Following it would be letting a response decide
 * where the credential goes; treating it as the end would be reporting a
 * complete candidate set nobody read.
 */
export function nextPage(link: string | undefined, endpoint: string): PageWalk {
  if (link === undefined) {
    return COMPLETE;
  }
  for (const entry of link.split(",")) {
    const found = /^\s*<([^>]+)>\s*;\s*rel\s*=\s*"?next"?\s*$/.exec(entry);
    const candidate = found?.[1];
    if (candidate === undefined) {
      continue;
    }
    try {
      const url = new URL(candidate);
      return url.href.startsWith(`${new URL(endpoint).origin}/`)
        ? Object.freeze({ kind: "next" as const, url: url.href })
        : UNFOLLOWABLE;
    } catch {
      return UNFOLLOWABLE;
    }
  }
  // No entry parsed as a next relation. A header that names one anyway is one
  // this adapter could not read, which is not the same as a walk that ended.
  return /rel\s*=\s*"?next"?/.test(link) ? UNFOLLOWABLE : COMPLETE;
}

export function member(value: unknown, name: string): unknown {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  } catch {
    return undefined;
  }
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * One pull request, read whole, before anything is decided about it.
 *
 * Every place a GitHub payload enters this adapter goes through here: a listing
 * candidate, a numbered lookup, a creation's answer and the observation that
 * closes an update. That is deliberate — the questions asked afterwards differ,
 * but a payload that cannot be read is the same answer everywhere, and a second
 * reading would be a second thing to keep exact.
 *
 * It reads the eleven facts a snapshot holds plus the two a snapshot does not:
 * which repository the head lives in, and which the base does. A number is a
 * document's own word and a listing is filtered by a name, so neither proves
 * that what came back belongs to the repository this run retained — the
 * payload's own `full_name`s are what prove it.
 *
 * State is read rather than required. A closed pull request is a fact this
 * adapter has to be able to state, and refusing to read one would report it as a
 * host that could not be understood.
 */
export interface GitHubReading {
  readonly state: "open" | "closed";
  readonly providerId: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headRepository: string;
  readonly baseRepository: string;
}

/** The pull request this payload describes, or `undefined` when it describes none. */
export function readPullRequest(
  payload: unknown,
  format: GitObjectFormat,
): GitHubReading | undefined {
  const head = member(payload, "head");
  const base = member(payload, "base");
  const state = member(payload, "state");
  const providerId = nonEmpty(member(payload, "node_id"));
  const number = pullRequestNumber(member(payload, "number"));
  const url = nonEmpty(member(payload, "html_url"));
  const title = nonEmpty(member(payload, "title"));
  const rawBody = member(payload, "body");
  // GitHub writes an absent body as `null`, and an absent body is an empty one.
  const body = rawBody === null ? "" : typeof rawBody === "string" ? rawBody : undefined;
  const draft = member(payload, "draft");
  const headBranch = nonEmpty(member(head, "ref"));
  const headSha = gitObjectId(member(head, "sha"), format);
  const baseBranch = nonEmpty(member(base, "ref"));
  const baseSha = gitObjectId(member(base, "sha"), format);
  // A deleted fork reports no repository at all, which proves nothing and so is
  // as unreadable as a missing one.
  const headRepository = nonEmpty(member(member(head, "repo"), "full_name"));
  const baseRepository = nonEmpty(member(member(base, "repo"), "full_name"));
  if (
    (state !== OPEN && state !== "closed") ||
    providerId === undefined ||
    number === undefined ||
    url === undefined ||
    title === undefined ||
    body === undefined ||
    typeof draft !== "boolean" ||
    headBranch === undefined ||
    headSha === undefined ||
    baseBranch === undefined ||
    baseSha === undefined ||
    headRepository === undefined ||
    baseRepository === undefined
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
    draft,
    headBranch,
    headSha,
    baseBranch,
    baseSha,
    headRepository,
    baseRepository,
  });
}

/** The snapshot this reading is, when it is of an open pull request. */
export function openSnapshot(reading: GitHubReading): PullRequestSnapshot | undefined {
  return reading.state === OPEN
    ? Object.freeze({
        providerId: reading.providerId,
        number: reading.number,
        url: reading.url,
        state: OPEN,
        title: reading.title,
        body: reading.body,
        draft: reading.draft,
        headBranch: reading.headBranch,
        headSha: reading.headSha,
        baseBranch: reading.baseBranch,
        baseSha: reading.baseSha,
      })
    : undefined;
}

/**
 * Whether this reading is of a pull request wholly inside one repository.
 *
 * The supported natural key is a direct, same-repository pull request. A fork
 * head and a pull request numbered somewhere else are both outside it — not
 * candidates that happen not to match, but pull requests this adapter does not
 * act on at all. GitHub compares owner and repository names without regard to
 * case, so this does too.
 */
export function sameRepository(reading: GitHubReading, full: string): boolean {
  return (
    reading.headRepository.toLowerCase() === full.toLowerCase() &&
    reading.baseRepository.toLowerCase() === full.toLowerCase()
  );
}
