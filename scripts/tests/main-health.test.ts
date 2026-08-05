import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";
import { readTextFile } from "@effectionx/fs";

import { exec, Stdio } from "@effectionx/process";

import { Gh, githubReads, quietPayloads } from "../lib/github.ts";
import type { GhCommand } from "../lib/github.ts";
import {
  CI_WORKFLOW,
  decide,
  Issues,
  mainHealth,
  parseMarker,
  Reads,
  renderBody,
  renderComment,
  renderMarker,
  selectAuthoritative,
  selectMarker,
  TRUSTED_AUTHOR,
} from "../lib/main-health.ts";
import type {
  Authored,
  GitHubReads,
  IssueOperations,
  ReportHandle,
  Run,
} from "../lib/main-health.ts";

const HEAD = "209bf218aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "511776efbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 900,
    runNumber: 40,
    attempt: 1,
    status: "completed",
    conclusion: "failure",
    headSha: HEAD,
    headBranch: "main",
    event: "push",
    workflow: "CI",
    url: "https://github.com/taras/executable.md/actions/runs/900",
    actor: "taras",
    ...overrides,
  };
}

function report(
  overrides: Partial<{
    number: number;
    assignees: string[];
    candidates: Authored[];
  }> = {},
) {
  return {
    number: 7,
    assignees: ["taras"],
    candidates: [],
    ...overrides,
  };
}

function marked(source: Run, author = TRUSTED_AUTHOR): Authored {
  return { author, text: `some prose\n\n${renderMarker(source)}` };
}

interface Recorded {
  calls: string[];
  warnings: string[];
}

function recorder(
  failures: Record<string, number> = {},
  opened = 7,
): { ops: IssueOperations; log: Recorded } {
  const log: Recorded = { calls: [], warnings: [] };
  const attempts: Record<string, number> = {};

  function fails(key: string): boolean {
    attempts[key] = (attempts[key] ?? 0) + 1;
    return attempts[key] <= (failures[key] ?? 0);
  }

  const ops: IssueOperations = {
    // deno-lint-ignore require-yield
    *ensureLabel(): Operation<void> {
      log.calls.push("ensureLabel");
    },
    // deno-lint-ignore require-yield
    *open(): Operation<number> {
      log.calls.push("open");
      return opened;
    },
    // deno-lint-ignore require-yield
    *comment(): Operation<void> {
      log.calls.push("comment");
    },
    // deno-lint-ignore require-yield
    *close(): Operation<void> {
      log.calls.push("close");
    },
    // deno-lint-ignore require-yield
    *assign(_issue, assignee): Operation<void> {
      log.calls.push(`assign:${assignee}`);
      if (fails(`assign:${assignee}`)) {
        throw new Error(`cannot assign ${assignee}`);
      }
    },
    warn(message: string): void {
      log.warnings.push(message);
    },
  };

  return { ops, log };
}

interface World {
  head?: string;
  runs?: Run[];
  handle?: ReportHandle;
  comments?: Authored[];
  broken?: "head" | "runs" | "findReport" | "comments";
}

function world(input: World): GitHubReads {
  function refuse(name: World["broken"]): void {
    if (input.broken === name) {
      throw new Error(`${name} read failed`);
    }
  }

  return {
    // deno-lint-ignore require-yield
    *head(): Operation<string> {
      refuse("head");
      return input.head ?? HEAD;
    },
    // deno-lint-ignore require-yield
    *runs(): Operation<Run[]> {
      refuse("runs");
      return input.runs ?? [];
    },
    // deno-lint-ignore require-yield
    *findReport(): Operation<ReportHandle | undefined> {
      refuse("findReport");
      return input.handle;
    },
    // deno-lint-ignore require-yield
    *comments(): Operation<Authored[]> {
      refuse("comments");
      return input.comments ?? [];
    },
  };
}

function drive(input: World, ops: IssueOperations): Operation<unknown> {
  return Reads.with(world(input), () => Issues.with(ops, mainHealth));
}

