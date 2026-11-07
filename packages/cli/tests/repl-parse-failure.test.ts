/**
 * A saved REPL entry whose `<Parse>` content is invalid (spec §6.12).
 *
 * Real sessions over a real execution file. The entry's own outcome is what a
 * reopened session reads back, so each case closes the session that wrote it
 * and reopens the file cold: what was recorded must come back as recorded,
 * repeating no effect and appending nothing.
 *
 * The historical case reopens a history recorded before `<Parse>` failed its
 * document, when the same entry printed the failure and settled `ok`. That
 * outcome is the record's, and reopening it does not rewrite it.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { appendFile, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplHost } from "../src/repl/host.ts";
import { createExecutionFile, executionPath, openExecutionFile } from "../src/repl/journal.ts";
import { openReplSession, submitReplEntry } from "../src/repl/session.ts";
import type { ReplSession } from "../src/repl/session.ts";
import type { ReplEntry } from "../src/repl/model.ts";

const SCHEMA = '{{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }}';

function entrySource(content: string): string {
  return [
    "```sh exec",
    "echo BEFORE_EFFECT",
    "```",
    "",
    "PREFIX",
    "",
    `<Parse schema=${SCHEMA} as="v">${content}</Parse>`,
    "",
    "```sh exec",
    "echo LATER_EFFECT",
    "```",
    "",
  ].join("\n");
}

/** Where the history recorded before the repair lives, relative to this file. */
const HISTORY = new URL("./fixtures/parse-failure-history/parse922history.jsonl", import.meta.url);

function useNodeReplHost(name: string): Operation<void> {
  return ReplHost.around(
    {
      // deno-lint-ignore require-yield
      *identify(): Operation<string> {
        return name;
      },
      *createExclusive([path]: [string]): Operation<void> {
        const handle = yield* until(open(path, "wx"));
        yield* until(handle.close());
      },
      *appendRecord([path, record]: [string, string]): Operation<void> {
        yield* until(appendFile(path, record));
      },
    },
    { at: "min" },
  );
}

/** Every command a block actually ran, rather than one replay restored. */
function* countProcesses(): Operation<string[]> {
  const commands: string[] = [];
  yield* API.Process.around({
    // deno-lint-ignore require-yield
    *exec([options]) {
      commands.push(options.command.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return commands;
}

function* useDirectory(): Operation<string> {
  const root = yield* until(mkdtemp(join(tmpdir(), "xmd-repl-parse-")));
  yield* ensure(() => rm(root, { recursive: true, force: true }));
  return root;
}

function opened(result: Result<ReplSession>): ReplSession {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function only(session: ReplSession): ReplEntry {
  expect(session.model.entries).toHaveLength(1);
  const [entry] = session.model.entries;
  return entry;
}

function names(entry: ReplEntry): string[] {
  return entry.bindings.map((binding) => binding.name);
}

/** Open the execution file cold, join it, and return the one entry it holds. */
function reopen(root: string, execution: string): Operation<ReplEntry> {
  return scoped(function* () {
    const session = opened(
      yield* openReplSession({ execution: yield* openExecutionFile(root, execution) }),
    );
    yield* session.join();
    return only(session);
  });
}

describe(
  "REPL: an entry with an invalid Parse",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    for (const [execution, kind, content, diagnostic] of [
      ["malformed", "malformed JSON", "nope", "content is not JSON"],
      ["rejected", "content the schema rejects", '{ "a": 1 }', "must be string"],
    ]) {
      it(`saves ${kind} as a failed entry that reopens failed`, function* () {
        yield* useNodeReplHost(execution);
        const commands = yield* countProcesses();
        const root = yield* useDirectory();

        const first = yield* scoped(function* () {
          const session = opened(
            yield* submitReplEntry({
              execution: yield* createExecutionFile(root, execution),
              source: entrySource(content),
            }),
          );
          const settled = yield* session.join();
          return { settled, entry: only(session) };
        });

        expect(first.settled.ok).toBe(false);
        expect(first.settled.ok ? "" : first.settled.error.message).toContain(diagnostic);
        expect(first.entry.terminal?.status).toBe("err");
        expect(first.entry.terminal?.output).toContain("PREFIX");
        expect(names(first.entry)).not.toContain("v");
        expect(commands).toHaveLength(1);
        expect(commands[0]).toContain("BEFORE_EFFECT");

        const path = executionPath(root, execution);
        const recorded = yield* readTextFile(path);

        const again = yield* reopen(root, execution);
        expect(again.terminal?.status).toBe("err");
        expect(again.terminal?.output).toBe(first.entry.terminal?.output);
        expect(again.terminal?.message).toBe(first.entry.terminal?.message);
        expect(names(again)).not.toContain("v");
        expect(commands).toHaveLength(1);
        expect(yield* readTextFile(path)).toBe(recorded);
      });
    }

    it("reopens an entry recorded as successful before the repair as successful", function* () {
      const execution = "parse922history";
      yield* useNodeReplHost(execution);
      const commands = yield* countProcesses();
      const root = yield* useDirectory();
      yield* ensureDir(root);
      const recorded = yield* readTextFile(HISTORY.pathname);
      const path = executionPath(root, execution);
      yield* writeTextFile(path, recorded);

      const entry = yield* reopen(root, execution);
      expect(entry.terminal?.status).toBe("ok");
      expect(entry.terminal?.output).toContain("PREFIX");
      expect(entry.terminal?.output).toContain("content failed its schema");
      expect(commands).toEqual([]);
      expect(yield* readTextFile(path)).toBe(recorded);
    });
  },
);
