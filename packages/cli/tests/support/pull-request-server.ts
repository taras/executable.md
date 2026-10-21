/**
 * A loopback GitHub the compiled CLI can actually reach.
 *
 * The terminal evidence runs the real binary as a child process, so there is no
 * seam to inject a transport through: what the adapter talks to has to be a
 * socket. This is that socket — the pull request itself, the upsert that opens
 * one, and the three evidence collections — answering the shapes the adapter
 * parses and recording every request, so a run that performed one cannot report
 * that it restored instead.
 *
 * The pull requests it holds are mutable, because a journey that opens one has
 * to find it afterwards. A caller that seeds them reads the same list back.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { each, ensure, type Operation, resource, until, useScope } from "effection";
import { fromReadable } from "@effectionx/node";

/** One request this server received, as an assertion reads it. */
export interface ServedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

export interface PullRequestServer {
  /** The API base an operator configures. */
  readonly url: string;
  /** Every request, in order. Cleared between forks by the caller. */
  readonly requests: ServedRequest[];
  /** The pull requests this GitHub holds, including any it opened. */
  readonly pullRequests: ServedPullRequest[];
  /** The commit each branch holds, as a publication put it there. */
  readonly heads: Map<string, string>;
}

export interface ServedPullRequest {
  readonly number: number;
  readonly headSha: string;
  /** The review bodies this pull request holds. */
  reviews: readonly string[];
  /** The conversation comment bodies on its issue. */
  comments?: readonly string[];
  /** The check-run names for its head. */
  checks?: readonly string[];
  /** What the upsert asked for, once one has opened this pull request. */
  title?: string;
  body?: string | null;
  draft?: boolean;
  headRef?: string;
  baseRef?: string;
}

export interface ServerOptions {
  readonly owner?: string;
  readonly repository?: string;
  readonly token?: string;
  readonly pullRequests?: readonly ServedPullRequest[];
  /**
   * Where this GitHub reads a branch's commit when it is asked to open a pull
   * request over one.
   *
   * The real service knows because the publication put the branch there, and it
   * reads its own copy. A journey that publishes to a bare repository on disk
   * supplies the same reading of that repository, so a creation names the
   * commit that was actually published rather than one a caller asserted.
   */
  readonly resolveHead?: (branch: string) => string | undefined;
}

function review(store: Store, pull: number, index: number, body: string) {
  return {
    id: pull * 100 + index,
    user: { login: "reviewer" },
    state: "APPROVED",
    body,
    submitted_at: "2026-08-24T00:00:00Z",
    commit_id: "a".repeat(40),
    html_url: `https://github.com/${store.owner}/${store.repository}/pull/${pull}#r${index}`,
    // Absolute against this server's own origin: a subject the adapter can hold
    // the answer to is the whole API URL, not a trailing number.
    pull_request_url: `${store.origin}/repos/${store.owner}/${store.repository}/pulls/${pull}`,
  };
}

export function usePullRequestServer(options: ServerOptions = {}): Operation<PullRequestServer> {
  return resource(function* (provide) {
    const owner = options.owner ?? "octo";
    const repository = options.repository ?? "project";
    const token = options.token ?? "pull-request-server-credential";
    const served: ServedPullRequest[] = [...(options.pullRequests ?? [])];
    const requests: ServedRequest[] = [];
    const heads = new Map<string, string>();
    const resolveHead = options.resolveHead;
    let origin = "";

    // Each request body is read by a task of this server's own scope, so
    // tearing the server down ends the reads still in progress rather than
    // leaving their listeners on sockets it is about to destroy. `fromReadable`
    // is the scope-bound adapter for that: it attaches and detaches the
    // stream's own handlers with the task.
    const scope = yield* useScope();
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      scope.run(function* () {
        const chunks: Uint8Array[] = [];
        for (const chunk of yield* each(fromReadable(incoming))) {
          chunks.push(chunk);
          yield* each.next();
        }

        const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
        const authorization =
          typeof incoming.headers["authorization"] === "string"
            ? incoming.headers["authorization"]
            : undefined;
        const method = incoming.method ?? "GET";
        requests.push({ method, path: url.pathname, authorization });

        const answer = respond(
          {
            owner,
            repository,
            token,
            served,
            origin,
            heads,
            ...(resolveHead === undefined ? {} : { resolveHead }),
          },
          { method, url, body: Buffer.concat(chunks).toString("utf8") },
          authorization,
        );
        // `Connection: close` for the reason the issue tracker's server does it:
        // an idle keep-alive socket makes closing the listener wait on a
        // connection nobody is using.
        outgoing.writeHead(answer.status, {
          "content-type": "application/json",
          connection: "close",
        });
        outgoing.end(answer.body);
      });
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the pull-request server did not listen on a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
    yield* provide({ url: origin, requests, pullRequests: served, heads });
  });
}

interface Store {
  readonly owner: string;
  readonly repository: string;
  readonly token: string;
  readonly served: ServedPullRequest[];
  readonly origin: string;
  readonly heads: Map<string, string>;
  readonly resolveHead?: (branch: string) => string | undefined;
}

/** One call this GitHub was asked to answer. */
interface Asked {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
}

/** The whole payload one pull request is reported as. */
function payload(store: Store, pull: ServedPullRequest): Record<string, unknown> {
  const home = `${store.owner}/${store.repository}`;
  return {
    node_id: `PR_node_${pull.number}`,
    number: pull.number,
    html_url: `https://github.com/${home}/pull/${pull.number}`,
    state: "open",
    title: pull.title ?? "Served pull request",
    body: pull.body ?? null,
    draft: pull.draft ?? false,
    head: { ref: pull.headRef ?? "review/served", sha: pull.headSha, repo: { full_name: home } },
    base: { ref: pull.baseRef ?? "main", sha: "0".repeat(40), repo: { full_name: home } },
    user: { login: "octocat" },
  };
}

