/**
 * Synthetic mounted cases for `mounted-failure-journal.test.ts`, run as a child
 * test file under the parent's own runtime.
 *
 * Each case drives the real mounted REPL over real file storage and copies what
 * that storage held to `XMD_MOUNTED_WITNESS`, outside the directory its host
 * removes, so the parent can compare a saved failure journal with the bytes the
 * command actually wrote. Each case also records, after its whole teardown has
 * run, which data roots it mounted and whether each still exists.
 */

import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { journalBeforeEach, useJournalStream } from "@executablemd/test-support/failure-journal";
import { exists, readTextFile, walk, writeTextFile, ensureDir } from "@effectionx/fs";
import { API, env } from "@executablemd/runtime";
import { each, ensure, race, scoped, sleep } from "effection";
import type { Operation } from "effection";
import { dirname, join, relative } from "node:path";

import { useReplPage } from "../support/repl-page.ts";
import type { ReplPage } from "../support/repl-page.ts";
import { awaited } from "../support/mounted-repl.ts";
import { asked, intoDraft, sendMessage, typed } from "../support/screen-journeys.ts";
import { useTemporary } from "./repl/issue-883/sidekick-harness.ts";

const OWNER = "packages/cli/tests/fixtures/mounted-failure-journal.ts";

const WIDE = { columns: 160, rows: 36 };

/** How long the deadline case waits for a reply its turn never sends. */
const CASE_DEADLINE_MS = 500;

/** One case's witness directory, and the roots it mounted, in mount order. */
interface Witness {
  readonly directory: string;
  readonly roots: string[];
}

function* witnessDirectory(name: string): Operation<string> {
  const base = yield* env("XMD_MOUNTED_WITNESS");
  if (!base) {
    throw new Error("The mounted journal witness needs a witness directory.");
  }
  return join(base, name);
}

function witness(name: string, body: (witnessed: Witness) => Operation<void>): void {
  describe("mounted journal " + name, () => {
    beforeEach(function* () {
      const root = yield* env("XMD_TEST_ARTIFACTS");
      if (!root) {
        throw new Error("The mounted journal witness needs an artifact root.");
      }
      yield* API.Env.around({
        *env([variable], next) {
          return variable === "XMD_TEST_ARTIFACTS" ? join(root, name) : yield* next(variable);
        },
      });
    });
    beforeEach(journalBeforeEach(OWNER));
    it(name, function* () {
      const witnessed: Witness = { directory: yield* witnessDirectory(name), roots: [] };
      // Registered before any host, so it runs once every mounted scope has
      // unwound: what it records is the state teardown actually left.
      yield* ensure(function* () {
        const roots: { root: string; exists: boolean }[] = [];
        for (const root of witnessed.roots) {
          roots.push({ root, exists: yield* exists(root) });
        }
        yield* ensureDir(witnessed.directory);
        yield* writeTextFile(
          join(witnessed.directory, "teardown.json"),
          JSON.stringify({ joined: true, roots }) + "\n",
        );
      });
      yield* body(witnessed);
    });
  });
}

/** Copy the JSONL files beneath this root, as the command left them. */
function* copyJournals(witnessed: Witness, ordinal: number, root: string): Operation<void> {
  const target = join(witnessed.directory, `root-${ordinal}`);
  yield* ensureDir(target);
  for (const entry of yield* each(walk(root, { includeDirs: false, match: [/\.jsonl$/] }))) {
    const copy = join(target, relative(root, entry.path));
    yield* ensureDir(dirname(copy));
    yield* writeTextFile(copy, yield* readTextFile(entry.path));
    yield* each.next();
  }
}

/** Mount the real command and remember the root it stores its histories in. */
function* mounted(
  witnessed: Witness,
  options: Parameters<typeof useReplPage>[0] = {},
): Operation<{ page: ReplPage; ordinal: number }> {
  const page = yield* useReplPage({ size: WIDE, ...options });
  witnessed.roots.push(page.repl.root);
  return { page, ordinal: witnessed.roots.length };
}

/**
 * One Sidekick exchange and one entry of a person's own, both settled.
 *
 * The message spells `word` in lower case so that only the reply draws it.
 */
function* exchange(page: ReplPage, word: string): Operation<void> {
  page.repl.fake.script({ reply: `<Output>${word}</Output>\n` });
  yield* asked(page, `reply ${word.toLowerCase()}`, word);
  yield* intoDraft(page);
  yield* typed(page, `<Output>entry ${word}</Output>`);
  yield* page.key("Enter");
  yield* page.until("the entry settling", (one) => one.shows("1 ✓"));
}

/** Leave the command and wait for it to return. */
function* exit(page: ReplPage): Operation<void> {
  yield* page.press("[exit]");
  yield* awaited("Exit joined", () => page.repl.outcome() !== undefined);
  expect(page.repl.outcome()?.ok).toBe(true);
}

witness("passing page", function* (witnessed) {
  const { page, ordinal } = yield* mounted(witnessed);
  yield* exchange(page, "PASSING");
  yield* exit(page);
  yield* copyJournals(witnessed, ordinal, page.repl.root);
});

witness("late assertion", function* (witnessed) {
  const { page, ordinal } = yield* mounted(witnessed);
  yield* exchange(page, "ASSERTED");
  yield* exit(page);
  yield* copyJournals(witnessed, ordinal, page.repl.root);
  expect("the mounted command returned").toBe("deliberate mounted late assertion");
});

witness("deadline", function* (witnessed) {
  // A root this case supplies, so the copy can be taken at the latest moment
  // before removal: after the host's own retention and before the directory goes.
  const dataRoot = yield* useTemporary("xmd-mounted-witness-");
  let root: string | undefined;
  yield* ensure(function* () {
    if (root !== undefined) {
      yield* copyJournals(witnessed, 1, root);
    }
  });
  const { page } = yield* mounted(witnessed, { dataRoot });
  root = page.repl.root;
  yield* exchange(page, "STARTED");
  page.repl.fake.script({ manual: true });
  yield* sendMessage(page, "never answered");
  yield* page.repl.fake.startedTurns(2);
  yield* race([
    page.until("a reply its turn never sends", (one) => one.shows("NEVER SENT")),
    (function* (): Operation<never> {
      yield* sleep(CASE_DEADLINE_MS);
      throw new Error(`deliberate mounted deadline after ${CASE_DEADLINE_MS}ms`);
    })(),
  ]);
});

witness("multiple roots", function* (witnessed) {
  const stream = yield* useJournalStream("synthetic/in-memory.md");
  yield* stream.append({
    type: "close",
    coroutineId: "root",
    result: { status: "ok", value: null },
  });
  yield* scoped(function* () {
    const { page, ordinal } = yield* mounted(witnessed);
    yield* exchange(page, "NESTED");
    yield* exit(page);
    yield* copyJournals(witnessed, ordinal, page.repl.root);
  });
  expect(yield* exists(witnessed.roots[0])).toBe(false);
  const { page, ordinal } = yield* mounted(witnessed);
  yield* exchange(page, "OUTER");
  yield* exit(page);
  yield* copyJournals(witnessed, ordinal, page.repl.root);
  expect("both mounted roots returned").toBe("deliberate multiple-root assertion");
});
