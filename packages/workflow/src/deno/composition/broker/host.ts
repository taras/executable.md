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
import { CAPABILITY_VARIABLE, ENDPOINT_VARIABLE, READY, ACQUIRED } from "./protocol.ts";

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
  /** What one command attaches to speak for this lease. */
  attachment(): GitAttachment;
}

export interface CredentialBroker {
  lease(request: CredentialRequest): Operation<CredentialLease>;
}

export interface BrokerObserver {
  opened?: (directory: string) => void;
  released?: (directory: string) => void;
}

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
  attachment: () => NOTHING,
});

/** Where this lease's endpoint lives, by what the platform can protect. */
function endpointFor(directory: string): string {
  return process.platform === "win32"
    ? // A pipe has no directory to hide in, so its name is the secret it has:
      // random, invocation-local, and created with no all-user access.
      `\\\\.\\pipe\\xmd-credential-${randomBytes(24).toString("hex")}`
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
          // Invalidate first: a shim that connects from here on is answered by
          // nothing, rather than racing a broker that is going away.
          closed = true;
          if (child !== undefined) {
            child.stdin?.end();
            try {
              if (child.pid !== undefined) {
                process.kill(-child.pid, "SIGKILL");
              }
            } catch {
              child.kill("SIGKILL");
            }
            yield* finished.operation;
          }
          // Only now: an endpoint removed while a broker still answered on it
          // would be a live service nobody owns.
          yield* until(rm(directory, { recursive: true, force: true }));
          observe.released?.(directory);
        });

        const endpoint = endpointFor(directory);
        const capability = randomBytes(32).toString("hex");
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(ambient)) {
          if (value !== undefined) {
            environment[name] = value;
          }
        }

        const broker = options.internal.broker();
        child = spawnChild(
          broker.command,
          [
            ...broker.args,
            endpoint,
            capability,
            request.protocol,
            request.host,
            request.path ?? "",
          ],
          { env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true },
        );
        child.on("close", () => finished.resolve());
        child.on("error", () => finished.resolve());

        const started = withResolvers<boolean>();
        let announced = "";
        let acquired = false;
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          announced += chunk;
          if (announced.includes(ACQUIRED)) {
            acquired = true;
          }
          if (announced.includes(READY)) {
            started.resolve(true);
          }
        });
        child.on("close", () => started.resolve(false));

        if (!(yield* started.operation)) {
          // A broker that never listened is a host that can prove nothing. It is
          // not an error to raise: the caller already has a word for it.
          yield* provide(NO_LEASE);
          return;
        }
        // The acquisition line arrives with or just after readiness, and both
        // are written before the socket is answered on.
        yield* until(new Promise<void>((resolve) => setTimeout(resolve, 0)));

        const shim = join(directory, "credential-helper");
        yield* until(writeFile(shim, shimProgram(options.internal.shim()), { mode: 0o700 }));
        yield* until(chmod(shim, 0o700));

        yield* provide({
          get acquired() {
            return acquired && !closed;
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
