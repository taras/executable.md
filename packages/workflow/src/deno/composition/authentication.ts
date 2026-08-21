/**
 * The authentication one live provider invocation borrows from its host.
 *
 * A workflow's retained state says which repository an effect belongs to. It
 * does not, and must not, say who this run is: an identity is a live property of
 * the machine the run is standing on, and a run resumed a week later on another
 * machine authenticates as whoever is there then. So nothing here is durable.
 * An attachment is built for one command, disposed with it, and never consulted
 * again — a completed replay restores its retained result without reaching this
 * module at all.
 *
 * ## Why the host decides, and the checkout cannot
 *
 * `host.ts` builds Git's environment from nothing precisely so a workflow's
 * behavior does not depend on whose machine created it. That is still true: a
 * credential is not general configuration, and admitting one does not admit the
 * rest. What crosses back from the invoking environment is a socket path, a
 * known-hosts file and one username and password for one exact locator. A
 * `~/.gitconfig` URL rewrite, a `core.hooksPath`, an `init.templateDir` and an
 * askpass program remain as absent as they were.
 *
 * The retained checkout has even less say. A `.git/config` a document wrote is
 * inside the Workspace and restored by replay, so a `credential.helper` or a
 * `core.sshCommand` in one would be document-authored data naming a program.
 * Both settings are therefore fixed on the command line — where they outrank
 * every configuration file — for every invocation that transports to a remote,
 * whether or not there was a credential to attach.
 *
 * ## What each transport borrows
 *
 * **SSH** borrows the agent, and only the agent. `HOME` is still the disposable
 * materialization, so no key file on the machine is reachable and no
 * `~/.ssh/config` is read; `IdentityAgent` names the ambient socket outright, so
 * the keys this run can offer are exactly the ones the invoking user has
 * unlocked. Host verification stays on and its material is the invoking user's
 * `known_hosts`, selected here rather than found: an unknown host is a refusal,
 * never a key accepted on this run's behalf.
 *
 * **HTTP** borrows one answer from a broker. The broker is where the invoking
 * user's own configuration is consulted, because that is where a credential
 * helper and a platform keychain live, and it is asked about one exact
 * credential-free locator. What comes back is checked against what was asked —
 * a helper that answers for another host has not authorized this one — and is
 * handed to the command through Git's own file-backed helper rather than
 * through an argument, a URL or a header, none of which stay out of the places
 * a credential may not reach.
 *
 * Acquisition only. XMD never approves, rejects or erases a stored credential:
 * a helper's own refresh is its business, and a run that failed to push has
 * learned nothing about whether the credential it borrowed should still exist.
 */

import { ensure, type Operation, resource, until } from "effection";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * The host-owned authentication a provider invocation may borrow.
 *
 * Injectable so a suite can prove which locator was asked about, that a replay
 * asks about none, and that one locator's answer never authorizes another —
 * without a public contextual surface existing for a document, a middleware or
 * another package to install, observe or route through.
 */
export interface GitAuthentication {
  /**
   * What to attach to one invocation transporting to this exact locator.
   *
   * Acquired inside the invocation's own scope, so whatever it had to write
   * down is gone when the command is.
   */
  acquire(locator: string): Operation<GitAttachment>;
}

/** Which ambient mechanism a locator's transport can use, if any. */
export type GitTransport = "ssh" | "http" | "none";

/** One credential-free locator, as a credential helper is asked about it. */
export interface CredentialRequest {
  /** `https` or `http`. The scheme is part of what is being asked about. */
  readonly protocol: string;
  /** Host and port, as they appear in the locator. */
  readonly host: string;
  /** The repository path, without its leading separator, or none. */
  readonly path?: string;
}

/** One answer a helper gave. Neither field is ever recorded anywhere. */
export interface GitCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * Where an HTTP credential comes from.
 *
 * The one place the invoking user's Git configuration is read, and the reason
 * it is a seam: a suite proves the shipped broker against a helper it wrote
 * into a fixture home, and proves everything downstream of it against an answer
 * it supplies directly. Neither reads a developer's real credential.
 */
export interface CredentialBroker {
  fill(request: CredentialRequest): Operation<GitCredential | undefined>;
}

