/**
 * A GitHub that answers pull-request calls, without a network.
 *
 * One store, two ways to reach it. Most suites install {@link fakeGitHubAccess}
 * and drive the adapter directly, which keeps every claim deterministic and
 * lets a test count exactly how many requests were made and refuse the ones it
 * wants to fail. The crash suite needs a second process to reach the same
 * GitHub, so {@link useGitHubServer} puts the identical handler behind a real
 * `node:http` listener on an ephemeral port.
 *
 * The store is a small model of the part of GitHub this adapter uses: open and
 * closed pull requests filtered by head and base, one creation that refuses a
 * duplicate the way GitHub does, and enough pagination to prove that a partial
 * page is never read as a complete answer.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ensure, type Operation, resource, until } from "effection";
import type {
  GitHubAccess,
  GitHubHttpRequest,
  GitHubHttpResponse,
} from "../../src/deno/composition/github.ts";

/** One pull request this GitHub holds. */
export interface StoredPullRequest {
  nodeId: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** `owner/repository` the head lives in. `null` reports no repository at all. */
  headRepository?: string | null;
  /**
   * An empty SHA means "whatever that branch holds when this is read".
   *
   * A pull request seeded before the run cannot name a commit the run has not
   * made yet, and GitHub's own answer is a reading of the branch rather than a
   * value somebody stored beside it.
   */
  baseRepository?: string;
  /** Overrides the payload this pull request is reported as, member by member. */
  payload?: Record<string, unknown>;
}

/** What a suite makes this GitHub do instead of answering. */
export interface GitHubFault {
  /** Which call fails. */
  readonly on: "list" | "lookup" | "create" | "patch" | "graphql";
  /** The status to answer with, or `undefined` to fail the transport itself. */
  readonly status?: number;
  /** Answer with a body that is not the shape the adapter reads. */
  readonly malformed?: boolean;
  /** Fail only this many times, then answer normally. */
  remaining?: number;
  /**
   * Do the work and then fail the answer.
   *
   * The state an interrupted creation leaves behind: the pull request exists,
   * and this end never learned that it does.
   */
  readonly afterEffect?: boolean;
}

export interface GitHubStore {
  readonly owner: string;
  readonly repository: string;
  readonly pullRequests: StoredPullRequest[];
  /** Every request this GitHub received, in order. */
  readonly requests: GitHubHttpRequest[];
  /** The commit each branch holds, so a creation can record a base SHA. */
  readonly heads: Map<string, string>;
  /** Where a branch's commit is read from when it is not in `heads`. */
  resolveHead?: (branch: string) => string | undefined;
  /** How many candidates one page holds. Absent means one page of everything. */
  pageSize?: number;
  fault?: GitHubFault;
  /** The token every request must carry, so a suite can prove one was sent. */
  token?: string;
  /** A `Link` header this GitHub sends with every listing instead of its own. */
  link?: string;
  /** Called before each request is answered. */
  observe?: (request: GitHubHttpRequest) => void;
}

export interface GitHubStoreOptions {
  readonly owner?: string;
  readonly repository?: string;
  readonly pullRequests?: readonly StoredPullRequest[];
  readonly heads?: Readonly<Record<string, string>>;
  readonly token?: string;
}

export function gitHubStore(options: GitHubStoreOptions = {}): GitHubStore {
  return {
    owner: options.owner ?? "octo",
    repository: options.repository ?? "project",
    pullRequests: [...(options.pullRequests ?? [])],
    requests: [],
    heads: new Map(Object.entries(options.heads ?? {})),
    token: options.token ?? "test-token",
  };
}

/** The locator a document writes for this store's repository. */
export function gitHubLocator(store: GitHubStore): string {
  return `https://github.com/${store.owner}/${store.repository}`;
}

function payloadOf(store: GitHubStore, pullRequest: StoredPullRequest): Record<string, unknown> {
  const home = { full_name: `${store.owner}/${store.repository}` };
  return {
    node_id: pullRequest.nodeId,
    number: pullRequest.number,
    html_url: `https://github.com/owner/repository/pull/${pullRequest.number}`,
    state: pullRequest.state,
    title: pullRequest.title,
    body: pullRequest.body,
    draft: pullRequest.draft,
    head: {
      ref: pullRequest.headRef,
      sha: resolved(store, pullRequest.headRef, pullRequest.headSha),
      repo:
        pullRequest.headRepository === null
          ? null
          : { full_name: pullRequest.headRepository ?? home.full_name },
    },
    base: {
      ref: pullRequest.baseRef,
      sha: resolved(store, pullRequest.baseRef, pullRequest.baseSha),
      repo: { full_name: pullRequest.baseRepository ?? home.full_name },
    },
    // The members a real payload is full of, so a suite can prove none of them
    // reaches the journal, the result or a routing observation.
    user: { login: "octocat" },
    _links: { self: { href: "https://api.github.com/repos/owner/repository/pulls/1" } },
    ...pullRequest.payload,
  };
}

