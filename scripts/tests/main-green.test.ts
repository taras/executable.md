import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { Ok } from "effection";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";

import {
  announce,
  inspectMain,
  judge,
  mainGreen,
  MainNotGreen,
  Reads,
  REPAIR_LABEL,
  REPAIR_LABEL_DESCRIPTION,
  repairRequested,
} from "../lib/main-green.ts";
import type { MainReads, Obstacle } from "../lib/main-green.ts";
import type { Run } from "../lib/main-health.ts";

const HEAD = "209bf218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "511776efbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function verdict(input: { head?: string; runs: Run[]; became?: string }) {
  const head = input.head ?? HEAD;
  return judge({ head, runs: input.runs, became: input.became ?? head });
}

/** The obstacle a block reports, or the reason it did not block. */
function obstacleOf(input: { head?: string; runs: Run[]; became?: string }): Obstacle | "passed" {
  const decided = verdict(input);
  if (decided.ok) {
    return "passed";
  }
  if (!(decided.error instanceof MainNotGreen)) {
    throw new Error(`expected MainNotGreen, saw ${decided.error.name}`);
  }
  return decided.error.obstacle;
}

function kindOf(input: {
  head?: string;
  runs: Run[];
  became?: string;
}): Obstacle["kind"] | "passed" {
  const obstacle = obstacleOf(input);
  return obstacle === "passed" ? "passed" : obstacle.kind;
}

interface World {
  heads?: string[];
  runs?: Run[];
}

/** A reads that records its calls, so their order is observable. */
function world(input: World): { reads: MainReads; calls: string[] } {
  const calls: string[] = [];
  const heads = [...(input.heads ?? [HEAD, HEAD])];

  const reads: MainReads = {
    // deno-lint-ignore require-yield
    *head(): Operation<string> {
      const next = heads.shift();
      if (next === undefined) {
        throw new Error("head() was read more times than the world provides");
      }
      calls.push(`head:${next.slice(0, 7)}`);
      return next;
    },
    // deno-lint-ignore require-yield
    *runs(head: string): Operation<Run[]> {
      calls.push(`runs:${head.slice(0, 7)}`);
      return input.runs ?? [];
    },
  };

  return { reads, calls };
}

describe("MG1 — main's exact head has a completed successful run", () => {
  it("passes, and reports the run it passed on", function* () {
    const authoritative = run();

    expect(verdict({ runs: [authoritative] })).toEqual(Ok(authoritative));
  });

  it("passes through the gate an ordinary pull request runs", function* () {
    const { reads, calls } = world({ runs: [run()] });

    const cleared = yield* Reads.with(reads, () => mainGreen("[]"));

    expect(cleared.ok).toBe(true);
    expect(cleared.ok && cleared.value.via).toEqual("main");
    expect(calls).toEqual(["head:209bf21", "runs:209bf21", "head:209bf21"]);
  });
});

describe("MG2 — the authoritative run failed", () => {
  it("blocks, and names the run rather than the race", function* () {
    expect(kindOf({ runs: [run({ conclusion: "failure" })] })).toEqual("unsuccessful");
  });

  it("tells the author how to proceed", function* () {
    const decided = verdict({ runs: [run({ conclusion: "failure" })] });

    expect(decided.ok).toBe(false);
    expect(decided.ok === false && decided.error.message).toContain(REPAIR_LABEL);
  });
});

describe("MG3 — the authoritative run has not finished", () => {
  it("blocks for a queued run and for one in progress", function* () {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      expect(kindOf({ runs: [run({ status, conclusion: undefined })] })).toEqual("unfinished");
    }
  });

  /** A conclusion GitHub has not retracted must not outrank an unfinished status. */
  it("blocks an in-progress re-run that still carries a stale success", function* () {
    expect(kindOf({ runs: [run({ status: "in_progress", conclusion: "success" })] })).toEqual(
      "unfinished",
    );
  });
});

describe("MG4 — the authoritative run was cancelled, timed out or failed at startup", () => {
  it("blocks each of them", function* () {
    for (const conclusion of ["cancelled", "timed_out", "startup_failure"]) {
      expect(kindOf({ runs: [run({ conclusion })] })).toEqual("unsuccessful");
    }
  });

  /**
   * Main Health stays silent for `cancelled` — it is not a statement that
   * `main` is broken. The gate is the opposite claim: silence about `main` is
   * not proof of `main`, so anything short of a success blocks.
   */
  it("blocks a conclusion Main Health deliberately does not report", function* () {
    expect(kindOf({ runs: [run({ conclusion: "cancelled" })] })).toEqual("unsuccessful");
    expect(kindOf({ runs: [run({ conclusion: "neutral" })] })).toEqual("unsuccessful");
    expect(kindOf({ runs: [run({ conclusion: undefined })] })).toEqual("unsuccessful");
  });
});

describe("MG5 — no qualifying run exists for the exact head", () => {
  it("blocks when nothing was listed at all", function* () {
    expect(kindOf({ runs: [] })).toEqual("absent");
  });

  /** The selector's rules, exercised through the gate that depends on them. */
  it("blocks when every candidate is disqualified by branch, event or workflow", function* () {
    const disqualified = [
      run({ id: 1, headBranch: "release/0.8.1" }),
      run({ id: 2, event: "pull_request" }),
      run({ id: 3, event: "workflow_dispatch" }),
      run({ id: 4, workflow: "Draft release" }),
    ];

    for (const candidate of disqualified) {
      expect(kindOf({ runs: [candidate] })).toEqual("absent");
    }
    expect(kindOf({ runs: disqualified })).toEqual("absent");
  });
});

