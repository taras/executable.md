import { copyFile, ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { cwd } from "@executablemd/runtime";
import { runShell, shellQuote } from "@executablemd/test-support/launch";
import { ensure, race, scoped, spawn } from "effection";
import type { Operation } from "effection";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  actorEnv,
  actorSchema,
  fableFailure,
  overlapEnv,
  readPrompts,
  waitForFile,
} from "../../acp-overlap/receipts.ts";

export const props = {
  type: "object",
  properties: {
    command: { type: "string" },
    directory: { type: "string" },
    revision: { type: "string" },
    scenario: { enum: ["pass", "changes_required", "lost"] },
  },
  required: ["command", "directory", "revision", "scenario"],
  additionalProperties: false,
};

const input = z.strictObject({
  command: z.string(),
  directory: z.string().startsWith("/"),
  revision: z.string(),
  scenario: z.enum(["pass", "changes_required", "lost"]),
});
const production = new URL("../../../", import.meta.url);
const fixtures = new URL("../../acp-overlap/", import.meta.url);
const preparedWorker = new URL(
  "../../packages/cli/tests/fixtures/prepared-test-worker.mjs",
  production,
);

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const statusSchema = z.object({
  status: z.string(),
  nextAction: z.string(),
  reviewPublication: z.object({
    state: z.string(),
    revision: z.string().optional(),
    url: z.string().optional(),
  }),
  review: z.object({
    attempt: z.string(),
    result: z.object({
      revision: z.string(),
      verdict: z.string(),
      acceptance: z.array(z.string()),
    }),
  }),
});
const outcomeSchema = z.object({
  catalog: z.object({ state: z.string(), model: z.string() }),
  turn: z.object({
    state: z.string(),
    stage: z.string(),
    failure: z.string(),
    partial: z.string(),
    terminal: z.string(),
  }),
});

