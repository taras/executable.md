/**
 * The harness the ordinary-run repository suites drive.
 *
 * Everything here is real: a real bare remote, a real working checkout the
 * command is "run in", real `git`, real advisory locks and a real managed root
 * in a temporary directory. What is substituted is only what a claim needs to
 * be deterministic about — the managed root, so no suite ever touches the
 * user's own `~/.xmd/repositories`, and the Git subprocess where a suite counts
 * invocations.
 *
 * There is no database, no journal and no WorkflowRun anywhere in this file.
 * That is the point of the profile: an ordinary run has none of them.
 */

import { scoped, spawn, suspend, until, withResolvers, type Operation } from "effection";
import { ensureDir, exists, lstat, readdir, readTextFile } from "@effectionx/fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import type { ComponentRegistration } from "@executablemd/core";
import { API, useHostFiles } from "@executablemd/runtime";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { Json } from "@executablemd/durable-streams";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { useCompositionComponents } from "../../src/composition/installation.ts";
import { RepositoryContext } from "../../src/composition/context.ts";
import type { RepositorySelection } from "../../src/composition/selection.ts";
import { denoRepositoryHost } from "../../src/deno/composition/host.ts";
import type { GitInvocation, GitOutcome, RepositoryHost } from "../../src/deno/composition/host.ts";
import { UNAUTHENTICATED } from "../../src/deno/composition/authentication.ts";
import type {
  GitAuthentication,
  GitAuthenticationSession,
} from "../../src/deno/composition/authentication.ts";
import type { IdentityReader } from "../../src/deno/run-composition/identity.ts";
import type { GitHubAccess, GitHubHttpResponse } from "../../src/deno/composition/github.ts";
import { useRunComposition } from "../../src/deno/run-composition/provider.ts";
import type { RunCompositionOptions } from "../../src/deno/run-composition/provider.ts";
import {
  checkoutOf,
  metadataOf,
  repositorySlot,
  worktreeSlot,
} from "../../src/deno/run-composition/placement.ts";
import { git } from "./git-remotes.ts";
import type { BareRemote } from "./git-remotes.ts";

/** A working checkout on this host, as if somebody had cloned it by hand. */
export interface HostCheckout {
  /** The canonical root of the checkout. */
  readonly root: string;
  /** The home Git runs with when this fixture drives it directly. */
  readonly home: string;
  /** Run a Git command in this checkout and answer what it printed. */
  run(...args: string[]): string;
}

/**
 * Clone `locator` into a directory the acquiring scope owns.
 *
 * Acquired in the caller's scope rather than a bounded one: the checkout is
 * what the whole test runs against, and a `scoped()` around this would remove
 * it before the first assertion.
 */
export function* useHostCheckout(locator: string, branch?: string): Operation<HostCheckout> {
  const home = yield* useTempDirectory("xmd-run-composition-");
  const parent = yield* useTempDirectory("xmd-host-");
  const resolved = yield* until(realpath(parent));
  const root = join(resolved, "checkout");
  git(["clone", "--", locator, root], resolved, home);
  if (branch !== undefined) {
    git(["checkout", "-B", branch], root, home);
  }
  return {
    root,
    home,
    run(...args: string[]): string {
      return git(args, root, home);
    },
  };
}

/** A Git checkout with no remote at all, made here rather than cloned. */
export function* useOriginlessCheckout(): Operation<HostCheckout> {
  const home = yield* useTempDirectory("xmd-run-composition-");
  const parent = yield* useTempDirectory("xmd-solo-");
  const resolved = yield* until(realpath(parent));
  const root = join(resolved, "checkout");
  git(["init", "--initial-branch=main", root], resolved, home);
  git(["commit", "--allow-empty", "-m", "first"], root, home);
  return {
    root,
    home,
    run(...args: string[]): string {
      return git(args, root, home);
    },
  };
}

/** A managed root of this suite's own, removed when the scope ends. */
export function* useManagedRoot(): Operation<string> {
  const created = yield* useTempDirectory("xmd-run-composition-");
  const root = join(yield* until(realpath(created)), "repositories");
  yield* ensureDir(root);
  return root;
}

/** What one ordinary execution reached, at the boundaries a claim is made at. */
export interface OrdinaryCounters {
  /** Every Git command, in order, as its argument list. */
  readonly commands: string[][];
  /** Every authentication session opened, by locator. */
  readonly sessions: string[];
}

export interface CountingOrdinaryHost {
  readonly host: RepositoryHost;
  readonly authentication: GitAuthentication;
  readonly counters: OrdinaryCounters;
}

/**
 * The production host, counted.
 *
 * Both leaves are wrapped rather than replaced: what a suite needs to know is
 * *whether* a credential was opened and *whether* a transport ran, and the only
 * honest way to answer is to let the real one happen and watch.
 */
