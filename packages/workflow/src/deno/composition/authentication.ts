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

import { type Operation, resource } from "effection";
import { join } from "node:path";
import process from "node:process";
import { denoCredentialBroker } from "./broker/host.ts";
import type { CredentialBroker, CredentialRequest } from "./broker/host.ts";
import { internalModes } from "./broker/main.ts";

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
  return ["-c", `core.sshCommand=${ssh}`, "-c", "credential.helper=", ...lease];
}

export type { CredentialBroker, CredentialLease, CredentialRequest } from "./broker/host.ts";

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
  const broker =
    options.broker ?? denoCredentialBroker({ ambient, observe, internal: internalModes() });
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
