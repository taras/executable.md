/**
 * Which Issue providers a Deno workflow host installs, and what they may reach.
 *
 * Installation is where the ceiling is decided. A document names a destination
 * through lexical context, and that context is replaceable by anything running
 * in the document — so the answer to "may this run create an issue there" is
 * not the context's to give. It is given here, beside the credential, as a list
 * of containers the host authorizes, and every provider admits its request
 * against it before observing anything.
 *
 * Providers are installed side by side rather than chosen between. Each answers
 * only requests whose resolved discriminator is its own and delegates the rest
 * untouched, so installing a second one adds an option without changing what
 * the first receives.
 */

import type { Operation } from "effection";
import { useIssueProvider } from "../../issue/effect.ts";
import { IssueTrackerContext } from "../../issue/context.ts";
import { builtInIssueProvider } from "./resolution.ts";
import type { IssueProvider } from "../../issue/api.ts";
import type { GitHubAccess } from "../composition/github.ts";
import { GITHUB, gitHubIssueProvider } from "./github.ts";

/** One provider installed under one discriminator. */
export interface InstalledIssueProvider {
  readonly discriminator: string;
  readonly provider: IssueProvider;
}

export interface IssueProviderOptions {
  /**
   * The containers this host authorizes, canonical.
   *
   * Absent installs no GitHub provider at all, which is what an ordinary run
   * with no issue configuration should be: a document that writes `<Issue>`
   * there is refused by the routing surface's own default rather than reaching
   * a provider that would then have to decide.
   */
  readonly ceiling?: readonly string[];
  /** The Git host access the GitHub provider uses, when not the platform's. */
  readonly gitHub?: GitHubAccess;
  /**
   * Further providers this host installs.
   *
   * The seam a second production adapter arrives through, and the one a suite
   * uses to prove that two providers installed together receive only their own
   * requests.
   */
  readonly providers?: readonly InstalledIssueProvider[];
}

/** Install this run's Issue providers for the current scope and below. */
export function* useIssueProviders(options: IssueProviderOptions = {}): Operation<void> {
  // Beside the adapters, because the table of well-known hosts is host policy.
  // It answers the resolution alone and leaves the target a context supplies to
  // whatever installed one further in.
  yield* IssueTrackerContext.around(
    {
      // deno-lint-ignore require-yield
      *resolve([target]): Operation<string | undefined> {
        return builtInIssueProvider(target);
      },
    },
    { at: "min" },
  );
  for (const installed of options.providers ?? []) {
    yield* useIssueProvider(installed.discriminator, installed.provider);
  }
  if (options.ceiling !== undefined) {
    yield* useIssueProvider(
      GITHUB,
      gitHubIssueProvider({ ceiling: options.ceiling, access: options.gitHub }),
    );
  }
}
