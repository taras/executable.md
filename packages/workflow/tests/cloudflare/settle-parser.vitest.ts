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

/**
 * A retained Workspace root is a content identity, and every command that names
 * one names the same thing. A command shape that admitted "any non-empty text"
 * would let a request select a root by a spelling the store can never hold, and
 * would let two commands disagree about what a root is.
 *
 * Shape only. Whether a well-spelled root is the one this run is actually at is
 * the owner's revalidation, in the checkpoint that has a lifecycle to check it
 * against.
 */
describe("a root identity in a command", () => {
  const wrong: Record<string, unknown> = {
    "one character short": ROOT.slice(1),
    "one character long": `${ROOT}0`,
    "uppercase hexadecimal": ROOT.toUpperCase(),
    "hexadecimal with a non-hexadecimal letter": `${ROOT.slice(0, 63)}z`,
    "a plausible-looking name": "root-a",
    "not text at all": 7,
  };

  /** Every root field in the private command shapes, by the request it sits in. */
  const fields: Record<string, (root: unknown) => string> = {
    "materialize.workspaceRootId": (root) =>
      JSON.stringify({ id: "m1", command: "materialize", workspaceRootId: root }),
    "commit.expectedWorkspaceRootId": (root) => commit({ expectedWorkspaceRootId: root }),
    "commit.proposedWorkspaceRootId": (root) => commit({ proposedWorkspaceRootId: root }),
    "settle.expectedWorkspaceRootId": (root) => settle({ expectedWorkspaceRootId: root }),
  };

  function commit(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      id: "c1",
      command: "commit",
      expectedWorkspaceRootId: ROOT,
      expectedJournalEventId: null,
      content: [],
      proposedWorkspaceRootId: ROOT,
      events: [],
      ...overrides,
    });
  }

  it("reads the canonical spelling in every command that names one", () => {
    for (const [field, request] of Object.entries(fields)) {
      expect([field, read(request(ROOT))]).toEqual([field, field.split(".")[0]]);
    }
  });

  it("refuses anything that is not the canonical spelling", () => {
    for (const [field, request] of Object.entries(fields)) {
      for (const [description, root] of Object.entries(wrong)) {
        expect([field, description, read(request(root))]).toEqual([
          field,
          description,
          "malformed-member",
        ]);
      }
    }
  });
});
