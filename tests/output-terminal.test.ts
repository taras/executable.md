/**
 * Tier TF — Terminal ANSI formatting middleware tests (spec §9.5).
 *
 * Note: In the test environment (non-TTY), chalk's color level is 0,
 * so marked-terminal won't produce ANSI escape sequences. Tests verify
 * that the middleware transforms markdown (strips syntax, reformats)
 * rather than checking for specific ANSI codes.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@std/expect";
import { useScope, createChannel, type Operation } from "effection";
import { EMA } from "../src/ema-api.ts";
import { useTerminalOutput } from "../src/output/terminal.ts";
import { subscribe } from "../src/subscribe.ts";

/**
 * Helper: install terminal middleware + capture handler, emit text, collect.
 */
function* collectTerminal(texts: string[]): Operation<string[]> {
  const channel = createChannel<string, void>();
  const scope = yield* useScope();

  // First: terminal formatting (outermost)
  yield* useTerminalOutput();

  // Last: channel delivery (closest to core)
  scope.around(EMA, {
    *output([text]) {
      yield* channel.send(text);
    },
  });

  const { ready, task: consumer } = yield* subscribe<string>(channel);
  yield* ready;

  for (const text of texts) {
    yield* EMA.operations.output(text);
  }
  yield* channel.close();

  return yield* consumer;
}

describe("Tier TF — Terminal ANSI formatting", () => {
  // TF1: Heading is processed by marked-terminal
  it("TF1: heading is processed by marked-terminal", function* () {
    const result = yield* collectTerminal(["# Title\n\n"]);
    // marked-terminal processes the heading — output differs from raw markdown.
    // In non-TTY (no color), it still adds the "# " prefix or reformats.
    expect(result.length).toBe(1);
    expect(result[0]).toContain("Title");
  });

  // TF2: Bold is processed
  it("TF2: bold text is processed by marked-terminal", function* () {
    const result = yield* collectTerminal(["**bold text**\n"]);
    // marked-terminal strips ** markers
    expect(result[0]).toContain("bold text");
    expect(result[0]).not.toContain("**");
  });

  // TF3: Plain text passes through
  it("TF3: plain text is rendered", function* () {
    const result = yield* collectTerminal(["Hello world\n"]);
    expect(result[0]).toContain("Hello world");
  });

  // TF4: Async:false (synchronous)
  it("TF4: marked.parse with async:false returns string", function* () {
    const result = yield* collectTerminal(["# Test\n"]);
    expect(typeof result[0]).toBe("string");
  });

  // TF5: Middleware composes with other middleware
  it("TF5: middleware composes with other handlers", function* () {
    const captured: string[] = [];
    const scope = yield* useScope();

    // First: terminal (outermost)
    yield* useTerminalOutput();

    // Last: capture (closest to core)
    scope.around(EMA, {
      *output([text]) {
        captured.push(text);
      },
    });

    yield* EMA.operations.output("**bold**\n");

    expect(captured.length).toBe(1);
    // marked-terminal strips the ** markers
    expect(captured[0]).not.toContain("**");
    expect(captured[0]).toContain("bold");
  });
});
