import { readTextFile, writeTextFile } from "@effectionx/fs";
import { Ok, suspend } from "effection";
import { join } from "node:path";
import { z } from "zod";
import { parseDurableEvent } from "@executablemd/durable-streams";
import type { PromptRecord } from "@executablemd/agent/host";
import { parsePromptRecord } from "@executablemd/agent/host";
import { runReplSubmit } from "../../src/sidekick-acp/submit.ts";
import { SubmitRecord } from "../../src/sidekick-acp/protocol.ts";
import { git } from "../../../git/tests/support/git-remotes.ts";
import type { RecoveryFixture } from "./joined-response-recovery.ts";
import type { Json } from "@executablemd/core";

function* nativeStep(fixture: RecoveryFixture, record: Record<string, Json>) {
  const records: SubmitRecord[] = [];
  const source =
    "---\nreturns: {type: object}\n---\n<Ticket.Continue record={" +
    JSON.stringify(record) +
    '} maxSteps={1} as="stepped" /><Return value={stepped} />';
  const status = yield* runReplSubmit(
    ["repl", "submit", "--attach", fixture.native.reference.sessionId, "-"],
    function* () {
      return Ok(source);
    },
    suspend(),
    function* (record) {
      records.push(record);
    },
    (message) => {
      throw new Error(message);
    },
  );
  const final = records.at(-1);
  if (
    status !== 0 ||
    final?.kind !== "finished" ||
    final.outcome !== "completed" ||
    final.result === null ||
    final.submission === null
  ) {
    throw new Error("Ordinary native continuation did not join: " + JSON.stringify(final));
  }
  const returned = z.record(z.string(), z.json()).parse(final.result.value);
  yield* writeTextFile(
    join(fixture.directory, "continuation-" + final.submission.entry + ".jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return returned;
}

export function* originalFeedback(
  fixture: RecoveryFixture,
  record: Record<string, Json>,
  architectFirst: boolean,
) {
  const originalSession = fixture.native.host.fake.turns[0]?.handle.sessionKey;
  const base = {
    schema: "phase-result.v2",
    phase: "review",
    work: "controlled-recovery",
    revision: fixture.revision,
    summary: "Reconcile the recorded controlled acceptance rows.",
    handoff: "Original Implementor: supply the missing controlled witness.",
    artifacts: [fixture.note],
    evidence: [],
    findings: [],
    discoveryRequests: [],
    discoveryGaps: [],
  };
  let current = record;
  if (architectFirst) {
    fixture.native.host.fake.script({
      reply: JSON.stringify({
        ...base,
        outcome: "pass",
        next: { phase: "review", role: "planner" },
      }),
    });
    current = yield* nativeStep(fixture, current);
  }
  fixture.native.host.fake.script({
    reply: JSON.stringify({
      ...base,
      outcome: "missing_evidence",
      assessment: {
        mechanical: false,
        architecture: false,
        acceptance: true,
        risk: null,
        reason: "Supply the controlled missing acceptance witness.",
        evidence: [fixture.note],
      },
      next: { phase: "implementation", role: "implementor" },
    }),
  });
  current = yield* nativeStep(fixture, current);
  const solPrompt = fixture.native.host.fake.prompts.at(-1) ?? "";
  const note = yield* readTextFile(fixture.note);
  if (!solPrompt.includes(fixture.revision) || !solPrompt.includes(JSON.stringify(note))) {
    throw new Error(
      "Original Sol did not receive the exact feedback SHA and separately selected complete note.",
    );
  }
  const state = z.object({ continuation: z.object({ path: z.string() }) }).parse(current);
  const before = JSON.parse(yield* readTextFile(state.continuation.path));
  if (
    before.calls.at(-1).session !== "original-sol" ||
    before.checkpoint.gate !== "implementation" ||
    before.checkpoint.round !== 1
  ) {
    throw new Error("Missing evidence did not retain the original Sol/correction route.");
  }
  yield* writeTextFile(
    join(fixture.repository, "tracked"),
    "controlled missing witness supplied\n",
  );
  git(["add", "tracked"], fixture.repository, fixture.directory);
  git(["commit", "-qm", "controlled correction"], fixture.repository, fixture.directory);
  const corrected = git(["rev-parse", "HEAD"], fixture.repository, fixture.directory).trim();
  git(["reset", "--hard", fixture.revision], fixture.repository, fixture.directory);
  const fake = fixture.native.host.fake;
  const create = fake.create.bind(fake);
  let changed = false;
  fake.create = (options) => {
    const runtime = create(options);
    const start = runtime.startTurn.bind(runtime);
    return {
      ...runtime,
      startTurn(input) {
        if (!changed) {
          changed = true;
          git(["reset", "--hard", corrected], fixture.repository, fixture.directory);
        }
        return start(input);
      },
    };
  };
  fixture.native.host.fake.script({
    reply: JSON.stringify({
      ...fixture.result,
      revision: corrected,
      assessment: {
        mechanical: false,
        architecture: false,
        acceptance: true,
        risk: null,
        reason: "Supplied the controlled missing acceptance witness.",
        evidence: [fixture.note],
      },
      evidence: [
        {
          revision: corrected,
          command: "controlled correction check",
          outcome: "passed",
          artifact: fixture.note,
        },
      ],
      next: { phase: "review", role: "planner" },
    }),
  });
  current = yield* nativeStep(fixture, current);
  const after = JSON.parse(
    yield* readTextFile(
      z.object({ continuation: z.object({ path: z.string() }) }).parse(current).continuation.path,
    ),
  );
  if (
    after.calls.at(-1).session !== "original-haiku" ||
    after.calls.at(-1).profile?.model !== "haiku" ||
    after.manifest.roles.implementor.model !== "haiku" ||
    after.checkpoint.round !== 1 ||
    after.manifest.maxCorrections !== 3 ||
    after.manifest.maxApiRepairs !== 3 ||
    after.manifest.maxResponseCorrections !== 2 ||
    fixture.native.host.fake.turns.at(-1)?.handle.sessionKey !== originalSession
  ) {
    throw new Error(
      "The correction changed its original Implementor identity, model or allowance.",
    );
  }
  const child = fixture.native.children[0];
  if (child === undefined) {
    throw new Error("Original native child unavailable.");
  }
  const journal = yield* readTextFile(
    join(fixture.native.host.root, "v1", child.execution, "entries.jsonl"),
  );
  const prompts: Pick<PromptRecord, "agent" | "sessionKey" | "status" | "configuration">[] = [];
  for (const line of journal.trimEnd().split("\n")) {
    const event = parseDurableEvent(line);
    if (!event.ok) {
      throw event.error;
    }
    if (event.value.type === "yield") {
      if (event.value.description.name === "Ticket.SelectModel") {
        throw new Error("Ordinary continuation selected another model.");
      }
      if (event.value.description.type === "agent_prompt" && event.value.result.status === "ok") {
        const prompt = parsePromptRecord(event.value.result.value);
        if (prompt !== undefined) {
          prompts.push({
            agent: prompt.agent,
            sessionKey: prompt.sessionKey,
            status: prompt.status,
            configuration: prompt.configuration,
          });
        }
      }
    }
  }
  return {
    record: current,
    corrected,
    prompts,
    solReceivedNote: true,
    originalSession,
    sourceRound: after.checkpoint.round,
  };
}