describe("MG6 — an older main commit is green and the current one is not", () => {
  it("blocks, however new and however successful the older run is", function* () {
    const stale = run({ id: 99, runNumber: 999, attempt: 9, headSha: OTHER });

    expect(kindOf({ head: HEAD, runs: [stale] })).toEqual("absent");
  });

  it("never lets a run for another head satisfy this head", function* () {
    const decided = verdict({ head: HEAD, runs: [run({ headSha: OTHER })] });

    expect(decided.ok).toBe(false);
    expect(decided.ok === false && decided.error.message).toContain("209bf21");
  });
});

describe("MG7 — several runs or attempts exist", () => {
  it("takes the greatest run number", function* () {
    const newest = run({ id: 2, runNumber: 41, conclusion: "failure" });
    const older = run({ id: 1, runNumber: 40, conclusion: "success" });

    expect(kindOf({ runs: [older, newest] })).toEqual("unsuccessful");
    expect(obstacleOf({ runs: [older, newest] })).toEqual({ kind: "unsuccessful", run: newest });
  });

  it("takes the greatest attempt within that run number", function* () {
    const first = run({ id: 5, runNumber: 41, attempt: 1, conclusion: "failure" });
    const rerun = run({ id: 5, runNumber: 41, attempt: 2, conclusion: "success" });

    expect(verdict({ runs: [first, rerun] })).toEqual(Ok(rerun));
  });

  /** A re-run that failed must supersede the original success, not the reverse. */
  it("lets a failed re-run block a run number that once succeeded", function* () {
    const first = run({ id: 5, runNumber: 41, attempt: 1, conclusion: "success" });
    const rerun = run({ id: 5, runNumber: 41, attempt: 2, conclusion: "failure" });

    expect(kindOf({ runs: [first, rerun] })).toEqual("unsuccessful");
  });

  it("is not decided by listing order", function* () {
    const newest = run({ id: 3, runNumber: 42 });
    const middle = run({ id: 2, runNumber: 41, conclusion: "failure" });
    const oldest = run({ id: 1, runNumber: 40, conclusion: "failure" });

    expect(verdict({ runs: [newest, middle, oldest] })).toEqual(Ok(newest));
    expect(verdict({ runs: [oldest, middle, newest] })).toEqual(Ok(newest));
  });
});

describe("MG8 — main advances while the gate inspects it", () => {
  it("blocks, because the run it read is no longer about the base", function* () {
    expect(kindOf({ head: HEAD, runs: [run()], became: OTHER })).toEqual("advanced");
  });

  it("reads the head again after the run, not before it", function* () {
    const { reads, calls } = world({ heads: [HEAD, OTHER], runs: [run()] });

    const cleared = yield* Reads.with(reads, () => inspectMain());

    expect(calls).toEqual(["head:209bf21", "runs:209bf21", "head:511776e"]);
    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.error instanceof MainNotGreen).toBe(true);
    expect(cleared.ok === false && cleared.error.message).toContain("advanced");
  });

  it("still passes when the head is unchanged across both reads", function* () {
    const { reads } = world({ heads: [HEAD, HEAD], runs: [run()] });

    expect((yield* Reads.with(reads, () => inspectMain())).ok).toBe(true);
  });
});

describe("MG9 — an ordinary pull request is gated on main's health", () => {
  it("consults main when no label asks otherwise", function* () {
    const { reads, calls } = world({ runs: [run({ conclusion: "failure" })] });

    const cleared = yield* Reads.with(reads, () => mainGreen("[]"));

    expect(cleared.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("is not excused by any other label", function* () {
    const { reads, calls } = world({ runs: [run({ conclusion: "failure" })] });
    const labels = JSON.stringify(["flake", "ci-main-red", "bug", "ci-main-red-fix-please"]);

    const cleared = yield* Reads.with(reads, () => mainGreen(labels));

    expect(cleared.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("MG10 — a ci-main-red-fix pull request bypasses only the lookup", () => {
  it("passes without reading main at all", function* () {
    const { reads, calls } = world({ runs: [run({ conclusion: "failure" })] });

    const cleared = yield* Reads.with(reads, () => mainGreen(JSON.stringify([REPAIR_LABEL])));

    expect(cleared).toEqual(Ok({ via: "repair" }));
    expect(calls).toEqual([]);
  });

  it("says which path it took, so a passing gate is never ambiguous", function* () {
    expect(announce({ via: "repair" })).toContain(REPAIR_LABEL);
    expect(announce({ via: "main", run: run() })).toContain("209bf21");
  });

  it("recognizes the label beside others", function* () {
    expect(repairRequested(JSON.stringify(["bug", REPAIR_LABEL, "flake"]))).toBe(true);
  });

  /**
   * The label is authority, so a near-miss must not carry it. The workflow's
   * `contains()` compares strings case-insensitively where this compares them
   * exactly; only a maintainer can create a label at all, and the difference
   * blocks rather than grants, so the exact rule is the one worth holding.
   */
  it("matches the label exactly", function* () {
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
      expect({ malformed, raised: raised instanceof Error }).toEqual({ malformed, raised: true });
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

describe("the main-green workflow job", () => {
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