export function countingOrdinaryHost(
  inner: RepositoryHost = denoRepositoryHost(),
): CountingOrdinaryHost {
  const counters: OrdinaryCounters = { commands: [], sessions: [] };
  return {
    counters,
    authentication: {
      *open(locator: string): Operation<GitAuthenticationSession> {
        counters.sessions.push(locator);
        return UNAUTHENTICATED;
      },
    },
    host: {
      *git(invocation: GitInvocation): Operation<GitOutcome> {
        counters.commands.push([...invocation.args]);
        return yield* inner.git(invocation);
      },
      useDirectory: inner.useDirectory,
      ...(inner.useAuthentication === undefined
        ? {}
        : { useAuthentication: inner.useAuthentication }),
    },
  };
}

/** The Git subcommands one execution issued, in order. */
export function subcommands(counters: OrdinaryCounters): string[] {
  return counters.commands.map((args) => args.find((arg) => !arg.startsWith("-")) ?? "");
}

/**
 * An identity reader that answers whatever a suite says this host knows.
 *
 * `undefined` for either variable is a host that cannot say who a commit would
 * be by, which is the one condition `<Git.Commit>` refuses on.
 */
export function statedIdentity(
  author: string | undefined,
  committer: string | undefined = author,
): IdentityReader {
  // deno-lint-ignore require-yield
  return function* (variable: string): Operation<string | undefined> {
    return variable === "GIT_AUTHOR_IDENT" ? author : committer;
  };
}

export interface RunOptions extends Omit<RunCompositionOptions, "root" | "cwd"> {
  /** The managed root this execution uses. */
  readonly root: string;
  /** The directory the command is run in, which ambient discovery starts from. */
  readonly cwd: string;
  /** Props the document is executed with. */
  readonly props?: Record<string, Json>;
  /** Extra components this execution registers, for a suite's own probes. */
  readonly components?: readonly ComponentRegistration[];
  /**
   * A Repository selection installed as the contextual one, ahead of the
   * document.
   *
   * The only thing a document could replace, and therefore what a suite hands
   * over to prove that replacing it buys nothing.
   */
  readonly contextualRepository?: RepositorySelection;
}

/**
 * Execute one document under the ordinary repository provider.
 *
 * The contextual working directory is installed to `cwd` first, exactly as a
 * runtime entrypoint's host filesystem provider would leave it, so a document's
 * root-level element is written "in" that directory.
 */
export function runOrdinaryDocument(source: string, options: RunOptions): Operation<Json> {
  return scoped(function* () {
    yield* API.Env.around(
      {
        // deno-lint-ignore require-yield
        *cwd(): Operation<string> {
          return options.cwd;
        },
      },
      { at: "min" },
    );
    // What a runtime entrypoint installs beside the provider: `API.Files` has
    // no host default, and a document that writes `<File>` must reach the
    // caller's own filesystem exactly as `xmd run` leaves it.
    yield* useHostFiles();
    yield* useCompositionComponents();
    const { root, cwd, props: _props, components, contextualRepository, ...rest } = options;
    yield* useRunComposition({ root, cwd, ...rest });
    if (components !== undefined) {
      yield* registerComponents([...components]);
    }
    if (contextualRepository !== undefined) {
      yield* RepositoryContext.around({ current: () => contextualRepository }, { at: "min" });
    }
    return yield* collect(
      yield* execute({
        ...inlineSource(source),
        stream: new InMemoryStream(),
        ...(options.props === undefined ? {} : { props: options.props }),
      }),
    );
  });
}

/** What a suite reads back about one managed slot. */
export interface ManagedSlot {
  readonly slot: string;
  readonly checkout: string;
  readonly metadata: string;
}

export function repositorySlotOf(root: string, locator: string, name: string): ManagedSlot {
  const slot = repositorySlot(root, locator, name);
  return { slot, checkout: checkoutOf(slot), metadata: metadataOf(slot) };
}

export function worktreeSlotOf(root: string, commonDirectory: string, name: string): ManagedSlot {
  const slot = worktreeSlot(root, commonDirectory, name);
  return { slot, checkout: checkoutOf(slot), metadata: metadataOf(slot) };
}

/** The parsed sidecar at this slot, or `undefined` when it holds none. */
export function* readSidecar(slot: ManagedSlot): Operation<unknown> {
  if (!(yield* exists(slot.metadata))) {
    return undefined;
  }
  return JSON.parse(yield* readTextFile(slot.metadata));
}

/** The canonical common Git directory of this checkout. */
export function commonDirectoryOf(checkout: HostCheckout): string {
  const reported = checkout.run("rev-parse", "--git-common-dir");
  const absolute = reported.startsWith("/") ? reported : join(checkout.root, reported);
  // Synchronous so a test body can name a slot in an ordinary expression, the
  // way it already names one from `git()`. Nothing is in flight to lose: this
  // is a fixture reading its own directory before an execution exists.
  // oxlint-disable-next-line local/no-sync-filesystem
  return realpathSync(absolute);
}

/** Whatever this operation raised, as a value. */
export function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
  } catch (error) {
    return error;
  }
  throw new Error("the operation did not fail");
}

