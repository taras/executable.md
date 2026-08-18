/**
 * Tier WF — a `<Git.Add>` across a process boundary.
 *
 * At the kill point the staging transaction is open with the imported index, the
 * published Workspace root and the routed journal row all written; `SIGKILL`
 * then runs no application cleanup, so nothing commits and nothing rolls back.
 * What a later connection finds is decided there.
 *
 * The write that produced the file commits in its own effect before the staging
 * begins, which is what makes the observation sharp: the recovered database must
 * hold the file and an index that never saw it.
 *
 * The handshake is a line of JSON on standard output, never a sleep.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exec as execProcess } from "@effectionx/process";
import { exec } from "@executablemd/runtime";
import { call, type Operation, race, scoped, spawn, withResolvers } from "effection";
import { WORKSPACE_GIT_ADD } from "../src/deno/composition/provider.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { CRASH_PATH, MAIN_CONTENT } from "./support/git-crash-process.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CRASH_CHILD = fileURLToPath(new URL("./support/git-crash-child.ts", import.meta.url));

const REMOTE = {
  commits: [{ message: "first", entries: [{ path: "which.txt", content: MAIN_CONTENT }] }],
} as const;

interface ChildResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function* runChild(args: string[]): Operation<ChildResult> {
  const result = yield* exec({
    command: [process.execPath, "run", "--allow-all", "--frozen", CRASH_CHILD, ...args],
    cwd: REPOSITORY,
  });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

function announced(result: ChildResult): Record<string, unknown> {
  if (result.code !== 0) {
    throw new Error(`the child exited ${result.code}: ${result.err}`);
  }
  return JSON.parse(result.out);
}

/** What a second connection can see of this database right now. */
function committed(path: string): Record<string, unknown> {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  try {
    sqlite.exec("PRAGMA busy_timeout = 10000");
    return {
      currentRoot: sqlite.prepare("SELECT current_root_id FROM workspace_state").get()?.[
        "current_root_id"
      ],
      types: sqlite
        .prepare("SELECT record FROM journal_events ORDER BY sequence")
        .all()
        .map((row) => JSON.parse(String(row["record"])).description?.type),
    };
  } finally {
    sqlite.close();
  }
}

describe("workflow Git.Add across a process boundary", () => {
  it("commits the whole staging or none of it when a real SIGKILL lands", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const runId = "git-add-crash";
    yield* withStorage(root, function* () {
      yield* createRun({ runId });
    });

    const path = runPath(root, runId);

    const during = yield* scoped(function* () {
      const child = yield* execProcess(process.execPath, {
        arguments: [
          "run",
          "--allow-all",
          "--frozen",
          CRASH_CHILD,
          "crash",
          root,
          runId,
          remote.locator,
          "add",
        ],
        cwd: REPOSITORY,
      });
      const ready = withResolvers<Record<string, unknown>>();
      const decoder = new TextDecoder();
      let out = "";
      let err = "";
      yield* spawn(function* () {
        const subscription = yield* child.stdout;
        let next = yield* subscription.next();
        while (!next.done) {
          out += decoder.decode(next.value, { stream: true });
          const end = out.indexOf("\n");
          if (end >= 0) {
            ready.resolve(JSON.parse(out.slice(0, end)));
          }
          next = yield* subscription.next();
        }
      });
      yield* spawn(function* () {
        const subscription = yield* child.stderr;
        let next = yield* subscription.next();
        while (!next.done) {
          err += decoder.decode(next.value, { stream: true });
          next = yield* subscription.next();
        }
      });

      const announcement = yield* race([
        ready.operation,
        call(function* (): Operation<Record<string, unknown>> {
          const status = yield* child.join();
          throw new Error(
            `the crash child ended before its handshake (${JSON.stringify(status)}): ${err}`,
          );
        }),
      ]);

      const outside = committed(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();

    // Inside the crashed transaction the staging's journal row and its published
    // root both existed.
    expect(during.announcement["ready"]).toBe(true);
    expect(during.announcement["operationRows"]).toBe(1);

    // None of it was visible to anyone else while the child was alive: the
    // Repository and the file write committed before the staging began.
    expect(during.outside["types"]).not.toContain(WORKSPACE_GIT_ADD);
    expect(during.outside["currentRoot"]).not.toBe(during.announcement["currentRoot"]);

    // A different process, through a newly installed production provider, finds
    // the file and an index that never saw it.
    const inspected = announced(yield* runChild(["inspect", root, runId]));
    expect(inspected["repositories"]).toBe(1);
    expect(inspected["staged"]).toEqual([]);
    expect(inspected["types"]).not.toContain(WORKSPACE_GIT_ADD);
    expect(inspected["currentRoot"]).toBe(during.outside["currentRoot"]);
    expect(CRASH_PATH).toBe("added.txt");
  });
});
