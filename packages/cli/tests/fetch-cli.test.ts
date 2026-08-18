/**
 * Tier FE — what a host retains of a `<Fetch>` (spec §6.18).
 *
 * Retention is the host's choice and nothing else's. The same document, the
 * same request, and the same rendered text produce a trace or no trace
 * depending only on how the run was started — so rendered output is never the
 * evidence here. What is asserted is the file the run did or did not create,
 * and the one event inside it.
 *
 * The requests are real: a loopback server in this process answers them, and
 * counts them, so "one request" is observed outside the run rather than
 * inferred from what it printed.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import { exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { runCli } from "@executablemd/test-support/launch";

const RUN = { timeout: 60_000 };

interface Loopback {
  readonly origin: string;
  readonly requests: Array<{ method: string; path: string; accept: string | undefined }>;
}

/** A server that answers one known path, torn down with the calling scope. */
function useLoopback(): Operation<Loopback> {
  return resource(function* (provide) {
    const requests: Loopback["requests"] = [];

    const server = createServer((request, response) => {
      const accept = request.headers["accept"];
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        accept: Array.isArray(accept) ? accept.join(", ") : accept,
      });
      response.setHeader("content-type", "application/json");
      response.setHeader("x-observed", "loopback");
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

interface JournalEvent {
  type: string;
  description?: { type?: string; name?: string; input?: unknown };
  result?: { status?: string; value?: unknown };
}

function* readJournal(path: string): Operation<JournalEvent[]> {
  return (yield* readTextFile(path))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JournalEvent);
}

/**
 * A document that reads and says nothing about what it read.
 *
 * Uncaptured on purpose. What a host retains is decided by how the run was
 * started, not by what the document bound or printed, and an uncaptured 2xx
 * renders nothing — which leaves the journal as the only thing left to assert.
 */
function document(origin: string): string {
  return [
    "# Reads",
    "",
    `<Fetch url="${origin}/greeting" headers={{ Accept: "application/json" }} />`,
    "",
  ].join("\n");
}

describe("Tier FE — diagnostic retention of a Fetch", () => {
  it("FEC1: a run without --journal performs the request and keeps nothing", function* () {
    const server = yield* useLoopback();
    const dir = yield* useTempDirectory("xmd-fetch-cli-");
    const path = join(dir, "doc.md");
    const trace = join(dir, "trace.jsonl");
    yield* writeTextFile(path, document(server.origin));

    const result = yield* runCli(["run", path, "--raw"], RUN).expect();

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    // Nothing on disk: retention was never asked for.
    expect(yield* exists(trace)).toBe(false);
    // And nothing of the response reached the output either.
    expect(result.stdout).not.toContain("greeting");
  });

  it("FEC2: a run with --journal retains the normalized request and the response", function* () {
    const server = yield* useLoopback();
    const dir = yield* useTempDirectory("xmd-fetch-cli-");
    const path = join(dir, "doc.md");
    const trace = join(dir, "trace.jsonl");
    yield* writeTextFile(path, document(server.origin));

    const result = yield* runCli(["run", path, `--journal=${trace}`, "--raw"], RUN).expect();

    expect(result.code).toBe(0);
    expect(server.requests).toEqual([
      { method: "GET", path: "/greeting", accept: "application/json" },
    ]);

    const fetched = (yield* readJournal(trace)).filter(
      (event) => event.type === "yield" && event.description?.type === "fetch",
    );
    expect(fetched).toHaveLength(1);

    const [event] = fetched;
    expect(event?.description?.input).toEqual({
      url: `${server.origin}/greeting`,
      method: "GET",
      headers: { accept: "application/json" },
    });
    expect(event?.result?.status).toBe("ok");
    const value = event?.result?.value;
    if (value === null || typeof value !== "object") {
      throw new Error("the retained Fetch result is not an object");
    }
    const retained: Record<string, unknown> = { ...value };
    expect(retained.status).toBe(200);
    expect(retained.body).toBe('{"greeting":"hello"}');
    const headers = retained.headers;
    if (headers === null || typeof headers !== "object") {
      throw new Error("the retained Fetch response carries no header object");
    }
    const named: Record<string, unknown> = { ...headers };
    expect(named["content-type"]).toBe("application/json");
    expect(named["x-observed"]).toBe("loopback");
    // Lowercase and lexicographic, whatever order the host reported them in.
    expect(Object.keys(named)).toEqual([...Object.keys(named)].sort());
  });
});
