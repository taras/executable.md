/**
 * Tier SK — session identity tests (specs/acp-client-spec.md §Session).
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { API } from "@executablemd/runtime";
import type { Operation } from "effection";
import {
  deriveSessionKey,
  resolveSessionPlacement,
  sessionCandidates,
} from "../src/session-key.ts";
import { makeRecord, makeStore } from "./helpers.ts";

/** Stub stat so exactly the given paths exist. */
function* useStatWorld(existing: Record<string, "file" | "dir">): Operation<void> {
  yield* API.Fs.around({
    *stat([path]) {
      const kind = existing[path];
      if (kind === undefined) {
        return { exists: false, isFile: false, isDirectory: false };
      }
      return { exists: true, isFile: kind === "file", isDirectory: kind === "dir" };
    },
  });
}

describe("Tier SK — session identity", () => {
  it("SK1: keys are namespaced, digested, and name-scoped", function* () {
    const key = deriveSessionKey("codex --acp", "/repo", "review");
    const parts = key.split(":");
    expect(parts.slice(0, 2)).toEqual(["xmd", "v1"]);
    expect(parts[2]).toMatch(/^[0-9a-f]{16}$/);
    expect(parts[3]).toMatch(/^[0-9a-f]{16}$/);
    expect(parts[4]).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSessionKey("codex --acp", "/other", "review")).not.toBe(key);
    expect(deriveSessionKey("claude --acp", "/repo", "review")).not.toBe(key);
  });

  it("SK8: the unnamed session is distinct from any given name", function* () {
    const unnamed = deriveSessionKey("codex --acp", "/repo");
    expect(unnamed.endsWith(":default")).toBe(true);
    expect(unnamed).not.toBe(deriveSessionKey("codex --acp", "/repo", "review"));
    expect(unnamed).not.toBe(deriveSessionKey("codex --acp", "/repo", "default"));
    expect(deriveSessionKey("codex --acp", "/repo", "review")).not.toBe(
      deriveSessionKey("codex --acp", "/repo", "release"),
    );
  });

  it("SK9: long commands and long names stay usable as file names", function* () {
    const command = `'${"/very/long/path".repeat(20)}/xmd' test-agent --connect 127.0.0.1:50049/${"a".repeat(64)}`;
    const name = "session-".repeat(50);
    for (const key of [
      deriveSessionKey(command, "/repo", "review"),
      deriveSessionKey("codex", `/${"deep".repeat(60)}`, "review"),
      deriveSessionKey("codex", "/repo", name),
      deriveSessionKey(command, `/${"deep".repeat(60)}`, name),
    ]) {
      expect(key.length).toBeLessThan(80);
      expect(encodeURIComponent(key).length).toBeLessThan(255);
    }
  });

  it("SK2: candidates walk from cwd to the git root, nearest first", function* () {
    yield* useStatWorld({ "/repo/.git": "dir" });
    const candidates = yield* sessionCandidates("codex", "/repo/sub/dir");
    expect(candidates.map((candidate) => candidate.cwd)).toEqual([
      "/repo/sub/dir",
      "/repo/sub",
      "/repo",
    ]);
  });

  it("SK3: a .git file (worktree) bounds the walk like a directory", function* () {
    yield* useStatWorld({ "/repo/worktrees/wt/.git": "file" });
    const candidates = yield* sessionCandidates("codex", "/repo/worktrees/wt");
    expect(candidates.map((candidate) => candidate.cwd)).toEqual(["/repo/worktrees/wt"]);
  });

  it("SK4: outside a repository only the exact cwd is a candidate", function* () {
    yield* useStatWorld({});
    const candidates = yield* sessionCandidates("codex", "/no/repo/here");
    expect(candidates.map((candidate) => candidate.cwd)).toEqual(["/no/repo/here"]);
  });

  it("SK5: placement reuses the nearest existing record and passes its cwd", function* () {
    yield* useStatWorld({ "/repo/.git": "dir" });
    const rootKey = deriveSessionKey("codex", "/repo");
    const store = makeStore({ [rootKey]: makeRecord("codex", "/repo") });
    const placement = yield* resolveSessionPlacement(store, "codex", "/repo/sub");
    expect(placement.cwd).toBe("/repo");
    expect(placement.sessionKey).toBe(rootKey);
  });

  it("SK6: without an existing record the exact contextual cwd is used", function* () {
    yield* useStatWorld({ "/repo/.git": "dir" });
    const placement = yield* resolveSessionPlacement(makeStore(), "codex", "/repo/sub");
    expect(placement.cwd).toBe("/repo/sub");
    expect(placement.sessionKey).toBe(deriveSessionKey("codex", "/repo/sub"));
  });

  it("SK7: records for a different agent command or cwd are not reused", function* () {
    yield* useStatWorld({ "/repo/.git": "dir" });
    const rootKey = deriveSessionKey("codex", "/repo");
    const store = makeStore({
      [rootKey]: makeRecord("other-command", "/repo"),
    });
    const placement = yield* resolveSessionPlacement(store, "codex", "/repo/sub");
    expect(placement.cwd).toBe("/repo/sub");
  });
});
