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
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import process from "node:process";
import {
  ensure,
  type Operation,
  resource,
  scoped,
  until,
  useScope,
  withResolvers,
} from "effection";
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
  /** The locator of the second repository, when one is served. */
  readonly alsoLocator: string;
  /** The host and port, as a credential helper is asked about them. */
  readonly host: string;
  /** What this remote is called where a credential may not be named. */
  readonly label: string;
  readonly requests: ServedGitRequest[];
}

/** A second repository on the same server, protected by its own credential. */
export interface AlsoServed {
  readonly remote: BareRemote;
  readonly username: string;
  readonly password: string;
}

export interface GitHttpOptions {
  readonly remote: BareRemote;
  readonly username: string;
  readonly password: string;
  /**
   * Another repository, served from this same host and port.
   *
   * What makes "one locator's authentication cannot authorize another"
   * observable end to end: two paths on one server, each demanding a different
   * credential, so what separates them is the whole locator rather than a host.
   */
  readonly also?: AlsoServed;
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
  /**
   * Where an accepted request is sent instead of being served.
   *
   * A redirect is the case where Git ends up somewhere the invocation was never
   * authorized for. The credential is accepted here first, so what the second
   * target receives is decided by the provider's helper rather than by this
   * server having refused anything.
   */
  readonly redirect?: (request: ServedGitRequest) => string | undefined;
  /**
   * Called when a held authenticated connection closes.
   *
   * The only thing this end can say about a cancellation: the client that had
   * authenticated and was waiting is gone. Nonsecret and argument-free — it
   * reports that the transport ended, never what was on it — and it is what
   * lets a suite place the transport's end in the same sequence as the
   * authentication cleanup that must follow it.
   */
  readonly closed?: () => void;
  /**
   * Handed every backend child as it is spawned.
   *
   * Package-private, for the cancellation regression: the listeners this
   * fixture installs are on a process it owns and does not otherwise hand out,
   * and their release is the thing under test.
   */
  readonly observeBackend?: (child: ChildProcess) => void;
  /**
   * Run inside the request task, after the backend's cleanup is registered and
   * before its input is forwarded.
   *
   * Package-private, for the cancellation regression: a backend is only
   * observable while its request is still running, and this is what holds one
   * there.
   */
  readonly holdBackend?: () => Operation<void>;
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
  segment: string,
  directory: string,
): Record<string, string> {
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  // The path a document writes need not be the directory name on disk: two
  // fixtures both build `remote.git`, and telling them apart is the point.
  const pathInfo = url.pathname.replace(`/${segment}`, `/${directory}`);
  const type = incoming.headers["content-type"];
  const encoding = incoming.headers["content-encoding"];
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: incoming.method ?? "GET",
    PATH_INFO: pathInfo,
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

/**
 * Hand one request to `git-http-backend` and its answer back to the client, as
 * a task of the server's own scope.
 *
 * The backend is a child process with four listeners on it, and both belong to
 * this request rather than to the fixture: cancelling the server ends the
 * request, which kills the backend, waits for it to be gone, and detaches
 * every handler synchronously afterwards. A request that simply finishes takes
 * the same path.
 */
function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  backend: string,
  root: string,
  user: string,
  segment: string,
  directory: string,
  observe?: (child: ChildProcess) => void,
  hold?: () => Operation<void>,
): Operation<void> {
  return scoped(function* () {
    // Declared before the cleanup below and assigned after it: a backend that
    // exists before its release is registered can be stranded, because `yield*
    // ensure(...)` is itself a suspension and an owner halted while it
    // registers unwinds with nothing on it.
    let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;

    let buffered = Buffer.alloc(0);
    let started = false;
    const answered = withResolvers<void>();
    const closed = withResolvers<void>();
    // `close`, and nothing else, is what says the backend and its pipes are
    // done; an assigned exit status says only that the process ended.
    let finished = false;

    // A client that hung up mid-body closes this pipe under the backend. It is
    // the client's answer rather than a fault of this fixture's, and an
    // unhandled stream error here would take the whole suite process down.
    const onStdinError = (): void => {};
    const onStdout = (chunk: Buffer): void => {
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
    };
    const onStdoutEnd = (): void => {
      if (!started) {
        outgoing.writeHead(500);
      }
      outgoing.end();
      answered.resolve();
    };
    const onChildError = (): void => {
      if (!started) {
        outgoing.writeHead(500);
        started = true;
      }
      outgoing.end();
      answered.resolve();
    };
    const onClose = (): void => {
      finished = true;
      closed.resolve();
    };

    // Established before the backend exists, so a request cancelled anywhere
    // below still ends the process it started — and so that no instant exists
    // in which a backend is running with no cleanup registered for it.
    //
    // Teardown keeps every handler attached through the close wait, so the
    // answer this fixture was streaming is still being written while the
    // backend ends. They come off, and the request is unpiped, synchronously
    // once that wait has settled.
    yield* ensure(function* () {
      if (child === undefined) {
        return;
      }

      try {
        child.kill("SIGKILL");

        if (!finished) {
          yield* closed.operation;
        }
      } finally {
        incoming.unpipe(child.stdin);
        child.stdin.off("error", onStdinError);
        child.stdout.off("data", onStdout);
        child.stdout.off("end", onStdoutEnd);
        child.off("error", onChildError);
        child.off("close", onClose);
      }
    });

    child = spawn(backend, [], {
      env: cgiEnvironment(incoming, root, user, segment, directory),
      stdio: ["pipe", "pipe", "pipe"],
    });

    observe?.(child);

    child.stdin.on("error", onStdinError);
    child.stdout.on("data", onStdout);
    child.stdout.on("end", onStdoutEnd);
    child.on("error", onChildError);
    child.on("close", onClose);

    if (hold) {
      yield* hold();
    }

    incoming.pipe(child.stdin);

    yield* answered.operation;
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
    // Filled once the listener has a port. A caller that had to name this
    // server's own origin could not, since it does not exist until it listens.
    let origin = "";
    const credential = (username: string, password: string) =>
      `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const expected = credential(options.username, options.password);
    const requests: ServedGitRequest[] = [];

    // Every repository this server holds, by the first segment of its path, so
    // one listener can demand a different credential for each.
    const served = new Map<
      string,
      { root: string; expected: string; user: string; directory: string }
    >();
    served.set(name, { root, expected, user: options.username, directory: name });
    let alsoLocator = "";
    if (options.also !== undefined) {
      const alsoBare = options.also.remote.locator;
      const alsoRoot = dirname(alsoBare);
      const alsoName = alsoBare.slice(alsoRoot.length + 1);
      git(["config", "http.receivepack", "true"], alsoBare, alsoRoot);
      // A path of its own, whatever the directory happens to be called.
      const segment = alsoName === name ? "other.git" : alsoName;
      served.set(segment, {
        root: alsoRoot,
        expected: credential(options.also.username, options.also.password),
        user: options.also.username,
        directory: alsoName,
      });
      alsoLocator = segment;
    }

    // Each accepted request runs as a task of this resource, so tearing the
    // server down ends the backends it is still talking to.
    const requestScope = yield* useScope();
    const holds = new Map<Socket, () => void>();
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const header = incoming.headers.authorization;
      // Which repository this is for decides which credential is right.
      const segment = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
      const entry = served.get(segment);
      const accepted = entry !== undefined && header === entry.expected;
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
        // waiting on this end rather than on a refusal — and when it goes, this
        // is where that is observed. The handler is remembered so teardown can
        // take it off before it destroys the connection it is attached to.
        const held = incoming.socket;
        const onHeldClose = (): void => {
          holds.delete(held);
          options.closed?.();
        };
        holds.set(held, onHeldClose);
        held.on("close", onHeldClose);
        incoming.resume();
        return;
      }
      const named = options.redirect?.(requests[requests.length - 1] as ServedGitRequest);
      const elsewhere = named?.replace("__ELSEWHERE__", origin);
      if (elsewhere !== undefined) {
        outgoing.writeHead(302, { Location: elsewhere });
        outgoing.end();
        incoming.resume();
        return;
      }
      requestScope.run(() =>
        serve(
          incoming,
          outgoing,
          backend,
          entry.root,
          entry.user,
          segment,
          entry.directory,
          options.observeBackend,
          options.holdBackend,
        ),
      );
    });

    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* () {
      // Before the first suspension below, so a teardown halted part-way
      // leaves no handler on a connection this server is finished with.
      for (const [socket, onHeldClose] of holds) {
        socket.off("close", onHeldClose);
      }
      holds.clear();
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
    origin = host;
    yield* provide({
      locator: `http://${host}/${name}`,
      alsoLocator: alsoLocator === "" ? "" : `http://${host}/${alsoLocator}`,
      host,
      label: options.label ?? name,
      requests,
    });
  });
}
