/**
 * The Sidekick CI guide's response, run as a Sidekick would run it.
 *
 * The reply is the chapter's own example, read from the shipped asset, with the
 * placeholder pull request replaced by one a loopback GitHub model answers. The
 * mounted REPL evaluates it as a Sidekick response: the entry is prepared,
 * submitted through the production entry capability, and its output is read
 * from the history the REPL retained.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { each, ensure, resource, until, useScope } from "effection";
import type { Operation } from "effection";
import { fromReadable } from "@effectionx/node";
import { readTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { gitPlugin } from "@executablemd/git";
import { replRepositoryPlugin } from "../src/repl/repositories/plugin.ts";
import { replRepositoryInstallation } from "../src/repl/repositories/deno/provider.ts";
import { gitHubStore, respond } from "../../git/tests/support/github.ts";
import { useReplPage } from "./support/repl-page.ts";
import { mountedReading, useMountedHost } from "./support/mounted-repl.ts";
import { intoComposer, sidekickIdle } from "./support/screen-journeys.ts";

const TOKEN = "github-credential-for-this-test";
const URL_1 = "https://github.com/owner/repository/pull/1";
const HEAD = "a".repeat(40);

/** The modeled GitHub: one pull request whose checks have all completed. */
function useGitHub(): Operation<string> {
  return resource<string>(function* (provide) {
    const store = gitHubStore({
      owner: "owner",
      repository: "repository",
      token: TOKEN,
      pullRequests: [
        {
          nodeId: "PR_kwDOA",
          number: 1,
          state: "open",
          title: "Prepare 1.4",
          body: "Ready for review.",
          draft: false,
          headRef: "review/1.4",
          headSha: HEAD,
          baseRef: "main",
          baseSha: "c".repeat(40),
        },
      ],
    });
    const base = { endpoint: "" };
    const scope = yield* useScope();
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
      scope.run(function* (): Operation<void> {
        for (const _chunk of yield* each(fromReadable(incoming))) {
          yield* each.next();
        }
        const path = new URL(incoming.url ?? "/", "http://localhost").pathname;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          headers[name === "authorization" ? "Authorization" : name] = String(value);
        }
        const answer = path.endsWith("/check-runs")
          ? {
              status: 200,
              body: JSON.stringify({
                total_count: 2,
                check_runs: [run(31, "build", "failure"), run(32, "lint", "success")],
              }),
            }
          : path.endsWith("/status")
            ? { status: 200, body: JSON.stringify({ sha: HEAD, statuses: [] }) }
            : respond(store, {
                method: "GET",
                url: `${base.endpoint}${incoming.url ?? "/"}`,
                headers,
              });
        outgoing.writeHead(answer.status, { "content-type": "application/json" });
        outgoing.end(answer.body);
      });
    });
    yield* until(new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
    yield* ensure(function* (): Operation<void> {
      server.closeAllConnections();
      yield* until(new Promise<void>((resolve) => server.close(() => resolve())));
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("this listener reported no address with a port");
    }
    base.endpoint = `http://127.0.0.1:${address.port}`;
    yield* provide(base.endpoint);
  });
}

function run(id: number, name: string, conclusion: string) {
  return {
    id,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion,
    html_url: `https://github.com/owner/repository/runs/${id}`,
    started_at: "2026-11-23T12:00:00Z",
    completed_at: "2026-11-23T12:05:00Z",
    output: { title: name, summary: conclusion, text: null },
  };
}

/** Set an environment variable for this test, and put it back afterwards. */
function* useVariable(name: string, value: string): Operation<void> {
  const before = process.env[name];
  process.env[name] = value;
  yield* ensure(() => {
    if (before === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = before;
    }
  });
}

/** The chapter's example response, pointed at the modeled pull request. */
function* guideResponse(): Operation<string> {
  const chapter = yield* readTextFile(new URL("../src/documents/sidekick/ci.md", import.meta.url));
  const fence = /`````xmd\n([\s\S]*?)\n`````/.exec(chapter);
  if (fence?.[1] === undefined) {
    throw new Error("the CI guide carries no Sidekick response example");
  }
  return fence[1].replaceAll("https://github.com/taras/executable.md/pull/123", URL_1);
}

describe("the Sidekick CI guide", () => {
  it("G1: its example response submits a watch whose failure renders the failed rows", function* () {
    const endpoint = yield* useGitHub();
    yield* useVariable("GH_TOKEN", TOKEN);
    yield* useVariable("XMD_REPL_GITHUB_BASE_URL", endpoint);
    const host = yield* useMountedHost({
      plugins: [replRepositoryPlugin(gitPlugin)],
      entryInstallation: (owner: string) => replRepositoryInstallation(owner, {}),
    });
    const page = yield* useReplPage({ host, size: { columns: 160, rows: 44 } });
    page.repl.fake.script({ reply: yield* guideResponse() });
    page.repl.fake.script({ reply: "<Output>CI watched.</Output>" });
    yield* intoComposer(page);
    yield* page.type("Wait for CI on pull request 1");
    yield* page.key("Enter");
    yield* page.until(
      "the submitted watch settled and the Sidekick at rest",
      (one) => one.shows("1 ✓") && sidekickIdle(one) && one.shows("CI watched."),
    );
    const saved = yield* mountedReading(page.repl);
    const output = saved.model.entries[0]?.terminal?.output ?? "";
    expect(output).toContain('"outcome": "failure"');
    expect(output).toContain(`"headSha": "${HEAD}"`);
    const rows = output.slice(output.indexOf("Failed check records"));
    expect(output).toContain("Failed check records");
    expect(rows).toContain('"build"');
    expect(rows).not.toContain('"lint"');
  });
});
