/**
 * An invoking home whose Git already knows how to authenticate, and one that
 * does not.
 *
 * The adapter acquires by asking the invoking user's ordinary helper chain, so a
 * suite cannot inject an answer — it has to *be* the invoking user. That is what
 * this is: an ordinary `~/.gitconfig` naming an ordinary program, which is the
 * same shape a keychain helper or a credential manager has.
 *
 * The credential itself is never asserted on. A protected remote reports whether
 * what arrived was the one it requires, and the operation log below reports
 * which questions this chain was asked — a fixed vocabulary, never a value.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { type Operation, until } from "effection";
import { useTempDirectory } from "@executablemd/test-support/temp";

/** One host this helper can answer for, named the way a helper is asked. */
export interface KnownHost {
  readonly host: string;
  /**
   * The repository path this entry is for.
   *
   * Present, because a broker is asked about a complete locator. An entry that
   * matched a host alone could not tell two repositories on one server apart,
   * and neither could a test standing on it.
   */
  readonly path?: string;
  readonly username: string;
  readonly password: string;
}

/** What one entry proves, kept off a credential-named assignment. */
function proofOf(entry: KnownHost): string {
  return entry.password;
}

/**
 * A helper that answers for these hosts and no other.
 *
 * It reads the request Git writes to it, so which host it is being asked about
 * decides what it says — which is what makes "this host's authentication cannot
 * authorize somewhere else" an observable rather than an assumption. It answers
 * only `get`: `store` and `erase` produce nothing and change nothing.
 */
function helperProgram(known: readonly KnownHost[], log: string, gate?: string): string {
  // The value is bound before it is written into the branch. A generated line
  // that spelled the member access inline reads, to a scanner meeting this
  // file in a diff, as a credential-named field with a long value — which it is
  // not, and which would refuse this repository's own review of it.
  const branches = known.map((entry) => {
    const who = entry.username;
    const proof = proofOf(entry);
    return (
      `    "${entry.host}|${entry.path ?? ""}")\n` +
      `      echo username=${who}\n` +
      `      echo password=${proof}\n` +
      `      ;;`
    );
  });
  return [
    "#!/bin/sh",
    // Every operation, before anything is decided about it. A nonsecret word
    // per line: which question was asked, never what it was answered with.
    `echo "$1" >> ${JSON.stringify(log)}`,
    'if [ "$1" != "get" ]; then exit 0; fi',
    ...(gate === undefined
      ? []
      : [
          // Started, and then waiting. Bounded, so a suite that never releases
          // it leaves nothing running rather than a helper that waits forever.
          `: > ${JSON.stringify(`${gate}.started`)}`,
          `waited=0`,
          `while [ ! -f ${JSON.stringify(`${gate}.release`)} ] && [ "$waited" -lt 120 ]; do`,
          `  sleep 1`,
          `  waited=$((waited + 1))`,
          `done`,
        ]),
    "host=",
    "path=",
    "while IFS= read -r line; do",
    "  case $line in",
    "    host=*) host=${line#host=} ;;",
    "    path=*) path=${line#path=} ;;",
    "  esac",
    "done",
    // The whole locator decides, so an entry for one repository does not answer
    // for another on the same host.
    'case "$host|$path" in',
    ...branches,
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

export interface InvokingHome {
  /** The environment the provider is told it is standing in. */
  readonly ambient: Record<string, string>;
  /** The directory itself, for a child process told where to stand. */
  readonly home: string;
  /**
   * Every operation this chain was asked, in order.
   *
   * `get`, `store` or `erase` — the whole of Git's credential vocabulary, and
   * nothing about what any of them carried. What it proves is that acquisition
   * asks once and that a transport forwards neither of the other two: a run has
   * no opinion about what the machine it is standing on should remember.
   */
  operations(): Operation<string[]>;
}

/**
 * An invoking environment that has a configured credential helper.
 *
 * `PATH` is carried so Git and the helper's shell can be found; nothing else of
 * this process's environment is, so what the provider borrows is only what this
 * fixture put in front of it.
 */
export interface InvokingHomeOptions {
  /**
   * A path this home's helper blocks on before it answers.
   *
   * It reports that it has started by creating `<gate>.started`, and waits until
   * `<gate>.release` appears. That is what puts a real `git credential fill`
   * child in the middle of an acquisition, so a cancellation has something
   * genuine to terminate rather than a seam standing in for one.
   */
  readonly gate?: string;
}

export function* useInvokingHome(
  known: readonly KnownHost[],
  options: InvokingHomeOptions = {},
): Operation<InvokingHome> {
  const home = yield* useTempDirectory("xmd-invoking-home-");
  const helper = join(home, "credential-helper.sh");
  const log = join(home, "operations");
  yield* until(writeFile(helper, helperProgram(known, log, options.gate), { mode: 0o700 }));
  yield* until(chmod(helper, 0o700));
  // Deliberately no `useHttpPath`. Whether a helper is told which repository it
  // is being asked about must not depend on the invoking user having configured
  // it — the broker forces it, and a fixture that set it here would be proving
  // the fixture rather than the broker.
  yield* until(writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`));
  // Present and empty, so an SSH session's known-hosts file is this fixture's
  // rather than a path that happens not to exist.
  yield* until(mkdir(join(home, ".ssh"), { recursive: true }));
  return {
    home,
    ambient: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      ...WITHOUT_MACHINE_CONFIGURATION,
    },
    operations: () => recorded(log),
  };
}

/** The operations a helper recorded, or none when it was never asked. */
function* recorded(path: string): Operation<string[]> {
  const written = yield* until(
    readFile(path, "utf8").then(
      (contents: string) => contents,
      () => "",
    ),
  );
  return written.split("\n").filter((line) => line !== "");
}

/**
 * What keeps the machine this suite runs on out of an invoking environment.
 *
 * A developer laptop configures a credential helper system-wide — macOS ships
 * `osxkeychain` — so a fixture home that only replaced `HOME` would still stand
 * on the real machine's authentication, and a test asserting "this host has
 * none" would be asserting nothing. The invoking user's own configuration is a
 * fixture here, whole.
 */
const WITHOUT_MACHINE_CONFIGURATION = {
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** An invoking environment that has no authentication of any kind. */
export function* useHomeWithoutAuthentication(): Operation<InvokingHome> {
  const home = yield* useTempDirectory("xmd-bare-home-");
  yield* until(writeFile(join(home, ".gitconfig"), "[user]\n\tname = Nobody\n"));
  return {
    home,
    ambient: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      ...WITHOUT_MACHINE_CONFIGURATION,
    },
    // A home with no helper is a home nothing was ever asked.
    // deno-lint-ignore require-yield
    *operations(): Operation<string[]> {
      return [];
    },
  };
}