/** The commit this branch holds, when the stored one says to go and look. */
function resolved(store: GitHubStore, branch: string, stored: string): string {
  if (stored !== "") {
    return stored;
  }
  return store.heads.get(branch) ?? store.resolveHead?.(branch) ?? "0".repeat(40);
}

function fails(store: GitHubStore, call: GitHubFault["on"]): GitHubFault | undefined {
  const fault = store.fault;
  if (fault === undefined || fault.on !== call) {
    return undefined;
  }
  if (fault.remaining !== undefined) {
    if (fault.remaining <= 0) {
      return undefined;
    }
    fault.remaining -= 1;
  }
  return fault;
}

/** What this GitHub answers, or a thrown transport failure. */
export function respond(store: GitHubStore, request: GitHubHttpRequest): GitHubHttpResponse {
  store.requests.push(request);
  store.observe?.(request);

  const url = new URL(request.url);
  const expected = `/repos/${store.owner}/${store.repository}/pulls`;
  const numbered = url.pathname.startsWith(`${expected}/`)
    ? Number(url.pathname.slice(expected.length + 1))
    : undefined;
  if (url.pathname !== expected && numbered === undefined && url.pathname !== "/graphql") {
    return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
  }
  if (store.token !== undefined && request.headers["Authorization"] !== `Bearer ${store.token}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }

  if (url.pathname === "/graphql") {
    const fault = fails(store, "graphql");
    if (fault !== undefined) {
      return refusal(fault);
    }
    return draftMutation(store, request);
  }

  if (numbered !== undefined) {
    if (request.method === "PATCH") {
      const fault = fails(store, "patch");
      return fault === undefined ? patched(store, numbered, request) : refusal(fault);
    }
    const fault = fails(store, "lookup");
    return fault === undefined ? lookup(store, numbered) : refusal(fault);
  }

  if (request.method === "GET") {
    const fault = fails(store, "list");
    return fault === undefined ? listing(store, url) : refusal(fault);
  }

  const fault = fails(store, "create");
  if (fault === undefined) {
    return creation(store, request);
  }
  if (fault.afterEffect === true) {
    const answer = creation(store, request);
    return answer.status === 201 ? refusal(fault) : answer;
  }
  return refusal(fault);
}

/** What a faulted call answers, or the transport failing outright. */
function refusal(fault: GitHubFault): GitHubHttpResponse {
  if (fault.status === undefined) {
    throw new Error("the fake GitHub refused the connection");
  }
  return {
    status: fault.status,
    body: fault.malformed === true ? "{" : JSON.stringify({ message: "refused" }),
  };
}

/** One pull request by number, as GitHub answers it. */
function lookup(store: GitHubStore, number: number): GitHubHttpResponse {
  const found = store.pullRequests.find((pullRequest) => pullRequest.number === number);
  return found === undefined
    ? { status: 404, body: JSON.stringify({ message: "Not Found" }) }
    : { status: 200, body: JSON.stringify(payloadOf(store, found)) };
}

/** The three mutable REST fields, applied to the pull request that holds them. */
function patched(
  store: GitHubStore,
  number: number,
  request: GitHubHttpRequest,
): GitHubHttpResponse {
  const found = store.pullRequests.find((pullRequest) => pullRequest.number === number);
  if (found === undefined) {
    return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
  }
  const asked = Object(JSON.parse(request.body ?? "{}"));
  if (typeof asked.title === "string") {
    found.title = asked.title;
  }
  if (typeof asked.body === "string") {
    found.body = asked.body === "" ? null : asked.body;
  }
  if (typeof asked.base === "string") {
    found.baseRef = asked.base;
    found.baseSha = store.heads.get(asked.base) ?? store.resolveHead?.(asked.base) ?? found.baseSha;
  }
  return { status: 200, body: JSON.stringify(payloadOf(store, found)) };
}

/** The two draft transitions, which GitHub owns on GraphQL and not on REST. */
function draftMutation(store: GitHubStore, request: GitHubHttpRequest): GitHubHttpResponse {
  const asked = Object(JSON.parse(request.body ?? "{}"));
  const query = String(asked.query ?? "");
  const id = String(Object(asked.variables ?? {}).id ?? "");
  const found = store.pullRequests.find((pullRequest) => pullRequest.nodeId === id);
  if (found === undefined) {
    return { status: 200, body: JSON.stringify({ errors: [{ message: "no such id" }] }) };
  }
  if (query.includes("convertPullRequestToDraft")) {
    found.draft = true;
  } else if (query.includes("markPullRequestReadyForReview")) {
    found.draft = false;
  } else {
    return { status: 200, body: JSON.stringify({ errors: [{ message: "no such mutation" }] }) };
  }
  return {
    status: 200,
    body: JSON.stringify({ data: { pullRequest: { id } } }),
  };
}

function listing(store: GitHubStore, url: URL): GitHubHttpResponse {
  const state = url.searchParams.get("state") ?? "open";
  const head = url.searchParams.get("head") ?? "";
  const base = url.searchParams.get("base") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");

  const matching = store.pullRequests.filter(
    (pullRequest) =>
      (state === "all" || pullRequest.state === state) &&
      head === `${store.owner}:${pullRequest.headRef}` &&
      base === pullRequest.baseRef,
  );

  const size = store.pageSize ?? Math.max(matching.length, 1);
  const start = (page - 1) * size;
  const slice = matching.slice(start, start + size);
  const more = start + size < matching.length;
  const next = new URL(url.href);
  next.searchParams.set("page", String(page + 1));
  return {
    status: 200,
    body: JSON.stringify(slice.map((pullRequest) => payloadOf(store, pullRequest))),
    link: store.link ?? (more ? `<${next.href}>; rel="next"` : undefined),
  };
}

function creation(store: GitHubStore, request: GitHubHttpRequest): GitHubHttpResponse {
  const asked = Object(JSON.parse(request.body ?? "{}"));
  const headRef = String(asked.head ?? "");
  const baseRef = String(asked.base ?? "");
  const open = store.pullRequests.find(
    (pullRequest) =>
      pullRequest.state === "open" &&
      pullRequest.headRef === headRef &&
      pullRequest.baseRef === baseRef,
  );
  if (open !== undefined) {
    return {
      status: 422,
      body: JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "already exists" }],
      }),
    };
  }
  const headSha = store.heads.get(headRef) ?? store.resolveHead?.(headRef);
  if (headSha === undefined) {
    return { status: 422, body: JSON.stringify({ message: "no such branch" }) };
  }
  const number = store.pullRequests.length + 1;
  const created: StoredPullRequest = {
    nodeId: `PR_node_${number}`,
    number,
    state: "open",
    title: String(asked.title ?? ""),
    body: typeof asked.body === "string" && asked.body !== "" ? asked.body : null,
    draft: asked.draft === true,
    headRef,
    headSha,
    baseRef,
    baseSha: store.heads.get(baseRef) ?? store.resolveHead?.(baseRef) ?? "0".repeat(40),
  };
  store.pullRequests.push(created);
  return { status: 201, body: JSON.stringify(payloadOf(store, created)) };
}

/** An access that answers out of this store, with no HTTP anywhere. */
export function fakeGitHubAccess(
  store: GitHubStore,
  endpoint = "https://api.github.test",
): GitHubAccess {
  return {
    endpoint,
    // deno-lint-ignore require-yield
    *token(): Operation<string | undefined> {
      return store.token;
    },
    // deno-lint-ignore require-yield
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      return respond(store, request);
    },
  };
}

/** The requests one store received, as method and path. */
export function calls(store: GitHubStore): string[] {
  return store.requests.map((request) => `${request.method} ${new URL(request.url).search}`);
}

export function creations(store: GitHubStore): number {
  return store.requests.filter(
    (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/pulls"),
  ).length;
}

/** How many REST field updates this GitHub was asked for. */
export function patches(store: GitHubStore): number {
  return store.requests.filter((request) => request.method === "PATCH").length;
}

/** How many draft transitions this GitHub was asked for. */
export function draftMutations(store: GitHubStore): number {
  return store.requests.filter((request) => new URL(request.url).pathname === "/graphql").length;
}

/** Every mutation this GitHub received, in order, as a short word. */
export function mutations(store: GitHubStore): string[] {
  return store.requests
    .filter((request) => request.method !== "GET")
    .map((request) =>
      new URL(request.url).pathname === "/graphql"
        ? "draft"
        : request.method === "PATCH"
          ? "patch"
          : "create",
    );
}

/**
 * The same GitHub, behind a real listener another process can reach.
 *
 * `port: 0` so concurrent suites cannot share one, and every connection is
 * closed on teardown: a spare connection a client pool opened and never used
 * would otherwise keep `close()` waiting.
 */
export function useGitHubServer(store: GitHubStore): Operation<string> {
  return resource(function* (provide) {
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          headers[name === "authorization" ? "Authorization" : name] = String(value);
        }
        let answer: GitHubHttpResponse;
        try {
          answer = respond(store, {
            method:
              incoming.method === "POST" ? "POST" : incoming.method === "PATCH" ? "PATCH" : "GET",
            url: `http://localhost${incoming.url ?? "/"}`,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        } catch {
          outgoing.destroy();
          return;
        }
        outgoing.writeHead(answer.status, {
          "content-type": "application/json",
          ...(answer.link === undefined ? {} : { link: answer.link }),
        });
        outgoing.end(answer.body);
      });
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });

    const address = server.address() as AddressInfo;
    yield* provide(`http://127.0.0.1:${address.port}`);
  });
}
