/**
 * `<Fetch>` through the compiled binary (#456).
 *
 * The component resolves from core's registry rather than from a search path,
 * performs its request through the contextual Fetch adapter, and detaches the
 * response before binding it — three things that live in the module graph, and
 * only the binary shows that `deno compile` kept them.
 *
 * The server is this script's own, so the claim is observed from outside the
 * run: one request reached it, and the document bound what it answered.
 */

import { ensure, main, resource, withResolvers } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import { exists, writeTextFile } from "@effectionx/fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { useTempDirectory } from "./lib/temp-directory.ts";

const BINARY = path.join(Deno.cwd(), "dist", "xmd");

function fail(claim: string): never {
  console.error(`fetch smoke: ${claim}`);
  Deno.exit(1);
}

interface Loopback {
  readonly origin: string;
  readonly requests: string[];
}

function useLoopback(): Operation<Loopback> {
  return resource(function* (provide) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.setHeader("x-observed", "smoke");
      response.writeHead(200);
      response.end('{"greeting":"hello"}');
    });

    const listening = withResolvers<void>();
    // Removed with the resource rather than after the first error: a listening
    // server outlives its bind, and a handler left behind would still be
    // holding a rejected resolver when the next test binds its own.
    //
    // Established before the handler exists, because `yield* ensure(...)` is
    // itself a suspension: an owner halted while it registers unwinds with no
    // cleanup at all, so nothing may be attached until it has completed.
    let onError: ((error: Error) => void) | undefined;

    yield* ensure(() => {
      if (onError) {
        server.off("error", onError);
      }
    });

    onError = (error: Error) => listening.reject(error);
    server.on("error", onError);
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

await main(function* () {
  if (!(yield* exists(BINARY))) {
    fail(`no compiled binary at ${BINARY} — run \`deno task build\` first`);
  }

  const server = yield* useLoopback();
  const dir = yield* useTempDirectory("xmd-smoke-fetch-");
  // Not `fetch.md`: the run's own directory is a component search path, and on
  // a case-insensitive filesystem a document with that name resolves as a
  // repository `Fetch` and shadows the component under test.
  const document = path.join(dir, "read.md");

  yield* writeTextFile(
    document,
    [
      "```js eval",
      "const ready = true;",
      "```",
      "",
      `<Fetch url="${server.origin}/greeting" headers={{ Accept: "application/json" }} as="answer" />`,
      "",
      "```js eval",
      "const said = `${answer.status} ${answer.headers['x-observed']} ${JSON.parse(answer.body).greeting}`;",
      "```",
      "",
      "CAPTURED {said}",
      "",
    ].join("\n"),
  );

  const run = yield* exec(BINARY, {
    arguments: ["run", document, "--raw"],
    cwd: dir,
  }).join();

  if (run.code !== 0) {
    fail(`the compiled binary exited ${run.code}: ${run.stderr}`);
  }
  if (!run.stdout.includes("CAPTURED 200 smoke hello")) {
    fail(`the document did not bind the response: ${JSON.stringify(run.stdout)}`);
  }
  if (server.requests.length !== 1) {
    fail(`expected exactly one request, saw ${JSON.stringify(server.requests)}`);
  }

  console.log("fetch smoke: one request, one detached response, bound and rendered");
});
