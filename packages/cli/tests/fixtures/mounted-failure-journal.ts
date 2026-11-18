/**
 * Synthetic mounted cases for `mounted-failure-journal.test.ts`, run as a child
 * test file under the parent's own runtime.
 *
 * Each case drives the real mounted REPL over real file storage and copies the
 * histories that storage held to `XMD_MOUNTED_WITNESS`, outside the directory
 * its host removes, so the parent can compare a saved failure journal with what
 * the command actually wrote. Each case also records, from its own teardown
 * after every mounted scope has unwound, which data roots it mounted and
 * whether each still exists.
 */

import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { journalBeforeEach, useJournalStream } from "@executablemd/test-support/failure-journal";
import { exists, readTextFile, writeTextFile, ensureDir } from "@effectionx/fs";
import { API, env } from "@executablemd/runtime";
import { createContext, ensure, race, scoped, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { dirname, join } from "node:path";

import { useReplPage } from "../support/repl-page.ts";
import type { ReplPage } from "../support/repl-page.ts";
import { appendGate, awaited, mountedExecution, useMountedHost } from "../support/mounted-repl.ts";
import { asked, intoDraft, sendMessage, typed } from "../support/screen-journeys.ts";
import { pairedLocation, SIDEKICK_FILE } from "../../src/repl/sidekick/history.ts";
import { executionPath } from "../../src/repl/journal.ts";
import { useTemporary } from "./repl/issue-883/sidekick-harness.ts";

const OWNER = "packages/cli/tests/fixtures/mounted-failure-journal.ts";

const WIDE = { columns: 160, rows: 36 };

/** How long the deadline case waits for a reply its turn never sends. */
const CASE_DEADLINE_MS = 500;

/**
 * How long the held append stays held once its case has failed, so the host's
 * teardown is demonstrably waiting on it rather than merely not yet reached.
 */
const HELD_MS = 300;

/** A session another run left beside this one, under an identifier that is not hex. */
const SECOND_SESSION = "Second_session-1";

/** A direct legacy history beside the paired ones. */
const LEGACY_SESSION = "Legacy-Run_2";

/**
 * Non-ASCII text, and a final record a write left unfinished: no newline, and
 * ending in a multi-byte character that is still whole.
 */
const LEGACY_TEXT =
  '{"type":"close","coroutineId":"root","result":{"status":"ok","value":"é☃"}}\n' +
  '{"type":"yield","coroutineId":"root","partial":"naïve ☃';

/** One case's witness directory, and the roots it mounted, in mount order. */
interface Witness {
  readonly directory: string;
  readonly roots: string[];
}

const Witnessed = createContext<Witness>("mounted-failure-journal/witness");

/**
 * This case's witness, its own artifact directory, and the record its teardown
 * leaves once every mounted scope it opened has unwound.
 */
function witnessCase(name: string): () => Operation<void> {
  return function* () {
    const artifacts = yield* env("XMD_TEST_ARTIFACTS");
    const witnesses = yield* env("XMD_MOUNTED_WITNESS");
    if (!artifacts || !witnesses) {
      throw new Error("The mounted journal witness needs an artifact and a witness directory.");
    }
    yield* API.Env.around({
      *env([variable], next) {
        return variable === "XMD_TEST_ARTIFACTS" ? join(artifacts, name) : yield* next(variable);
      },
    });
    const witness: Witness = { directory: join(witnesses, name), roots: [] };
    yield* Witnessed.set(witness);
    // Acquired before the case body, so it runs after everything the body
    // acquired: what it records is the state that teardown actually left.
    yield* ensure(function* () {
      const roots: { root: string; exists: boolean }[] = [];
      for (const root of witness.roots) {
        roots.push({ root, exists: yield* exists(root) });
      }
      yield* writeWitness(witness, "teardown.json", JSON.stringify({ roots }) + "\n");
    });
  };
}

function* writeWitness(witness: Witness, path: string, text: string): Operation<void> {
  const target = join(witness.directory, path);
  yield* ensureDir(dirname(target));
  yield* writeTextFile(target, text);
}

/** Copy this root's paired histories of `execution`, as the command left them. */
function* copyPair(ordinal: number, root: string, execution: string): Operation<void> {
  const witness = yield* Witnessed.expect();
  const location = pairedLocation(root, execution);
  for (const [name, path] of [
    ["entries.jsonl", location.entries],
    ["sidekick.jsonl", location.sidekick],
  ]) {
    yield* writeWitness(
      witness,
      join(`root-${ordinal}`, "v1", execution, name),
      yield* readTextFile(path),
    );
  }
}

/** Mount the real command and remember the root it stores its histories in. */
function* mounted(
  options: Parameters<typeof useReplPage>[0] = {},
): Operation<{ page: ReplPage; ordinal: number }> {
  const witness = yield* Witnessed.expect();
  const page = yield* useReplPage({ size: WIDE, ...options });
  witness.roots.push(page.repl.root);
  return { page, ordinal: witness.roots.length };
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

/** Write a synthetic file beneath a mounted root. */
function* plant(root: string, path: string, text: string): Operation<void> {
  yield* ensureDir(dirname(join(root, path)));
  yield* writeTextFile(join(root, path), text);
}

describe("mounted journal passing page", () => {
  beforeEach(witnessCase("passing page"));
  beforeEach(journalBeforeEach(OWNER));

  it("passing page", function* () {
    const { page, ordinal } = yield* mounted();
    yield* exchange(page, "PASSING");
    yield* exit(page);
    yield* copyPair(ordinal, page.repl.root, yield* mountedExecution(page.repl));
  });
});

describe("mounted journal late assertion", () => {
  beforeEach(witnessCase("late assertion"));
  beforeEach(journalBeforeEach(OWNER));

  it("late assertion", function* () {
    const { page, ordinal } = yield* mounted();
    yield* exchange(page, "ASSERTED");
    yield* exit(page);
    const execution = yield* mountedExecution(page.repl);
    yield* copyPair(ordinal, page.repl.root, execution);
    // An execution's own authored inputs, named like journals, which are not history.
    yield* plant(page.repl.root, join("v1", execution, "assets", "authored.jsonl"), "{}\n");
    yield* plant(page.repl.root, join("v1", execution, "components", "authored.jsonl"), "{}\n");
    expect("the mounted command returned").toBe("deliberate mounted late assertion");
  });
});

describe("mounted journal deadline", () => {
  beforeEach(witnessCase("deadline"));
  beforeEach(journalBeforeEach(OWNER));

  it("deadline", function* () {
    // A root this case supplies, so the copy can be taken at the latest moment
    // before removal: after the host's own retention and before the directory goes.
    const dataRoot = yield* useTemporary("xmd-mounted-witness-");
    let root: string | undefined;
    yield* ensure(function* () {
      if (root !== undefined) {
        yield* copyPair(1, root, yield* mountedExecution(page.repl));
      }
    });
    const { page } = yield* mounted({ dataRoot });
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
});

describe("mounted journal held append", () => {
  beforeEach(witnessCase("held append"));
  beforeEach(journalBeforeEach(OWNER));

  it("held append", function* () {
    const witness = yield* Witnessed.expect();
    const gate = appendGate();
    let record: string | undefined;
    const held = gate.holdNext((path, appended) => {
      if (!path.endsWith(SIDEKICK_FILE) || !appended.includes('"kind":"response"')) {
        return false;
      }
      record = appended;
      return true;
    });
    const failing = withResolvers<void>();
    let root = "";
    let closed = false;
    // Owned by the case rather than the host, so the release comes from outside
    // the scope whose teardown is waiting for it.
    const controller = yield* spawn(function* () {
      yield* held.started();
      yield* failing.operation;
      yield* sleep(HELD_MS);
      const observed = { rootWhileHeld: yield* exists(root), closedWhileHeld: closed };
      held.release();
      return observed;
    });
    let failure: unknown;
    try {
      yield* scoped(function* () {
        const host = yield* useMountedHost({ gate });
        const { page } = yield* mounted({ host });
        root = page.repl.root;
        yield* exchange(page, "BEFORE");
        page.repl.fake.script({ reply: "<Output>HELD</Output>\n" });
        yield* sendMessage(page, "reply held");
        yield* held.started();
        failing.resolve();
        throw new Error("deliberate held append cancellation");
      });
    } catch (error) {
      failure = error;
    }
    closed = true;
    const observed = yield* controller;
    yield* writeWitness(
      witness,
      "held.json",
      JSON.stringify({
        ...observed,
        record,
        reached: gate.reached.filter((path) => path.endsWith(SIDEKICK_FILE)).length,
        rootAfterClose: yield* exists(root),
      }) + "\n",
    );
    throw failure;
  });
});

describe("mounted journal multiple roots", () => {
  beforeEach(witnessCase("multiple roots"));
  beforeEach(journalBeforeEach(OWNER));

  describe("nested setup", () => {
    beforeEach(journalBeforeEach(OWNER));

    it("multiple roots", function* () {
      const witness = yield* Witnessed.expect();
      const stream = yield* useJournalStream("synthetic/in-memory.md");
      yield* stream.append({
        type: "close",
        coroutineId: "root",
        result: { status: "ok", value: null },
      });
      yield* scoped(function* () {
        const { page, ordinal } = yield* mounted();
        yield* exchange(page, "NESTED");
        yield* exit(page);
        yield* copyPair(ordinal, page.repl.root, yield* mountedExecution(page.repl));
      });
      expect(yield* exists(witness.roots[0])).toBe(false);

      // A root this case supplies and removes itself, holding a second session
      // and a direct legacy history beside the command's own.
      const dataRoot = yield* useTemporary("xmd-mounted-supplied-");
      const { page, ordinal } = yield* mounted({ dataRoot });
      yield* exchange(page, "OUTER");
      yield* exit(page);
      const root = page.repl.root;
      const execution = yield* mountedExecution(page.repl);
      yield* copyPair(ordinal, root, execution);
      const second = pairedLocation(root, SECOND_SESSION);
      for (const [path, text] of [
        [second.entries, '{"synthetic":"entries ü"}\n'],
        [second.sidekick, '{"synthetic":"sidekick ü"}\n'],
        [executionPath(root, LEGACY_SESSION), LEGACY_TEXT],
      ]) {
        const inside = path.slice(root.length + 1);
        yield* plant(root, inside, text);
        yield* writeWitness(witness, join(`root-${ordinal}`, inside), text);
      }
      expect("both mounted roots returned").toBe("deliberate multiple-root assertion");
    });
  });
});
