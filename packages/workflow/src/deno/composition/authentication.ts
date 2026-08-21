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
 * ## XMD is not the credential carrier
 *
 * No credential value crosses this boundary, and none is written anywhere. What
 * a session holds is the host's *decision* about which authentication Git may
 * use for one exact locator: a socket path, a known-hosts file, and the names of
 * the credential helpers the invoking user already configured. Git and the
 * helper exchange the secret between themselves, over Git's own credential
 * protocol, and this module never sees it.
 *
 * That is why there is no `{ username, password }` here and no file for one to
 * be written into. XMD acquires nothing to hand on: it says which mechanism is
 * in force for one locator, and Git does the asking. Approving, rejecting,
 * erasing, copying and persisting a credential are therefore things this
 * provider cannot do rather than things it declines to do.
 *
 * ## Why the host decides, and the checkout cannot
 *
 * `host.ts` builds Git's environment from nothing precisely so a workflow's
 * behavior does not depend on whose machine created it. Configuration is still
 * built from nothing: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
 * `GIT_CONFIG_NOSYSTEM` stay as they were, so no `~/.gitconfig` URL rewrite,
 * `core.hooksPath` or `init.templateDir` is read. What a session adds is the
 * narrow set of things a standard credential helper needs in order to reach the
 * user's own keychain or store, and the helper names themselves, re-stated on
 * the command line where this provider chose them rather than inherited them.
 *
 * The retained checkout has no say at all. A `.git/config` a document wrote is
 * inside the Workspace and restored by replay, so a `credential.helper` or a
 * `core.sshCommand` in one would be document-authored data naming a program.
 * Both are fixed on the command line — where they outrank every configuration
 * file — for every invocation that transports to a remote, and the
 * `credential.helper` list is reset before the host's own choice is stated.
 *
 * ## What each transport borrows
 *
 * **SSH** borrows the agent, and only the agent. `HOME` stays the disposable
 * materialization, so no key file on the machine is reachable and no
 * `~/.ssh/config` is read; `IdentityAgent` names the ambient socket outright, so
 * the keys this run can offer are exactly the ones the invoking user has
 * unlocked. Host verification stays on and its material is the invoking user's
 * `known_hosts`, selected here rather than found: an unknown host is a refusal,
 * never a key accepted on this run's behalf.
 *
 * **HTTP** borrows the credential helpers the invoking user configured, and the
 * environment those helpers need to answer. Git queries them for the exact URL
 * it is transporting to, which is a more exact question than this module could
 * ask on its behalf. `core.excludesFile` and `core.attributesFile` are pinned
 * alongside, because with configuration itself off they are the only remaining
 * things a passed-through `HOME` would decide.
 */

import { ensure, type Operation, resource, until } from "effection";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runProcess } from "./subprocess.ts";

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
  return ["-c", `core.sshCommand=${ssh}`, "-c", "credential.helper=", ...lease];
}

/** One credential-free locator, as a broker is asked about it. */
export interface CredentialRequest {
  /** `https` or `http`. The scheme is part of what is being asked about. */
  readonly protocol: string;
  /** Host and port, as they appear in the locator. */
  readonly host: string;
  /** The repository path, without its leading separator, or none. */
  readonly path?: string;
}

/**
 * What one invocation holds instead of a credential.
 *
 * Opaque by construction: there is no member that answers with a username or a
 * password, and nothing outside the broker module can read one out of it. What a
 * caller can do is ask whether the host proved an identity for the exact locator
 * this lease was minted for, and attach the lease to a command. The value stays
 * inside the broker's own closure and reaches Git through the credential
 * protocol, never through XMD.
 */
export interface CredentialLease {
  /**
   * Whether the host actually proved an identity for this lease's locator.
   *
   * The distinction the refusal vocabulary needs. A helper being configured is
   * not authentication: a helper that answered nothing, an unreadable answer and
   * an answer about somewhere else all leave this `false`, and a transport that
   * then fails failed for want of authentication.
   */
  readonly acquired: boolean;
  /** What one command attaches to speak for this lease. */
  attachment(): GitAttachment;
}

/**
 * Where an HTTP credential comes from, and who owns it.
 *
 * The broker owns the value; a caller owns a lease. It is queried once, for one
 * complete locator, when a live provider invocation opens its session — so an
 * observation and the mutation it decided speak for the same acquisition rather
 * than asking again and possibly being answered differently.
 */
export interface CredentialBroker {
  lease(request: CredentialRequest): Operation<CredentialLease>;
}

/** The lease of a host that proved nothing. */
const NO_LEASE: CredentialLease = Object.freeze({
  acquired: false,
  attachment: () => NOTHING,
});

/**
 * The credential request this HTTP locator is, or `undefined` for none.
 *
 * The whole locator travels with it — scheme, host and path. A broker asked
 * about less than the whole of it would be answering a different question than
 * the one this invocation is about to perform, which is how one repository's
 * acquisition would come to authorize another on the same host.
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

/** One `key=value` record, as Git's credential protocol writes and reads one. */
function credentialRecord(fields: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      lines.push(`${key}=${value}`);
    }
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * The fields a helper answered with, as far as they can be read.
 *
 * A value containing a newline cannot exist in this protocol, so a line without
 * a separator ends the reading rather than being skipped: what follows it is not
 * something whose meaning is still known.
 */
function readCredentialRecord(output: string): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const line of output.split("\n")) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 0) {
      return undefined;
    }
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

/** The two variables a lease speaks through, and nothing else. */
const LEASE_USERNAME = "XMD_GIT_CREDENTIAL_USERNAME";
const LEASE_PASSWORD = "XMD_GIT_CREDENTIAL_PASSWORD";

