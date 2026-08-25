/**
 * A loopback GitHub the compiled CLI can actually reach.
 *
 * The fork evidence runs the real binary as a child process, so there is no
 * seam to inject a transport through: what the adapter talks to has to be a
 * socket. This is that socket — the three review endpoints and the pull request
 * itself, answering the shapes the adapter parses, and recording every request
 * so a fork that performed one cannot claim it restored instead.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ensure, type Operation, resource, until } from "effection";

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
}

export interface ServedPullRequest {
  readonly number: number;
  readonly headSha: string;
  /** The review bodies this pull request holds. */
  readonly reviews: readonly string[];
}

export interface ServerOptions {
  readonly owner?: string;
  readonly repository?: string;
  readonly token?: string;
  readonly pullRequests?: readonly ServedPullRequest[];
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
    const served = options.pullRequests ?? [];
    const requests: ServedRequest[] = [];
    let origin = "";

    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      incoming.resume();
      incoming.on("end", () => {
        const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
        const authorization =
          typeof incoming.headers["authorization"] === "string"
            ? incoming.headers["authorization"]
            : undefined;
        requests.push({ method: incoming.method ?? "GET", path: url.pathname, authorization });

        const answer = respond({ owner, repository, token, served, origin }, url, authorization);
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
    yield* provide({ url: origin, requests });
  });
}

interface Store {
  readonly owner: string;
  readonly repository: string;
  readonly token: string;
  readonly served: readonly ServedPullRequest[];
  readonly origin: string;
}

function respond(
  store: Store,
  url: URL,
  authorization: string | undefined,
): { status: number; body: string } {
  if (authorization !== `Bearer ${store.token}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }
  const prefix = `/repos/${store.owner}/${store.repository}/pulls/`;
  if (!url.pathname.startsWith(prefix)) {
    return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
  }
  const rest = url.pathname.slice(prefix.length);
  const [written, collection] = rest.split("/");
  const pull = store.served.find((entry) => String(entry.number) === written);
  if (pull === undefined) {
    return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
  }
  if (collection === "reviews") {
    return {
      status: 200,
      body: JSON.stringify(
        pull.reviews.map((body, index) => review(store, pull.number, index, body)),
      ),
    };
  }
  if (collection === undefined) {
    return {
      status: 200,
      body: JSON.stringify({
        number: pull.number,
        head: { sha: pull.headSha },
        base: { repo: { full_name: `${store.owner}/${store.repository}` } },
      }),
    };
  }
  return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
}
