import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok, sleep, spawn, withResolvers } from "effection";
import type { Operation } from "effection";
import { when } from "@effectionx/converge";
import { readTextFile } from "@effectionx/fs";

import {
  announce,
  inspectMain,
  JOB_TIMEOUT_MINUTES,
  judge,
  mainGreen,
  MainNotGreen,
  NoVerdict,
  POLL_INTERVAL_MILLISECONDS,
  Reads,
  REPAIR_LABEL,
  REPAIR_LABEL_DESCRIPTION,
  repairRequested,
  WAIT_TIMEOUT_MILLISECONDS,
  waitForMain,
} from "../lib/main-green.ts";
import type { MainReads, Observation, WaitOptions } from "../lib/main-green.ts";
import type { Run } from "../lib/main-health.ts";

const HEAD = "209bf218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "511776efbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** No interval and a bound no correct case reaches, so waiting costs no time. */
const FAST: WaitOptions = { interval: 0, timeout: 5000 };

function short(sha: string): string {
  return sha.slice(0, 7);
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 900,
    runNumber: 40,
    attempt: 1,
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    headBranch: "main",
    event: "push",
    workflow: "CI",
    url: "https://github.com/taras/executable.md/actions/runs/900",
    actor: "taras",
    ...overrides,
  };
}

function kindOf(input: { head?: string; runs: Run[]; became?: string }): Observation["kind"] {
  const head = input.head ?? HEAD;
  return judge({ head, runs: input.runs, became: input.became ?? head }).kind;
}

/** One pass over `main`: the head it reads, what it lists, and the head after. */
interface Poll {
  head: string;
  runs?: Run[];
  became?: string;
}

interface Script {
  reads: MainReads;
  calls: string[];
  notes: string[];
  note: (message: string) => void;
}

/**
 * A `main` that behaves as scripted, one `Poll` per iteration.
 *
 * Reading past the last poll throws, so a case that converges later than it
 * claims fails rather than quietly reading a repeated state. `endless` repeats
 * the final poll instead, which is the only way to reach the wait's own bound.
 */
function world(polls: Poll[], options: { endless?: boolean } = {}): Script {
  const calls: string[] = [];
  const notes: string[] = [];
  const queue = [...polls];
  let current: Poll | undefined;

  const reads: MainReads = {
    // deno-lint-ignore require-yield
    *head(): Operation<string> {
      if (current === undefined) {
        const next = queue.length > 1 || !options.endless ? queue.shift() : queue[0];
        if (next === undefined) {
          throw new Error("head() was read past the last scripted poll");
        }
        current = next;
        calls.push(`head:${short(next.head)}`);
        return next.head;
      }
      const became = current.became ?? current.head;
      current = undefined;
      calls.push(`head:${short(became)}`);
      return became;
    },
    // deno-lint-ignore require-yield
    *runs(head: string): Operation<Run[]> {
      calls.push(`runs:${short(head)}`);
      return current?.runs ?? [];
    },
  };

  return { reads, calls, notes, note: (message) => void notes.push(message) };
}