/**
 * The helper a lease installs: Git's credential protocol, answering `get` only.
 *
 * It names the two variables rather than carrying anything, so what appears on
 * an observable command line is a shape and never a value. `store` and `erase`
 * exit without doing anything, which is what makes this acquisition-only in the
 * strict sense — there is no path through it that writes, approves, rejects or
 * forgets a credential, whatever Git decides to send after a success or a
 * rejection.
 */
const LEASE_HELPER =
  `!f() { test "$1" = get || exit 0; ` +
  `test -n "$${LEASE_PASSWORD}" || exit 0; ` +
  `printf 'username=%s\\npassword=%s\\n' "$${LEASE_USERNAME}" "$${LEASE_PASSWORD}"; }; f`;

/**
 * The invoking user's own Git, asked once what it holds for one exact locator.
 *
 * `git credential fill` is the whole of the standard mechanism: it consults the
 * helpers the user configured, and those are what reach a platform keychain, a
 * cached token or a manager process. It runs with the invoking environment
 * because that is where those helpers are named — with terminal prompting and
 * both askpass hooks off, so an absent credential is an answer that comes back
 * rather than a run that stops on a question nobody is there for.
 *
 * It runs in a directory of its own, not in a checkout, so no repository's
 * retained configuration takes part in the question or in who answers it. And it
 * runs once per lease: the answer is held for the invocation that asked, so the
 * two commands of a reconciliation cannot be answered differently.
 *
 * XMD never calls `git credential approve`, `reject` or `erase`. A run that
 * failed to push has learned nothing about whether the credential it borrowed
 * should still exist, and a helper's own refresh is its business.
 */
export function denoCredentialBroker(
  ambient: Readonly<Record<string, string | undefined>> = process.env,
  observe: GitAuthenticationObserver = {},
): CredentialBroker {
  return {
    lease(request: CredentialRequest): Operation<CredentialLease> {
      return resource<CredentialLease>(function* (provide) {
        const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-credential-")));
        observe.opened?.(directory);
        yield* ensure(function* () {
          yield* until(rm(directory, { recursive: true, force: true }));
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

        let outcome: { code: number; stdout: string };
        try {
          outcome = yield* runProcess({
            command: "git",
            // `useHttpPath` is forced rather than hoped for. Without it Git
            // withholds the path from every helper, so a host's answer is about
            // the server and one repository's acquisition would silently be the
            // identity for every repository on it. The question this broker asks
            // is the whole locator, and this is what makes the helper hear it.
            args: ["-c", "credential.useHttpPath=true", "credential", "fill"],
            cwd: directory,
            env,
            input: credentialRecord({
              protocol: request.protocol,
              host: request.host,
              path: request.path,
            }),
          });
        } catch {
          yield* provide(NO_LEASE);
          return;
        }
        if (outcome.code !== 0) {
          // No credential, a helper that failed and a helper that was
          // interrupted are one answer here: this host cannot prove an identity
          // for this locator right now. What Git said about it goes nowhere.
          yield* provide(NO_LEASE);
          return;
        }

        const held = readCredential(outcome.stdout, request);
        if (held === undefined) {
          yield* provide(NO_LEASE);
          return;
        }
        // The value lives here and nowhere else. The lease handed out below has
        // no member that answers with it.
        yield* provide(
          Object.freeze({
            acquired: true,
            attachment: () =>
              Object.freeze({
                environment: Object.freeze({
                  [LEASE_USERNAME]: held.username,
                  [LEASE_PASSWORD]: held.password,
                }),
                configuration: Object.freeze(["-c", `credential.helper=${LEASE_HELPER}`]),
              }),
          }),
        );
      });
    },
  };
}

/**
 * The credential in this answer, when the answer is about what was asked.
 *
 * Git echoes the request's own fields back beside the ones a helper supplied,
 * and a helper is free to rewrite them. A rewritten protocol, host or path means
 * the identity that came back belongs to somewhere else — which is exactly the
 * accident that would let a credential for one repository be sent to another.
 */
function readCredential(
  output: string,
  request: CredentialRequest,
): { username: string; password: string } | undefined {
  const fields = readCredentialRecord(output);
  if (fields === undefined) {
    return undefined;
  }
  const username = fields["username"];
  const password = fields["password"];
  if (username === undefined || password === undefined || password === "") {
    return undefined;
  }
  if (fields["protocol"] !== request.protocol || fields["host"] !== request.host) {
    return undefined;
  }
  // The path is required, not merely checked when present. An answer that omits
  // it is an answer about the server, and adopting one would make a single
  // acquisition the identity for every repository there — which is exactly the
  // separation the request was phrased to keep. A helper that answered about
  // another path has not authorized this one either.
  if (request.path !== undefined && fields["path"] !== request.path) {
    return undefined;
  }
  return Object.freeze({ username, password });
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
}

export interface GitAuthenticationOptions {
  /** The environment the ambient mechanisms are found in. */
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly observe?: GitAuthenticationObserver;
  /**
   * Who owns a credential value for this host.
   *
   * Injectable so a suite can prove what a session does with a lease without
   * standing on a developer's own credentials, and so the one component that
   * ever holds a value is the one component a test can replace.
   */
  readonly broker?: CredentialBroker;
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
  const broker = options.broker ?? denoCredentialBroker(ambient, observe);
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
export function unauthenticable(locator: string, session: GitAuthenticationSession): boolean {
  return gitTransport(locator) !== "none" && session.mechanism === "none";
}
