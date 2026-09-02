/**
 * Tier TF — Terminal ANSI formatting middleware tests (spec §9.5).
 *
 * Note: In the test environment (non-TTY), chalk's color level is 0,
 * so marked-terminal won't produce ANSI escape sequences. Tests verify
 * that the middleware transforms markdown (strips syntax, reformats)
 * rather than checking for specific ANSI codes.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createChannel, type Operation } from "effection";
import { DocumentOutput } from "../src/api.ts";
import { useTerminalOutput } from "../src/output/terminal.ts";
import { subscribe } from "../src/subscribe.ts";

/**
 * Helper: install terminal middleware + capture handler, emit text, collect.
 */
function* collectTerminal(texts: (string | [string, boolean])[]): Operation<string[]> {
  const channel = createChannel<string, void>();
  // First: terminal formatting (outermost)
  yield* useTerminalOutput();

  // Last: channel delivery (closest to core)
  yield* DocumentOutput.around({
    *output([text]) {
      yield* channel.send(text);
    },
  });

  const { ready, task: consumer } = yield* subscribe<string>(channel);
  yield* ready;

  for (const text of texts) {
    if (typeof text === "string") {
      yield* DocumentOutput.operations.output(text);
      continue;
    }
    yield* DocumentOutput.operations.output(text[0], text[1]);
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

    // First: terminal (outermost)
    yield* useTerminalOutput();

    // Last: capture (closest to core)
    yield* DocumentOutput.around({
      *output([text]) {
        captured.push(text);
      },
    });

    yield* DocumentOutput.operations.output("**bold**\n");

    expect(captured.length).toBe(1);
    // marked-terminal strips the ** markers
    expect(captured[0]).not.toContain("**");
    expect(captured[0]).toContain("bold");
  });

  // TF6: An exact write is source, and source is never rendered
  it("TF6: exact bytes pass through byte for byte", function* () {
    // Everything this formatter would otherwise transform: a heading, a fenced
    // block, emphasis markers, a line ending in spaces, and a run of blank
    // lines. As a program's source, all of it has to arrive unchanged — a
    // heading turned into a styled heading is no longer source anybody can run.
    const exact = [
      "# Approved program",
      "",
      "Writes **evidence** when something runs it.   ",
      "",
      "",
      "",
      "```markdown",
      '  <File path="planned.txt">ran</File>',
      "```",
      "",
    ].join("\n");

    const result = yield* collectTerminal([[exact, true]]);

    expect(result).toEqual([exact]);
    // The emphasis markers inside the source survived, which is the same fact
    // TF2 proves this formatter removes from prose.
    expect(result[0]).toContain("**evidence**");
  });

  // TF7: The bypass is per write, not a switch
  it("TF7: prose around an exact write is still formatted", function* () {
    const exact = "keep **these** markers   \n";
    const result = yield* collectTerminal(["**before**\n", [exact, true], "**after**\n"]);

    // The prose on either side went through marked-terminal as it always has.
    expect(result[0]).not.toContain("**");
    expect(result[0]).toContain("before");
    expect(result[2]).not.toContain("**");
    expect(result[2]).toContain("after");
    // The write between them did not: its markers and its trailing spaces are
    // exactly what was written.
    expect(result[1]).toBe(exact);
  });
});