describe("MGW1 — a ci-main-red-fix pull request bypasses the wait entirely", () => {
  it("clears without reading main and without pausing", function* () {
    const { reads, calls, note, notes } = world([]);

    const cleared = yield* Reads.with(reads, () =>
      mainGreen(JSON.stringify([REPAIR_LABEL]), { ...FAST, note }),
    );

    expect(cleared).toEqual(Ok({ via: "repair" }));
    expect(calls).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("is not excused by any other label", function* () {
    const { reads, calls, note } = world([
      {
        head: HEAD,
        runs: [run({ conclusion: "failure" })],
      },
    ]);
    const labels = JSON.stringify(["flake", "ci-main-red", "bug", "ci-main-red-fix-please"]);

    const cleared = yield* Reads.with(reads, () => mainGreen(labels, { ...FAST, note }));

    expect(cleared.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("recognizes the label beside others, and only exactly", function* () {
    expect(repairRequested(JSON.stringify(["bug", REPAIR_LABEL, "flake"]))).toBe(true);
    for (const near of ["ci-main-red", "ci-main-red-fix ", "CI-MAIN-RED-FIX", "main-red-fix"]) {
      expect(repairRequested(JSON.stringify([near]))).toBe(false);
    }
  });

  it("refuses a payload it cannot read rather than reading it as unlabelled", function* () {
    for (const malformed of ['"ci-main-red-fix"', "null", "{}", "7"]) {
      let raised: unknown;
      try {
        repairRequested(malformed);
      } catch (error) {
        raised = error;
      }
      expect({ malformed, raised: raised instanceof Error }).toEqual({
        malformed,
        raised: true,
      });
    }
  });

  it("holds the label a maintainer applies and the one the gate reads together", function* () {
    expect(REPAIR_LABEL).toEqual("ci-main-red-fix");
    expect(REPAIR_LABEL_DESCRIPTION).toContain("Maintainer-controlled");
    expect(REPAIR_LABEL_DESCRIPTION).toContain("clean-checkout");
    // GitHub refuses a label description longer than this.
    expect(REPAIR_LABEL_DESCRIPTION.length).toBeLessThanOrEqual(100);
  });
});

describe("MGW2 — absent, queued and in-progress runs are waited through", () => {
  const pending: Record<string, Run[]> = {
    "nothing listed yet": [],
    queued: [run({ status: "queued", conclusion: undefined })],
    "in progress": [run({ status: "in_progress", conclusion: undefined })],
    "in progress carrying a stale success": [run({ status: "in_progress", conclusion: "success" })],
    "only runs for other branches, events or workflows": [
      run({ id: 1, headBranch: "release/0.8.1" }),
      run({ id: 2, event: "pull_request" }),
      run({ id: 3, workflow: "Draft release" }),
    ],
  };

  for (const [state, runs] of Object.entries(pending)) {
    it(`waits through ${state} and passes when the same head completes`, function* () {
      const finished = run({ runNumber: 41 });
      const { reads, calls, note } = world([
        { head: HEAD, runs },
        { head: HEAD, runs: [finished] },
      ]);

      const cleared = yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

      expect(cleared).toEqual(Ok(finished));
      // Two complete polls, so the first one genuinely did not decide.
      expect(calls).toEqual([
        "head:209bf21",
        "runs:209bf21",
        "head:209bf21",
        "head:209bf21",
        "runs:209bf21",
        "head:209bf21",
      ]);
    });
  }

  it("says what it is waiting on, and only when that changes", function* () {
    const queued = run({ status: "queued", conclusion: undefined });
    const started = run({ status: "in_progress", conclusion: undefined });
    const { reads, notes, note } = world([
      { head: HEAD, runs: [queued] },
      { head: HEAD, runs: [queued] },
      { head: HEAD, runs: [started] },
      { head: HEAD, runs: [started] },
      { head: HEAD, runs: [run()] },
    ]);

    yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(notes.length).toBe(2);
    expect(notes[0]).toContain("queued");
    expect(notes[1]).toContain("in_progress");
  });

  it("names the run it is waiting on by number and attempt", function* () {
    const { reads, notes, note } = world([
      {
        head: HEAD,
        runs: [run({ runNumber: 41, attempt: 3, status: "queued" })],
      },
      { head: HEAD, runs: [run()] },
    ]);

    yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(notes[0]).toContain("41.3");
  });
});

describe("MGW3 — main advances while the gate is watching it", () => {
  it("discards an unfinished candidate and decides only the new head", function* () {
    const arrived = run({ headSha: OTHER, runNumber: 41 });
    const { reads, calls, note } = world([
      {
        head: HEAD,
        runs: [run({ status: "in_progress", conclusion: undefined })],
        became: OTHER,
      },
      { head: OTHER, runs: [arrived] },
    ]);

    const cleared = yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(cleared).toEqual(Ok(arrived));
    expect(calls).toEqual([
      "head:209bf21",
      "runs:209bf21",
      "head:511776e",
      "head:511776e",
      "runs:511776e",
      "head:511776e",
    ]);
  });

  /** The direction a one-shot gate got wrong: a failure main has left is not main. */
  it("does not fail on a completed unsuccessful run for the head main left", function* () {
    const arrived = run({ headSha: OTHER, runNumber: 41 });
    const { reads, note } = world([
      { head: HEAD, runs: [run({ conclusion: "failure" })], became: OTHER },
      { head: OTHER, runs: [arrived] },
    ]);

    const cleared = yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(cleared).toEqual(Ok(arrived));
  });

  it("reports that it is following the new head", function* () {
    const { reads, notes, note } = world([
      { head: HEAD, runs: [run()], became: OTHER },
      { head: OTHER, runs: [run({ headSha: OTHER })] },
    ]);

    yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(notes).toEqual(["`main` advanced from 209bf21 to 511776e — following the new head."]);
  });

  it("judges advancement before anything it read about the old head", function* () {
    expect(kindOf({ head: HEAD, runs: [run()], became: OTHER })).toEqual("advanced");
    expect(kindOf({ head: HEAD, runs: [], became: OTHER })).toEqual("advanced");
    expect(
      kindOf({
        head: HEAD,
        runs: [run({ conclusion: "failure" })],
        became: OTHER,
      }),
    ).toEqual("advanced");
  });
});

describe("MGW4 — a completed unsuccessful run for the current head fails at once", () => {
  it("blocks on the first poll, names the run, and never waits", function* () {
    const failed = run({ conclusion: "failure" });
    const { reads, calls, notes, note } = world([
      {
        head: HEAD,
        runs: [failed],
      },
    ]);

    const cleared = yield* Reads.with(reads, () => waitForMain({ ...FAST, note }));

    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.error instanceof MainNotGreen).toBe(true);
    expect(
      cleared.ok === false && cleared.error instanceof MainNotGreen && cleared.error.run,
    ).toEqual(failed);
    expect(cleared.ok === false && cleared.error.message).toContain(REPAIR_LABEL);
    expect(calls).toEqual(["head:209bf21", "runs:209bf21", "head:209bf21"]);
    expect(notes).toEqual([]);
  });

  it("blocks on every conclusion that is not a success", function* () {
    for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure", "neutral"]) {
      expect(kindOf({ runs: [run({ conclusion })] })).toEqual("unsuccessful");
    }
    expect(kindOf({ runs: [run({ conclusion: undefined })] })).toEqual("unsuccessful");
  });

  /** The selector's rules, exercised through the judgment that depends on them. */
  it("selects the greatest run number, then the greatest attempt", function* () {
    const older = run({ id: 1, runNumber: 40, conclusion: "success" });
    const newest = run({ id: 2, runNumber: 41, conclusion: "failure" });
    expect(kindOf({ runs: [older, newest] })).toEqual("unsuccessful");
    expect(kindOf({ runs: [newest, older] })).toEqual("unsuccessful");

    const first = run({
      id: 5,
      runNumber: 41,
      attempt: 1,
      conclusion: "success",
    });
    const rerun = run({
      id: 5,
      runNumber: 41,
      attempt: 2,
      conclusion: "failure",
    });
    expect(kindOf({ runs: [first, rerun] })).toEqual("unsuccessful");
  });

  /** However new and however successful, a run for another head decides nothing. */
  it("never lets a run for another head satisfy this head", function* () {
    const stale = run({ id: 99, runNumber: 999, attempt: 9, headSha: OTHER });

    expect(kindOf({ head: HEAD, runs: [stale] })).toEqual("absent");
  });
});

describe("MGW5 — success is accepted only against a final head read", () => {
  it("reads head, then runs, then head again, and returns that run", function* () {
    const authoritative = run();
    const { reads, calls, note } = world([
      {
        head: HEAD,
        runs: [authoritative],
      },
    ]);

    const seen = yield* Reads.with(reads, () => inspectMain());
    expect(seen).toEqual({ kind: "successful", run: authoritative });
    expect(calls).toEqual(["head:209bf21", "runs:209bf21", "head:209bf21"]);

    const second = world([{ head: HEAD, runs: [authoritative] }]);
    const cleared = yield* Reads.with(second.reads, () => mainGreen("[]", { ...FAST, note }));
    expect(cleared).toEqual(Ok({ via: "main", run: authoritative }));
  });

  it("says which path it took, so a passing gate is never ambiguous", function* () {
    expect(announce({ via: "repair" })).toContain(REPAIR_LABEL);
    expect(announce({ via: "main", run: run() })).toContain("209bf21");
  });
});

describe("MGW6 — an infrastructure failure is not a wait and not a verdict", () => {
  const refusal = new Error("gh: could not read the run list");

  it("stops on a failing head read without polling again", function* () {
    const calls: string[] = [];
    const reads: MainReads = {
      // deno-lint-ignore require-yield
      *head(): Operation<string> {
        calls.push("head");
        throw refusal;
      },
      // deno-lint-ignore require-yield
      *runs(): Operation<Run[]> {
        calls.push("runs");
        return [];
      },
    };

    const cleared = yield* Reads.with(reads, () => waitForMain(FAST));

    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.error).toBe(refusal);
    expect(cleared.ok === false && cleared.error instanceof MainNotGreen).toBe(false);
    expect(cleared.ok === false && cleared.error instanceof NoVerdict).toBe(false);
    expect(calls).toEqual(["head"]);
  });

  it("stops on a failing run read without polling again", function* () {
    const calls: string[] = [];
    const reads: MainReads = {
      // deno-lint-ignore require-yield
      *head(): Operation<string> {
        calls.push("head");
        return HEAD;
      },
      // deno-lint-ignore require-yield
      *runs(): Operation<Run[]> {
        calls.push("runs");
        throw refusal;
      },
    };

    const cleared = yield* Reads.with(reads, () => waitForMain(FAST));

    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.error).toBe(refusal);
    expect(calls).toEqual(["head", "runs"]);
  });
});

describe("MGW7 — the wait is bounded and cancellable", () => {
  it("gives up inside its own bound and says so without blaming main", function* () {
    const { reads, note } = world([{ head: HEAD, runs: [] }], {
      endless: true,
    });

    const cleared = yield* Reads.with(reads, () => waitForMain({ interval: 1, timeout: 30, note }));

    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.error instanceof NoVerdict).toBe(true);
    expect(cleared.ok === false && cleared.error instanceof MainNotGreen).toBe(false);
    expect(cleared.ok === false && cleared.error.message).toContain("waiting for CI to start");
  });

  it("begins no further poll once its task is halted", function* () {
    const parked = withResolvers<void>();
    const { reads, calls } = world([{ head: HEAD, runs: [] }], {
      endless: true,
    });

    const waiter = yield* spawn(() =>
      Reads.with(reads, () =>
        waitForMain({
          interval: 10_000,
          timeout: 600_000,
          note: () => parked.resolve(),
        }),
      ),
    );

    yield* parked.operation;
    yield* waiter.halt();
    const atHalt = [...calls];

    // Longer than anything still in flight would take to land.
    yield* sleep(100);

    expect(calls).toEqual(atHalt);
    // Non-vacuous: it had polled once, and had not been allowed a second.
    expect(atHalt).toEqual(["head:209bf21", "runs:209bf21", "head:209bf21"]);
  });

  /** Waiting is the change here, so a case that never waits proves nothing. */
  it("actually sleeps its interval between polls", function* () {
    const { reads, note } = world([
      { head: HEAD, runs: [] },
      { head: HEAD, runs: [run()] },
    ]);

    const started = yield* now();
    yield* Reads.with(reads, () => waitForMain({ interval: 60, timeout: 5000, note }));

    expect((yield* now()) - started).toBeGreaterThanOrEqual(50);
  });
});