function handleOf(body: Authored, assignees: string[] = ["taras"]): ReportHandle {
  return { number: 7, assignees, body };
}

describe("selectAuthoritative", () => {
  it("takes the highest run number for the current head", function* () {
    const older = run({ id: 1, runNumber: 39 });
    const newest = run({ id: 2, runNumber: 41 });

    expect(selectAuthoritative(HEAD, [older, newest, run({ id: 3, runNumber: 40 })])).toEqual(
      newest,
    );
  });

  it("takes the highest attempt within that run number", function* () {
    const first = run({ id: 4, runNumber: 41, attempt: 1 });
    const rerun = run({ id: 4, runNumber: 41, attempt: 3 });

    expect(selectAuthoritative(HEAD, [first, rerun])?.attempt).toEqual(3);
  });

  it("ignores runs for another head, another branch, and another workflow", function* () {
    const wrong = [
      run({ id: 5, runNumber: 99, headSha: OTHER }),
      run({ id: 6, runNumber: 99, headBranch: "feat/x" }),
      run({ id: 7, runNumber: 99, workflow: "Deploy" }),
    ];

    expect(selectAuthoritative(HEAD, [...wrong, run({ id: 8, runNumber: 1 })])?.id).toEqual(8);
  });

  /** A pull request run is about a merge ref, not about `main`. */
  it("ignores pull request runs for the same sha", function* () {
    const pull = run({ id: 9, runNumber: 99, event: "pull_request" });

    expect(selectAuthoritative(HEAD, [pull])).toEqual(undefined);
  });

  it("finds nothing when no run matches", function* () {
    expect(selectAuthoritative(HEAD, [])).toEqual(undefined);
  });
});

describe("markers", () => {
  it("round-trips a run", function* () {
    expect(parseMarker(renderMarker(run({ id: 12, runNumber: 44, attempt: 2 })))).toEqual({
      runId: 12,
      runNumber: 44,
      attempt: 2,
    });
  });

  it("takes the newest by value, not by position", function* () {
    const candidates = [
      marked(run({ id: 20, runNumber: 50, attempt: 1 })),
      marked(run({ id: 21, runNumber: 52, attempt: 1 })),
      marked(run({ id: 22, runNumber: 51, attempt: 9 })),
    ];

    expect(selectMarker(candidates)?.runId).toEqual(21);
  });

  /**
   * Issue comments are public. A marker is authority only because the workflow
   * wrote it, so one pasted by anyone else must not be readable as the
   * mechanism's own state.
   */
  it("ignores a forged marker whatever it names", function* () {
    const forged = marked(run({ id: 99, runNumber: 999, attempt: 9 }), "impostor");

    expect(selectMarker([forged])).toEqual(undefined);
  });

  it("lets a genuine older marker outrank a forged newer one", function* () {
    const genuine = marked(run({ id: 30, runNumber: 60, attempt: 1 }));
    const forged = marked(run({ id: 31, runNumber: 61, attempt: 1 }), "impostor");

    expect(selectMarker([genuine, forged])?.runId).toEqual(30);
  });

  it("reads nothing out of malformed or absent text", function* () {
    expect(parseMarker("<!-- main-health run=x -->")).toEqual(undefined);
    expect(selectMarker([{ author: TRUSTED_AUTHOR, text: "no marker here" }])).toEqual(undefined);
  });
});