/** The first cause in this error's chain that `is` accepts. */
export function causedBy<T>(error: unknown, is: (value: unknown) => value is T): T | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (is(current)) {
      return current;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Everything a directory holds, as one comparable value.
 *
 * Paths, kinds and content digests, sorted. A refusal that claims to change
 * nothing has to survive this: a comparison of "the checkout is still there"
 * would pass while a file inside it had been rewritten.
 */
export function* fingerprintTree(root: string): Operation<string[]> {
  if (!(yield* exists(root))) {
    return [];
  }
  const entries: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const name of yield* readdir(directory)) {
      const path = `${directory}/${name}`;
      const info = yield* lstat(path);
      const relative = path.slice(root.length + 1);
      if (info.isDirectory()) {
        entries.push(`d ${relative}`);
        pending.push(path);
        continue;
      }
      if (info.isSymbolicLink()) {
        entries.push(`l ${relative}`);
        continue;
      }
      const bytes = yield* until(readFile(path));
      entries.push(`f ${relative} ${createHash("sha256").update(bytes).digest("hex")}`);
    }
  }
  return entries.sort();
}

/**
 * What Git says this checkout holds right now.
 *
 * Deliberately the mutable half — HEAD, the branch, every ref, and the working
 * tree's own dirtiness — because that is what a refusal must not touch and what
 * a compatible reuse must preserve.
 */
export function gitStateOf(checkout: HostCheckout, directory: string = checkout.root): string[] {
  return [
    `head ${git(["rev-parse", "HEAD"], directory, checkout.home)}`,
    `branch ${git(["rev-parse", "--abbrev-ref", "HEAD"], directory, checkout.home)}`,
    `status ${git(["status", "--porcelain"], directory, checkout.home)}`,
    `refs ${git(["for-each-ref", "--format=%(refname) %(objectname)"], directory, checkout.home)}`,
  ];
}

/** A component that suspends forever, so a suite can halt an execution inside it. */
export function gateComponent(reached: () => void): ComponentRegistration {
  return {
    name: "Gate",
    origin: "test",
    props: { type: "object", additionalProperties: false },
    *fn(): Operation<string> {
      reached();
      yield* suspend();
      return "";
    },
  };
}

/**
 * Run a document that reaches `<Gate />`, then halt it there.
 *
 * The halt is the cancellation every persistence claim is made against: the
 * execution is torn down from outside, mid-document, with a component still in
 * flight.
 */
export function* haltAtGate(source: string, options: RunOptions): Operation<void> {
  const opened = withResolvers<void>();
  let reached = false;
  const task = yield* spawn(() =>
    scoped(function* () {
      yield* registerComponents([
        gateComponent(() => {
          if (!reached) {
            reached = true;
            opened.resolve();
          }
        }),
      ]);
      yield* runOrdinaryDocument(source, options);
    }),
  );
  yield* opened.operation;
  yield* task.halt();
}

/**
 * A host that answers for one locator while Git works against another.
 *
 * The ambient checkout records a `github.com` origin, because that is what the
 * pull-request adapter parses a repository out of; native Git is handed the
 * local bare repository instead, and what it prints is translated back. Exactly
 * one string moves in each direction — the same substitution the workflow
 * pull-request suites already run on.
 */
export function rewritingHost(
  named: string,
  actual: string,
  inner: RepositoryHost = denoRepositoryHost(),
): RepositoryHost {
  return {
    *git(invocation: GitInvocation): Operation<GitOutcome> {
      const outcome = yield* inner.git({
        ...invocation,
        args: invocation.args.map((argument) => (argument === named ? actual : argument)),
      });
      return { ...outcome, stdout: outcome.stdout.split(actual).join(named) };
    },
    useDirectory: inner.useDirectory,
  };
}

/** A checkout of `remote` that records `named` as its origin. */
export function* useNamedOriginCheckout(
  remote: BareRemote,
  named: string,
): Operation<HostCheckout> {
  const checkout = yield* useHostCheckout(remote.locator);
  checkout.run("remote", "set-url", "origin", named);
  return checkout;
}

/** One request a recording access received. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorized: boolean;
}

export interface RecordingAccess {
  readonly access: GitHubAccess;
  readonly requests: RecordedRequest[];
}

/**
 * A GitHub access that answers a fixed route table and records every request.
 *
 * Enough to say whether the transport was reached and with what, which is the
 * whole of what an ordinary-profile read has to prove: what a body normalizes
 * to belongs to the shared adapter's own suite.
 */
export function recordingAccess(
  bodies: Readonly<Record<string, string>>,
  endpoint = "https://api.github.test",
  token: string | undefined = "test-token",
): RecordingAccess {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    access: {
      endpoint,
      // deno-lint-ignore require-yield
      *token(): Operation<string | undefined> {
        return token;
      },
      // deno-lint-ignore require-yield
      *send(request): Operation<GitHubHttpResponse> {
        const path = new URL(request.url).pathname;
        requests.push({
          method: request.method,
          url: request.url,
          authorized: request.headers?.Authorization !== undefined,
        });
        const body = bodies[path];
        return body === undefined ? { status: 404, body: "{}" } : { status: 200, body };
      },
    },
  };
}
