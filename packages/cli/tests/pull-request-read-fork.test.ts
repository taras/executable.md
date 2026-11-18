/**
 * Tier PRR — a fork that inherits a completed pull-request read.
 *
 * The question is what a fork does with retained evidence at a durable position
 * it inherits. Answering it needs a checkpoint *after* the read, not before: a
 * fork that begins earlier never presents the retained result to anything,
 * and would prove nothing about either branch.
 *
 * Both branches matter, and the control is what keeps the other honest. If the
 * unchanged fork could not restore the read, the changed one would
 * "diverge" for reasons that have nothing to do with the URL.
 *
 * The run is the real binary, so the endpoint has to be a socket: there is no
 * seam to inject a transport into a child process. `XMD_WORKFLOW_GITHUB_PULL_REQUESTS`
 * is how an operator points this host somewhere, and it is how this suite does.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, type Operation, scoped } from "effection";
import { exec } from "@effectionx/process";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@executablemd/test-support/launch";
import { usePullRequestServer } from "./support/pull-request-server.ts";
import type { PullRequestServer } from "./support/pull-request-server.ts";

const DEFINITION = "flows/review.md";
const TOKEN = "pull-request-server-credential";

const SEVEN = "https://github.com/octo/project/pull/7";
const EIGHT = "https://github.com/octo/project/pull/8";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

/**
 * A definition whose read is driven by a property.
 *
 * The URL is a root prop precisely so a fork can override it — which is the
 * only supported way to reach the same durable position with a different
 * request. Editing the document would be a different definition.
 */
function sourceOf(read: string, output: string): string {
  return [
    "---",
    "props:",
    `  url: { type: string, default: "${SEVEN}" }`,
    "---",
    "",
    read,
    "",
    output,
    "",
  ].join("\n");
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(source: string, body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-prr-fork-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-prr@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier PRR"]);
    const path = join(fixture.repository, DEFINITION);
    yield* ensureDir(join(path, ".."));
    yield* writeTextFile(path, source);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "flow"]);

    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, server: PullRequestServer, args: string[]) {
  return runCli(args, {
    cwd: fixture.repository,
    env: {
      HOME: fixture.home,
      XMD_WORKFLOW_RUNS: fixture.runs,
      XMD_EXPERIMENTAL_WORKFLOW: "1",
      GH_TOKEN: TOKEN,
      XMD_WORKFLOW_GITHUB_PULL_REQUESTS: JSON.stringify({
        allowed: ["https://github.com/octo/project"],
        endpoint: server.url,
      }),
    },
  });
}

interface HistoryRow {
  readonly eventId: string;
  readonly event: {
    readonly type: string;
    readonly description?: { readonly type: string };
  };
  readonly forkability: {
    readonly forkable: boolean;
    readonly blockers?: readonly { readonly code: string }[];
  };
}

function* history(
  fixture: Fixture,
  server: PullRequestServer,
  runId: string,
): Operation<HistoryRow[]> {
  const answered = yield* xmd(fixture, server, ["workflow", "history", runId, "--json"]).join();
  expect(answered.code).toBe(0);
  return JSON.parse(answered.stdout);
}

describe("Tier PRR — forking a run that already read a pull request", () => {
  const originalBody = "Original pull request description";
  const originalReviews = ["ship it", "one note"];
  const cases = [
    {
      kind: "reviews",
      read: '<PullRequest.Reviews url={props.url} as="reviews" />',
      output: "reviews: {reviews.length}",
      original: "reviews: 2",
      route: "/repos/octo/project/pulls/7/reviews",
    },
    {
      kind: "details",
      read: '<PullRequest url={props.url} as="pr" />',
      output: "body: {pr.value.body}",
      original: `body: ${originalBody}`,
      route: "/repos/octo/project/pulls/7",
    },
  ];

  for (const scenario of cases) {
    it(`PRR27: a fork restores inherited ${scenario.kind} and refuses a changed URL`, function* () {
      const original = {
        number: 7,
        headSha: "a".repeat(40),
        reviews: originalReviews,
        body: originalBody,
      };
      const server = yield* usePullRequestServer({
        pullRequests: [
          original,
          {
            number: 8,
            headSha: "b".repeat(40),
            reviews: ["different pull request"],
            body: "Different pull request description",
          },
        ],
      });

      yield* useFixture(sourceOf(scenario.read, scenario.output), function* (fixture) {
        const started = yield* xmd(fixture, server, [
          "workflow",
          "start",
          "--id=source-1",
          DEFINITION,
        ]).join();
        expect(started.code).toBe(0);
        expect(started.stdout).toContain(scenario.original);
        const requests = [
          { method: "GET", path: scenario.route, authorization: `Bearer ${TOKEN}` },
        ];
        expect(server.requests).toEqual(requests);

        const entries = yield* history(fixture, server, "source-1");
        const read = entries.find(
          (entry) =>
            entry.event.type === "yield" && entry.event.description?.type === "pull_request_read",
        );
        expect(read).toBeDefined();
        expect(read?.forkability.forkable).toBe(true);
        const checkpoint = String(read?.eventId);

        original.body = "Edited upstream after the read";
        original.reviews = [];
        const control = yield* xmd(fixture, server, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint}`,
          "--id=control-1",
          DEFINITION,
        ]).join();
        expect(control.code).toBe(0);
        expect(control.stdout).toContain(scenario.original);
        expect(server.requests).toEqual(requests);

        const changed = yield* xmd(fixture, server, [
          "workflow",
          "fork",
          "source-1",
          `--at=${checkpoint}`,
          "--id=changed-1",
          // Configliere needs the definition before its props.
          DEFINITION,
          `--props-url=${EIGHT}`,
        ]).join();
        expect(changed.code).not.toBe(0);
        expect(changed.stderr).toContain("diverges");
        expect(changed.stderr).toContain(checkpoint);
        expect(changed.stdout).not.toContain(scenario.original);
        expect(server.requests).toEqual(requests);
      });
    });
  }
});
