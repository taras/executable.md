/**
 * The provider-owned credential helper, and how a host assembles one.
 *
 * The trusted adapter holds one HTTP credential in memory for one live provider
 * invocation. This is the only way that credential ever leaves the adapter: a
 * helper Git runs, in a private child environment the adapter built, answering
 * one exact locator.
 *
 * ## What the helper is for
 *
 * Git decides what to ask about — after a redirect, that is wherever it arrived
 * rather than where the invocation was authorized for. So the helper compares
 * what it was asked against the locator this invocation acquired for, and a
 * question about another protocol, host, port or repository path is answered
 * with nothing. That is what makes a redirected transport fail closed instead of
 * carrying this run's identity somewhere it was never granted.
 *
 * ## What it will not do
 *
 * `store` and `approve` do nothing at all, and neither reaches an ambient helper
 * or a credential store: this run has no opinion about what should be remembered
 * on the machine it is standing on. `erase` for the exact locator writes a fixed,
 * nonsecret marker and nothing else — it is how the adapter learns the transport
 * refused what it was given, which is a live authentication condition rather
 * than a locator that names nothing. An `erase` about anywhere else does
 * nothing, so a redirect cannot make this run report a rejection it never had.
 *
 * ## Why the assembly is injected
 *
 * A host knows what it is; a library guessing from an executable's name does
 * not. The runtime entrypoints state whether they are Deno source or a compiled
 * binary, and which platform's launcher to write, because both are facts about
 * the program that is running rather than something to infer at the moment a
 * credential is needed.
 */

import { type Operation, until } from "effection";
import { writeFile } from "node:fs/promises";
import process from "node:process";

/** The private variables a helper is given, and nothing else. */
export const HELPER_VARIABLES = Object.freeze({
  username: "XMD_HTTP_CREDENTIAL_USERNAME",
  password: "XMD_HTTP_CREDENTIAL_PASSWORD",
  protocol: "XMD_HTTP_CREDENTIAL_PROTOCOL",
  host: "XMD_HTTP_CREDENTIAL_HOST",
  path: "XMD_HTTP_CREDENTIAL_PATH",
  marker: "XMD_HTTP_CREDENTIAL_MARKER",
  /**
   * Where the helper records that it ran at all.
   *
   * The one way an invocation can tell a helper that declined from a helper
   * that never started. Both leave Git unable to authenticate, but the first is
   * a host that holds nothing and the second is a host that could not run its
   * own program — and those are not the same answer.
   */
  invoked: "XMD_HTTP_CREDENTIAL_INVOKED",
});

/** The argument that selects the internal helper mode. */
export const HELPER_MODE = "__xmd-credential-helper";

/** What a host is, said by the host rather than inferred. */
export type HelperRuntime = "source" | "compiled";
export type HelperPlatform = "unix" | "windows";

export interface HelperAssembly {
  readonly runtime: HelperRuntime;
  readonly platform: HelperPlatform;
  /** The executable that runs this host's own code. */
  readonly execPath: string;
  /** The module that carries the helper mode. Source hosts only. */
  readonly modulePath?: string;
  /**
   * What the launcher needs to be able to start this host's own runtime.
   *
   * Nonsecret host paths — where a source runtime keeps its module cache, and
   * the home it looks in for one. The Git command a launcher is installed on
   * runs in a built environment with none of that in it, so a launcher that
   * relied on inheriting it would work only when the run happened to be started
   * somewhere convenient. Nothing about a credential or a locator is here.
   */
  readonly launcherEnvironment?: Readonly<Record<string, string>>;
}

/** What the launcher this assembly writes will execute. */
export function helperCommand(assembly: HelperAssembly): readonly string[] {
  return assembly.runtime === "compiled"
    ? [assembly.execPath, HELPER_MODE]
    : [assembly.execPath, "run", "--allow-all", assembly.modulePath ?? "", HELPER_MODE];
}

/** What a launcher file is called on this platform. */
export function launcherName(assembly: HelperAssembly): string {
  return assembly.platform === "windows" ? "credential-helper.cmd" : "credential-helper";
}

/**
 * The launcher this platform runs.
 *
 * A file rather than a command line, because Git executes a helper by name and a
 * command line is what a process listing shows. Neither the credential, the
 * locator nor the marker is in it — all three reach the helper through the
 * private environment of the Git command that installed it, so a launcher that
 * outlived its invocation is a program that can answer nothing.
 *
 * Windows gets a batch file. A `#!` line means nothing there, and a shell that
 * is not present cannot be the thing that starts a credential helper.
 */
