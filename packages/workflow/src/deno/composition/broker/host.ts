/**
 * The provider's side of the broker: a capability, an endpoint, and a shim.
 *
 * Starting a broker is how one live provider invocation acquires. What comes
 * back is a lease, and a lease is opaque in the strict sense now — there is no
 * credential anywhere in this process to be read out of one. The credential is
 * acquired by a child, held by that child, and reaches Git through a shim the
 * child answers. The provider learns one fact about it: whether an identity was
 * proved at all, which is what the refusal vocabulary reads.
 *
 * ## What a lease is protected by
 *
 * A private endpoint and a capability, and both are this invocation's alone. On
 * a Unix host the endpoint is a socket inside a directory only this user may
 * enter; on Windows it is a random invocation-local named pipe, since a pipe has
 * no directory to hide in. Neither is enough by itself — the capability is
 * checked before any credential byte is emitted, so an endpoint somebody found
 * is an endpoint that answers nothing.
 *
 * The capability never appears on a command line. It reaches the shim through
 * the environment of the Git command the lease was attached to, which is the
 * same channel `SSH_AUTH_SOCK` already travels and is not a place a process
 * listing shows.
 *
 * ## Teardown order
 *
 * Invalidate, then kill, then remove. The lease is marked closed first, so a
 * shim that connects during teardown is refused rather than raced; the child's
 * standard input is closed, which is the end-of-file it exits on; the process
 * group is signalled and awaited; and only then are the endpoint and the shim
 * removed. Doing it the other way round would leave a live broker addressable
 * by a path nobody owns.
 */

import { ensure, type Operation, resource, until, withResolvers } from "effection";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { connect } from "node:net";
import {
  CAPABILITY_VARIABLE,
  decodeRejection,
  decodeStatus,
  encodeLine,
  ENDPOINT_VARIABLE,
  LISTENING,
  STATUS,
  SUBJECT_VARIABLES,
} from "./protocol.ts";

/** What a lease hands the command it speaks for. */
export interface GitAttachment {
  readonly environment: Readonly<Record<string, string>>;
  readonly configuration: readonly string[];
}

/** One credential-free locator, as a broker is asked about it. */
export interface CredentialRequest {
  readonly protocol: string;
  readonly host: string;
  readonly path?: string;
}

/**
 * What one invocation holds instead of a credential.
 *
 * There is no member that answers with a username or a password, and now there
 * is nothing in this process for one to answer with.
 */
export interface CredentialLease {
  /** Whether the host proved an identity for this lease's exact locator. */
  readonly acquired: boolean;
  /**
   * Whether the transport rejected the identity this lease gave it.
   *
   * Git's `erase` reaches the shim when a remote refused what it was handed.
   * Nothing is erased; the signal comes here. A run that proved an identity and
   * had it refused is in the same position as one that could prove none —
   * authentication unavailability, never an invalid locator.
   */
  rejected(): Operation<boolean>;
  /** What one command attaches to speak for this lease. */
  attachment(): GitAttachment;
}

export interface CredentialBroker {
  lease(request: CredentialRequest): Operation<CredentialLease>;
}

export interface BrokerObserver {
  opened?: (directory: string) => void;
  released?: (directory: string) => void;
  /**
   * Each step of teardown, as it happens.
   *
   * The order is the contract — a lease invalidated after its endpoint went
   * away, or an endpoint removed while a broker still answered on it, would be
   * the same steps in an unsafe sequence. A suite watches rather than infers.
   */
  step?: (name: string) => void;
}

/** The steps teardown takes, in the order it must take them. */
export const TEARDOWN = Object.freeze({
  invalidated: "invalidated",
  terminated: "terminated",
  closed: "ipc-closed",
  awaited: "awaited",
  removed: "removed",
});

/**
 * How this host starts one of its own unadvertised internal modes.
 *
 * Not a command a person runs and not part of any public grammar: it appears in
 * no help, and it can acquire nothing by itself — the broker mode is useless
 * without a locator, and the shim mode is useless without an endpoint and a
 * capability this process minted.
 */
export interface InternalExecution {
  readonly command: string;
  readonly args: readonly string[];
}

export interface InternalModes {
  broker(): InternalExecution;
  shim(): InternalExecution;
}

const NOTHING: GitAttachment = Object.freeze({
  environment: Object.freeze({}),
  configuration: Object.freeze([]),
});

const NO_LEASE: CredentialLease = Object.freeze({
  acquired: false,
  // deno-lint-ignore require-yield
  *rejected(): Operation<boolean> {
    return false;
  },
  attachment: () => NOTHING,
});

/**
 * Ask one broker a question and read its one-line answer.
 *
 * The parent's own client. It speaks the protocol the shim speaks and is held to
 * the same capability, because an endpoint that answered its parent more readily
 * than anyone else would be an endpoint with a second way in.
 */
function inquire(endpoint: string, question: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    let buffered = "";
    const finish = () => resolve(buffered);
    socket.on("error", () => resolve(""));
    socket.on("data", (chunk) => {
      buffered += String(chunk);
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("connect", () => socket.write(question));
  });
}

/**
 * Where this lease's endpoint lives, by what the platform can protect.
 *
 * A Unix socket hides in a directory only this user may enter. A named pipe has
 * no directory to hide in, so what it has instead is a name nobody can guess:
 * random, invocation-local, and created with no all-user access option. Neither
 * is trusted on its own — the capability is checked before a credential byte is
 * emitted either way.
 *
 * The platform is a parameter so a suite can prove the Windows shape on a host
 * that is not Windows.
 */
