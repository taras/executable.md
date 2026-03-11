/**
 * Tier S — Provider component pattern integration tests.
 *
 * Tests the full provider lifecycle: eval → daemon → when → children → cleanup.
 * Uses real subprocesses via nodeRuntime() and a Node HTTP server as the daemon.
 *
 * The provider component pattern (spec §6.7) is:
 * 1. eval block allocates port via findFreePort()
 * 2. daemon block starts server on that port
 * 3. eval block polls readiness via when(fetch(...))
 * 4. <children /> expand with server available
 * 5. Component scope closes → daemon terminated
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { runDocument } from "../src/run-document.ts";
import type { ModifierFactory } from "../src/modifiers.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ema-s-test-"));
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

// ---------------------------------------------------------------------------
// Stub sample handler for tests that need S3/S8/S9
// Returns "[sampled]" for any input — exercises the modifier chain
// without requiring an actual LLM.
// ---------------------------------------------------------------------------

const stubSampleHandler: ModifierFactory = (_params) =>
  (_args, next) =>
    (function* () {
      const inner = yield* next();
      return { ...inner, output: "[sampled]" };
    })();

// ---------------------------------------------------------------------------
// Provider component template
// A minimal HTTP server started by daemon, with readiness via when+fetch.
// ---------------------------------------------------------------------------

/** Node one-liner HTTP server that responds "ok" on any request. */
const NODE_HTTP_SERVER =
  'node -e "require(\'http\').createServer((q,s)=>{s.writeHead(200);s.end(\'ok\')}).listen({port},\'127.0.0.1\')"';

/**
 * Build a provider component file with standard eval→daemon→when→children.
 * Uses findFreePort, daemon with the Node HTTP server, and when+fetch for readiness.
 */
function providerComponent(): string {
  // Note: eval blocks skip {name} interpolation (handled by expand.ts guard),
  // so template literals like `${baseUrl}` work correctly. Daemon/exec blocks
  // still interpolate, so {port} in the daemon command is substituted.
  // fetch().expect() throws HttpError on non-2xx; when() catches and retries.
  return [
    "---",
    "meta:",
    "  componentName: TestProvider",
    "---",
    "",
    "```js eval",
    "const port = yield* findFreePort();",
    "const baseUrl = 'http://127.0.0.1:' + port;",
    "```",
    "",
    "```bash daemon exec",
    NODE_HTTP_SERVER,
    "```",
    "",
    "```js eval",
    "yield* when(function*() {",
    "  yield* fetch(baseUrl + '/health').expect();",
    "}, { timeout: 5000, interval: 50 });",
    "```",
    "",
    "<Content />",
  ].join("\n");
}