const NOTHING: GitAttachment = Object.freeze({
  environment: Object.freeze({}),
  configuration: Object.freeze([]),
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

/**
 * The credential request this HTTP locator is, or `undefined` for none.
 *
 * The path travels with it. A helper only matches on it when the invoking user
 * asked for that, but asking about less than the whole locator would be asking
 * a different question than the one this invocation is about to perform.
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
 * a separator ends the reading rather than being skipped: what follows it is
 * not something whose meaning is still known.
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

/**
 * The invoking user's own Git, asked what it holds for one exact locator.
 *
 * `git credential fill` is the whole of the standard mechanism: it consults the
 * helpers the user configured, and those are what reach a platform keychain, a
 * cached token or a manager process. It runs with the invoking environment
 * because that is where those helpers are named — with terminal prompting and
 * both askpass hooks off, so an absent credential is an answer that comes back
 * rather than a run that stops on a question nobody is there for.
 *
 * It runs in a directory of its own, not in a checkout, so no repository's
 * retained configuration takes part in the question or in who answers it.
 */
export function denoCredentialBroker(
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): CredentialBroker {
  return {
    *fill(request: CredentialRequest): Operation<GitCredential | undefined> {
      return yield* resource<GitCredential | undefined>(function* (provide) {
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
        env["GIT_TERMINAL_PROMPT"] = "0";
        env["GIT_ASKPASS"] = "";
        env["SSH_ASKPASS"] = "";
        env["LC_ALL"] = "C";

        const outcome = yield* runProcess({
          command: "git",
          args: ["credential", "fill"],
          cwd: directory,
          env,
          input: credentialRecord({
            protocol: request.protocol,
            host: request.host,
            path: request.path,
          }),
        });
        if (outcome.code !== 0) {
          // No credential, a helper that failed and a helper that was
          // interrupted are the same answer here: this host cannot prove an
          // identity for this locator right now. What Git said about it is not
          // carried anywhere.
          yield* provide(undefined);
          return;
        }
        yield* provide(readCredential(outcome.stdout, request));
      });
    },
  };
}

/**
 * The credential in this answer, when the answer is about what was asked.
 *
 * Git echoes the request's own fields back beside the ones a helper supplied,
 * and a helper is free to rewrite them. A rewritten protocol or host means the
 * identity that came back belongs to somewhere else — which is exactly the
 * accident that would let a credential for one repository be sent to another.
 */
function readCredential(output: string, request: CredentialRequest): GitCredential | undefined {
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
  return Object.freeze({ username, password });
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
 */
function pinned(ssh: string, helper: string | undefined): readonly string[] {
  return [
    "-c",
    `core.sshCommand=${ssh}`,
    "-c",
    "credential.helper=",
    ...(helper === undefined ? [] : ["-c", `credential.helper=${helper}`]),
  ];
}

export interface GitAuthenticationOptions {
  /** The environment the ambient mechanisms are found in. */
  readonly ambient?: Readonly<Record<string, string | undefined>>;
  readonly broker?: CredentialBroker;
}

/**
 * The authentication the invoking host actually has.
 *
 * Lazy, and per invocation: nothing is read until a command that transports to
 * a remote is about to run, and what is read is about that command's own
 * locator. Two Repositories are two acquisitions even when the same helper
 * answers both — a credential obtained for one locator is never carried forward
 * as authority for another.
 */
export function denoGitAuthentication(options: GitAuthenticationOptions = {}): GitAuthentication {
  const ambient = options.ambient ?? process.env;
  const broker = options.broker ?? denoCredentialBroker(ambient);
  const ssh = sshCommand(ambient["HOME"], ambient["SSH_AUTH_SOCK"]);

  return {
    acquire(locator: string): Operation<GitAttachment> {
      return resource(function* (provide) {
        const transport = gitTransport(locator);
        if (transport === "none") {
          yield* provide(NOTHING);
          return;
        }
        if (transport === "ssh") {
          // The agent socket, and nothing else from the invoking environment.
          // `SSH_AUTH_SOCK` is also named in the command above, so this is what
          // makes the two agree rather than a second way to choose an agent.
          const socket = ambient["SSH_AUTH_SOCK"];
          yield* provide({
            environment: socket === undefined || socket === "" ? {} : { SSH_AUTH_SOCK: socket },
            configuration: pinned(ssh, undefined),
          });
          return;
        }

        const request = credentialRequest(locator);
        const credential = request === undefined ? undefined : yield* broker.fill(request);
        if (credential === undefined) {
          // An HTTP locator this host holds nothing for still gets the pinned
          // settings. Whether the remote needs a credential is the remote's to
          // say, and a public repository this way clones exactly as it did
          // before there was a broker to ask.
          yield* provide({ environment: {}, configuration: pinned(ssh, undefined) });
          return;
        }

        const directory = yield* until(mkdtemp(join(tmpdir(), "xmd-workflow-credential-")));
        yield* ensure(function* () {
          yield* until(rm(directory, { recursive: true, force: true }));
        });
        const file = join(directory, "credentials");
        // Git's own `store` helper, reading a file this invocation owns. The
        // alternative spellings all put the credential somewhere it may not be:
        // in the locator argument, in a header on the command line, or in an
        // askpass program written to disk for something else to execute.
        //
        // The file is created for reading and by nobody else — `mkdtemp` makes
        // a directory only this user may enter, and the mode says the same
        // thing about the file inside it.
        yield* until(
          writeFile(
            file,
            `${request?.protocol}://${encodeURIComponent(credential.username)}:` +
              `${encodeURIComponent(credential.password)}@${request?.host}\n`,
            { mode: 0o600 },
          ),
        );
        yield* provide({
          environment: {},
          // Quoted, because Git runs a relative helper name through the shell.
          configuration: pinned(ssh, `store --file=${quoted(file)}`),
        });
      });
    },
  };
}

/** The authentication of a host that lends none. */
export function noGitAuthentication(): GitAuthentication {
  return {
    // deno-lint-ignore require-yield
    *acquire(): Operation<GitAttachment> {
      return NOTHING;
    },
  };
}
