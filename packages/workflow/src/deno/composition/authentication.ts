/**
 * The authentication one live provider invocation borrows from its host.
 *
 * A workflow's retained state says which repository an effect belongs to. It
 * does not, and must not, say who this run is: an identity is a live property of
 * the machine the run is standing on, and a run resumed a week later on another
 * machine authenticates as whoever is there then. So nothing here is durable. A
 * session is opened for one provider invocation, shared by that invocation's
 * observations and its mutation, and disposed with it — a completed replay
 * restores its retained result without reaching this module at all.
 *
 * ## The adapter owns the credential, and owns it narrowly
 *
 * This is the trusted host adapter, so it may hold one HTTP credential in
 * memory — for one invocation, released when that invocation ends. What it may
 * not do is let one out. The value reaches nothing but the private environment
 * of this invocation's own Git children, through a helper this provider wrote,
 * and it is not in an argument, a URL, a configuration file, a launcher, the
 * ambient environment, a context, the Workspace, a journal, retained identity,
 * rendered output, a diagnostic or a failure cause.
 *
 * Acquisition asks the invoking user's ordinary helper chain once, about one
 * exact repository. That is where a platform keychain, a cached token or a
 * credential manager lives, and asking it is the whole point: a workflow reaches
 * a private clone wherever the equivalent local Git command reaches one.
 *
 * ## Two failures that must not be confused
 *
 * A host that holds no credential, an answer that is incomplete and an answer
 * about somewhere else are all *authentication unavailability* — ordinary live
 * conditions this run reports and continues past. A helper that could not be
 * installed, a `git credential fill` that could not be run, a marker that could
 * not be read: those are the machine failing to provide a mechanism, and they
 * fail the run stop. Reporting infrastructure as "no credential" would turn a
 * broken host into a clean refusal.
 *
 * ## Why the host decides, and the checkout cannot
 *
 * `host.ts` builds Git's environment from nothing precisely so a workflow's
 * behavior does not depend on whose machine created it. Configuration is still
 * built from nothing, and the transport's arguments reset ambient credential
 * helpers and install only the provider-owned one — no ambient `credential.*`
 * definition or value is copied there. A `.git/config` a document wrote is
 * inside the Workspace and restored by replay, so a `credential.helper` or a
 * `core.sshCommand` in one would be document-authored data naming a program;
 * both are fixed on the command line, where they outrank every configuration
 * file, for every invocation that transports to a remote.
 *
 * ## What each transport borrows
 *
 * **SSH** borrows the agent, and only the agent. `HOME` stays the disposable
 * materialization, so no key file on the machine is reachable and no
 * `~/.ssh/config` is read; `IdentityAgent` names the ambient socket outright.
 * Host verification stays on and its material is the invoking user's
 * `known_hosts`, selected here rather than found: an unknown host is a refusal,
 * never a key accepted on this run's behalf.
 *
 * **HTTP** borrows one answer from the user's helper chain, and hands it onward
 * only through the provider-owned helper described in `credential-helper.ts`.
 */

import { ensure, type Operation, resource, until } from "effection";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runProcess } from "./subprocess.ts";
import {
  HELPER_VARIABLES,
  launcherName,
  launcherProgram,
  type HelperAssembly,
} from "./credential-helper.ts";

/**
 * What an authenticated invocation adds to the command it was going to run.
 *
 * Two lists rather than a rewritten command: the caller still owns its
 * arguments and its environment, and what is here is only what the host lends
 * it. Both are empty for a locator no ambient mechanism applies to.
 */
export interface GitAttachment {
  readonly environment: Readonly<Record<string, string>>;
  /** `-c` settings, which outrank every configuration file Git would read. */
  readonly configuration: readonly string[];
}

/** Which ambient mechanism a session stands on, if any. */
export type GitAuthenticationMechanism = "ssh-agent" | "credential-helper" | "none";

/**
 * One live provider invocation's authentication.
 *
 * Opaque on purpose. A caller can attach it to a command and can ask which
 * mechanism it stands on, so a failure is classified correctly; it cannot read a
 * credential out of one, because there is no credential in one to read.
 */
