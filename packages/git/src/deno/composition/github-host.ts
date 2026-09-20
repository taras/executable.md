/**
 * The Deno host's half of the GitHub adapter.
 *
 * Concrete environment access, the credential-helper invocation, a temporary
 * working directory and the platform's own `fetch` — the four things that are
 * this runtime's rather than GitHub's. The protocol beside it knows none of
 * them: it is handed a `GitHubAccess` and asks it for answers, which is what
 * lets the same implementation be driven by a suite's transport with no host
 * involved at all.
 *
 * Nothing here runs at import. A credential is read and a request is made by
 * the first invoked operation that needs one, and not before.
 */

import { call, ensure, resource, scoped, until } from "effection";
import type { Operation } from "effection";
import { tmpdir } from "node:os";
import process from "node:process";
import { runProcess } from "./subprocess.ts";
import {
  GITHUB_API,
  gitHubSource,
  type GitHubAccess,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubLogin,
  type GitHubSource,
} from "./github.ts";

/** The hostname the shipped login is asked about, fixed. */
const GITHUB_HOST = "github.com";

/**
 * The GitHub CLI's own stored credential.
 *
 * The third source, and the one that makes an already authenticated machine
 * work without a second setup: `gh auth login` is what a person on this host
 * has almost certainly already done, and asking `gh` for the token is asking
 * the same broker every other tool on that machine asks.
 *
 * It is asked about `github.com` outright rather than about whatever endpoint
 * an adapter was built with. A substituted endpoint is a test's local server,
 * and handing a real host's credential to one would be the accident this whole
 * boundary exists to prevent.
 *
 * A `gh` that is absent, unauthenticated or unreadable is no credential. None
 * of those is an error to raise: they are answers the caller already has a word
 * for, and what `gh` printed about it travels nowhere.
 */
export function denoGitHubLogin(
  ambient: Readonly<Record<string, string | undefined>> = process.env,
): GitHubLogin {
  return {
    *token(): Operation<string | undefined> {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(ambient)) {
        if (value !== undefined) {
          env[name] = value;
        }
      }
      let outcome: { code: number; stdout: string };
      try {
        outcome = yield* runProcess({
          command: "gh",
          args: ["auth", "token", "--hostname", GITHUB_HOST],
          cwd: tmpdir(),
          env,
        });
      } catch {
        // A `gh` that is not on this machine at all.
        return undefined;
      }
      if (outcome.code !== 0) {
        return undefined;
      }
      const printed = outcome.stdout.trim();
      // One word, or nothing. A token with a space in it is not one this
      // adapter puts in a header, and anything `gh` printed around one is not
      // something to guess the shape of.
      return printed === "" || /\s/.test(printed) ? undefined : printed;
    },
  };
}

/**
 * Where a live invocation gets its access, without holding one.
 *
 * A source is credential-free and long-lived: an installed middleware or a
 * provider module may hold one for as long as it likes, because there is nothing
 * in one to retain. A *session* is what has an identity, and one is opened per
 * live invocation — after that invocation's ceiling and local admission checks
 * — and disposed with it. Two calls are two sessions, so an observation and the
 * mutation it decided go out under one identity while two unrelated invocations
 * never share one.
 */

/** The shipped source: the platform's transport and this host's credentials. */
export function denoGitHubSource(
  endpoint: string = GITHUB_API,
  options: GitHubAccessOptions = {},
): GitHubSource {
  return gitHubSource(denoGitHubAccess(endpoint, options));
}

export interface GitHubAccessOptions {
  /** Where the two explicit variables are read from. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** The Git-host login consulted when neither variable names a credential. */
  readonly login?: GitHubLogin;
}

/**
 * The platform's own transport and environment.
 *
 * The request is aborted when the scope around it ends, so a cancelled
 * invocation tears its HTTP down rather than leaving it to finish somewhere
 * nobody is listening.
 */
export function denoGitHubAccess(
  endpoint: string = GITHUB_API,
  options: GitHubAccessOptions = {},
): GitHubAccess {
  const environment = options.environment ?? process.env;
  const login = options.login ?? denoGitHubLogin(environment);
  return {
    endpoint,
    *token(): Operation<string | undefined> {
      // Three sources, in this order. The two variables are what a caller says
      // outright, and they are answered without consulting anything else — an
      // empty one included, because a variable set to nothing is an explicit
      // "no credential" rather than an invitation to look elsewhere. Only when
      // neither is set at all is the machine's own login asked.
      const supplied = environment["GH_TOKEN"] ?? environment["GITHUB_TOKEN"];
      if (supplied !== undefined) {
        return supplied === "" ? undefined : supplied;
      }
      return yield* login.token();
    },
    *send(request: GitHubHttpRequest): Operation<GitHubHttpResponse> {
      return yield* scoped(function* () {
        const controller = new AbortController();
        yield* ensure(() => controller.abort());
        const response = yield* until(
          fetch(request.url, {
            method: request.method,
            headers: { ...request.headers },
            body: request.body,
            signal: controller.signal,
          }),
        );
        const body = yield* until(response.text());
        const link = response.headers.get("link");
        return { status: response.status, body, link: link === null ? undefined : link };
      });
    },
  };
}
