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
    // deno-lint-ignore require-yield
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
  it("SK1: keys are namespaced, encoded, digested, and name-scoped", function* () {
    const key = deriveSessionKey("codex --acp", "/repo", "review");
    const parts = key.split(":");
    expect(parts.slice(0, 2)).toEqual(["xmd", "v1"]);
    expect(parts[2]).toBe(encodeURIComponent("codex --acp"));
    expect(parts[3]).toMatch(/^[0-9a-f]{16}$/);
    expect(parts[4]).toBe("review");
    expect(deriveSessionKey("codex --acp", "/repo")).not.toBe(key);
    expect(deriveSessionKey("codex --acp", "/repo").endsWith(":default")).toBe(true);
    expect(deriveSessionKey("codex --acp", "/other", "review")).not.toBe(key);
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