export interface GitAuthenticationSession {
  /** What every native command in this invocation attaches. */
  readonly attachment: GitAttachment;
  /**
   * Which mechanism this host had for the session's locator.
   *
   * `none` is what makes a refusal classifiable without reading anything Git
   * printed: a transport that carries an identity, attempted with no mechanism
   * to prove one, failed for want of authentication rather than because the
   * locator was wrong.
   */
  readonly mechanism: GitAuthenticationMechanism;
  /**
   * Whether the transport rejected the identity this session gave it.
   *
   * Read after a command fails, not before it runs. A host that proved an
   * identity the remote refused is in the same position as one that could prove
   * none, and the refusal vocabulary says so.
   */
  rejected(): Operation<boolean>;
}

/**
 * The host-owned authentication a provider invocation may borrow.
 *
 * Injectable so a suite can prove which locator a session was opened for, that a
 * replay opens none, and that one locator's session never authorizes another —
 * without a public contextual surface existing for a document, a middleware or
 * another package to install, observe or route through.
 */
export interface GitAuthentication {
  /**
   * Open one session for this exact locator.
   *
   * Opened once per live provider invocation, after the authority checks that
   * invocation requires, and disposed with it.
   */
  open(locator: string): Operation<GitAuthenticationSession>;
}

/** Which ambient mechanism a locator's transport can use, if any. */
export type GitTransport = "ssh" | "http" | "none";

const NOTHING: GitAttachment = Object.freeze({
  environment: Object.freeze({}),
  configuration: Object.freeze([]),
});

/** The session a locator no ambient mechanism applies to gets. */
export const UNAUTHENTICATED: GitAuthenticationSession = Object.freeze({
  attachment: NOTHING,
  mechanism: "none",
  // deno-lint-ignore require-yield
  *rejected(): Operation<boolean> {
    return false;
  },
});

/**
 * Which transport this locator names.
 *
 * `git://` and a local path are `none`: neither carries an identity, so there
 * is nothing to borrow and nothing to refuse for. Anything unparseable that
 * looks like Git's scp-like spelling is SSH, which is what Git itself would
 * make of it.
 */
export function gitTransport(locator: string): GitTransport {
  let url: URL | undefined;
  try {
    url = new URL(locator);
  } catch {
    url = undefined;
  }
  if (url !== undefined) {
    if (url.protocol === "ssh:") {
      return "ssh";
    }
    return url.protocol === "https:" || url.protocol === "http:" ? "http" : "none";
  }
  // Git reads `host:path` as SSH when the first colon comes before the first
  // slash, and as a path otherwise. Said the same way here, so a locator this
  // module decides is unauthenticated is not one Git then sends over SSH.
  const colon = locator.indexOf(":");
  const slash = locator.indexOf("/");
  return colon > 0 && (slash < 0 || colon < slash) ? "ssh" : "none";
}

/** How a value is written into a single-quoted word of a shell command line. */
function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The SSH this run makes, pinned.
 *
 * `-F /dev/null` is what makes the destination fixed: with no `ssh_config`
 * read, no `Host` block rewrites the host, names a `ProxyCommand` or selects a
 * transport program, and the locator's own host is where this goes.
 * `BatchMode=yes` is the SSH half of `GIT_TERMINAL_PROMPT=0`. Host verification
 * is left on and pointed at the invoking user's `known_hosts`, since `HOME` is
 * the materialization and the file there is empty.
 *
 * The agent is named rather than inherited. `IdentityAgent=none` when the
 * invoking environment has none, so what happens without an agent is a refusal
 * this run can state instead of a search for key files.
 */
export function sshCommand(home: string | undefined, agent: string | undefined): string {
  const options = [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `IdentityAgent=${agent === undefined || agent === "" ? "none" : agent}`,
  ];
  if (home !== undefined && home !== "") {
    options.push("-o", `UserKnownHostsFile=${join(home, ".ssh", "known_hosts")}`);
  }
  return ["ssh", ...options.map(quoted)].join(" ");
}

/**
 * The settings every remote-touching invocation fixes, credential or not.
 *
 * `credential.helper` is multi-valued, and an empty value is how the list is
 * reset — which is why the reset is present even when nothing follows it. A
 * `.git/config` a document wrote names no helper after this, and neither does
 * anything else Git would have read.
 *
 * The two file settings are pinned because an HTTP session passes `HOME`
 * through for the helper's sake, and with configuration itself off they are the
 * only remaining things a home directory would decide.
 */