export function launcherProgram(assembly: HelperAssembly): string {
  const words = helperCommand(assembly);
  const carried = Object.entries(assembly.launcherEnvironment ?? {});
  if (assembly.platform === "windows") {
    const sets = carried.map(([name, value]) => `set "${name}=${value}"\r\n`).join("");
    return `@echo off\r\n${sets}${words.map((word) => `"${word}"`).join(" ")} %*\r\n`;
  }
  const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
  const exports = carried
    .map(([name, value]) => `${name}=${quote(value)}\nexport ${name}\n`)
    .join("");
  return `#!/bin/sh\n${exports}exec ${words.map(quote).join(" ")} "$@"\n`;
}

/** The fields Git wrote, as far as they can be read. */
function readRequest(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return fields;
}

/** Whether this question is about the exact locator the invocation acquired for. */
export function asksAbout(
  environment: Readonly<Record<string, string | undefined>>,
  asked: Map<string, string>,
): boolean {
  const wanted = environment[HELPER_VARIABLES.path] ?? "";
  return (
    asked.get("protocol") === environment[HELPER_VARIABLES.protocol] &&
    // Git writes the port into `host` when there is one, which is what makes an
    // explicit port part of what is compared.
    asked.get("host") === environment[HELPER_VARIABLES.host] &&
    (asked.get("path") ?? "") === wanted &&
    wanted !== ""
  );
}

/**
 * Answer one credential request the way Git asks it.
 *
 * Nothing is a complete answer in Git's protocol: a helper that prints no
 * username and no password has declined, and Git goes on to whatever is next —
 * which, with prompting off and no other helper installed, is a refusal this run
 * can state.
 */
export function answerCredentialRequest(
  operation: string,
  input: string,
  environment: Readonly<Record<string, string | undefined>>,
  mark: (path: string) => void,
): string {
  const asked = readRequest(input);
  if (!asksAbout(environment, asked)) {
    // Including every `store`, `approve` and `erase` about somewhere else.
    return "";
  }
  if (operation === "erase") {
    const marker = environment[HELPER_VARIABLES.marker];
    if (marker !== undefined && marker !== "") {
      mark(marker);
    }
    return "";
  }
  if (operation !== "get") {
    return "";
  }
  const username = environment[HELPER_VARIABLES.username];
  const password = environment[HELPER_VARIABLES.password];
  return username === undefined || password === undefined
    ? ""
    : `username=${username}\npassword=${password}\n`;
}

/**
 * Everything on standard input, which Git closes when it has finished.
 *
 * A stream error is raised rather than read as an empty request. Empty is a
 * question about nothing, which this helper answers by declining — and a helper
 * that declined because its input broke would be reporting "no credential" for
 * an infrastructure failure.
 */
function readAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffered += chunk;
    });
    process.stdin.on("end", () => resolve(buffered));
    process.stdin.on("error", (error: Error) => reject(error));
  });
}

/** Whether these arguments select the internal helper mode. */
export function isCredentialHelperMode(argv: readonly string[]): boolean {
  return argv[0] === HELPER_MODE;
}

/**
 * Run the internal helper mode, to completion.
 *
 * An operation rather than a detached promise: reading the request, writing the
 * marker and writing the answer are the whole of what this program does, and a
 * failure in any of them is a helper that did not do its job. A marker write
 * that failed in the background would leave a rejection unrecorded and the run
 * reporting that nothing was refused.
 *
 * An internal execution mode, not a command: it appears in no help and in no
 * public grammar, it is dispatched before anything public is parsed, and without
 * the private environment its invocation built it has nothing to answer with.
 */
export function* runCredentialHelper(argv: readonly string[]): Operation<void> {
  const operation = argv[1] ?? "";
  const input = yield* until(readAll());
  // Recorded before anything is decided, so it says this program ran rather
  // than that it agreed to anything.
  const ran = process.env[HELPER_VARIABLES.invoked];
  if (ran !== undefined && ran !== "") {
    yield* until(writeFile(ran, "invoked\n", { mode: 0o600 }));
  }
  let marked: string | undefined;
  const answer = answerCredentialRequest(operation, input, process.env, (path) => {
    marked = path;
  });
  if (marked !== undefined) {
    // A fixed, nonsecret byte. What it records is that a rejection happened,
    // never what was rejected. A failure to record it is this helper failing.
    yield* until(writeFile(marked, "rejected\n", { mode: 0o600 }));
  }
  if (answer !== "") {
    process.stdout.write(answer);
  }
}