/** One conversation comment on this pull request's issue. */
function comment(store: Store, pull: number, index: number, body: string) {
  const home = `${store.owner}/${store.repository}`;
  return {
    id: pull * 1000 + index,
    user: { login: "commenter" },
    body,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    html_url: `https://github.com/${home}/pull/${pull}#c${index}`,
    // Absolute against this server's own origin, for the reason a review's is.
    issue_url: `${store.origin}/repos/${home}/issues/${pull}`,
  };
}

/** One check run for this pull request's head. */
function checkRun(headSha: string, index: number, name: string) {
  return {
    id: index + 1,
    head_sha: headSha,
    name,
    status: "completed",
    conclusion: "success",
    html_url: null,
    started_at: "2026-10-20T00:00:00Z",
    completed_at: "2026-10-20T00:01:00Z",
    output: { title: name, summary: "ok", text: null },
  };
}

function respond(
  store: Store,
  asked: Asked,
  authorization: string | undefined,
): { status: number; body: string } {
  if (authorization !== `Bearer ${store.token}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }
  const home = `${store.owner}/${store.repository}`;
  const pulls = `/repos/${home}/pulls`;

  // The collection itself: the observation a fresh upsert makes, and the
  // creation it performs when that observation proved absence.
  if (asked.url.pathname === pulls) {
    return asked.method === "POST" ? created(store, asked) : listed(store, asked.url);
  }
  // The conversation half of a comments read, which GitHub answers on the
  // issue rather than on the pull request.
  const issue = /^\/repos\/(.+)\/issues\/([1-9][0-9]*)\/comments$/.exec(asked.url.pathname);
  if (issue !== null && issue[1] === home) {
    const pull = store.served.find((entry) => String(entry.number) === issue[2]);
    return pull === undefined
      ? missing()
      : answered(
          (pull.comments ?? []).map((body, index) => comment(store, pull.number, index, body)),
        );
  }
  // The two halves of a checks read, both keyed by the head rather than by the
  // pull request.
  const checks = /^\/repos\/(.+)\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(
    asked.url.pathname,
  );
  if (checks !== null && checks[1] === home) {
    const head = checks[2] ?? "";
    const pull = store.served.find((entry) => entry.headSha === head);
    if (checks[3] === "status") {
      return answered({ sha: head, statuses: [] });
    }
    const names = pull?.checks ?? [];
    return answered({
      total_count: names.length,
      check_runs: names.map((name, index) => checkRun(head, index, name)),
    });
  }

  const prefix = `${pulls}/`;
  if (!asked.url.pathname.startsWith(prefix)) {
    return missing();
  }
  const rest = asked.url.pathname.slice(prefix.length);
  const [written, collection] = rest.split("/");
  const pull = store.served.find((entry) => String(entry.number) === written);
  if (pull === undefined) {
    return missing();
  }
  if (collection === "reviews") {
    return answered(pull.reviews.map((body, index) => review(store, pull.number, index, body)));
  }
  // The inline half of a comments read. This GitHub holds none, and an empty
  // page is a complete answer rather than an absent one.
  if (collection === "comments") {
    return answered([]);
  }
  if (collection === undefined) {
    // The three members the adapter authenticates a lookup by, plus everything
    // an adopted completion is read from.
    return answered(payload(store, pull));
  }
  return missing();
}

function answered(value: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify(value) };
}

function missing(): { status: number; body: string } {
  return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
}

/** The open pull requests matching the head and base an observation named. */
function listed(store: Store, url: URL): { status: number; body: string } {
  const head = url.searchParams.get("head") ?? "";
  const base = url.searchParams.get("base") ?? "";
  const matching = store.served.filter(
    (entry) =>
      head === `${store.owner}:${entry.headRef ?? ""}` && base === (entry.baseRef ?? "main"),
  );
  return answered(matching.map((entry) => payload(store, entry)));
}

/**
 * Open one pull request, exactly as it was asked for.
 *
 * The head commit comes from this server's own reading of the branch — put
 * there by the publication that preceded the upsert — because a pull request
 * reports the commit the host holds rather than one the request asserted.
 */
function created(store: Store, asked: Asked): { status: number; body: string } {
  const body: unknown = JSON.parse(asked.body === "" ? "{}" : asked.body);
  const read = (name: string): string | undefined => {
    const held = Reflect.get(Object(body), name);
    return typeof held === "string" ? held : undefined;
  };
  const headRef = read("head") ?? "";
  const baseRef = read("base") ?? "main";
  const headSha = store.heads.get(headRef) ?? store.resolveHead?.(headRef);
  if (headSha === undefined) {
    return { status: 422, body: JSON.stringify({ message: "no such branch" }) };
  }
  if (store.served.some((entry) => entry.headRef === headRef && entry.baseRef === baseRef)) {
    return {
      status: 422,
      body: JSON.stringify({
        message: "Validation Failed",
        errors: [{ message: "already exists" }],
      }),
    };
  }
  const written = read("body");
  const opened: ServedPullRequest = {
    number: store.served.length + 1,
    headSha,
    reviews: [],
    comments: [],
    checks: [],
    title: read("title") ?? "",
    body: written === undefined || written === "" ? null : written,
    draft: Reflect.get(Object(body), "draft") === true,
    headRef,
    baseRef,
  };
  store.served.push(opened);
  return { status: 201, body: JSON.stringify(payload(store, opened)) };
}
