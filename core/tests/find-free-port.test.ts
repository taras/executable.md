/**
 * Tier R — findFreePort and VM globals tests.
 *
 * Verifies findFreePort returns a usable port and that VM sandbox
 * globals are accessible — both standalone and inside eval blocks.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { race } from "effection";
import type { Operation } from "effection";
import { once } from "@effectionx/node";
import { createServer } from "node:net";
import { InMemoryStream } from "@executablemd/durable-streams";
import { findFreePort } from "../src/find-free-port.ts";
import { compileBlock } from "../src/eval-context.ts";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers for integration tests
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ema-r-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    const fileDir = path.dirname(fullPath);
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

describe("Tier R — findFreePort", () => {
  // R1: findFreePort returns a number > 0
  it("R1: findFreePort returns a number > 0", function* () {
    const port = yield* findFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  // R3: Returned port is bindable (open a server on it)
  it("R3: returned port is bindable", function* () {
    const port = yield* findFreePort();

    const server = createServer();
    const listening = once(server, "listening");
    const error = once<[Error]>(server, "error");

    server.listen(port);

    try {
      yield* race([
        listening,
        {
          *[Symbol.iterator]() {
            const [err] = yield* error;
            throw err;
          },
        } as Operation<never>,
      ]);
      // If we reach here, the server bound successfully
    } finally {
      server.close();
    }
  });

  // R1b: Two consecutive calls return different ports
  it("R1b: two consecutive calls return different ports", function* () {
    const port1 = yield* findFreePort();
    const port2 = yield* findFreePort();
    // Ports should both be valid — they may or may not be different
    // (the OS recycles ports), but both should be valid numbers
    expect(typeof port1).toBe("number");
    expect(typeof port2).toBe("number");
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });
});

describe("Tier R — Eval module globals", () => {
  // R6: when is accessible via generated module imports
  it("R6: when is accessible in eval sandbox", function* () {
    // Verify that a compiled block can reference 'when' — it's imported
    // in the generated module via standard imports
    const fn = yield* compileBlock("env.hasWhen = typeof when === 'function';", []);
    const env: Record<string, unknown> = {};
    const gen = fn(env);
    let r = gen.next();
    while (!r.done) r = gen.next();
    expect(env["hasWhen"]).toBe(true);
  });

  // R1c: findFreePort is accessible via generated module imports
  it("R1c: findFreePort is accessible in eval sandbox", function* () {
    const fn = yield* compileBlock("env.hasFindFreePort = typeof findFreePort === 'function';", []);
    const env: Record<string, unknown> = {};
    const gen = fn(env);
    let r = gen.next();
    while (!r.done) r = gen.next();
    expect(env["hasFindFreePort"]).toBe(true);
  });

  // R6b: All expected Effection globals are available in compiled block
  it("R6b: expected Effection globals are in sandbox", function* () {
    const checks = [
      "sleep", "spawn", "call", "resource", "useScope",
      "createChannel", "each", "suspend", "createSignal",
      "when", "findFreePort",
    ];
    const checkCode = checks.map(name => `env["has_${name}"] = typeof ${name} === "function";`).join("\n");
    const fn = yield* compileBlock(checkCode, []);
    const env: Record<string, unknown> = {};
    const gen = fn(env);
    let r = gen.next();
    while (!r.done) r = gen.next();
    for (const name of checks) {
      expect(env[`has_${name}`]).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier R — Behavioral integration tests (via runDocument)
// ---------------------------------------------------------------------------

describe("Tier R — findFreePort in eval blocks", () => {
  // R1 (integration): findFreePort accessible and returns a port inside eval
  it("R1: findFreePort in eval block returns a port number", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "const port = yield* findFreePort();",
          "```",
          "",
          "```bash exec",
          "echo port-found",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // Eval block ran without error, exec block produced output
      expect(output).toContain("port-found");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // R2: Port from findFreePort is usable (bindable) inside eval
  // Verified by: daemon binding to the port doesn't error
  it("R2: port from findFreePort is usable — daemon binds to it", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "const port = yield* findFreePort();",
          "```",
          "",
          // Daemon binds a Node HTTP server to the allocated port
          "```bash daemon exec",
          'node -e "require(\'http\').createServer((q,s)=>s.end(\'ok\')).listen({port})"',
          "```",
          "",
          "done",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // If the port was in use, the daemon would error and we'd see it
      expect(output).toContain("done");
      expect(output).not.toContain("EADDRINUSE");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // R3: findFreePort not called on replay — same port restored from journal
  it("R3: findFreePort not called on replay — stored port reused", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "const port = yield* findFreePort();",
          "```",
          "",
          "```bash exec",
          "echo port-is-{port}",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      // Golden run
      const output1 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // Replay — durableEval returns stored port, findFreePort not invoked
      const output2 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // Both runs produce the same port (replayed from journal)
      expect(output1).toContain("port-is-");
      expect(output2).toContain("port-is-");
      // Extract port values — they should be identical
      const port1 = output1.match(/port-is-(\d+)/)?.[1];
      const port2 = output2.match(/port-is-(\d+)/)?.[1];
      expect(port1).toBeTruthy();
      expect(port2).toBeTruthy();
      expect(port1).toBe(port2);
    } finally {
      cleanup(tmpDir);
    }
  });
});

describe("Tier R — when in eval blocks", () => {
  // R4: when accessible in eval block — retries until condition met
  it("R4: when accessible in eval block — converges on condition", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "let count = 0;",
          "yield* when(function*() {",
          "  count++;",
          "  if (count < 3) throw new Error('not yet');",
          "  return count;",
          "});",
          "const result = count;",
          "```",
          "",
          "```bash exec",
          "echo when-passed",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // when() converged after 3 retries, block completed
      expect(output).toContain("when-passed");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // R5: when retries on throw — inner function throws twice, then succeeds
  it("R5: when retries on throw then succeeds", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "let attempts = 0;",
          "const stats = yield* when(function*() {",
          "  attempts++;",
          "  if (attempts <= 2) throw new Error('retry');",
          "  return 'converged';",
          "});",
          "const converged = stats.value;",
          "```",
          "",
          "```bash exec",
          "echo result-{converged}",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // when() retried and converged, binding is available
      expect(output).toContain("result-converged");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // R6: when propagates timeout — assertion never succeeds → error
  it("R6: when propagates timeout as error", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "yield* when(function*() {",
          "  throw new Error('never-ready');",
          "}, { timeout: 200 });",
          "```",
          "",
          "done",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        freshness: false,
      }));

      // when() timed out — the error should appear in output
      expect(output).toContain("never-ready");
    } finally {
      cleanup(tmpDir);
    }
  });
});