function pinned(ssh: string, lease: readonly string[]): readonly string[] {
  // The lease's own words, verbatim: it states a whole `-c` pair, because what
  // it installs is one helper and nothing else. Nothing the invoking user or a
  // retained repository configured is copied here.
  return [
    "-c",
    `core.sshCommand=${ssh}`,
    // A redirect is a destination this run never authorized, and Git will carry
    // a credential it already holds across one to the same host — so the
    // helper's exact-locator refusal is not enough on its own. The retained
    // locator is where this goes, or it does not go.
    "-c",
    "http.followRedirects=false",
    "-c",
    "credential.helper=",
    ...lease,
  ];
}

/** One credential-free locator, as the invoking user's helper chain is asked. */
export interface CredentialRequest {
  readonly protocol: string;
  readonly host: string;
  readonly path?: string;
}

/**
 * What one live provider invocation holds instead of a bare credential.
 *
 * The value is retained lexically by the adapter, for this invocation only. A
 * caller can ask whether an identity was proved and whether the transport
 * rejected it, and can attach the invocation to a command — the credential
 * itself reaches nothing but the private environment of that command's own
 * child, through the provider-owned helper.
 */
export interface CredentialLease {
  readonly acquired: boolean;
  rejected(): Operation<boolean>;
  attachment(): GitAttachment;
}

export interface CredentialBroker {
  lease(request: CredentialRequest): Operation<CredentialLease>;
}

/**
 * The credential request this HTTP locator is, or `undefined` for none.
 *
 * The whole locator travels with it — scheme, host with its explicit port, and
 * path. A broker asked about less than the whole of it would be answering a
 * different question than the one this invocation is about to perform, which is
 * how one repository's acquisition would come to authorize another on the same
 * server.
 */
export function credentialRequest(locator: string): CredentialRequest | undefined {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const path = url.pathname.replace(/^\//, "");
  return Object.freeze({
    protocol: url.protocol.replace(/:$/, ""),
    host: url.host,
    ...(path === "" ? {} : { path }),
  });
}

/**
 * What a session did with host resources, for a suite that has to prove it.
 *
 * A claim that nothing survives teardown needs something that counted, and
 * counting by scanning the temporary directory for a name prefix is a claim
 * about the whole machine rather than about this invocation — two concurrent
 * ones would each see the other's. So a session reports its own working
 * directories, and a suite watches the invocation it started.
 */
export interface GitAuthenticationObserver {
  opened?: (directory: string) => void;
  released?: (directory: string) => void;
  /**
   * Each step of teardown, as it happens.
   *
   * The order is the contract — references released before the launcher and the
   * marker go, and both gone before the invocation is finished with — so a suite
   * watches rather than infers.
   */
  step?: (name: string) => void;
}

/**
 * The host operations acquisition performs, as one replaceable set.
 *
 * A seam rather than a set of filesystem calls, because the failures that have
 * to be proved are of the operations rather than of any particular directory.
 * Arranging them with permissions would be arranging the operating system: a
 * privileged runner can write where it should not be able to, and Windows does
 * not express the same modes at all, so the fault would be the environment's
 * rather than the test's.
 */
export interface CredentialOperations {
  /** Install the launcher Git will run. */
  writeLauncher(path: string, contents: string, executable: boolean): Operation<void>;
  /**
   * Whether the rejection marker is there.
   *
   * Absent is the one answer that means "not rejected". A marker this host
   * could not read is a marker it does not know about, and reporting that as
   * nothing-was-refused would turn a broken filesystem into a clean run.
   */
  markerPresent(path: string): Operation<boolean>;
  /** Remove the invocation's working directory when it ends. */
  removeWorkingDirectory(path: string): Operation<void>;
}

/** What this host actually does, when nothing substitutes one for a test. */
export function denoCredentialOperations(): CredentialOperations {
  return {
    *writeLauncher(path: string, contents: string, executable: boolean): Operation<void> {
      yield* until(writeFile(path, contents, { mode: 0o700 }));
      if (executable) {
        yield* until(chmod(path, 0o700));
      }
    },
    *markerPresent(path: string): Operation<boolean> {
      return yield* until(
        stat(path).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              return false;
            }
            throw error;
          },
        ),
      );
    },
    *removeWorkingDirectory(path: string): Operation<void> {
      yield* until(rm(path, { recursive: true, force: true }));
    },
  };
}

export interface GitAuthenticationOptions {
  /** The environment the ambient mechanisms are found in. */
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly observe?: GitAuthenticationObserver;
  /** How this host writes and starts its own credential helper. */
  readonly assembly?: HelperAssembly;
  /** Where a credential comes from, when it is not this host's own Git. */
  readonly broker?: CredentialBroker;
}

