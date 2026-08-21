/**
 * A Git remote that demands a credential, on a loopback port.
 *
 * The evidence boundary for ambient authentication says no test may read a
 * developer's real credential or contact a live remote — but it also has to
 * prove that a borrowed credential actually reaches a transport and is actually
 * accepted, which no injected seam can show. This is how both hold: `git
 * http-backend` is Git's own server, run behind a listener that answers `401`
 * until the exact `Basic` credential this fixture invented arrives.
 *
 * Everything about how the provider asks — that a helper was consulted, what it
 * was consulted about, and how the answer reached Git — stays the provider's.
 * This end only decides whether what arrived was right, and records what came.
 */

import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import process from "node:process";
import { ensure, type Operation, resource, until } from "effection";
import { git, type BareRemote } from "./git-remotes.ts";

/** One request this remote received, as a suite asserts on it. */
export interface ServedGitRequest {
  readonly method: string;
  readonly path: string;
  /** Whether an `Authorization` header arrived at all. */
  readonly credentialed: boolean;
  /**
   * Whether it was the exact credential this remote requires.
   *
   * A boolean rather than the header. What a suite needs to know is whether the
   * borrowed identity was the right one, and putting the value in a test's
   * assertions would be putting a credential in the one place this whole
   * contract says it must not travel.
   */
  readonly accepted: boolean;
}

export interface GitHttpRemote {
  /** The credential-free locator a document writes as `url`. */
  readonly locator: string;
  /** The host and port, as a credential helper is asked about them. */
  readonly host: string;
  /** What this remote is called where a credential may not be named. */
  readonly label: string;
  readonly requests: ServedGitRequest[];
}

export interface GitHttpOptions {
  readonly remote: BareRemote;
  readonly username: string;
  readonly password: string;
  /**
   * How this remote names itself to a credential helper.
   *
   * Two remotes in one suite have to be distinguishable without either one's
   * credential appearing in an assertion, and a helper is asked about a host.
   * The label is what a fixture helper matches on and what a failure message
   * says instead of a secret.
   */
  readonly label?: string;
  /**
   * Held open after a request has been accepted, and never answered.
   *
   * The moment a cancellation test needs: authentication has been proven to the
   * remote and the transport is live, so what a halt has to tear down is a real
   * Git child with a real connection open to a server that will not reply.
   */
  readonly hold?: (request: ServedGitRequest) => boolean;
}

/** Where Git keeps `git-http-backend`, asked of Git rather than guessed. */
function backendProgram(): string {
  const found = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (found.status !== 0) {
    throw new Error("git --exec-path did not answer");
  }
  return `${found.stdout.trim()}/git-http-backend`;
}

/**
 * The CGI environment one request becomes.
 *
 * Global and system configuration are off here for the same reason they are off
 * in the provider: what this fixture serves must not depend on whose machine
 * the suite is running on.
 */
function cgiEnvironment(
  incoming: IncomingMessage,
  root: string,
  user: string,
): Record<string, string> {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  const type = incoming.headers["content-type"];
  const encoding = incoming.headers["content-encoding"];
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: incoming.method ?? "GET",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ""),
    ...(typeof type === "string" ? { CONTENT_TYPE: type } : {}),
    ...(typeof encoding === "string" ? { HTTP_CONTENT_ENCODING: encoding } : {}),
    REMOTE_USER: user,
    REMOTE_ADDR: "127.0.0.1",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
}

/** Where the CGI header block ends, in either spelling of a blank line. */
function headerEnd(buffered: Buffer): { at: number; width: number } | undefined {
  const carriage = buffered.indexOf("\r\n\r\n");
  const plain = buffered.indexOf("\n\n");
  if (carriage >= 0 && (plain < 0 || carriage < plain)) {
    return { at: carriage, width: 4 };
  }
  return plain < 0 ? undefined : { at: plain, width: 2 };
}

/** Hand one request to `git-http-backend` and its answer back to the client. */
function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  backend: string,
  root: string,
  user: string,
): void {
  const child = spawn(backend, [], {
    env: cgiEnvironment(incoming, root, user),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A client that hung up mid-body closes this pipe under the backend. It is
  // the client's answer rather than a fault of this fixture's, and an unhandled
  // stream error here would take the whole suite process down.
  child.stdin.on("error", () => {});
  incoming.pipe(child.stdin);

  let buffered = Buffer.alloc(0);
  let started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (started) {
      outgoing.write(chunk);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const end = headerEnd(buffered);
    if (end === undefined) {
      return;
    }
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of buffered.subarray(0, end.at).toString("utf8").split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 0) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === "status") {
        status = Number.parseInt(value, 10) || 200;
      } else {
        headers[name] = value;
      }
    }
    outgoing.writeHead(status, headers);
    started = true;
    const rest = buffered.subarray(end.at + end.width);
    if (rest.length > 0) {
      outgoing.write(rest);
    }
  });
  child.stdout.on("end", () => {
    if (!started) {
      outgoing.writeHead(500);
    }
    outgoing.end();
  });
  child.on("error", () => {
    if (!started) {
      outgoing.writeHead(500);
      started = true;
    }
    outgoing.end();
  });
}

/**
 * Serve one bare remote over authenticated HTTP for the acquiring scope.
 *
 * `http.receivepack` is turned on in the served repository, since a bare
 * repository refuses a push over HTTP without it and this fixture exists to
 * prove that a push arrives.
 */
export function useGitHttpRemote(options: GitHttpOptions): Operation<GitHttpRemote> {
  return resource<GitHttpRemote>(function* (provide) {
    const bare = options.remote.locator;
    const root = dirname(bare);
    const name = bare.slice(root.length + 1);
    git(["config", "http.receivepack", "true"], bare, root);

    const backend = backendProgram();
    const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString(
      "base64",
    )}`;
    const requests: ServedGitRequest[] = [];

    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const header = incoming.headers.authorization;
      const accepted = header === expected;
      requests.push({
        method: incoming.method ?? "GET",
        path: url.pathname,
        credentialed: header !== undefined,
        accepted,
      });
      if (!accepted) {
        // The challenge is what makes Git ask a helper rather than give up, so
        // an unauthenticated first request is part of the ordinary exchange
        // rather than a failure this fixture is arranging.
        outgoing.writeHead(401, { "WWW-Authenticate": 'Basic realm="xmd"' });
        outgoing.end();
        // Drained, so the client is not left writing into a request nobody is
        // reading.
        incoming.resume();
        return;
      }
      if (options.hold?.(requests[requests.length - 1] as ServedGitRequest) === true) {
        // Accepted, and then nothing. The socket stays open, so the client is
        // waiting on this end rather than on a refusal.
        incoming.resume();
        return;
      }
      serve(incoming, outgoing, backend, root, options.username);
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });

    // Narrowed rather than asserted: `address()` answers `null` before the
    // listen completes and a string for a unix socket, and a suite that built
    // its locator out of either would fail somewhere far from here.
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the remote did not listen on a TCP port");
    }
    const host = `127.0.0.1:${address.port}`;
    yield* provide({
      locator: `http://${host}/${name}`,
      host,
      label: options.label ?? name,
      requests,
    });
  });
}
