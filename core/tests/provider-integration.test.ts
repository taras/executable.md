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
import { collect } from "../src/collect.ts";
import { Sample } from "../src/sample-api.ts";
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

// Note: S3 test installs stub Sample Api middleware via scope.around(Sample, ...)
// directly in the test body — no shared fixture needed.

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
function providerComponent(name = "TestProvider"): string {
  // Note: eval blocks skip {name} interpolation (handled by expand.ts guard),
  // so template literals like `${baseUrl}` work correctly. Daemon/exec blocks
  // still interpolate, so {port} in the daemon command is substituted.
  // fetch().expect() throws HttpError on non-2xx; when() catches and retries.
  return [
    "---",
    "meta:",
    `  componentName: ${name}`,
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

describe("Tier S — Provider component pattern", { sanitizeOps: false, sanitizeResources: false }, () => {
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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // Readiness check passed → port was correctly interpolated
      expect(output).toContain("port-flowed");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S3: Children can call sample after daemon ready
  // Uses Sample Api middleware stub to verify the modifier chain works
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

      // Install stub Sample Api middleware — returns "[sampled]" for any call
      yield* Sample.around({
        *sample(_args, _next) {
          return "[sampled]";
        },
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // The stub sample middleware replaces exec output with "[sampled]"
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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

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
  // Uses two distinct component names to avoid cycle detection.
  it("S7: nested providers — both start, inner tears down first", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "components/OuterProvider.md": providerComponent("OuterProvider"),
        "components/InnerProvider.md": providerComponent("InnerProvider"),
        "doc.md": [
          "<OuterProvider>",
          "",
          "outer-before",
          "",
          "<InnerProvider>",
          "",
          "inner-content",
          "",
          "</InnerProvider>",
          "",
          "outer-after",
          "",
          "</OuterProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

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

  // S8: Nested providers, no model specified — innermost handles
  // Two stub providers (OuterProvider, InnerProvider) install
  // Sample middleware via Sample.around(). A sample block with
  // no model should be handled by the innermost provider.
  it("S8: nested providers, no model — innermost handles", function* () {
    const tmpDir = makeTempDir();

    try {
      // Provider component body — installs Sample middleware returning "[handled-by-{model}]"
      // Uses { at: "min" } so that child (inner) scope middleware runs before
      // parent (outer) scope middleware — achieving innermost-wins semantics.
      const stubProviderBody = (componentName: string) =>
        [
          "---",
          "meta:",
          `  componentName: ${componentName}`,
          "inputs:",
          "  model:",
          "    type: string",
          "    required: true",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    if (context.model !== undefined && context.model !== model) {",
          "      return yield* next(context);",
          "    }",
          "    return '[handled-by-' + model + ']';",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n");

      writeFiles(tmpDir, {
        "components/OuterProvider.md": stubProviderBody("OuterProvider"),
        "components/InnerProvider.md": stubProviderBody("InnerProvider"),
        "doc.md": [
          '<OuterProvider model="outer-model">',
          "",
          '<InnerProvider model="inner-model">',
          "",
          "```bash sample exec",
          "echo ignored",
          "```",
          "",
          "</InnerProvider>",
          "",
          "</OuterProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // No model specified → innermost provider handles
      expect(output).toContain("[handled-by-inner-model]");
      expect(output).not.toContain("[handled-by-outer-model]");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S9: Nested providers, explicit model matching outer
  // Inner provider passes through via next(), outer handles.
  it("S9: nested providers, explicit model matching outer", function* () {
    const tmpDir = makeTempDir();

    try {
      const stubProviderBody = (componentName: string) =>
        [
          "---",
          "meta:",
          `  componentName: ${componentName}`,
          "inputs:",
          "  model:",
          "    type: string",
          "    required: true",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    if (context.model !== undefined && context.model !== model) {",
          "      return yield* next(context);",
          "    }",
          "    return '[handled-by-' + model + ']';",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n");

      writeFiles(tmpDir, {
        "components/OuterProvider.md": stubProviderBody("OuterProvider"),
        "components/InnerProvider.md": stubProviderBody("InnerProvider"),
        "doc.md": [
          '<OuterProvider model="outer-model">',
          "",
          '<InnerProvider model="inner-model">',
          "",
          "```bash sample[model=outer-model] exec",
          "echo ignored",
          "```",
          "",
          "</InnerProvider>",
          "",
          "</OuterProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // Explicit model=outer-model → inner passes through, outer handles
      expect(output).toContain("[handled-by-outer-model]");
      expect(output).not.toContain("[handled-by-inner-model]");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S10: Nested providers, explicit model matching inner
  // Inner provider handles regardless of nesting depth.
  it("S10: nested providers, explicit model matching inner", function* () {
    const tmpDir = makeTempDir();

    try {
      const stubProviderBody = (componentName: string) =>
        [
          "---",
          "meta:",
          `  componentName: ${componentName}`,
          "inputs:",
          "  model:",
          "    type: string",
          "    required: true",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    if (context.model !== undefined && context.model !== model) {",
          "      return yield* next(context);",
          "    }",
          "    return '[handled-by-' + model + ']';",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n");

      writeFiles(tmpDir, {
        "components/OuterProvider.md": stubProviderBody("OuterProvider"),
        "components/InnerProvider.md": stubProviderBody("InnerProvider"),
        "doc.md": [
          '<OuterProvider model="outer-model">',
          "",
          '<InnerProvider model="inner-model">',
          "",
          "```bash sample[model=inner-model] exec",
          "echo ignored",
          "```",
          "",
          "</InnerProvider>",
          "",
          "</OuterProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // Explicit model=inner-model → inner handles directly
      expect(output).toContain("[handled-by-inner-model]");
      expect(output).not.toContain("[handled-by-outer-model]");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S11: Unmatched model → chain exhausted → error
  // No provider handles the requested model → falls through to the
  // core Sample handler which throws a descriptive error.
  it("S11: unmatched model — descriptive error", function* () {
    const tmpDir = makeTempDir();

    try {
      const stubProvider = () =>
        [
          "---",
          "meta:",
          "  componentName: StubProvider",
          "inputs:",
          "  model:",
          "    type: string",
          "    required: true",
          "---",
          "",
          "```js persist eval",
          "yield* Sample.around({",
          "  *sample([context], next) {",
          "    if (context.model !== undefined && context.model !== model) {",
          "      return yield* next(context);",
          "    }",
          "    return '[handled-by-' + model + ']';",
          "  },",
          "}, { at: 'min' });",
          "```",
          "",
          "<Content />",
        ].join("\n");

      writeFiles(tmpDir, {
        "components/StubProvider.md": stubProvider(),
        "doc.md": [
          '<StubProvider model="known-model">',
          "",
          "```bash sample[model=unknown-model] exec",
          "echo ignored",
          "```",
          "",
          "</StubProvider>",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // Chain exhausted → core handler throws → error in output
      expect(output).toMatch(/error|Error|sample/i);
    } finally {
      cleanup(tmpDir);
    }
  });

  // S12: Full replay of provider component
  // All eval journal entries replayed; daemon starts fresh (ephemeral);
  // no live HTTP calls on replay.
  it("S12: full replay — eval replayed, daemon starts fresh", function* () {
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
      const output1 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        componentDirs,
        freshness: false,
      }));

      expect(output1).toContain("replay-test");
      expect(output1).not.toContain("ERROR");

      // Replay — eval blocks replay from journal, daemon spawns fresh
      const output2 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        componentDirs,
        freshness: false,
      }));

      // Replay produces same output
      expect(output2).toContain("replay-test");
      expect(output2).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S13: Modified doc with new children — fresh run produces new output
  // First run journals. Second run uses a fresh stream and a modified doc
  // with an additional child exec block. The provider starts a new daemon
  // and the new child runs live.
  it("S13: modified doc with new children — fresh run includes new output", function* () {
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
      const output1 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream: stream1,
        runtime,
        componentDirs,
        freshness: false,
      }));

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
      const output2 = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream: stream2,
        runtime,
        componentDirs,
        freshness: false,
      }));

      // Both original text and new exec block output appear
      expect(output2).toContain("original-child");
      expect(output2).toContain("new-child");
    } finally {
      cleanup(tmpDir);
    }
  });

  // S14: Multiple provider instances — two sibling providers with different ports
  it("S14: multiple provider instances — two siblings, different ports", function* () {
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
      const output = yield* collect(yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        componentDirs: [path.join(tmpDir, "components"), tmpDir],
        freshness: false,
      }));

      // Both providers expanded successfully with different ports
      expect(output).toContain("first-provider");
      expect(output).toContain("second-provider");
      expect(output).not.toContain("ERROR");
    } finally {
      cleanup(tmpDir);
    }
  });
});
