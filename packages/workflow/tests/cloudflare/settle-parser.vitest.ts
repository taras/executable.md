/**
 * The settle request, parsed inside a real Worker.
 *
 * The point of running this on workerd rather than portably is the import
 * graph. `parseDocumentExecutionCompletion()` is shared code that reaches
 * `canonicalize` and two spelling predicates in `@executablemd/core`, and until
 * those were published from node-free subpaths that graph pulled `node:crypto`
 * and `node:process` — which typechecks anywhere except the runtime that has to
 * run it. A test that only proved the parser worked would have proved nothing
 * about that; this one loads it where a Node builtin is genuinely absent.
 *
 * The owner's revalidation of acquisition, root and execution belongs to the
 * checkpoint where a lifecycle transaction exists. What is asserted here is the
 * private request contract: what a settle command has to be to be read at all.
 */

import { describe, expect, it } from "vitest";
import { CommandError, parseCommand } from "../../src/cloudflare/commands.ts";

const ROOT = "9f2c4b6a8d0e1f23456789abcdef0123456789abcdef0123456789abcdef0123";

function settle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "s1",
    command: "settle",
    completion: { executionId: "execution-1", status: "completed" },
    expectedWorkspaceRootId: ROOT,
    ...overrides,
  });
}

/** The refusal category, or the command name when it was read. */
function read(raw: string): string {
  try {
    return parseCommand(raw).command;
  } catch (error) {
    return error instanceof CommandError ? error.refusal : "unexpected";
  }
}

describe("a settle command", () => {
  it("reads a complete completion through the shared parser", () => {
    const command = parseCommand(settle());
    expect(command.command).toBe("settle");
    if (command.command !== "settle") {
      throw new Error("expected a settle command");
    }
    expect(command.completion).toEqual({ executionId: "execution-1", status: "completed" });
    expect(command.expectedWorkspaceRootId).toBe(ROOT);
  });

  it("reads a completion carrying a stop reason", () => {
    const command = parseCommand(
      settle({
        completion: {
          executionId: "execution-1",
          status: "failed",
          reason: { kind: "host", code: "settlement-refused" },
        },
      }),
    );
    if (command.command !== "settle") {
      throw new Error("expected a settle command");
    }
    expect(command.completion.reason).toEqual({ kind: "host", code: "settlement-refused" });
  });

  it("refuses a completion the shared parser will not read", () => {
    // Each of these is refused by the shared contract rather than by a private
    // approximation of it, and each becomes this transport's own closed
    // refusal rather than carrying the parser's message onto the wire.
    expect(read(settle({ completion: { status: "completed" } }))).toBe("malformed-member");
    expect(read(settle({ completion: { executionId: "", status: "completed" } }))).toBe(
      "malformed-member",
    );
    expect(read(settle({ completion: { executionId: "e", status: "invented" } }))).toBe(
      "malformed-member",
    );
    expect(read(settle({ completion: { executionId: "e", status: "failed", reason: 7 } }))).toBe(
      "malformed-member",
    );
    expect(read(settle({ completion: "not an object" }))).toBe("malformed-member");
    expect(read(settle({ completion: undefined }))).toBe("malformed-member");
  });

  it("refuses a missing or malformed expected root", () => {
    expect(read(settle({ expectedWorkspaceRootId: undefined }))).toBe("malformed-member");
    expect(read(settle({ expectedWorkspaceRootId: "" }))).toBe("malformed-member");
    expect(read(settle({ expectedWorkspaceRootId: 1 }))).toBe("malformed-member");
  });

  it("refuses a member the command does not declare", () => {
    expect(read(settle({ status: "completed" }))).toBe("unknown-member");
    expect(read(settle({ somethingElse: true }))).toBe("unknown-member");
  });
});
