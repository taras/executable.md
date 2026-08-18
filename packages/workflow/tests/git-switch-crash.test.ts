/**
 * Tier WF — a `<Git.Switch>` across a process boundary.
 *
 * The rest of the Git suites end their transactions in this process: they
 * commit, refuse, or are cancelled, and Effection tears the scope down. None of
 * that is a crash. At the kill point the switch transaction is open with the
 * imported checkout, the published Workspace root and the routed journal row all
 * written; `SIGKILL` then runs no application cleanup at all, so nothing commits
 * and nothing rolls back. Whether any of it reappears is decided by the next
 * connection to open the database.
 *
 * The handshake is a line of JSON on standard output, never a sleep: the parent
 * kills the child at a point the child has said it has reached.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { exec as execProcess } from "@effectionx/process";
import { exec } from "@executablemd/runtime";
import { call, type Operation, race, scoped, spawn, withResolvers } from "effection";
import { WORKSPACE_GIT_SWITCH } from "../src/deno/composition/provider.ts";
import { createRun, runPath, useStorageRoot, withStorage } from "./support/storage.ts";
import { useBareRemote } from "./support/git-remotes.ts";
import { MAIN_CONTENT, RELEASE_CONTENT } from "./support/git-crash-process.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const CRASH_CHILD = fileURLToPath(new URL("./support/git-crash-child.ts", import.meta.url));

const REMOTE = {
  commits: [
    { message: "first", entries: [{ path: "which.txt", content: MAIN_CONTENT }] },
    {
      message: "release",
      branch: "release",
      entries: [{ path: "which.txt", content: RELEASE_CONTENT }],
    },
  ],
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

describe("workflow Git.Switch across a process boundary", () => {
  it("commits the whole switch or none of it when a real SIGKILL lands", function* () {
    const root = yield* useStorageRoot();
    const remote = yield* useBareRemote(REMOTE);
    const runId = "git-switch-crash";
    yield* withStorage(root, function* () {
      yield* createRun({ runId });
    });

    // Taken after the provider scope closed, so nothing this process holds is
    // keeping the database open when the child starts.
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

      // The child holds its switch transaction open here, so what a second
      // connection can see is the discriminating observation.
      const outside = committed(path);
      process.kill(child.pid, "SIGKILL");
      const status = yield* child.join();
      return { announcement, outside, status };
    });

    expect(during.status.signal).toBe("SIGKILL");
    expect(during.status.code ?? null).toBeNull();

    // Inside the crashed transaction the switch's journal row and its published
    // root both existed.
    expect(during.announcement["ready"]).toBe(true);
    expect(during.announcement["switchRows"]).toBe(1);

    // None of it was visible to anyone else while the child was alive: the
    // Repository committed before the switch began, and that is all there is.
    expect(during.outside["types"]).not.toContain(WORKSPACE_GIT_SWITCH);
    expect(during.outside["currentRoot"]).not.toBe(during.announcement["currentRoot"]);

    // A different process, through a newly installed production provider, finds
    // the Repository and a checkout that never moved.
    const inspected = announced(yield* runChild(["inspect", root, runId]));
    expect(inspected["repositories"]).toBe(1);
    expect(inspected["which"]).toBe(MAIN_CONTENT);
    expect(inspected["types"]).not.toContain(WORKSPACE_GIT_SWITCH);
    expect(inspected["currentRoot"]).toBe(during.outside["currentRoot"]);
  });
});