describe("decide", () => {
  it("opens and assigns the pusher when main is red with no report", function* () {
    expect(decide({ authoritative: run({ actor: "pusher" }), report: undefined })).toEqual({
      report: "open",
      assignment: "pusher",
    });
  });

  it("comments rather than opening a second report", function* () {
    const authoritative = run({ id: 900, attempt: 1 });
    const stale = report({ candidates: [marked(run({ id: 800, runNumber: 39 }))] });

    expect(decide({ authoritative, report: stale }).report).toEqual("comment");
  });

  it("writes nothing for a run its own marker already reported", function* () {
    const authoritative = run({ id: 900, attempt: 1 });
    const current = report({ candidates: [marked(authoritative)] });

    expect(decide({ authoritative, report: current }).report).toEqual("none");
  });

  it("comments again for a newer attempt of the same run", function* () {
    const first = run({ id: 900, attempt: 1 });
    const rerun = run({ id: 900, attempt: 2 });
    const current = report({ candidates: [marked(first)] });

    expect(decide({ authoritative: rerun, report: current }).report).toEqual("comment");
  });

  /** Silence is the unsafe direction, so an unreadable marker reports. */
  it("comments when the marker is forged, malformed, or absent", function* () {
    const authoritative = run();
    const cases = [
      report({ candidates: [marked(authoritative, "impostor")] }),
      report({ candidates: [{ author: TRUSTED_AUTHOR, text: "<!-- main-health run=? -->" }] }),
      report({ candidates: [] }),
    ];

    for (const open of cases) {
      expect(decide({ authoritative, report: open }).report).toEqual("comment");
    }
  });

  it("still ensures the assignee on a reconciliation that writes nothing", function* () {
    const authoritative = run({ id: 900, attempt: 1, actor: "pusher" });
    const current = report({ assignees: [], candidates: [marked(authoritative)] });

    expect(decide({ authoritative, report: current })).toEqual({
      report: "none",
      assignment: "pusher",
    });
  });

  it("asks for no assignment when the pusher already has it", function* () {
    const authoritative = run({ actor: "pusher" });
    const current = report({ assignees: ["pusher"], candidates: [] });

    expect(decide({ authoritative, report: current }).assignment).toEqual(undefined);
  });

  it("follows a newer failure to a different pusher", function* () {
    const authoritative = run({ id: 901, runNumber: 41, actor: "someone-else" });
    const current = report({ assignees: ["taras"], candidates: [marked(run())] });

    expect(decide({ authoritative, report: current }).assignment).toEqual("someone-else");
  });

  it("closes the report when main recovers, and does nothing when none is open", function* () {
    const green = run({ conclusion: "success" });

    expect(decide({ authoritative: green, report: report() }).report).toEqual("comment-then-close");
    expect(decide({ authoritative: green, report: undefined }).report).toEqual("none");
  });

  it("stays silent for a cancelled run, an in-flight run, and no run at all", function* () {
    const open = report();

    expect(
      decide({ authoritative: run({ conclusion: "cancelled" }), report: open }).report,
    ).toEqual("none");
    expect(
      decide({
        authoritative: run({ status: "in_progress", conclusion: undefined }),
        report: open,
      }).report,
    ).toEqual("none");
    expect(decide({ authoritative: undefined, report: open }).report).toEqual("none");
  });
});