export function endpointFor(directory: string, platform: string = process.platform): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\xmd-credential-${randomBytes(24).toString("hex")}`
    : join(directory, "endpoint");
}

/**
 * The provider-owned shim, written where only this user can reach it.
 *
 * A file rather than a command line, because Git executes a helper by name and a
 * name is what a process listing shows. What is in the file is a launcher for
 * this host's own internal mode and nothing else — no credential, and no
 * endpoint or capability either, since those reach the shim through the
 * environment of the command that attached the lease.
 */
function shimProgram(internal: InternalExecution): string {
  const words = [internal.command, ...internal.args].map(
    (word) => `'${word.replaceAll("'", `'\\''`)}'`,
  );
  return `#!/bin/sh\nexec ${words.join(" ")} "$@"\n`;
}

export interface BrokerOptions {
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly observe?: BrokerObserver;
  readonly internal: InternalModes;
}

/**
 * The broker this host runs, one child per live provider invocation.
 *
 * The child is started with its standard input piped and held: that pipe is the
 * lease's lifetime, and closing it is how the child learns the invocation is
 * over whether it returned, refused or was cancelled.
 */
export function denoCredentialBroker(options: BrokerOptions): CredentialBroker {
  const ambient = options.ambient ?? process.env;
  const observe = options.observe ?? {};

  return {
    lease(request: CredentialRequest): Operation<CredentialLease> {
      return resource<CredentialLease>(function* (provide) {
        // `mkdtemp` makes a directory only this user may enter, which is what
        // protects a Unix endpoint before the capability is even read.
        const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-credential-")));
        observe.opened?.(directory);
        let closed = false;
        let child: ChildProcess | undefined;
        const finished = withResolvers<void>();

        yield* ensure(function* () {
          // The order is the contract, and each step is announced as it is
          // taken. Invalidate first, so a shim that connects from here on is
          // answered by nothing rather than racing a broker that is going away.
          closed = true;
          observe.step?.(TEARDOWN.invalidated);
          if (child !== undefined) {
            // The group, so a helper the broker started goes with it.
            try {
              if (child.pid !== undefined) {
                process.kill(-child.pid, "SIGKILL");
              }
            } catch {
              child.kill("SIGKILL");
            }
            observe.step?.(TEARDOWN.terminated);
            // Then the pipe that is the lease's lifetime: a broker that somehow
            // survived the signal reads end-of-file and exits on its own.
            child.stdin?.end();
            observe.step?.(TEARDOWN.closed);
            yield* finished.operation;
            observe.step?.(TEARDOWN.awaited);
          }
          // Only now. An endpoint removed while a broker still answered on it
          // would be a live service nobody owns.
          yield* until(rm(directory, { recursive: true, force: true }));
          observe.step?.(TEARDOWN.removed);
          observe.released?.(directory);
        });

        const endpoint = endpointFor(directory);
        const capability = randomBytes(32).toString("hex");
        const asked = {
          protocol: request.protocol,
          host: request.host,
          path: request.path ?? "",
        };
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(ambient)) {
          if (value !== undefined) {
            environment[name] = value;
          }
        }

        // The subject travels in the child's environment, never in its argument
        // vector: a capability on a command line is a secret every process
        // listing shows, and an endpoint there is an address nobody had to be
        // told.
        environment[SUBJECT_VARIABLES.endpoint] = endpoint;
        environment[SUBJECT_VARIABLES.capability] = capability;
        environment[SUBJECT_VARIABLES.protocol] = asked.protocol;
        environment[SUBJECT_VARIABLES.host] = asked.host;
        environment[SUBJECT_VARIABLES.path] = asked.path;

        const broker = options.internal.broker();
        child = spawnChild(broker.command, [...broker.args], {
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
        child.on("close", () => finished.resolve());
        child.on("error", () => finished.resolve());

        // One record, once. There is nothing further to wait for, and no pause
        // to decide how long to wait for it.
        const started = withResolvers<string>();
        let announced = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          announced += chunk;
          const line = announced.indexOf("\n");
          if (line >= 0) {
            started.resolve(announced.slice(0, line));
          }
        });
        child.on("close", () => started.resolve(""));

        const status = decodeStatus(yield* started.operation);
        if (status === undefined || status.status !== LISTENING) {
          // A broker that could not start or could not listen is a host that
          // can prove nothing.
          yield* provide(NO_LEASE);
          return;
        }
        const acquired = status.acquired;

        const shim = join(directory, "credential-helper");
        yield* until(writeFile(shim, shimProgram(options.internal.shim()), { mode: 0o700 }));
        yield* until(chmod(shim, 0o700));

        yield* provide({
          get acquired() {
            return acquired && !closed;
          },
          *rejected(): Operation<boolean> {
            if (closed) {
              return false;
            }
            const answered = yield* until(
              inquire(endpoint, encodeLine({ capability, operation: STATUS, ...asked })),
            );
            return decodeRejection(answered.split("\n")[0] ?? "");
          },
          attachment: () =>
            closed
              ? NOTHING
              : Object.freeze({
                  environment: Object.freeze({
                    [ENDPOINT_VARIABLE]: endpoint,
                    [CAPABILITY_VARIABLE]: capability,
                  }),
                  configuration: Object.freeze([
                    // Forced on the transport too, not only on the acquisition.
                    // Without it Git asks the shim about the server rather than
                    // about the repository, and the broker — which leased one
                    // exact path — would be unable to tell the two apart at all.
                    "-c",
                    "credential.useHttpPath=true",
                    "-c",
                    `credential.helper=${shim}`,
                  ]),
                }),
        });
      });
    },
  };
}
