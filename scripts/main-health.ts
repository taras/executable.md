/**
 * Run one reconciliation of the `ci-main-red` report against `main`'s
 * authoritative CI state.
 *
 * What this decides lives in `lib/main-health.ts`; what it parses lives in
 * `lib/github.ts`. What is left here is the one thing neither can hold: the
 * process that actually runs `gh`.
 */
import { main } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";

import { Issues, mainHealth, Reads } from "./lib/main-health.ts";
import { Gh, githubIssues, githubReads, quietPayloads } from "./lib/github.ts";

main(function* () {
  const repo = Deno.env.get("GITHUB_REPOSITORY");
  if (repo === undefined) {
    throw new Error("GITHUB_REPOSITORY is not set");
  }

  yield* quietPayloads();

  const gh = {
    *run(args: string[]): Operation<string> {
      return (yield* exec("gh", { arguments: args }).expect()).stdout;
    },
  };

  const decision = yield* Gh.with(gh, () =>
    Reads.with(githubReads(repo), () => Issues.with(githubIssues(repo), mainHealth)),
  );

  console.log(`report: ${decision.report}, assignment: ${decision.assignment ?? "none"}`);
});
