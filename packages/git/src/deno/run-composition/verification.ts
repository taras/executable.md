/**
 * Run the selected checkout's own configured signature verification for one
 * commit, when a `<Git.Commit ref verify={true}>` read asks for it.
 *
 * Every other read runs in an isolated view that consults none of the
 * checkout's configuration. This is the one exception, and the reason is the
 * question itself: what the person's Git configuration and installed verifier
 * say about a signature. So the command is
 * `git verify-commit <full id>` from the checkout root, under the caller's own
 * inherited environment — `HOME`, `GNUPGHOME`, the global and system
 * configuration, configuration passed through the environment, `PATH` and the
 * locale all keep their meaning, and a relative path in configuration keeps its
 * meaning against the checkout root.
 *
 * What is removed is what would make Git verify some other repository or some
 * other object: the variables that locate a Git directory, a work tree, an
 * index, an object store or a namespace are dropped, replace objects are
 * disabled so the object verified is the object read, and prompting, lazy
 * fetching and optional locks are off. Hooks and the filesystem monitor are
 * disabled on the command line. Nothing is configured and nothing is installed.
 *
 * Trusted-host code, selected by the entrypoint that installs a provider. Props,
 * Context and middleware cannot select or replace it.
 */

import type { Operation } from "effection";
import { stat } from "@effectionx/fs";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";
import { runProcess, runProcessChannels } from "../composition/subprocess.ts";

/** The signature formats Git verifies, named as `gpg.format` names them. */
export type CommitSignatureFormat = "openpgp" | "x509" | "ssh";

export interface CommitVerificationRequest {
  /** The canonical root of the selected checkout. */
  readonly root: string;
  /** The full object id the read resolved. */
  readonly commit: string;
  /**
   * The format of the commit's own signature, or `null` when it carries none
   * this host can name. Only a named format can make a verifier unavailable.
   */
  readonly format: CommitSignatureFormat | null;
}

/** What one configured verification reported, with both channels as bytes. */
export interface CommitVerificationReceipt {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  /** Whether the failure was the configured program for that format being absent. */
  readonly verifierUnavailable: boolean;
}

/** How a host verifies one commit under its own configuration. */
export type CommitVerifier = (
  request: CommitVerificationRequest,
) => Operation<CommitVerificationReceipt>;

/** Variables that would point Git at another repository, index or object store. */
const LOCATING: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
];

const STATED: Readonly<Record<string, string>> = {
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
};

const OPTIONS: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** Where each format's program is configured, and what Git runs when nothing is. */
const PROGRAMS: Readonly<
  Record<CommitSignatureFormat, { readonly keys: readonly string[]; readonly fallback: string }>
> = {
  openpgp: { keys: ["gpg.openpgp.program", "gpg.program"], fallback: "gpg" },
  x509: { keys: ["gpg.x509.program"], fallback: "gpgsm" },
  ssh: { keys: ["gpg.ssh.program"], fallback: "ssh-keygen" },
};

function environment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !LOCATING.includes(name)) {
      inherited[name] = value;
    }
  }
  return { ...inherited, ...STATED };
}

/**
 * The program Git would run to verify this format, as configuration names it.
 *
 * `gpg.program` and `gpg.openpgp.program` are aliases, and Git keeps whichever
 * one it reads last, across every scope and include. So both are read together,
 * in Git's own reading order, and the last one wins, rather than preferring one
 * name.
 */
function* configuredProgram(
  root: string,
  env: Record<string, string>,
  format: CommitSignatureFormat,
): Operation<string> {
  const { keys, fallback } = PROGRAMS[format];
  const pattern = `^(${keys.map((key) => key.replaceAll(".", "\\.")).join("|")})$`;
  const answered = yield* runProcess({
    command: "git",
    args: [...OPTIONS, "config", "--null", "--get-regexp", pattern],
    cwd: root,
    env,
  });
  if (answered.code !== 0) {
    return fallback;
  }
  let program = fallback;
  for (const entry of answered.stdout.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline >= 0 && newline < entry.length - 1) {
      program = entry.slice(newline + 1);
    }
  }
  return program;
}

function* executableFile(path: string): Operation<boolean> {
  try {
    const info = yield* stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Whether no executable regular file exists for this program.
 *
 * A name holding a `/` is a path, resolved against the checkout root when it is
 * relative, because that is the directory Git ran in. A bare name is searched on
 * the inherited `PATH`.
 */
function* unavailable(
  root: string,
  env: Record<string, string>,
  program: string,
): Operation<boolean> {
  if (program.includes("/")) {
    return !(yield* executableFile(isAbsolute(program) ? program : join(root, program)));
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (yield* executableFile(join(directory === "" ? root : directory, program))) {
      return false;
    }
  }
  return true;
}

/** The verifier a trusted entrypoint installs: native Git, the caller's environment. */
export function denoCommitVerifier(): CommitVerifier {
  return function* ({ root, commit, format }): Operation<CommitVerificationReceipt> {
    const env = environment();
    const outcome = yield* runProcessChannels({
      command: "git",
      args: [...OPTIONS, "verify-commit", commit],
      cwd: root,
      env,
    });
    // Neither an exit status nor a diagnostic says why verification failed: a
    // missing key, an untrusted principal and a missing program all exit 1, in
    // whatever language the locale chose. Only the program itself can say it is
    // not there.
    const verifierUnavailable =
      format !== null &&
      outcome.code !== 0 &&
      (yield* unavailable(root, env, yield* configuredProgram(root, env, format)));
    return {
      exitCode: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      verifierUnavailable,
    };
  };
}