// deno-lint-ignore require-yield
function* now(): Operation<number> {
  return Date.now();
}

describe("MGW8 — the poll interval and the job's bound are held together", () => {
  const ci = new URL("../../.github/workflows/ci.yml", import.meta.url);

  function* job(): Operation<string | undefined> {
    return /\n  main-green:\n((?:.+\n|\n)*?)(?=\n  \w)/.exec(yield* readTextFile(ci))?.[1];
  }

  it("polls every fifteen seconds", function* () {
    expect(POLL_INTERVAL_MILLISECONDS).toBe(15_000);
  });

  it("bounds the job at sixty minutes", function* () {
    expect(yield* job()).toContain(`timeout-minutes: ${JOB_TIMEOUT_MINUTES}`);
    expect(JOB_TIMEOUT_MINUTES).toBe(60);
  });

  /**
   * The waiter has to give up first. Reaching the job's own bound kills the
   * step mid-poll, and the log then says nothing about what was awaited.
   */
  it("gives the waiter a bound strictly inside the job's", function* () {
    expect(WAIT_TIMEOUT_MILLISECONDS).toBeLessThan(JOB_TIMEOUT_MINUTES * 60 * 1000);
    expect(WAIT_TIMEOUT_MILLISECONDS).toBeGreaterThan(POLL_INTERVAL_MILLISECONDS);
  });
});