export default function* ReviewOverlap(value: unknown) {
  const { command, directory, revision, scenario } = input.parse(value);
  const repository = yield* cwd();
  const evidence = `${directory}/overlap`;
  const attempt = `${directory}/review-${revision}`;
  const replacement = `${attempt}/replacement`;
  const release = `${evidence}/release`;
  yield* ensureDir(evidence);
  for (const file of ["Fable.md", "Gate.md"]) {
    yield* copyFile(new URL(file, fixtures), `${evidence}/${file}`);
  }
  const astra = yield* readTextFile(new URL("Astra.md", fixtures));
  yield* writeTextFile(
    `${evidence}/Astra.md`,
    scenario !== "changes_required"
      ? astra
      : astra
          .replace('verdict:"pass"', 'verdict:"changes_required"')
          .replace(
            "findings:[]",
            'findings:[{blocking:true,description:"Queue drops a waiting message."}]',
          ),
  );

  const args = [
    fileURLToPath(new URL("delivery.md", production)),
    "--props-record",
    `${directory}/requirements.json`,
    "--props-number",
    "7",
    "--include",
    fileURLToPath(new URL("components", fixtures)),
    "--include",
    fileURLToPath(new URL("components", production)),
    "--plugin",
    fileURLToPath(preparedWorker),
    "--plugin",
    fileURLToPath(new URL("local-workers.ts", fixtures)),
    "--raw",
  ]
    .map(shellQuote)
    .join(" ");

  const review = (actor: z.infer<typeof actorSchema>, timeout: number, action = "review") =>
    runShell(`exec ${command} ${args} --props-action ${shellQuote(action)}`, {
      cwd: repository,
      env: { [overlapEnv]: evidence, [actorEnv]: actor },
      inheritEnv: true,
      timeout,
    }).join();

  function* held() {
    return (
      (yield* exists(`${replacement}/transition.json`)) &&
      (yield* exists(`${replacement}/assignment.json`)) &&
      !(yield* exists(`${replacement}/outcome.json`)) &&
      !(yield* exists(`${replacement}/execution.json`))
    );
  }

  const winner = yield* scoped(function* () {
    const first = yield* spawn(() => review("winner", 90_000));
    let released = false;
    yield* ensure(function* () {
      if (!released) {
        yield* writeTextFile(release, "");
      }
      yield* first;
    });

    function* exitedEarly(): Operation<never> {
      const result = yield* first;
      throw new Error(
        `Winner exited before the matched Astra gate (${result.code}): ${result.stderr} ${result.stdout}`,
      );
    }
    const ready = yield* race([waitForFile(`${evidence}/ready`, 35_000), exitedEarly()]);
    check(
      !ready.timeout && (yield* held()),
      "Winner did not hold the reserved replacement at the matched Astra gate.",
    );

    const primary = outcomeSchema.parse(JSON.parse(yield* readTextFile(`${attempt}/outcome.json`)));
    const execution = z
      .object({ status: z.string() })
      .parse(JSON.parse(yield* readTextFile(`${attempt}/execution.json`)));
    check(
      execution.status === "completed" &&
        primary.catalog.state === "selected" &&
        primary.catalog.model === "fable" &&
        primary.turn.state === "failed" &&
        primary.turn.stage === "turn" &&
        primary.turn.partial === "" &&
        primary.turn.terminal === "failed" &&
        primary.turn.failure.includes(fableFailure),
      `Replacement lacked a joined matched Fable turn failure: ${JSON.stringify(primary)}`,
    );

    const contender = yield* review("contender", 25_000);
    const contenderPrompts = yield* readPrompts(evidence, "contender");
    check(yield* held(), "Replacement stopped waiting before the contender joined.");
    check(
      contenderPrompts.length === 0,
      `Contender sent ACP prompts: ${JSON.stringify(contenderPrompts)}`,
    );
    check(
      contender.code === 1 &&
        contender.stderr.includes(
          "The next action is reconcile_original_review; do not start another review.",
        ),
      `Unexpected contender result (${contender.code}): ${contender.stderr} ${contender.stdout}`,
    );

    if (scenario === "lost") {
      yield* writeTextFile(`${evidence}/stale`, "");
    }
    yield* writeTextFile(release, "");
    released = true;
    return yield* first;
  });

  const prompts = yield* readPrompts(evidence, "winner");
  check(
    prompts.length === 2 &&
      prompts[0]?.provider === "claude" &&
      prompts[0].disposition === "failed" &&
      prompts[1]?.provider === "codex" &&
      prompts[1].disposition === "completed",
    `Winner must send exactly one failed Fable and one completed Astra ACP prompt: ${JSON.stringify(prompts)}`,
  );
  check(winner.code === 0, `Winner exited ${winner.code}: ${winner.stderr} ${winner.stdout}`);
  const status = statusSchema.parse(JSON.parse(winner.stdout));
  check(
    status.status ===
      (scenario === "pass"
        ? "ready_for_merge"
        : scenario === "changes_required"
          ? "repair_required"
          : "publication_pending") &&
      status.review.attempt === replacement &&
      status.review.result.revision === revision &&
      status.review.result.verdict ===
        (scenario === "changes_required" ? "changes_required" : "pass") &&
      status.review.result.acceptance.length === 1 &&
      status.review.result.acceptance[0] === "behavior",
    `Winner did not retain its exact-head Astra pass: ${JSON.stringify(status)}`,
  );

  if (scenario === "lost") {
    check(!(yield* exists(`${evidence}/winner-posted`)), "A stale PR head received a POST.");
    check(
      status.nextAction === "publish_review",
      "A missing publication must take precedence over merge readiness.",
    );
    yield* rm(`${evidence}/stale`);
    yield* rm(`${replacement}/receipt.json`);
    yield* writeTextFile(`${evidence}/delay-post`, "");
    yield* scoped(function* () {
      const first = yield* spawn(() => review("winner", 75_000, "reconcile"));
      yield* ensure(function* () {
        yield* writeTextFile(`${evidence}/release-post`, "");
        yield* first;
      });
      function* exitedEarly(): Operation<never> {
        const result = yield* first;
        throw new Error(
          `Reconcile exited before comment publication (${result.code}): ${result.stderr} ${result.stdout}`,
        );
      }
      const ready = yield* race([waitForFile(`${evidence}/post-ready`, 35_000), exitedEarly()]);
      check(!ready.timeout, "Reconciliation did not attempt to publish the joined result.");
      const overlapping = yield* review("contender", 25_000, "publish-review");
      check(overlapping.code === 0, `Concurrent publication failed: ${overlapping.stderr}`);
      const waiting = statusSchema.parse(JSON.parse(overlapping.stdout));
      check(
        waiting.nextAction === "publish_review",
        "Concurrent publish did not wait for readback.",
      );
      check(
        !(yield* exists(`${evidence}/contender-posted`)),
        "Concurrent publication sent a second POST.",
      );
      yield* writeTextFile(`${evidence}/release-post`, "");
      const result = yield* first;
      check(
        result.code === 0,
        `Reconciliation after lost acknowledgement failed: ${result.stderr}`,
      );
      const unconfirmed = statusSchema.parse(JSON.parse(result.stdout));
      check(unconfirmed.nextAction === "publish_review", "Lost acknowledgement granted readiness.");
    });
    const report = yield* review("later", 25_000, "closeout");
    check(
      report.code === 0 &&
        statusSchema.parse(JSON.parse(report.stdout)).nextAction === "publish_review",
      "Closeout must leave unconfirmed publication pending.",
    );
    check(!(yield* exists(`${evidence}/later-posted`)), "Closeout attempted a GitHub write.");
  }
  const published = yield* review("later", 25_000, "publish-review");
  check(published.code === 0, `Publication retry failed: ${published.stderr} ${published.stdout}`);
  const verified = statusSchema.parse(JSON.parse(published.stdout));
  check(
    verified.status === (scenario === "changes_required" ? "repair_required" : "ready_for_merge") &&
      verified.reviewPublication.state === "verified" &&
      verified.reviewPublication.revision === revision &&
      verified.reviewPublication.url ===
        "https://github.com/taras/executable.md/pull/7#issuecomment-42",
    `Publication was not verified: ${JSON.stringify(verified)}`,
  );
  const comment = z
    .object({ body: z.string() })
    .parse(JSON.parse(yield* readTextFile(`${evidence}/comment.json`)));
  check(
    comment.body.startsWith(`<!-- xmd-independent-review:v1 ${revision} -->`) &&
      comment.body.includes("codex / gpt-6-astra") &&
      comment.body.includes("Reviewed the assigned behavior.") &&
      comment.body.includes(
        scenario === "changes_required" ? "**CHANGES REQUIRED**" : "**PASS**",
      ) &&
      (scenario !== "changes_required" || comment.body.includes("Queue drops a waiting message.")),
    `The published comment does not describe the validated Astra review: ${comment.body}`,
  );
  for (const actor of ["contender", "later"] as const) {
    check(!(yield* exists(`${evidence}/${actor}-posted`)), `${actor} sent an extra POST.`);
    check(
      (yield* readPrompts(evidence, actor)).length === 0,
      `${actor} contacted ACP during publication.`,
    );
  }
  if (scenario === "lost") {
    check((yield* readPrompts(evidence, "winner")).length === 0, "Reconciliation contacted ACP.");
  }

  const later = yield* review("later", 25_000);
  const laterPrompts = yield* readPrompts(evidence, "later");
  check(
    laterPrompts.length === 0,
    `Later invocation sent ACP prompts: ${JSON.stringify(laterPrompts)}`,
  );
  check(
    later.code === 1 &&
      later.stderr.includes(
        `The next action is ${scenario === "changes_required" ? "request_approved_repair" : "await_authorized_merge"}; do not start another review.`,
      ),
    `Unexpected later result (${later.code}): ${later.stderr} ${later.stdout}`,
  );
}
