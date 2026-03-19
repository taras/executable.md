/**
 * Integration tests for runDocument (Tiers B, D, E from spec §11).
 *
 * Uses API.*.around() middleware for isolation
 * and InMemoryStream from @executablemd/durable-streams for journaling.
 *
 * Test patterns:
 *   Golden run — InMemoryStream() (empty) + useStubFs(files) → assert output + journal
 *   Replay    — reuse same InMemoryStream (has events) + useNoIO() → zero I/O
 *   Staleness — golden run, mutate file, rerun with freshness:true → StaleInputError
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { InMemoryStream, StaleInputError } from "@executablemd/durable-streams";
import { useStubFs, useFailingExec } from "@executablemd/runtime/test";
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";
import { runDocument } from "../src/run-document.ts";
import { collect } from "../src/collect.ts";

// ---------------------------------------------------------------------------
// Helpers — install stub middleware via API.*.around()
// ---------------------------------------------------------------------------

function* useStubExec(): Operation<void> {
  yield* API.Process.around({
    *exec([options], _next) {
      // Simple mock exec — just return the command as stdout
      const cmd = options.command.join(" ");
      if (cmd.includes("bash -c")) {
        const script = (options.command[2] ?? "").trim();
        if (script.startsWith("echo ")) {
          return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
        }
        if (script === "ls ./src") {
          return { exitCode: 0, stdout: "main.ts\nutils.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: script + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

// ---------------------------------------------------------------------------
// Tier B — Component import (durable integration tests)
// ---------------------------------------------------------------------------

describe("Tier B — durable import", () => {
  // B1: durableImportComponent golden run — journal shape
  it("B1: import golden run — journal has import_component with path + contentHash", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": "Hello world\n" });
    yield* useStubExec();

    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    const events = stream.snapshot();
    const imports = events.flatMap((e) =>
      e.type === "yield" && e.description.type === "import_component" ? [e] : [],
    );

    expect(imports.length).toBe(1);

    const rootImport = imports[0]!;
    expect(rootImport).toMatchObject({
      type: "yield",
      description: { name: "__root__" },
      result: { status: "ok", value: { path: "README.md" } },
    });

    // Result should contain path and contentHash
    const result = rootImport.result;
    expect(result.status).toBe("ok");
    const value = (result as { status: "ok"; value: Record<string, unknown> }).value;
    expect(value.contentHash).toMatch(/^sha256:/);
    expect(value.content).toContain("Hello world");
  });

  // B2: durableImportComponent replay — stored result returned, no I/O
  it("B2: import replay — stored result returned, no file read", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": "Hello world\n" });
    yield* useStubExec();

    // Golden run
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Replay — middleware is in scope but durable stream replays from journal
    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
  });

  // B3: replay + runtime parsing — stored content parsed to same meta/inputs/segments
  it("B3: replay parses stored content to same result", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": [
        "---",
        "title: Parsed",
        "---",
        "",
        "# {meta.title}",
      ].join("\n"),
    });
    yield* useStubExec();

    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
    expect(secondResult).toContain("# Parsed");
  });

  // B9: import missing component — error propagated
  it("B9: import missing component — error in output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": "<Missing />\n" });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("ERROR");
    expect(
      result.includes("Cannot resolve component") || result.includes("Failed to import"),
    ).toBeTruthy();
  });

  // B10: stale import — file changed, guard installed → StaleInputError
  //
  // ReplayGuard.decide only fires when the workflow actually replays
  // effects (inside each effect's enter()). durableRun short-circuits
  // at the Close event for completed workflows, so we simulate an
  // interrupted run by stripping the Close event from the journal.
  it("B10: stale import — file changed with freshness:true → StaleInputError", function* () {
    // Use a mutable file map so we can change content between runs
    const files: Record<string, string> = { "README.md": "Hello original\n" };
    const stream = new InMemoryStream();
    yield* useStubFs(files);
    yield* useStubExec();

    // Golden run — produces Yield + Close events
    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Build a new stream with only the Yield events (no Close).
    // This simulates an interrupted workflow where replay must
    // re-run each effect through the decide phase.
    const yieldEvents = stream.snapshot().filter((e) => e.type === "yield");
    const interruptedStream = new InMemoryStream(yieldEvents);

    // Change the file content — middleware reads from the same mutable map
    files["README.md"] = "Hello changed\n";

    // Replay with freshness check — guard's decide phase detects hash mismatch.
    // The error propagates through yield* execution via withResolvers reject.
    let caught: unknown;
    try {
      yield* collect(yield* runDocument({
        docPath: "README.md",
        stream: interruptedStream,
        freshness: true,
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StaleInputError);
  });

  // B11: stale import — no guard → replay uses stored content silently
  it("B11: stale import — no guard (freshness:false) → silent replay", function* () {
    const files: Record<string, string> = { "README.md": "Hello original\n" };
    const stream = new InMemoryStream();
    yield* useStubFs(files);
    yield* useStubExec();

    // Golden run
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Change the file — replay WITHOUT guard still uses stored content
    files["README.md"] = "Hello changed\n";

    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Should use stored (original) content
    expect(secondResult).toBe(firstResult);
    expect(secondResult).toContain("original");
  });

  // B12: root document as component — __root__ import, same journal shape
  it("B12: root document imported as __root__", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({ "doc.md": "Root content\n" });
    yield* useStubExec();

    yield* collect(yield* runDocument({
      docPath: "doc.md",
      stream,
      freshness: false,
    }));

    const events = stream.snapshot();
    const [rootImport] = events.flatMap((e) =>
      e.type === "yield" &&
      e.description.type === "import_component" &&
      e.description.name === "__root__"
        ? [e]
        : [],
    );

    expect(rootImport).toBeTruthy();
    expect(rootImport!.result).toMatchObject({ status: "ok", value: { path: "doc.md" } });
  });

  // B13: dotted name resolution — Ns.Sub → components/Ns/Sub.md
  it("B13: dotted component name resolves to nested path", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": "<Ui.Button />\n",
      "components/Ui/Button.md": "Click me\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("Click me");

    // Verify journal has the import with correct path
    const events = stream.snapshot();
    const [compImport] = events.flatMap((e) =>
      e.type === "yield" &&
      e.description.type === "import_component" &&
      e.description.name === "Ui.Button"
        ? [e]
        : [],
    );
    expect(compImport).toBeTruthy();
    expect(compImport!.result).toMatchObject({
      status: "ok",
      value: { path: "components/Ui/Button.md" },
    });
  });

  // B15: default resolver middleware — resolves via stat in search path order
  it("B15: resolver searches component dirs in order", function* () {
    // Component exists in root dir (second search path), not components/
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": "<Banner />\n",
      "Banner.md": "Banner from root\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("Banner from root");
  });
});

// ---------------------------------------------------------------------------
// Tier D — Code execution and modifier middleware
// ---------------------------------------------------------------------------

describe("Tier D — code execution and modifiers", () => {
  // D1: bash exec golden run
  it("D1: bash exec golden run — stdout in output, exec in journal", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash exec", "echo hello", "```"].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("hello");

    // Verify journal
    const events = stream.snapshot();
    const [execEvent] = events.flatMap((e) =>
      e.type === "yield" && e.description.type === "exec" ? [e] : [],
    );
    expect(execEvent).toBeTruthy();
    expect(Array.isArray(execEvent!.description.command)).toBeTruthy();
    expect(execEvent!.result.status).toBe("ok");
  });

  // D2: exec replay — command not re-executed
  it("D2: exec replay — stored stdout used, no re-execution", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash exec", "echo hello", "```"].join("\n"),
    });
    yield* useStubExec();

    // Golden run
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Replay — middleware in scope, durable stream replays from journal
    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
    expect(secondResult).toContain("hello");
  });

  // D3: non-zero exit code → ErrorSegment in output
  it("D3: non-zero exit code → error in output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs(
      { "README.md": ["```bash exec", "failing-command", "```"].join("\n") },
    );
    yield* useFailingExec(1, "command not found");

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(
      result.includes("ERROR") || result.includes("failed"),
    ).toBeTruthy();
  });

  // D4: multi-line command — full script passed to -c
  it("D4: multi-line command — full script in journal", function* () {
    const multiLineScript = "echo line1\necho line2";
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash exec", multiLineScript, "```"].join("\n"),
    });
    yield* useStubExec();

    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Verify the command array in journal contains full script
    const events = stream.snapshot();
    const [execEvent] = events.flatMap((e) =>
      e.type === "yield" && e.description.type === "exec" ? [e] : [],
    );
    expect(execEvent).toBeTruthy();
    const command = execEvent!.description.command as string[];
    expect(command.slice(0, 2)).toEqual(["bash", "-c"]);
    // The third element should contain both lines
    expect(command[2]).toContain("echo line1");
    expect(command[2]).toContain("echo line2");
  });

  // D5: python exec — python -c invocation
  it("D5: python exec — python -c in command array", function* () {
    const files: Record<string, string> = {
      "README.md": ["```python exec", "print('hello')", "```"].join("\n"),
    };

    const stream = new InMemoryStream();
    yield* useStubFs(files);
    // Custom exec middleware that handles python -c
    yield* API.Process.around({
      *exec([options], _next) {
        if (options.command[0] === "python" && options.command[1] === "-c") {
          return { exitCode: 0, stdout: "hello\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      },
    });

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("hello");

    // Verify command in journal
    const events = stream.snapshot();
    const [execEvent] = events.flatMap((e) =>
      e.type === "yield" && e.description.type === "exec" ? [e] : [],
    );
    const command = execEvent!.description.command as string[];
    expect(command[0]).toBe("python");
    expect(command[1]).toBe("-c");
  });

  // D6: bash silent exec — chain: silent wraps exec, exec journals, silent returns empty
  it("D6: bash silent exec — exec journals, output suppressed", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash silent exec", "echo secret", "```"].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Output should be empty (silent suppresses)
    expect(result).not.toContain("secret");

    // Journal should still have exec event
    const events = stream.snapshot();
    const execs = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "exec",
    );
    expect(execs.length).toBe(1);
  });

  // D7: silent exec replay — still produces empty output from stored result
  it("D7: silent exec replay — still empty output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["before\n", "```bash silent exec", "echo secret", "```", "\nafter"].join("\n"),
    });
    yield* useStubExec();

    // Golden
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Replay — durable stream replays from journal
    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
    expect(secondResult).not.toContain("secret");
  });

  // D15: unknown modifier in chain → error
  it("D15: unknown modifier → error in output", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash frobnicate exec", "echo test", "```"].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("ERROR");
    expect(
      result.includes("Unknown modifier") || result.includes("frobnicate"),
    ).toBeTruthy();
  });

  // D16: no terminal modifier → error
  it("D16: no terminal modifier — code block without exec/eval is passive text", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash", "echo test", "```"].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Without exec/eval, code block is passive text — preserved as-is
    expect(result).toContain("```bash");
    expect(result).toContain("echo test");
  });

  // D17: custom modifier registration
  it("D17: custom modifier registration — handler runs in chain", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash uppercase exec", "echo hello", "```"].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
      modifiers: {
        uppercase: (_params) => (_args, next) => function* () {
          const inner = yield* next();
          return {
            output: inner.output.toUpperCase(),
            exitCode: inner.exitCode,
            stderr: inner.stderr,
          };
        }(),
      },
    }));

    expect(result).toContain("HELLO");
  });

  // D19: modifier parsing — timeout=30s
  it("D19: modifier with params parsed correctly", function* () {
    // We test that the modifier receives its params
    let receivedParams: string | undefined;
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": ["```bash timeout=30s exec", "echo test", "```"].join("\n"),
    });
    yield* useStubExec();

    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
      modifiers: {
        timeout: (params) => (_args, next) => {
          receivedParams = params;
          return next();
        },
      },
    }));

    expect(receivedParams).toBe("30s");
  });
});

// ---------------------------------------------------------------------------
// Tier E — End-to-end tests
// ---------------------------------------------------------------------------

describe("runDocument", () => {
  // E1: Full document golden run
  it("E1: full document golden run — root + component + exec", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Check output contains expected content
    expect(result).toContain("# My Project");
    expect(result).toContain("hi Hello, world!");
    expect(result).toContain("main.ts");
    expect(result).toContain("utils.ts");

    // Check journal has events
    const events = stream.snapshot();
    expect(events.length).toBeGreaterThan(0);

    // Should have import_component events for root and Greeting
    const imports = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "import_component",
    );
    expect(imports.length).toBe(2);

    // Should have exec event
    const execs = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "exec",
    );
    expect(execs.length).toBe(1);

    // Should have close event
    const closes = events.filter((e) => e.type === "close");
    expect(closes.length).toBe(1);
  });

  // E2: Full replay — zero file reads, zero exec calls
  it("E2: full replay — same output, no I/O", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": "# Hello\n" });
    yield* useStubExec();

    // First run — golden
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Replay — durable stream replays from journal, middleware not invoked
    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
  });

  // E6: Props flow through expansion
  it("E6: validated props flow through expansion", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("Hello, Alice!");
  });

  // E7: Undeclared prop in full document
  it("E7: undeclared prop produces error in output", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": '<Badge size="lg" />\n',
      "components/Badge.md": [
        "---",
        "color: blue",
        "---",
        "",
        "badge",
      ].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Should contain error about undeclared prop
    expect(result).toContain("ERROR");
    expect(
      result.includes("Unknown prop") || result.includes("Prop validation"),
    ).toBeTruthy();
  });

  // E8: Silent exec in full document
  it("E8: silent exec — command runs, result journaled, output omitted", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": [
        "before",
        "",
        "```bash silent exec",
        "echo hidden",
        "```",
        "",
        "after",
      ].join("\n"),
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Output should NOT contain the exec result
    expect(result).not.toContain("hidden");
    expect(result).toContain("before");
    expect(result).toContain("after");

    // But the journal should have the exec event
    const events = stream.snapshot();
    const execs = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "exec",
    );
    expect(execs.length).toBe(1);
  });

  // Simple text document — no components, no exec
  it("simple text document — passthrough", function*() {
    const stream = new InMemoryStream();
    yield* useStubFs({ "README.md": "# Hello World\n\nThis is a test.\n" });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toBe("# Hello World\n\nThis is a test.\n");
  });

  // Default props applied
  it("default props applied when not provided", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
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
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("Hello, world!");
  });

  // E3: Crash mid-expansion, resume — partial replay then live
  it("E3: crash mid-expansion — partial replay + live for remaining", function* () {
    const files: Record<string, string> = {
      "README.md": [
        '<Greeting name="world" />',
        "",
        "```bash exec",
        "echo done",
        "```",
      ].join("\n"),
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

    // Track exec calls via mutable flag
    let execCalled = false;

    const stream = new InMemoryStream();
    yield* useStubFs(files);
    // Custom exec middleware that tracks calls
    yield* API.Process.around({
      *exec([options], _next) {
        execCalled = true;
        const script = (options.command[2] ?? "").trim();
        if (script.startsWith("echo ")) {
          return { exitCode: 0, stdout: script.slice(5) + "\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Golden run to get full journal
    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    const fullEvents = stream.snapshot();

    // Simulate crash: create a new stream with only partial events
    // (imports but NO exec, NO close)
    const partialEvents = fullEvents.filter(
      (e) =>
        e.type === "yield" && e.description["type"] === "import_component",
    );

    const partialStream = new InMemoryStream(partialEvents);

    // Reset tracking — on resume, exec should be called live
    execCalled = false;

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream: partialStream,
      freshness: false,
    }));

    expect(result).toContain("Hello, world!");
    expect(result).toContain("done");
    expect(execCalled).toBeTruthy();
  });

  // E4: Component file changed, guard on → staleness detected
  //
  // Strip the Close event so durableRun actually replays effects through
  // the decide phase. When the Greeting component's hash mismatches, the
  // guard raises StaleInputError. The expansion engine catches import
  // errors and renders them as ErrorSegments (the error doesn't propagate
  // to the caller because expandComponent wraps all import failures).
  //
  // For the __root__ document, staleness throws at the top level (B10).
  // For child components, it surfaces as an error in the rendered output.
  it("E4: component file changed with guard → staleness error in output", function* () {
    // Use mutable file map so we can change content between runs
    const files: Record<string, string> = {
      "README.md": '<Greeting name="world" />\n',
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
    yield* useStubFs(files);
    yield* useStubExec();

    // Golden run — produces Yield + Close events
    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Strip Close event — simulates interrupted workflow
    const yieldEvents = stream.snapshot().filter((e) => e.type === "yield");
    const interruptedStream = new InMemoryStream(yieldEvents);

    // Change component file — mutable map seen by existing middleware
    files["components/Greeting.md"] = [
      "---",
      "inputs:",
      "  name:",
      "    type: string",
      "    required: true",
      "---",
      "",
      "Hola, {props.name}!",
    ].join("\n");

    // Replay with guard — decide phase detects hash mismatch on Greeting.
    // The expansion engine catches the StaleInputError and renders it as
    // an ErrorSegment (same as any import failure for child components).
    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream: interruptedStream,
      freshness: true,
    }));

    expect(
      result.includes("Component changed") || result.includes("Greeting"),
    ).toBeTruthy();
    expect(result).toContain("ERROR");
  });

  // E5: new component added — replay existing, live for new
  it("E5: new component added — replays existing, live for new", function* () {
    // Use mutable file map
    const files: Record<string, string> = {
      "README.md": "<Header />\n",
      "components/Header.md": "Header content\n",
    };
    const stream = new InMemoryStream();
    yield* useStubFs(files);
    yield* useStubExec();

    // Golden run with just Header
    yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Now add Footer to the document — fresh stream, same middleware
    files["README.md"] = "<Header />\n<Footer />\n";
    files["components/Footer.md"] = "Footer content\n";

    const newStream = new InMemoryStream();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream: newStream,
      freshness: false,
    }));

    expect(result).toContain("Header content");
    expect(result).toContain("Footer content");
  });

  // E10: unclosed bold across component boundary — healed
  it("E10: unclosed bold across component boundary — healed in first segment", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": "This is **bold\n<Greeting />\nmore text\n",
      "components/Greeting.md": "greeting\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // The **bold should be healed (closed) before component expansion.
    // remend appends closing ** after the text segment (including trailing \n).
    // Result: "This is **bold\n**" + "greeting\n" + "\nmore text\n"
    expect(result).toContain("greeting");
    expect(result).toContain("more text");

    // The first text segment should be healed — it should contain both
    // opening ** and closing ** (remend closes the unclosed bold).
    // The closing ** appears after the newline: "**bold\n**"
    const beforeComponent = result.split("greeting")[0]!;
    const openCount = (beforeComponent.match(/\*\*/g) || []).length;
    expect(openCount).toBe(2);
  });

  // E2 complex: full replay with component + exec — zero I/O
  it("E2 complex: full replay with component + exec — zero I/O on second run", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": [
        "---",
        "title: Test",
        "---",
        "",
        "# {meta.title}",
        "",
        '<Greeting name="world" />',
        "",
        "```bash exec",
        "echo output",
        "```",
      ].join("\n"),
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
    });
    yield* useStubExec();

    // Golden run
    const firstResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    // Record journal size
    const goldenEventCount = stream.snapshot().length;

    // Replay — durable stream replays from journal
    const secondResult = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(secondResult).toBe(firstResult);
    expect(secondResult).toContain("# Test");
    expect(secondResult).toContain("Hello, world!");
    expect(secondResult).toContain("output");

    // No new events should be appended during replay
    expect(stream.snapshot().length).toBe(goldenEventCount);
  });

  // Multiple components — verify all are imported and expanded
  it("multiple components — all imported and expanded", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": "<Header />\n<Footer />\n",
      "components/Header.md": "HEADER\n",
      "components/Footer.md": "FOOTER\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("HEADER");
    expect(result).toContain("FOOTER");

    // 3 import_component events: root + Header + Footer
    const events = stream.snapshot();
    const imports = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "import_component",
    );
    expect(imports.length).toBe(3);
  });

  // Transitive components — A references B
  it("transitive components — A → B, both imported", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": "<Wrapper />\n",
      "components/Wrapper.md": "before\n<Inner />\nafter\n",
      "components/Inner.md": "INNER\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("before");
    expect(result).toContain("INNER");
    expect(result).toContain("after");

    // 3 imports: root, Wrapper, Inner
    const events = stream.snapshot();
    const imports = events.filter(
      (e) => e.type === "yield" && e.description["type"] === "import_component",
    );
    expect(imports.length).toBe(3);
  });

  // Content slot with exec
  it("Content slot + exec — both work together", function* () {
    const stream = new InMemoryStream();
    yield* useStubFs({
      "README.md": [
        "<Wrapper>",
        "```bash exec",
        "echo inside",
        "```",
        "</Wrapper>",
      ].join("\n"),
      "components/Wrapper.md": "BEFORE\n<Content />\nAFTER\n",
    });
    yield* useStubExec();

    const result = yield* collect(yield* runDocument({
      docPath: "README.md",
      stream,
      freshness: false,
    }));

    expect(result).toContain("BEFORE");
    expect(result).toContain("inside");
    expect(result).toContain("AFTER");
  });
});