describe("MGW9 — the main-green workflow job", () => {
  const ci = new URL("../../.github/workflows/ci.yml", import.meta.url);

  function* source(): Operation<string> {
    return yield* readTextFile(ci);
  }

  /**
   * The job decides a required check, so a write permission on it would make a
   * pull request's own gate able to change the repository.
   */
  it("holds only the two read permissions its lookup needs", function* () {
    const job = /\n  main-green:\n((?:.+\n|\n)*?)(?=\n  \w)/.exec(yield* source())?.[1];

    expect(job).toBeDefined();
    expect(job).toContain("actions: read");
    expect(job).toContain("contents: read");
    expect(job).not.toContain("write");
  });

  it("runs on a pull request and is skipped on a push", function* () {
    const job = /\n  main-green:\n((?:.+\n|\n)*?)(?=\n  \w)/.exec(yield* source())?.[1];

    expect(job).toContain("if: github.event_name == 'pull_request'");
  });

  it("passes the pull request's own labels to the decision", function* () {
    expect(yield* source()).toContain(
      "PULL_REQUEST_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}",
    );
  });

  /**
   * The lockfile is frozen repository-wide (AGENTS.md), and `--no-lock` opts out
   * of it silently. `--allow-run=gh` is the whole subprocess authority the gate
   * needs.
   */
  it("runs the decision under the frozen lock and the narrowest permissions", function* () {
    expect(yield* source()).toContain(
      "deno run --frozen --allow-env --allow-run=gh scripts/main-green.ts",
    );
  });

  /**
   * A label decides a required result, so applying or removing one has to
   * recompute it. Listing types replaces the default set, so all five are named.
   */
  it("recomputes the workflow when a label changes", function* () {
    const types = /pull_request:\n(?:.*\n)*?\s+types: \[([^\]]+)\]/.exec(yield* source())?.[1];

    expect(types).toBeDefined();
    for (const type of ["opened", "reopened", "synchronize", "labeled", "unlabeled"]) {
      expect(types).toContain(type);
    }
  });

  /**
   * The repair label is the only thing that excuses the lookup. An actor, a
   * branch name, a commit message or another label must not.
   */
  it("grants the exception by that label and nothing else", function* () {
    const text = yield* source();
    const conditions = text.split("\n").filter((line) => line.includes("contains("));

    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition).toContain("github.event.pull_request.labels.*.name");
      expect(condition).toContain("'ci-main-red-fix'");
    }
    expect(text).not.toContain("github.actor ==");
    expect(text).not.toContain("github.head_ref ==");
  });
});
