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
function pinned(ssh: string, settings: readonly string[]): readonly string[] {
  return [
    "-c",
    `core.sshCommand=${ssh}`,
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "credential.helper=",
    ...settings.flatMap((entry) => ["-c", entry]),
  ];
}

/**
 * The `credential.*` settings the invoking user already has.
 *
 * Names and switches, never secrets: `credential.helper` says which program
 * answers, `credential.useHttpPath` says how much of a URL it is asked about,
 * and a `credential.<url>.*` section scopes either to one place. Git keeps no
 * password in a configuration file; these are re-stated on the command line so
 * the helper this host chose is the helper that runs, and then Git does the
 * asking.
 *
 * Read in the invoking environment, in a directory of its own, so no
 * repository's retained configuration takes part in which helper is found.
 */
export function configuredCredentialSettings(
  ambient: Readonly<Record<string, string | undefined>>,
): Operation<string[]> {
  return resource<string[]>(function* (provide) {
    const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-credential-")));
    yield* ensure(function* () {
      yield* until(rm(directory, { recursive: true, force: true }));
    });

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(ambient)) {
      if (value !== undefined) {
        env[name] = value;
      }
    }
    env["LC_ALL"] = "C";

    let outcome: { code: number; stdout: string };
    try {
      outcome = yield* runProcess({
        command: "git",
        args: ["config", "--null", "--get-regexp", "^credential\\."],
        cwd: directory,
        env,
      });
    } catch {
      yield* provide([]);
      return;
    }
    if (outcome.code !== 0) {
      // Exit 1 is "no such setting", which is an answer rather than a failure.
      yield* provide([]);
      return;
    }

    const settings: string[] = [];
    for (const record of outcome.stdout.split("\0")) {
      if (record === "") {
        continue;
      }
      // `--null` writes `key\nvalue`, so a value holding a newline stays whole
      // and a key never does.
      const separator = record.indexOf("\n");
      const key = separator < 0 ? record : record.slice(0, separator);
      const value = separator < 0 ? "" : record.slice(separator + 1);
      // A reset the user wrote is theirs to keep: it is what clears helpers a
      // system configuration added, and dropping it would run one they turned
      // off.
      settings.push(`${key}=${value}`);
    }
    yield* provide(settings);
  });
}

/** Whether these settings name anything that could answer for a credential. */
function namesAHelper(settings: readonly string[]): boolean {
  return settings.some((entry) => {
    const separator = entry.indexOf("=");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "" : entry.slice(separator + 1);
    return key.endsWith(".helper") && value !== "";
  });
}

/**
 * The environment a standard credential helper needs to answer.
 *
 * A named list rather than the invoking environment wholesale. `HOME` is what
 * lets a helper find the user's own store; the rest are what a platform keychain
 * or secret service is reached through. Git's own configuration variables are
 * deliberately absent, so configuration stays built from nothing even while a
 * helper can work.
 */
const HELPER_ENVIRONMENT: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "USER",
  "LOGNAME",
];

function helperEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of HELPER_ENVIRONMENT) {
    const value = ambient[name];
    if (value !== undefined && value !== "") {
      environment[name] = value;
    }
  }
  return environment;
}

export interface GitAuthenticationOptions {
  /** The environment the ambient mechanisms are found in. */
  readonly ambient?: Readonly<Record<string, string | undefined>>;
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

        const settings = yield* configuredCredentialSettings(ambient);
        yield* provide({
          attachment: {
            environment: helperEnvironment(ambient),
            configuration: pinned(ssh, settings),
          },
          mechanism: namesAHelper(settings) ? "credential-helper" : "none",
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
