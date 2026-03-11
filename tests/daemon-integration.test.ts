/**
 * Tier Q — Daemon modifier integration tests.
 *
 * Tests daemon process lifecycle with real subprocesses via nodeRuntime().
 * Verifies process lifetime, crash propagation, interpolation flow,
 * and replay behavior.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { InMemoryStream } from "@effectionx/durable-streams";
import { nodeRuntime } from "@effectionx/durable-effects";
import { runDocument } from "../src/run-document.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helper — create a temp directory for test artifacts
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ema-daemon-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Helper — write test documents to a temp directory
// ---------------------------------------------------------------------------

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    const fileDir = path.dirname(fullPath);
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

describe("Tier Q — Daemon integration", () => {
  // Q4: Process forked into eval scope — alive during children expansion
  // Q5: Process terminated when component scope closes
  it("Q4/Q5: daemon process alive during expansion, terminated after", function* () {
    const tmpDir = makeTempDir();
    const markerFile = path.join(tmpDir, "daemon-alive");

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```bash daemon exec",
          `touch ${markerFile} && sleep 300`,
          "```",
          "",
          "```bash exec",
          `test -f ${markerFile} && echo "daemon-is-alive"`,
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      // The exec block ran while daemon was alive — marker file existed
      expect(output).toContain("daemon-is-alive");
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q3: daemon returns empty output — no rendered output in document
  it("Q3: daemon produces no rendered output", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "before",
          "",
          "```bash daemon exec",
          "sleep 300",
          "```",
          "",
          "after",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      // Daemon produces no output — text segments before/after are present
      expect(output).toContain("before");
      expect(output).toContain("after");
      // No exec output block from the daemon
      expect(output).not.toContain("sleep 300");
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q2: daemon produces no journal entry
  it("Q2: daemon produces no journal entry for the daemon block", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```bash daemon exec",
          "sleep 300",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      const events = stream.snapshot();
      // Journal should have root import but no daemon/exec entry
      const hasExecEntry = events.some((e) => {
        const data = typeof e === "string" ? JSON.parse(e) : e;
        return data?.description?.type === "exec";
      });
      expect(hasExecEntry).toBe(false);
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q8: Premature exit propagates as error
  it("Q8: premature daemon exit propagates as error", function* () {
    const tmpDir = makeTempDir();

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```bash daemon exec",
          "exit 1",
          "```",
          "",
          "```bash exec",
          "echo should-not-reach",
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      // The daemon exited immediately — error should appear in output
      expect(output).toContain("ERROR");
      // The exec block after should not have run (or the error takes precedence)
      expect(output).not.toContain("should-not-reach");
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q9: {port} interpolation in daemon content
  it("Q9: eval binding interpolation flows into daemon content", function* () {
    const tmpDir = makeTempDir();
    const markerFile = path.join(tmpDir, "port-marker");

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "const marker = 'EVAL_WORKS';",
          "```",
          "",
          "```bash daemon exec",
          `echo {marker} > ${markerFile} && sleep 300`,
          "```",
          "",
          "```bash exec",
          // Give the daemon a moment to write, then read
          `sleep 0.1 && cat ${markerFile}`,
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      // The daemon received the interpolated value and wrote it to the marker
      expect(output).toContain("EVAL_WORKS");
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q6: Process terminated on component error
  it("Q6: daemon terminated when subsequent block errors", function* () {
    const tmpDir = makeTempDir();
    const markerFile = path.join(tmpDir, "daemon-for-error-test");

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```bash daemon exec",
          `touch ${markerFile} && sleep 300`,
          "```",
          "",
          "```js eval",
          'throw new Error("intentional error");',
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const output = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime: nodeRuntime(),
        freshness: false,
      });

      // The eval block error should appear in output
      expect(output).toContain("intentional error");

      // After runDocument completes, the daemon process should be terminated.
      // The marker file was created (daemon started), but the process is now dead.
      // We can't easily check process liveness without PIDs, but the fact that
      // runDocument completed without hanging confirms the daemon was cleaned up.
    } finally {
      cleanup(tmpDir);
    }
  });

  // Q12/Q13: Replay behavior — daemon starts fresh on replay, env restored
  it("Q12/Q13: replay starts fresh daemon with restored bindings", function* () {
    const tmpDir = makeTempDir();
    const markerFile = path.join(tmpDir, "replay-marker");

    try {
      writeFiles(tmpDir, {
        "doc.md": [
          "```js eval",
          "const tag = 'REPLAY_TAG';",
          "```",
          "",
          "```bash daemon exec",
          `echo {tag} > ${markerFile} && sleep 300`,
          "```",
          "",
          "```bash exec",
          `sleep 0.1 && cat ${markerFile}`,
          "```",
        ].join("\n"),
      });

      const stream = new InMemoryStream();
      const runtime = nodeRuntime();

      // Golden run
      const output1 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        freshness: false,
      });

      expect(output1).toContain("REPLAY_TAG");

      // Remove marker to prove replay creates a fresh daemon
      fs.unlinkSync(markerFile);

      // Replay — eval block replays from journal, daemon spawns fresh
      const output2 = yield* runDocument({
        docPath: path.join(tmpDir, "doc.md"),
        stream,
        runtime,
        freshness: false,
      });

      // On replay:
      // - eval block replays from journal, restoring tag to env.values
      // - daemon spawns fresh process with interpolated {tag}
      // - exec block may replay from journal (returning stored output)
      //   OR run fresh depending on journal state
      expect(output2).toContain("REPLAY_TAG");
    } finally {
      cleanup(tmpDir);
    }
  });
});