describe("reconciliation", () => {
  it("opens before it assigns", function* () {
    const { ops, log } = recorder();

    yield* drive({ runs: [run({ actor: "pusher" })] }, ops);

    expect(log.calls).toEqual(["ensureLabel", "open", "assign:pusher"]);
  });

  it("skips the fallback when the pusher is assignable", function* () {
    const { ops, log } = recorder();

    yield* drive({ runs: [run({ actor: "pusher" })] }, ops);

    expect(log.calls.filter((call) => call.startsWith("assign:"))).toEqual(["assign:pusher"]);
  });

  it("falls back to a person when the pusher cannot be assigned", function* () {
    const { ops, log } = recorder({ "assign:robot[bot]": 99 });

    yield* drive({ runs: [run({ actor: "robot[bot]" })] }, ops);

    expect(log.calls).toEqual(["ensureLabel", "open", "assign:robot[bot]", "assign:taras"]);
    expect(log.warnings.length).toEqual(1);
  });

  it("keeps the opened report when both assignments fail", function* () {
    const { ops, log } = recorder({ "assign:robot[bot]": 99, "assign:taras": 99 });

    const decision = yield* drive({ runs: [run({ actor: "robot[bot]" })] }, ops);

    expect(log.calls).toEqual(["ensureLabel", "open", "assign:robot[bot]", "assign:taras"]);
    expect(log.warnings.length).toEqual(2);
    expect(decision).toEqual({ report: "open", assignment: "robot[bot]" });
  });

  /**
   * The marker is written by `open`, so a failed assignment must not be the
   * thing that stops the next reconciliation from retrying it.
   */
  it("retries a temporary assignment failure on the next reconciliation", function* () {
    const failing = recorder({ "assign:pusher": 1 });
    const red = run({ actor: "pusher" });

    yield* drive({ runs: [red] }, failing.ops);
    expect(failing.log.calls).toEqual(["ensureLabel", "open", "assign:pusher", "assign:taras"]);

    const retry = recorder();
    yield* drive(
      {
        runs: [red],
        handle: handleOf(marked(red), ["taras"]),
      },
      retry.ops,
    );

    expect(retry.log.calls).toEqual(["assign:pusher"]);
  });

  it("writes no second comment for a repeated wake-up at the same attempt", function* () {
    const red = run({ actor: "pusher" });
    const { ops, log } = recorder();

    yield* drive({ runs: [red], handle: handleOf(marked(red), ["pusher"]) }, ops);

    expect(log.calls).toEqual([]);
  });

  it("comments before it closes", function* () {
    const green = run({ conclusion: "success" });
    const { ops, log } = recorder();

    yield* drive({ runs: [green], handle: handleOf(marked(run())) }, ops);

    expect(log.calls).toEqual(["comment", "close"]);
  });

  it("reads a marker out of a comment, not only the body", function* () {
    const red = run({ actor: "pusher" });
    const { ops, log } = recorder();

    yield* drive(
      {
        runs: [red],
        handle: handleOf({ author: TRUSTED_AUTHOR, text: "opened for an older run" }, ["pusher"]),
        comments: [marked(red)],
      },
      ops,
    );

    expect(log.calls).toEqual([]);
  });
});

describe("failed reads", () => {
  it("fail the run before any mutation, whichever read fails", function* () {
    const reads: World["broken"][] = ["head", "runs", "findReport", "comments"];

    for (const broken of reads) {
      const { ops, log } = recorder();
      let raised: unknown;

      try {
        yield* drive(
          {
            broken,
            runs: [run()],
            handle: handleOf(marked(run())),
          },
          ops,
        );
      } catch (error) {
        raised = error;
      }

      expect({ broken, raised: raised instanceof Error, calls: log.calls }).toEqual({
        broken,
        raised: true,
        calls: [],
      });
    }
  });
});

describe("the Main Health workflow", () => {
  const workflow = new URL("../../.github/workflows/main-health.yml", import.meta.url);
  const ci = new URL("../../.github/workflows/ci.yml", import.meta.url);

  /**
   * Three places name the same workflow, and a `workflow_run` trigger that
   * matches nothing is silence rather than an error: renaming CI would stop
   * Main Health waking, or leave it waking and selecting no run at all.
   */
  it("agrees with CI's name, in the trigger and in the selector", function* () {
    const name = /^name: (.+)$/m.exec(yield* readTextFile(ci))?.[1];

    expect(name).toBeDefined();
    expect(yield* readTextFile(workflow)).toContain(`workflows: [${name}]`);
    expect(CI_WORKFLOW).toEqual(name);
  });

  it("declares every permission its reads and writes need", function* () {
    const source = yield* readTextFile(workflow);

    for (const permission of ["actions: read", "contents: read", "issues: write"]) {
      expect(source).toContain(permission);
    }
  });

  /**
   * Filtering deliveries by conclusion looks like an optimization and is a
   * hole: a filtered delivery still replaces the group's one pending wake-up
   * and then reconciles nothing.
   */
  it("never consults the delivery's own verdict", function* () {
    expect(yield* readTextFile(workflow)).not.toContain("workflow_run.conclusion");
  });

  /** Dropping a pending wake-up is safe; interrupting a mutation is not. */
  it("keeps one repository-wide lane that is not interruptible", function* () {
    const source = yield* readTextFile(workflow);

    expect(source).toContain("group: main-health\n");
    expect(source).not.toContain("cancel-in-progress: true");
  });

  /** The job holds `issues: write`, so it must only ever run trusted code. */
  it("checks out main rather than whatever woke it", function* () {
    expect(yield* readTextFile(workflow)).toContain("ref: main");
  });

  /**
   * The lockfile is frozen repository-wide (AGENTS.md), and `--no-lock` opts
   * out of it silently — a workflow that resolves outside the lock could run
   * a dependency version nothing here pins.
   */
  it("runs under the frozen lock rather than opting out of it", function* () {
    const source = yield* readTextFile(workflow);

    expect(source).not.toContain("--no-lock");
    expect(source).toContain("deno run --frozen");
  });
});