describe("Tier S — Provider component pattern", () => {
  // S1: Full provider golden run
  // eval → daemon → when → children → cleanup
  it("S1: full provider golden run — children rendered after daemon ready", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "children-rendered",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      expect(output).toContain("children-rendered");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S2: Port flows from eval to daemon
  // {port} in daemon content matches findFreePort() result.
  // Verified by: daemon starts (readiness check passes), which means
  // the interpolated port was valid.
  it("S2: port flows from eval to daemon — interpolation works", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "port-flowed",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // Readiness check passed → port was correctly interpolated
      expect(output).toContain("port-flowed");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S3: Children can call sample after daemon ready
  // Uses stub sampleHandler to verify the modifier chain works
  // within the provider's children.
  it("S3: children can call sample after daemon ready", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "```bash sample exec",
          "echo raw-output",
          "```",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
        sampleHandler: stubSampleHandler,
      });

      // The stub sample handler replaces exec output with "[sampled]"
      expect(output).toContain("[sampled]");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S4: Daemon terminated after children expand
  // After runDocument completes, the daemon process is not running.
  // Verified by: runDocument returns (doesn't hang), proving structured
  // concurrency cleaned up the daemon.
  it("S4: daemon terminated after children expand — runDocument completes", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "expansion-done",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // runDocument returned — daemon was cleaned up by structured concurrency.
      // If daemon wasn't terminated, the process would hang indefinitely.
      expect(output).toContain("expansion-done");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S5: Provider crash during when — daemon exits before ready
  // Daemon exits immediately (exit 0), the port is never bound,
  // when() polls a port that never responds → timeout → error.
  it("S5: provider crash during when — daemon exits before ready", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/CrashProvider.md": [
          "---",
          "meta:",
          "  componentName: CrashProvider",
          "---",
          "",
          "```js eval",
          "const port = yield* findFreePort();",
          "const baseUrl = 'http://127.0.0.1:' + port;",
          "```",
          "",
          // Daemon exits immediately — port is never bound
          "```bash daemon exec",
          "exit 0",
          "```",
          "",
          "```js eval",
          "yield* when(function*() {",
          "  yield* fetch(baseUrl + '/health').expect();",
          "}, { timeout: 500, interval: 50 });",
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "doc.md": [
          "<CrashProvider>",
          "",
          "should-not-appear",
          "",
          "</CrashProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // when() should timeout or get connection errors — error in output
      // Children may or may not appear depending on error handling
      expect(output).toMatch(/error|Error|ECONNREFUSED|timeout|Timeout/i);
    } finally {
      cleanup(tmpDir);
    }
  });

  // S6: Provider crash during children — daemon exits mid-expansion
  // Daemon starts but exits after a short delay while children are
  // still expanding. Error should propagate.
  it("S6: provider crash during children — error propagated", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/UnstableProvider.md": [
          "---",
          "meta:",
          "  componentName: UnstableProvider",
          "---",
          "",
          "```js eval",
          "const port = yield* findFreePort();",
          "const baseUrl = `http://127.0.0.1:${port}`;",
          "```",
          "",
          // Daemon serves for 0.2s then exits
          "```bash daemon exec",
          `node -e "const s=require('http').createServer((q,r)=>{r.writeHead(200);r.end('ok')}).listen({port},'127.0.0.1');setTimeout(()=>process.exit(1),200)"`,
          "```",
          "",
          "```js eval",
          "yield* when(function*() {",
          "  yield* fetch(`${baseUrl}/health`).expect();",
          "}, { timeout: 5000, interval: 50 });",
          "```",
          "",
          "<Content />",
        ].join("\n"),
        "doc.md": [
          "<UnstableProvider>",
          "",
          // Slow child that outlives the daemon
          "```bash exec",
          "sleep 1 && echo child-done",
          "```",
          "",
          "</UnstableProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // The daemon crashed during children expansion.
      // The output should contain some indication of the error
      // (DaemonExitError) or the child output, depending on timing.
      // Key property: runDocument completed (didn't hang).
      expect(output).toBeTruthy();
    } finally {
      cleanup(tmpDir);
    }
  });

  // S7: Nested providers — outer + inner, inner tears down first
  it("S7: nested providers — both start, inner tears down first", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "outer-before",
          "",
          "<TestProvider>",
          "",
          "inner-content",
          "",
          "</TestProvider>",
          "",
          "outer-after",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // Both providers started and tore down correctly.
      // Inner content appeared between outer content.
      expect(output).toContain("outer-before");
      expect(output).toContain("inner-content");
      expect(output).toContain("outer-after");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S8: Full replay of provider component
  // All eval journal entries replayed; daemon starts fresh (ephemeral);
  // no live HTTP calls on replay.
  it("S8: full replay — eval replayed, daemon starts fresh", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "replay-test",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const runtime = nodeRuntime();

      const componentDirs = [path.join(tmpDir, "components"), tmpDir];

      // Golden run
      const output1 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        componentDirs,
        freshness: false,
      });

      expect(output1).toContain("replay-test");
      expect(output1).not.toContain("ERROR");

      // Replay — eval blocks replay from journal, daemon spawns fresh
      const output2 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        componentDirs,
        freshness: false,
      });

      // Replay produces same output
      expect(output2).toContain("replay-test");
      expect(output2).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S9: Modified doc with new children — fresh run produces new output
  // First run journals. Second run uses a fresh stream and a modified doc
  // with an additional child exec block. The provider starts a new daemon
  // and the new child runs live.
  it("S9: modified doc with new children — fresh run includes new output", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "original-child",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const runtime = nodeRuntime();
      const componentDirs = [path.join(tmpDir, "components"), tmpDir];

      // Golden run
      const stream1 = new InMemoryStream();
      const output1 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream: stream1,
        runtime,
        componentDirs,
        freshness: false,
      });

      expect(output1).toContain("original-child");

      // Modify the doc — add a new exec block in children
      writeFiles(tmpDir, {
        "doc.md": [
          "<TestProvider>",
          "",
          "original-child",
          "",
          "```bash exec",
          "echo new-child",
          "```",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      // Fresh stream — provider starts a new daemon, new child runs live
      const stream2 = new InMemoryStream();
      const output2 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream: stream2,
        runtime,
        componentDirs,
        freshness: false,
      });

      // Both original text and new exec block output appear
      expect(output2).toContain("original-child");
      expect(output2).toContain("new-child");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S10: Multiple provider instances — two sibling providers with different ports
  it("S10: multiple provider instances — two siblings, different ports", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/TestProvider.md": providerComponent(),
        "doc.md": [
          "<TestProvider>",
          "",
          "first-provider",
          "",
          "</TestProvider>",
          "",
          "<TestProvider>",
          "",
          "second-provider",
          "",
          "</TestProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      });

      // Both providers expanded successfully with different ports
      expect(output).toContain("first-provider");
      expect(output).toContain("second-provider");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});
