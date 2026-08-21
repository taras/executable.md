/**
 * An invoking home whose Git already knows how to authenticate, and one that
 * does not.
 *
 * The shipped provider never receives a credential: it re-states the credential
 * helpers the invoking user configured, and Git asks them itself. So a suite
 * cannot inject an answer — it has to be the invoking user, which is what this
 * is. The helper is an ordinary program named by an ordinary `~/.gitconfig`,
 * and every secret in the exchange passes between Git and that program.
 *
 * Nothing here is ever asserted on. A remote reports whether what arrived was
 * the credential it requires; this end only makes one available.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
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

/**
 * A helper that answers for these hosts and no other.
 *
 * It reads the request Git writes to it, so which host it is being asked about
 * decides what it says — which is what makes "this host's authentication cannot
 * authorize somewhere else" an observable rather than an assumption. It answers
 * only `get`: `store` and `erase` produce nothing and change nothing.
 */
function helperProgram(known: readonly KnownHost[]): string {
  const branches = known.map(
    (entry) =>
      `    "${entry.host}|${entry.path ?? ""}")\n` +
      `      echo username=${entry.username}\n` +
      `      echo password=${entry.password}\n` +
      `      ;;`,
  );
  return [
    "#!/bin/sh",
    'if [ "$1" != "get" ]; then exit 0; fi',
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
}

/**
 * An invoking environment that has a configured credential helper.
 *
 * `PATH` is carried so Git and the helper's shell can be found; nothing else of
 * this process's environment is, so what the provider borrows is only what this
 * fixture put in front of it.
 */
export function* useInvokingHome(known: readonly KnownHost[]): Operation<InvokingHome> {
  const home = yield* useTempDirectory("xmd-invoking-home-");
  const helper = join(home, "credential-helper.sh");
  yield* until(writeFile(helper, helperProgram(known), { mode: 0o700 }));
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
    ambient: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      ...WITHOUT_MACHINE_CONFIGURATION,
    },
  };
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
    ambient: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      HOME: home,
      ...WITHOUT_MACHINE_CONFIGURATION,
    },
  };
}