describe("rendered reports", () => {
  it("carry the marker that makes the next reconciliation idempotent", function* () {
    const red = run();

    expect(parseMarker(renderBody(red))?.runId).toEqual(red.id);
    expect(parseMarker(renderComment(red))?.runId).toEqual(red.id);
  });

  /**
   * A hand-closed report is the one way a reader breaks this: the next failure
   * opens a second issue rather than commenting. The warning has to lead, so
   * it is asserted on the opening lines rather than on the body as a whole.
   */
  it("open with the warning against closing by hand", function* () {
    const opening = renderBody(run()).split("\n").slice(0, 3).join(" ");

    expect(opening).toContain("Do not close this issue by hand");
    expect(opening).toContain("closes itself");
  });
});

function commentPage(count: number, marker?: Run): unknown[] {
  const page: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    page.push({ user: { login: TRUSTED_AUTHOR }, body: `chatter ${index}` });
  }
  if (marker !== undefined) {
    page.push({ user: { login: TRUSTED_AUTHOR }, body: renderMarker(marker) });
  }
  return page;
}

/** A `gh` that answers from canned payloads, keyed by a fragment of the path. */
function cannedGh(routes: Record<string, unknown[] | unknown>): GhCommand {
  return {
    // deno-lint-ignore require-yield
    *run(args: string[]): Operation<string> {
      const path = args[1] ?? "";
      for (const [fragment, answer] of Object.entries(routes)) {
        if (!path.includes(fragment)) {
          continue;
        }
        if (Array.isArray(answer) && answer.length > 0 && Array.isArray(answer[0])) {
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
          return JSON.stringify(answer[page - 1] ?? []);
        }
        return JSON.stringify(answer);
      }
      throw new Error(`no canned answer for ${path}`);
    },
  };
}

function runRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900,
    run_number: 40,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    head_sha: HEAD,
    head_branch: "main",
    event: "push",
    name: "CI",
    html_url: "https://github.com/taras/executable.md/actions/runs/900",
    actor: { login: "pusher" },
    ...overrides,
  };
}

function issueRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    assignees: [{ login: "pusher" }],
    user: { login: TRUSTED_AUTHOR },
    body: "opened for an older run",
    ...overrides,
  };
}

function driveAdapter(routes: Record<string, unknown>, ops: IssueOperations): Operation<unknown> {
  return Gh.with(cannedGh(routes), () =>
    Reads.with(githubReads("taras/executable.md"), () => Issues.with(ops, mainHealth)),
  );
}

