import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { runShell, shellQuote } from "@executablemd/test-support/launch";
import { ensure, race, scoped, spawn } from "effection";
import { z } from "zod";
import { waitForFile } from "../../acp-overlap/receipts.ts";

export const props = {
  type: "object",
  properties: {
    fixture: { type: "object" },
    command: { type: "string" },
    root: { type: "string" },
    mode: { enum: ["repair", "remote", "local", "roundtrip", "fallback-roundtrip"] },
  },
  required: ["fixture", "command", "root", "mode"],
  additionalProperties: false,
};

const input = z.object({
  fixture: z.object({ repository: z.string(), directory: z.string() }),
  command: z.string(),
  root: z.string(),
  mode: z.enum(["repair", "remote", "local", "roundtrip", "fallback-roundtrip"]),
});

const statusSchema = z.object({
  revision: z.string().nullable().optional(),
  status: z.string(),
  nextAction: z.string(),
  pin: z.object({ revision: z.string(), previous: z.string().nullable() }).nullable(),
  local: z.object({ head: z.string() }).optional(),
  remote: z.object({ revision: z.string(), draft: z.boolean() }).optional(),
  review: z
    .object({ result: z.object({ verdict: z.string() }) })
    .nullable()
    .optional(),
  reviewPublication: z
    .object({ state: z.string(), url: z.string().optional() })
    .nullable()
    .optional(),
});

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export default function* DeliveryJourney(value: unknown) {
  const { fixture, command, root, mode } = input.parse(value);
  const fallback = mode === "fallback-roundtrip";
  const cwd = fixture.repository;
  const directory = fixture.directory + "/delivery";
  const example = root + "/examples/adversarial-implementation";
  const launch = (script: string) => runShell(script, { cwd, timeout: 20_000 }).join();

  function* shell(script: string) {
    const result = yield* launch(script);
    check(result.code === 0, result.stderr + result.stdout);
    return result.stdout.trim();
  }

  const args = [
    example + "/delivery.md",
    "--props-record",
    directory + "/requirements.json",
    "--props-number",
    "7",
    "--raw",
    "--include",
    example + "/tests/components",
    "--include",
    example + "/components",
  ]
    .map(shellQuote)
    .join(" ");
  const entry = (action: string, revision?: string) =>
    launch(
      `export PATH="$PWD/bin:$PATH"; exec ${command} ${args} --props-action ${shellQuote(action)}${revision ? " --props-revision " + shellQuote(revision) : ""}`,
    );

  function* observe(action = "status", revision?: string) {
    const result = yield* entry(action, revision);
    check(result.code === 0, result.stderr + result.stdout);
    return statusSchema.parse(JSON.parse(result.stdout));
  }

  function* refuse(action: string, revision?: string) {
    const result = yield* entry(action, revision);
    check(result.code !== 0, `${action} unexpectedly succeeded: ${result.stdout}`);
  }

  function* json(path: string, data: unknown) {
    yield* writeTextFile(path, JSON.stringify(data));
  }

  const called = directory + "/called.json";
  function* prompts() {
    if (!(yield* exists(called))) {
      return [];
    }
    return z
      .array(z.object({ revision: z.string(), prompted: z.literal(true) }))
      .parse(JSON.parse(yield* readTextFile(called)))
      .map((call) => call.revision);
  }

  yield* ensureDir(directory);
  yield* ensureDir(cwd + "/bin");
  yield* writeTextFile(
    cwd + "/bin/gh",
    `#!/bin/bash
set -eu
if [[ "$*" != "pr ready 7 --repo taras/executable.md" ]]; then exit 70; fi
printf 'ready\\n' >> ready-count.txt
exit 1
`,
  );
  yield* shell("chmod +x bin/gh");
  const branch = yield* shell("git symbolic-ref --short HEAD");
  const base = yield* shell("git rev-parse HEAD");
  const initial = yield* shell("git commit --allow-empty -qm interim && git rev-parse HEAD");
  const green = { status: "completed", conclusion: "success" };
  const remote = {
    revision: initial,
    branch,
    base: "main",
    state: "open",
    draft: true,
    stable: true,
    merged: false,
    mergeRevision: null,
    ciGreen: true,
    ci: green,
    mainRepair: false,
    main: { revision: base, run: green },
  };
  const remotePath = cwd + "/remote.json";
  const feedback = (revision: string) =>
    json(directory + "/feedback.json", { status: "feedback_ready", revision });
  const readyCount = cwd + "/ready-count.txt";
  yield* writeTextFile(directory + "/journey", "");
  yield* json(directory + "/requirements.json", {
    work: fallback ? "fallback-roundtrip" : "delivery-journey",
    repository: cwd,
    directory,
    policy: {
      repository: "taras/executable.md",
      reviewer: {
        provider: "claude",
        model: fallback ? "fable" : "fixture",
        effort: null,
        session: "independent",
      },
      acceptance: [{ id: "behavior", source: "accepted.md", requirement: "Keep the behavior." }],
    },
    inputs: [],
    required: ["independent-review", "required-ci", "main-health"],
  });

  yield* json(remotePath, remote);
  if (mode === "repair") {
    yield* refuse("ready");
    yield* refuse("submit", initial);
    yield* feedback(base);
    yield* refuse("submit", initial);
    yield* feedback(initial);
    for (const ci of [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
    ]) {
      yield* json(remotePath, { ...remote, ci });
      yield* refuse("submit", initial);
    }
    yield* json(remotePath, { ...remote, revision: base });
    yield* refuse("submit", initial);
    yield* json(remotePath, remote);
    yield* writeTextFile(cwd + "/untracked.fixture", "uncommitted source");
    yield* refuse("submit", initial);
    yield* rm(cwd + "/untracked.fixture");
    check((yield* observe()).nextAction === "submit", "Green retry must await submission.");
    yield* refuse("ready");
    check(
      (yield* prompts()).length === 0 && !(yield* exists(readyCount)),
      "An interim action dispatched or marked ready.",
    );
  } else {
    yield* feedback(initial);
  }

  if (mode !== "repair") {
    const source = cwd + "/legacy.fixture";
    const submittedText = yield* readTextFile(source);
    yield* writeTextFile(source, "Different source during review.\n");
    const newer = yield* shell(
      "git add -- legacy.fixture && git commit -qm moved && git rev-parse HEAD",
    );
    yield* shell(`git reset --hard ${shellQuote(initial)}`);
    const release = directory + "/release";
    yield* writeTextFile(directory + "/hold", "");
    const result = yield* scoped(function* () {
      const first = yield* spawn(() => entry("submit", initial));
      yield* ensure(function* () {
        yield* writeTextFile(release, "");
        if (!fallback) {
          yield* first;
        }
      });
      const held = yield* race([
        waitForFile(called, 12_000),
        (function* () {
          throw new Error(
            "Submission completed before reaching the held reviewer: " +
              JSON.stringify(yield* first),
          );
        })(),
      ]);
      check(!held.timeout, "Initial submission did not reach the reviewer.");
      if (mode === "roundtrip" || fallback) {
        yield* shell(`git reset --hard ${shellQuote(newer)}`);
        check(
          (yield* readTextFile(source)) !== submittedText,
          "The live reviewer had no different source to read.",
        );
        yield* shell(`git reset --hard ${shellQuote(initial)}`);
        check(
          (yield* readTextFile(source)) === submittedText,
          "The original tree was not restored before join.",
        );
      } else {
        yield* refuse("submit", initial);
        if (mode === "local") {
          yield* shell(`git reset --hard ${shellQuote(newer)}`);
          yield* feedback(newer);
        }
        yield* json(remotePath, { ...remote, revision: newer });
        yield* refuse("submit", newer);
        yield* refuse("ready");
      }
      yield* writeTextFile(release, "");
      if (fallback) {
        const recorded = yield* race([
          waitForFile(directory + "/review-" + initial + "/hold.json", 12_000),
          (function* () {
            throw new Error(
              "The moved primary completed without a hold: " + JSON.stringify(yield* first),
            );
          })(),
        ]);
        check(!recorded.timeout, "The moved primary did not record its hold.");
        yield* first.halt();
        return null;
      }
      return yield* first;
    });
    if (fallback) {
      const retained = yield* observe();
      check(
        retained.status === "review_held" &&
          retained.pin?.revision === initial &&
          retained.review === null,
        "The moved primary did not hold against its submitted SHA.",
      );
      const attempt = directory + "/review-" + initial;
      const hold = z
        .object({ attempts: z.array(z.object({ reason: z.string() })) })
        .parse(JSON.parse(yield* readTextFile(attempt + "/hold.json")));
      check(
        hold.attempts[0]?.reason.includes("stable checkout") === true,
        "The hold did not identify the missing stable source evidence.",
      );
      yield* refuse("submit", initial);
      yield* refuse("publish-review");
      yield* refuse("ready");
      check((yield* prompts()).join() === initial, "The moved attempt prompted a replacement.");
      for (const path of [
        attempt + "/replacement",
        attempt + "/receipt.json",
        directory + "/comment-" + initial + ".json",
        readyCount,
      ]) {
        check(!(yield* exists(path)), "The moved attempt created " + path);
      }
      return;
    }
    check(result !== null, "The submission did not return its delivery result.");
    if (mode === "roundtrip") {
      check(
        result.code !== 0 && result.stderr.includes("Source changed during review"),
        "The restored checkout supplied a verdict: " + result.stderr + result.stdout,
      );
      const retained = yield* observe();
      check(
        retained.status === "reconciliation_required" &&
          retained.pin?.revision === initial &&
          retained.local?.head === initial &&
          retained.remote?.revision === initial &&
          retained.review === null,
        "The round trip did not hold the attempt against the submitted SHA.",
      );
      const attempt = directory + "/review-" + initial;
      const reply = z.object({ revision: z.literal(initial), verdict: z.literal("pass") });
      const outcome = z
        .object({ turn: z.object({ state: z.literal("reply"), reply: z.string() }) })
        .parse(JSON.parse(yield* readTextFile(attempt + "/outcome.json")));
      reply.parse(JSON.parse(outcome.turn.reply));
      z.object({ status: z.literal("completed") }).parse(
        JSON.parse(yield* readTextFile(attempt + "/execution.json")),
      );
      const reconciliation = yield* entry("reconcile");
      check(
        reconciliation.code !== 0 && reconciliation.stderr.includes("Source changed during review"),
        "Reconciliation accepted or lost the source-movement evidence.",
      );
      yield* refuse("publish-review");
      yield* refuse("ready");
      yield* refuse("submit", initial);
      for (const path of [
        attempt + "/receipt.json",
        directory + "/comment-" + initial + ".json",
        readyCount,
      ]) {
        check(!(yield* exists(path)), "The moved review created " + path);
      }
      check(
        (yield* prompts()).join() === initial,
        "Recovering the moved attempt repeated the prompt.",
      );
      return;
    }
    check(result.code === 0, result.stderr + result.stdout);
    const joined = statusSchema.parse(JSON.parse(result.stdout));
    check(
      joined.pin?.revision === initial && joined.remote?.revision === newer,
      "Observed head displaced the pin.",
    );
    check(
      joined.local?.head === (mode === "remote" ? initial : newer),
      "Wrong local head observation.",
    );
    check((yield* prompts()).join() === initial, "Overlap launched another reviewer.");
    check(
      !(yield* exists(directory + "/comment-" + initial + ".json")) && !(yield* exists(readyCount)),
      "Moved head received an old verdict or readiness mutation.",
    );
    if (mode === "local") {
      yield* shell(`git reset --hard ${shellQuote(initial)}`);
      yield* feedback(initial);
      yield* json(remotePath, remote);
      yield* refuse("reconcile");
      check(
        (yield* observe()).status === "reconciliation_required",
        "Restoring source certified a moved checkout.",
      );
    } else {
      check(
        joined.review?.result.verdict === "pass",
        "Remote movement discarded the joined verdict.",
      );
    }
    return;
  }

  yield* writeTextFile(directory + "/changes-" + initial, "");
  const changes = yield* observe("submit", initial);
  check(
    changes.review?.result.verdict === "changes_required" &&
      changes.reviewPublication?.state === "verified",
    "Repair verdict or comment missing.",
  );
  const repair = yield* shell("git commit --allow-empty -qm repair && git rev-parse HEAD");
  yield* json(remotePath, { ...remote, revision: repair, ci: { status: "in_progress" } });
  yield* refuse("submit", repair);
  yield* feedback(repair);
  yield* refuse("submit", repair);
  yield* json(remotePath, { ...remote, revision: repair });
  yield* feedback(initial);
  yield* refuse("submit", repair);
  check((yield* prompts()).join() === initial, "Ineligible repair launched a reviewer.");
  yield* feedback(repair);
  const pass = yield* observe("submit", repair);
  check(
    pass.pin?.previous === initial &&
      pass.pin.revision === repair &&
      pass.reviewPublication?.state === "verified",
    "Repair did not retain both admissions and publication.",
  );
  check(
    yield* exists(directory + "/comment-" + initial + ".json"),
    "Repair discarded the original comment.",
  );
  yield* writeTextFile(directory + "/comments-unavailable", "");
  yield* refuse("ready");
  yield* rm(directory + "/comments-unavailable");
  yield* json(cwd + "/remote-next.json", { ...remote, revision: repair, ciGreen: false });
  yield* refuse("ready");
  check(!(yield* exists(readyCount)), "Readiness used stale CI or comment evidence.");
  yield* json(remotePath, { ...remote, revision: repair });
  const ready = yield* observe("ready");
  const repeated = yield* observe("ready");
  check(
    ready.status === "ready_pending" &&
      ready.nextAction === "mark_ready_manually" &&
      ready.remote?.draft === true &&
      ready.revision === repair &&
      repeated.revision === repair &&
      repeated.reviewPublication?.url === ready.reviewPublication?.url,
    "Ready did not return the same verified draft candidate.",
  );
  check(!(yield* exists(readyCount)), "Readiness changed the remote draft.");
  yield* json(remotePath, { ...remote, revision: repair, draft: false });
  check(
    (yield* observe()).status === "ready_for_merge",
    "Status missed the maintainer transition.",
  );
  check(
    (yield* prompts()).join() === [initial, repair].join(),
    "Unexpected review prompts across repair and readiness.",
  );
}
