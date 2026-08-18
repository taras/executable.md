/**
 * Decide whether this pull request may claim `green`, and say why either way.
 *
 * What this decides lives in `lib/main-green.ts`; what it parses lives in
 * `lib/github.ts`. What is left here is the one thing neither can hold: the
 * process that actually runs `gh`.
 */
import { exit, main } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";

import { announce, mainGreen, Reads } from "./lib/main-green.ts";
import { Gh, githubReads, quietPayloads } from "./lib/github.ts";

main(function* () {
  const repo = Deno.env.get("GITHUB_REPOSITORY");
  if (repo === undefined) {
    throw new Error("GITHUB_REPOSITORY is not set");
  }

  // An empty array is how a pull request with no labels spells itself, so an
  // unset variable is the workflow failing to pass one rather than a bare
  // pull request.
  const labels = Deno.env.get("PULL_REQUEST_LABELS");
  if (labels === undefined) {
    throw new Error("PULL_REQUEST_LABELS is not set");
  }

  yield* quietPayloads();

  const gh = {
    *run(args: string[]): Operation<string> {
      return (yield* exec("gh", { arguments: args }).expect()).stdout;
    },
  };

  const cleared = yield* Gh.with(gh, () => Reads.with(githubReads(repo), () => mainGreen(labels)));

  if (cleared.ok) {
    console.log(announce(cleared.value));
    return;
  }

  console.log(`::error::${cleared.error.message}`);
  yield* exit(1);
});