describe("the gh adapter", () => {
  /**
   * One page of comments is 100. The marker that says a run was already
   * reported lands on the newest page, so a single-page read reports every
   * wake-up again, forever, as soon as a report passes 100 comments.
   */
  it("reads every page of comments, not only the first", function* () {
    const red = run({ id: 900, attempt: 1, actor: "pusher" });
    const { ops, log } = recorder();

    const decision = yield* driveAdapter(
      {
        "commits/main": { sha: HEAD },
        "actions/runs": { workflow_runs: [runRecord()] },
        "issues?labels": [[issueRecord()], []],
        "issues/7/comments": [commentPage(100), commentPage(0, red)],
      },
      ops,
    );

    expect(decision).toEqual({ report: "none", assignment: undefined });
    expect(log.calls).toEqual([]);
  });

  it("provisions the label before the first report", function* () {
    const { ops, log } = recorder();

    yield* driveAdapter(
      {
        "commits/main": { sha: HEAD },
        "actions/runs": { workflow_runs: [runRecord()] },
        "issues?labels": [[]],
      },
      ops,
    );

    expect(log.calls).toEqual(["ensureLabel", "open", "assign:pusher"]);
  });

  /**
   * A successful response missing a field is malformed, not empty. Reading
   * `""` or `0` out of it would put a wrong report on a real issue.
   */
  it("raises on a malformed response instead of coercing it, before any mutation", function* () {
    const malformed: Record<string, Record<string, unknown>> = {
      "a head with no sha": { "commits/main": {} },
      "a run with no head_sha": {
        "actions/runs": { workflow_runs: [runRecord({ head_sha: undefined })] },
      },
      "a run with a non-numeric attempt": {
        "actions/runs": { workflow_runs: [runRecord({ run_attempt: "two" })] },
      },
      "an issue with no number": { "issues?labels": [[issueRecord({ number: undefined })]] },
      "an author with no login": { "issues?labels": [[issueRecord({ user: {} })]] },
      "an assignee with no login": { "issues?labels": [[issueRecord({ assignees: [{}] })]] },
      "a comment with no body": {
        "issues/7/comments": [[{ user: { login: TRUSTED_AUTHOR } }]],
      },
    };

    for (const [name, override] of Object.entries(malformed)) {
      const { ops, log } = recorder();
      let raised: unknown;

      try {
        yield* driveAdapter(
          {
            "commits/main": { sha: HEAD },
            "actions/runs": { workflow_runs: [runRecord()] },
            "issues?labels": [[issueRecord()], []],
            "issues/7/comments": [[]],
            ...override,
          },
          ops,
        );
      } catch (error) {
        raised = error;
      }

      expect({ name, raised: raised instanceof Error, calls: log.calls }).toEqual({
        name,
        raised: true,
        calls: [],
      });
    }
  });

  /** `null` is how GitHub spells an empty body, and is not malformed. */
  it("accepts a null body as empty", function* () {
    const { ops, log } = recorder();

    yield* driveAdapter(
      {
        "commits/main": { sha: HEAD },
        "actions/runs": { workflow_runs: [runRecord()] },
        "issues?labels": [[issueRecord({ body: null })], []],
        "issues/7/comments": [[]],
      },
      ops,
    );

    expect(log.calls).toEqual(["comment"]);
  });
});

describe("payload logging", () => {
  /**
   * The reconciliation summary and its warnings are the point of the Actions
   * log. Before this, one read of a commit alone printed hundreds of kilobytes
   * of JSON ahead of them.
   */
  it("captures a payload for parsing without forwarding it to the log", function* () {
    const payload = '{"sha":"' + HEAD + '"}';
    const forwarded: string[] = [];

    yield* quietPayloads();

    const captured = yield* scoped(function* () {
      // Stdio middleware runs in installation order, so this stands where the
      // host's own streams would: anything the suppression above lets through
      // arrives here, and that is what the Actions log would show.
      yield* Stdio.around({
        *stdout(bytes, next) {
          forwarded.push(new TextDecoder().decode(bytes[0]));
          return yield* next(...bytes);
        },
      });
      return (yield* exec("echo", { arguments: [payload] }).expect()).stdout;
    });

    expect(captured).toContain(payload);
    expect(forwarded.join("")).toEqual("");
  });
});
