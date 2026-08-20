/**
 * Tier FE — what a workflow run retains of a `<Fetch>` (spec §6.18).
 *
 * A workflow's journal is the run's own, and this is where the same event that
 * a diagnostic trace holds has to survive losing the host. The run is killed
 * once its Fetch has committed, and the resume that follows must restore that
 * response rather than ask the server again — which is why the server is real
 * and counts what it was asked, outside either process.
 *
 * The rows are read through a second connection, and the rendered output is
 * asserted separately: a resumed document prints the same sentence whether it
 * replayed the response or fetched it a second time.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, scoped, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { ensureDir, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { when } from "@effectionx/converge";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { cliCommand, runCli } from "@executablemd/test-support/launch";
import { workflowRunPath } from "@executablemd/workflow/deno";
import { readRunDatabase } from "./support/run-database.ts";

const RUN_ID = "fetch-run";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
  /** The file the document's own wait is released by. */
  readonly gate: string;
}

interface Loopback {
  readonly origin: string;
  readonly requests: string[];
}

/** A server that answers one path, torn down with the calling scope. */
function useLoopback(): Operation<Loopback> {
  return resource(function* (provide) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.writeHead(200);
      response.end('{"greeting":"hello"}');
    });

    const listening = withResolvers<void>();
    server.on("error", (error: Error) => listening.reject(error));
    server.listen(0, "127.0.0.1", () => listening.resolve());
    yield* listening.operation;

    yield* ensure(function* () {
      const closed = withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      yield* closed.operation;
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the loopback server reported no TCP address");
    }
    yield* provide({ origin: `http://127.0.0.1:${address.port}`, requests });
  });
}

/**
 * A document that fetches, says what it got, and then waits.
 *
 * The wait is what gives the first execution somewhere to be killed after its
 * Fetch has committed; the resume finds the gate already open and carries on.
 */
function definition(origin: string, gate: string): string {
  return [
    "```js eval",
    "const ready = true;",
    "```",
    "",
    `<Fetch url="${origin}/greeting" headers={{ Accept: "application/json" }} as="answer" />`,
    "",
    "```js eval",
    "const greeting = JSON.parse(answer.body).greeting;",
    "```",
    "",
    "SAID {greeting}",
    "",
    "```bash exec",
    `while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.05; done`,
    "```",
    "",
  ].join("\n");
}

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(origin: string, body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-fetch-wf-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
      gate: join(root, "open"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(join(fixture.repository, "flows"));
    yield* ensureDir(fixture.home);
    yield* writeTextFile(
      join(fixture.repository, "flows/fetch.md"),
      definition(origin, fixture.gate),
    );

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-fe@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier FE"]);
    yield* git(fixture.repository, ["add", "-A"]);
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);

    return yield* body(fixture);
  });
}

function inherited(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

interface JournalRecord {
  type?: string;
  coroutineId?: string;
  description?: { type?: string; name?: string; input?: unknown };
  result?: { status?: string; value?: unknown };
}

/** Everything a second connection can read of the run's journal. */
function rows(path: string): JournalRecord[] {
  return readRunDatabase(path, (database) =>
    database
      .prepare("SELECT record FROM journal_events ORDER BY sequence")
      .all()
      .map((row) => JSON.parse(typeof row["record"] === "string" ? row["record"] : "{}")),
  );
}

function committedFetches(path: string): JournalRecord[] {
  return rows(path).filter(
    (record) =>
      record.type === "yield" &&
      record.description?.type === "fetch" &&
      record.result?.status === "ok",
  );
}

function rootCloses(path: string): number {
  return rows(path).filter((record) => record.type === "close" && record.coroutineId === "root")
    .length;
}

describe("Tier FE — a workflow run's Fetch", () => {
  it("FEW1: commits one response, and a resume restores it without asking again", function* () {
    const server = yield* useLoopback();

    yield* useFixture(server.origin, function* (fixture) {
      const path = workflowRunPath(fixture.runs, RUN_ID);

      // Start the run in a real child and kill it once its Fetch has committed.
      yield* scoped(function* () {
        const cli = cliCommand(["workflow", "start", `--id=${RUN_ID}`, "flows/fetch.md"]);
        const child = yield* exec(cli.command, {
          arguments: cli.arguments,
          cwd: fixture.repository,
          env: { ...inherited(), HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        });
        // Drain the child's streams so a full pipe cannot stall it.
        for (const stream of [child.stdout, child.stderr]) {
          yield* spawn(function* () {
            const subscription = yield* stream;
            let next = yield* subscription.next();
            while (!next.done) {
              next = yield* subscription.next();
            }
          });
        }

        yield* when(
          function* () {
            expect(committedFetches(path)).toHaveLength(1);
          },
          { timeout: 60_000 },
        );
        process.kill(child.pid, "SIGKILL");
        yield* child.join();
      });

      const [committed] = committedFetches(path);
      expect(server.requests).toEqual(["GET /greeting"]);
      expect(committed?.description?.input).toEqual({
        url: `${server.origin}/greeting`,
        method: "GET",
        headers: { accept: "application/json" },
      });
      const retained = committed?.result?.value;
      if (retained === null || typeof retained !== "object") {
        throw new Error("the run committed no Fetch response");
      }
      const value: Record<string, unknown> = { ...retained };
      expect(Object.keys(value)).toEqual(["status", "headers", "body"]);
      expect(value.status).toBe(200);
      expect(value.body).toBe('{"greeting":"hello"}');
      const headers = value.headers;
      if (headers === null || typeof headers !== "object") {
        throw new Error("the retained response carries no header object");
      }
      // Whatever the host reported, the names are lowercase and ordered.
      const named: Record<string, unknown> = { ...headers };
      const names = Object.keys(named);
      expect(names).toEqual([...names].sort());
      expect(names).toEqual(names.map((name) => name.toLowerCase()));
      expect(named["content-type"]).toBe("application/json");
      // The killed run left the root open, which is what makes it resumable.
      expect(rootCloses(path)).toBe(0);

      // Open the gate the document waits on, then resume.
      yield* writeTextFile(fixture.gate, "open\n");
      const resumed = yield* runCli(["workflow", "resume", RUN_ID], {
        cwd: fixture.repository,
        env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
        timeout: 120_000,
      }).join();

      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("SAID hello");

      // The response came from the journal: the server was never asked again,
      // and the run still holds exactly one Fetch observation.
      expect(server.requests).toEqual(["GET /greeting"]);
      const after = committedFetches(path);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(committed);
      expect(rootCloses(path)).toBe(1);
    });
  });
});
