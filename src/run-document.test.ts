/**
 * Integration tests for runDocument (Tier E from spec §11).
 *
 * Uses stubRuntime from @effectionx/durable-effects for isolation
 * and InMemoryStream from @effectionx/durable-streams for journaling.
 */
import { describe, it } from "@effectionx/bdd/node";
import assert from "node:assert/strict";
import { InMemoryStream } from "@effectionx/durable-streams";
import { stubRuntime } from "@effectionx/durable-effects";
import type { DurableRuntime, StatResult } from "@effectionx/durable-streams";
import { runDocument } from "./run-document.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(files: Record<string, string>): DurableRuntime {
  return stubRuntime({
    *readTextFile(path: string) {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return content;
    },
    *stat(path: string): Generator<never, StatResult, unknown> {
      const exists = path in files;
      return { exists, isFile: exists, isDirectory: false };
    },
    *exec(options: { command: string[]; timeout?: number }) {
      // Simple mock exec — just return the command as stdout
      const cmd = options.command.join(" ");
      if (cmd.includes("bash -c")) {
        // Code block content includes trailing newline — trim for matching
        const script = (options.command[2] ?? "").trim();
        // Simulate a few commands
        if (script.startsWith("echo ")) {
          return {
            exitCode: 0,
            stdout: script.slice(5) + "\n",
            stderr: "",
          };
        }
        if (script === "ls ./src") {
          return {
            exitCode: 0,
            stdout: "main.ts\nutils.ts\n",
            stderr: "",
          };
        }
        // Default: return the script itself
        return {
          exitCode: 0,
          stdout: script + "\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

// ---------------------------------------------------------------------------
// Tier E — End-to-end tests
// ---------------------------------------------------------------------------

describe("runDocument", () => {
  // E1: Full document golden run
  it("E1: full document golden run — root + component + exec", function*() {
    const files: Record<string, string> = {
      "README.md": [
        "---",
        "title: My Project",
        "---",
        "",
        "# {meta.title}",
        "",
        '<Greeting name="world" />',
        "",
        "```bash exec",
        "ls ./src",
        "```",
      ].join("\n"),
      "components/Greeting.md": [
        "---",
        "emoji: hi",
        "",
        "inputs:",
        "  name:",
        "    type: string",
        "    required: true",
        "---",
        "",
        "{meta.emoji} Hello, {props.name}!",
      ].join("\n"),
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false, // Skip guard for golden run test
    });

    // Check output contains expected content
    assert.ok(result.includes("# My Project"), "should have title");
    assert.ok(result.includes("hi Hello, world!"), "should have greeting");
    assert.ok(result.includes("main.ts"), "should have exec output");
    assert.ok(result.includes("utils.ts"), "should have exec output");

    // Check journal has events
    const events = stream.snapshot();
    assert.ok(events.length > 0, "should have journal events");

    // Should have import_component events for root and Greeting
    const imports = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "import_component",
    );
    assert.equal(imports.length, 2, "should have 2 import events");

    // Should have exec event
    const execs = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "exec",
    );
    assert.equal(execs.length, 1, "should have 1 exec event");

    // Should have close event
    const closes = events.filter((e) => e.type === "close");
    assert.equal(closes.length, 1, "should have 1 close event");
  });

  // E2: Full replay — zero file reads, zero exec calls
  it("E2: full replay — same output, no I/O", function*() {
    const files: Record<string, string> = {
      "README.md": "# Hello\n",
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    // First run — golden
    const firstResult = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    // Second run — replay from same stream, stub runtime that throws on all I/O
    let readCalled = false;
    let execCalled = false;
    const replayRuntime = stubRuntime({
      *readTextFile(_path: string) {
        readCalled = true;
        throw new Error("should not read during replay");
      },
      *stat(_path: string): Generator<never, StatResult, unknown> {
        throw new Error("should not stat during replay");
      },
      *exec(_options: unknown) {
        execCalled = true;
        throw new Error("should not exec during replay");
      },
    });

    const secondResult = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime: replayRuntime,
      freshness: false,
    });

    assert.equal(secondResult, firstResult);
    assert.equal(readCalled, false, "should not read during replay");
    assert.equal(execCalled, false, "should not exec during replay");
  });

  // E6: Props flow through expansion
  it("E6: validated props flow through expansion", function*() {
    const files: Record<string, string> = {
      "README.md": '<Greeting name="Alice" />\n',
      "components/Greeting.md": [
        "---",
        "inputs:",
        "  name:",
        "    type: string",
        "    required: true",
        "---",
        "",
        "Hello, {props.name}!",
      ].join("\n"),
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    assert.ok(result.includes("Hello, Alice!"));
  });

  // E7: Undeclared prop in full document
  it("E7: undeclared prop produces error in output", function*() {
    const files: Record<string, string> = {
      "README.md": '<Badge size="lg" />\n',
      "components/Badge.md": [
        "---",
        "color: blue",
        "---",
        "",
        "badge",
      ].join("\n"),
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    // Should contain error about undeclared prop
    assert.ok(result.includes("ERROR"), "should have error marker");
    assert.ok(
      result.includes("Unknown prop") || result.includes("Prop validation"),
      "should mention prop validation",
    );
  });

  // E8: Silent exec in full document
  it("E8: silent exec — command runs, result journaled, output omitted", function*() {
    const files: Record<string, string> = {
      "README.md": [
        "before",
        "",
        "```bash silent exec",
        "echo hidden",
        "```",
        "",
        "after",
      ].join("\n"),
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    // Output should NOT contain the exec result
    assert.ok(!result.includes("hidden"), "silent should suppress output");
    assert.ok(result.includes("before"), "should have text before");
    assert.ok(result.includes("after"), "should have text after");

    // But the journal should have the exec event
    const events = stream.snapshot();
    const execs = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "exec",
    );
    assert.equal(execs.length, 1, "exec should be journaled even when silent");
  });

  // Simple text document — no components, no exec
  it("simple text document — passthrough", function*() {
    const files: Record<string, string> = {
      "README.md": "# Hello World\n\nThis is a test.\n",
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    assert.equal(result, "# Hello World\n\nThis is a test.\n");
  });

  // Default props applied
  it("default props applied when not provided", function*() {
    const files: Record<string, string> = {
      "README.md": "<Greeting />\n",
      "components/Greeting.md": [
        "---",
        "inputs:",
        "  name:",
        "    type: string",
        "    default: world",
        "---",
        "",
        "Hello, {props.name}!",
      ].join("\n"),
    };

    const stream = new InMemoryStream();
    const runtime = makeRuntime(files);

    const result = yield* runDocument({
      docPath: "README.md",
      stream,
      runtime,
      freshness: false,
    });

    assert.ok(result.includes("Hello, world!"));
  });
});
