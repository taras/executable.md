/**
 * A GitHub, behind a real loopback listener.
 *
 * This exists so at least one scenario drives the shipped adapter over the
 * platform's own asynchronous `fetch` — `denoGitHubAccess(url)` — rather than
 * over an injected transport. What a substituted `send()` cannot show is that
 * the adapter builds a real request: a method, a path, an `Authorization`
 * header and a JSON body that a server actually received.
 *
 * The store is a small model of the part of the API the adapter uses. It is
 * deliberately not a mock of the adapter: it answers HTTP, and everything about
 * how the adapter asks is the adapter's own.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ensure, type Operation, resource, until } from "effection";

/**
 * The credential this tracker requires, held here and never in a document.
 *
 * A document that wrote one would be refused by this repository's own secret
 * gate before it ran, which is the gate working rather than a gap. A scenario
 * proves a credential was carried by asserting on the header shape.
 */
export function credential(): string {
  return "loopback-credential";
}

/**
 * What a scenario says about the credential it carries, without saying what it
 * is.
 *
 * A document names a condition; the host turns that name into a token and keeps
 * it. Two of these are the interesting ones — a request that carries the right
 * credential, and one that carries the wrong credential — and neither needs the
 * value to appear in a document, in its rendered output, or in a journal.
 */
export type CredentialCondition = "valid" | "invalid" | "absent";

/** The token a named condition carries. Host-side only. */
export function credentialFor(condition: CredentialCondition): string | undefined {
  if (condition === "valid") {
    return credential();
  }
  if (condition === "invalid") {
    return "a-credential-this-tracker-does-not-accept";
  }
  return undefined;
}

/** One issue this tracker holds. */
export interface ServedIssue {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  labels: string[];
  assignee: string | null;
  /** Present when this entry is a pull request, as GitHub reports one. */
  pullRequest?: boolean;
  /** The repository it reports belonging to, when not this server's. */
  repository?: string;
}

/** One request this tracker received, as a scenario asserts on it. */
export interface ServedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface IssueTrackerServer {
  readonly url: string;
  readonly owner: string;
  readonly repository: string;
  readonly issues: ServedIssue[];
  readonly requests: ServedRequest[];
}

export interface ServerOptions {
  readonly owner?: string;
  readonly repository?: string;
  readonly issues?: readonly ServedIssue[];
  /** The credential every request must carry, so a scenario can prove one was. */
  readonly token?: string;
}

/**
 * A tracker listening on an ephemeral port for as long as the scope runs.
 *
 * `port: 0` so concurrent suites cannot share one, and every connection is
 * closed on teardown: a spare connection a client pool opened and never used
 * would otherwise keep `close()` waiting.
 */
export function useIssueTrackerServer(options: ServerOptions = {}): Operation<IssueTrackerServer> {
  return resource(function* (provide) {
    const owner = options.owner ?? "octo";
    const repository = options.repository ?? "project";
    const token = options.token ?? credential();
    const issues: ServedIssue[] = [...(options.issues ?? [])];
    const requests: ServedRequest[] = [];
    let origin = "";

    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = new URL(incoming.url ?? "/", origin);
        let body: unknown;
        try {
          body = raw === "" ? undefined : JSON.parse(raw);
        } catch {
          body = raw;
        }
        requests.push({
          method: incoming.method ?? "GET",
          path: url.pathname,
          authorization:
            typeof incoming.headers["authorization"] === "string"
              ? incoming.headers["authorization"]
              : undefined,
          body,
        });
        const answer = respond({ owner, repository, issues, token, origin }, incoming, url, body);
        // `Connection: close` on every answer, because `fetch` otherwise keeps
        // an idle keep-alive socket the client never reuses, and closing the
        // listener then waits on a connection nobody is using.
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

    // Narrowed rather than asserted: `address()` answers `null` before the
    // listen completes and a string for a unix socket, and a scenario that
    // built its endpoint out of either would fail somewhere far from here.
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the tracker did not listen on a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
    yield* provide({ url: origin, owner, repository, issues, requests });
  });
}

interface Store {
  readonly owner: string;
  readonly repository: string;
  readonly issues: ServedIssue[];
  readonly token: string;
  readonly origin: string;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

function payload(store: Store, issue: ServedIssue): Record<string, unknown> {
  return {
    node_id: `I_node_${issue.number}`,
    number: issue.number,
    html_url: `https://github.com/${store.owner}/${store.repository}/issues/${issue.number}`,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    repository_url: issue.repository ?? `${store.origin}/repos/${store.owner}/${store.repository}`,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignee === null ? [] : [{ login: issue.assignee }],
    ...(issue.pullRequest === true ? { pull_request: { url: "…" } } : {}),
  };
}

function respond(store: Store, incoming: IncomingMessage, url: URL, body: unknown): Answer {
  const issues = `/repos/${store.owner}/${store.repository}/issues`;
  if (incoming.headers["authorization"] !== `Bearer ${store.token}`) {
    return { status: 401, body: JSON.stringify({ message: "Bad credentials" }) };
  }
  const numbered = url.pathname.startsWith(`${issues}/`)
    ? Number(url.pathname.slice(issues.length + 1))
    : undefined;

  if (numbered !== undefined) {
    const found = store.issues.find((issue) => issue.number === numbered);
    if (found === undefined) {
      return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
    }
    if (incoming.method === "PATCH") {
      const asked = Object(body);
      if (typeof asked.title === "string") {
        found.title = asked.title;
      }
      if (typeof asked.body === "string") {
        found.body = asked.body;
      }
      if (Array.isArray(asked.labels)) {
        found.labels = asked.labels.map((label: unknown) => String(label));
      }
      if (Array.isArray(asked.assignees)) {
        const [first] = asked.assignees;
        found.assignee = first === undefined ? null : String(first);
      }
    }
    return { status: 200, body: JSON.stringify(payload(store, found)) };
  }

  if (url.pathname !== issues) {
    return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
  }
  if (incoming.method === "POST") {
    const asked = Object(body);
    const created: ServedIssue = {
      number: store.issues.length + 1,
      state: "open",
      title: String(asked.title ?? ""),
      body: typeof asked.body === "string" ? asked.body : null,
      labels: Array.isArray(asked.labels) ? asked.labels.map((l: unknown) => String(l)) : [],
      assignee:
        Array.isArray(asked.assignees) && asked.assignees.length > 0
          ? String(asked.assignees[0])
          : null,
    };
    store.issues.push(created);
    return { status: 201, body: JSON.stringify(payload(store, created)) };
  }
  return {
    status: 200,
    body: JSON.stringify(store.issues.map((issue) => payload(store, issue))),
  };
}