/**
 * The invoking user's own Git, asked once about one exact repository.
 *
 * `git credential fill` is the whole of the standard mechanism: it consults the
 * helpers the user configured, and those are what reach a platform keychain, a
 * cached token or a manager process. Prompting and both askpass hooks are off,
 * so an absent credential is an answer that comes back rather than a run that
 * stops on a question nobody is there for, and `useHttpPath` is forced — without
 * it Git withholds the path and the answer would be about the server.
 *
 * The answer is required to carry back the exact protocol, host and path that
 * were asked about. A helper may rewrite those, and an answer about somewhere
 * else has authorized nothing.
 *
 * What comes back is retained lexically here, for this invocation, and reaches
 * nothing but the private environment of this invocation's own Git children.
 */
export function denoCredentialBroker(
  ambient: Readonly<Record<string, string | undefined>> = process.env,
  observe: GitAuthenticationObserver = {},
  assembly?: HelperAssembly,
  operations: CredentialOperations = denoCredentialOperations(),
): CredentialBroker {
  return {
    lease(request: CredentialRequest): Operation<CredentialLease> {
      return resource<CredentialLease>(function* (provide) {
        const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-credential-")));
        observe.opened?.(directory);
        let closed = false;
        // The one reference, released when this invocation ends.
        let held: { username: string; password: string } | undefined;
        yield* ensure(function* () {
          closed = true;
          held = undefined;
          observe.step?.("released");
          yield* operations.removeWorkingDirectory(directory);
          observe.step?.("removed");
          observe.released?.(directory);
        });

        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(ambient)) {
          if (value !== undefined) {
            env[name] = value;
          }
        }
        env["GIT_TERMINAL_PROMPT"] = "0";
        env["GIT_ASKPASS"] = "";
        env["SSH_ASKPASS"] = "";
        env["LC_ALL"] = "C";

        // No `try` around this. A `git credential fill` that could not be
        // started, or that failed in a way this host cannot run past, is the
        // machine failing to provide a mechanism rather than a machine that
        // holds no credential — and the two must not report the same thing.
        const outcome = yield* runProcess({
          command: "git",
          args: ["-c", "credential.useHttpPath=true", "credential", "fill"],
          cwd: directory,
          env,
          input:
            `protocol=${request.protocol}\nhost=${request.host}\n` +
            `${request.path === undefined ? "" : `path=${request.path}\n`}\n`,
        });
        if (outcome.code !== 0) {
          yield* provide(unacquired());
          return;
        }
        held = readCredential(outcome.stdout, request);
        if (held === undefined || assembly === undefined) {
          yield* provide(unacquired());
          return;
        }

        // Installing the launcher is the one thing acquisition does that can
        // fail after an identity was proved, and a failure of it is this host
        // being unable to give Git a helper — never a credential it lacks.
        const launcher = join(directory, launcherName(assembly));
        yield* operations.writeLauncher(
          launcher,
          launcherProgram(assembly),
          assembly.platform !== "windows",
        );
        const marker = join(directory, "rejected");

        yield* provide({
          get acquired() {
            return held !== undefined && !closed;
          },
          *rejected(): Operation<boolean> {
            // A fixed, nonsecret file the helper writes when the transport
            // refused what it was given. Read when a failed command is being
            // classified, so the answer is about that command.
            if (closed) {
              return false;
            }
            return yield* operations.markerPresent(marker);
          },
          attachment: () =>
            closed || held === undefined
              ? NOTHING
              : Object.freeze({
                  environment: Object.freeze({
                    [HELPER_VARIABLES.username]: held.username,
                    [HELPER_VARIABLES.password]: held.password,
                    [HELPER_VARIABLES.protocol]: request.protocol,
                    [HELPER_VARIABLES.host]: request.host,
                    [HELPER_VARIABLES.path]: request.path ?? "",
                    [HELPER_VARIABLES.marker]: marker,
                  }),
                  configuration: Object.freeze([
                    // Forced on the transport too: without it Git asks the
                    // helper about the server rather than the repository, and
                    // the exact-locator match would have nothing to compare.
                    "-c",
                    "credential.useHttpPath=true",
                    "-c",
                    `credential.helper=${launcher}`,
                  ]),
                }),
        });
      });
    },
  };
}

/** The lease of an invocation that proved nothing. */
function unacquired(): CredentialLease {
  return {
    acquired: false,
    // deno-lint-ignore require-yield
    *rejected(): Operation<boolean> {
      return false;
    },
    attachment: () => NOTHING,
  };
}

/**
 * The credential in this answer, when the answer is about what was asked.
 *
 * Git echoes the request's own fields back beside the ones a helper supplied,
 * and a helper is free to rewrite them. A rewritten protocol, host or path means
 * the identity that came back belongs to somewhere else. The path is required
 * rather than merely checked: an answer that omits it is an answer about the
 * server, and adopting one would make a single acquisition the identity for
 * every repository there.
 */
function readCredential(
  output: string,
  request: CredentialRequest,
): { username: string; password: string } | undefined {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  const username = fields.get("username");
  const password = fields.get("password");
  if (username === undefined || password === undefined || password === "") {
    return undefined;
  }
  if (fields.get("protocol") !== request.protocol || fields.get("host") !== request.host) {
    return undefined;
  }
  if (request.path !== undefined && fields.get("path") !== request.path) {
    return undefined;
  }
  return { username, password };
}

/**
 * The authentication the invoking host actually has.
 *
 * Lazy, and per provider invocation: nothing is read until an operation that
 * transports to a remote is about to run, and what is read is about that
 * operation's own locator. Two Repositories are two sessions even when the same
 * helper answers both — a session opened for one locator is never carried
 * forward as authority for another, and neither is anything it stands on.
 */
export function denoGitAuthentication(options: GitAuthenticationOptions = {}): GitAuthentication {
  const ambient = options.ambient ?? process.env;
  const observe = options.observe ?? {};
  const broker = options.broker ?? denoCredentialBroker(ambient, observe, options.assembly);
  const ssh = sshCommand(ambient["HOME"], ambient["SSH_AUTH_SOCK"]);

  return {
    open(locator: string): Operation<GitAuthenticationSession> {
      return resource(function* (provide) {
        const transport = gitTransport(locator);
        if (transport === "none") {
          yield* provide(UNAUTHENTICATED);
          return;
        }
        if (transport === "ssh") {
          const socket = ambient["SSH_AUTH_SOCK"];
          const present = socket !== undefined && socket !== "";
          yield* provide({
            attachment: {
              environment: present ? { SSH_AUTH_SOCK: socket } : {},
              configuration: pinned(ssh, []),
            },
            mechanism: present ? "ssh-agent" : "none",
            // deno-lint-ignore require-yield
            *rejected(): Operation<boolean> {
              return false;
            },
          });
          return;
        }

        // One lease, for this whole invocation and for this complete locator.
        // A request this module cannot phrase is one no broker can answer.
        const request = credentialRequest(locator);
        const lease = request === undefined ? undefined : yield* broker.lease(request);
        const attached = lease?.attachment() ?? NOTHING;
        yield* provide({
          attachment: {
            environment: attached.environment,
            configuration: pinned(ssh, attached.configuration),
          },
          *rejected(): Operation<boolean> {
            return lease === undefined ? false : yield* lease.rejected();
          },
          // Acquisition, not configuration. A helper that answered nothing
          // leaves this `none`, and a transport that then fails failed for want
          // of authentication rather than because the locator was wrong.
          mechanism: lease?.acquired === true ? "credential-helper" : "none",
        });
      });
    },
  };
}

/** The authentication of a host that lends none. */
export function noGitAuthentication(): GitAuthentication {
  return {
    // deno-lint-ignore require-yield
    *open(): Operation<GitAuthenticationSession> {
      return UNAUTHENTICATED;
    },
  };
}

/**
 * Whether a failed transport failed for want of authentication.
 *
 * Decided from what the host had rather than from anything Git printed: a
 * remote writes into that stream, and a classification read out of a sentence
 * would be a remote deciding which refusal this run reports. A transport that
 * carries an identity, attempted with no mechanism to prove one, could not have
 * authenticated — which is a different thing from a locator that names nothing
 * and from a remote that holds nothing.
 */
export function* unauthenticable(
  locator: string,
  session: GitAuthenticationSession,
): Operation<boolean> {
  if (gitTransport(locator) === "none") {
    return false;
  }
  // Two ways to have no usable identity: none was proved, or one was proved and
  // the remote refused it. Git tells a helper the second by asking it to erase,
  // which this provider turns into a signal rather than an erasure. Neither is
  // a locator that names nothing.
  return session.mechanism === "none" || (yield* session.rejected());
}
