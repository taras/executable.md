import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, readTextFile, writeTextFile, rm } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { z } from "zod";
import { join } from "node:path";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { git } from "../../git/tests/support/git-remotes.ts";
import { originalFeedback } from "./support/joined-response-feedback.ts";
import { cuts, interruptedRecovery, contenders } from "./support/joined-response-interruption.ts";
import { recoveryFixture, reconcile, directRecovery } from "./support/joined-response-recovery.ts";
import type { RecoveryFixture } from "./support/joined-response-recovery.ts";
import { describe as descriptor } from "../../../examples/adversarial-implementation/components/Ticket/text-storage.ts";

const envelope = z.object({
  status: z.string(),
  publication: z.string(),
  hold: z.string().nullable(),
  failure: z.json().optional(),
  continuation: z.object({ path: z.string() }),
});
function* originalFiles(directory: string) {
  const files: Record<string, string> = {};
  function* walk(path: string): import("effection").Operation<void> {
    for (const item of yield* API.Fs.operations.readDirectory(path)) {
      const name = join(path, item.name);
      if (item.isDirectory) {
        yield* walk(name);
      } else if (item.isFile) {
        files[name] = descriptor(name, yield* readTextFile(name)).sha256;
      }
    }
  }
  yield* walk(directory);
  return files;
}
function* unchanged(files: Record<string, string>) {
  for (const [path, hash] of Object.entries(files)) {
    expect(descriptor(path, yield* readTextFile(path)).sha256).toBe(hash);
  }
}
function* accepted(fixture: RecoveryFixture, runtime: "deno" | "node" = "deno") {
  const before = yield* originalFiles(fixture.ticket);
  const oldState = JSON.parse(
    yield* readTextFile(envelope.parse(fixture.record).continuation.path),
  );
  const calls = fixture.native.host.fake.prompts.length;
  const run = yield* reconcile(fixture, runtime);
  if (run.exitCode !== 0) {
    throw new Error(run.stderr || run.stdout);
  }
  const recovered = envelope.parse(JSON.parse(run.stdout));
  expect(recovered).toMatchObject({ status: "paused", publication: "confirmed", hold: null });
  yield* unchanged(before);
  expect(fixture.native.host.fake.prompts.length).toBe(calls);
  const state = JSON.parse(yield* readTextFile(recovered.continuation.path));
  expect(state.manifest).toEqual(oldState.manifest);
  expect(state.calls).toEqual(oldState.calls);
  expect(state.deliveredInputs).toEqual(oldState.deliveredInputs);
  expect(state.checkpoint.round).toBe(0);
  expect(state.manifest.maxCorrections).toBe(3);
  expect(state.manifest.maxApiRepairs).toBe(3);
  expect(state.manifest.maxResponseCorrections).toBe(2);
  expect(state.checkpoint.dispatchable).toBe(true);
  expect(state.calls.at(-1).status).toBe("failed_without_result");
  expect(state.calls.at(-1).result).toBe(undefined);
  expect(state.checkpoint.feedbackInputs).toContain(fixture.note);
  const resultPath = state.checkpoint.feedback.find((path: string) =>
    path.endsWith("/result.json"),
  );
  const result = JSON.parse(yield* readTextFile(resultPath));
  for (const key of [
    "outcome",
    "revision",
    "summary",
    "handoff",
    "assessment",
    "artifacts",
    "evidence",
    "findings",
  ]) {
    expect(result[key]).toEqual(fixture.result[key]);
  }
  const journal = (yield* readTextFile(run.journal))
    .trim()
    .split("\n")
    .map((line) => parseDurableEvent(line));
  const paths = journal.flatMap((item) =>
    item.ok &&
    item.value.type === "yield" &&
    item.value.description.type === "import_component" &&
    item.value.result.status === "ok"
      ? [JSON.stringify(item.value.result.value)]
      : [],
  );
  for (const name of ["Ticket/ReconcileResponse.md", "Phase/Extract.ts"]) {
    expect(paths.some((path) => path.includes("/recovery/components/" + name))).toBe(true);
  }
  expect(
    paths.some(
      (path) =>
        path.includes(fixture.ownerComponents + "/Ticket/LoadState.ts") &&
        path.includes("./control.ts"),
    ),
  ).toBe(true);
  const returned = JSON.parse(run.stdout);
  const recordPath = join(fixture.directory, "confirmed-return.json");
  yield* writeTextFile(recordPath, JSON.stringify(returned));
  return { returned, state, recordPath, resultPath };
}

describe("joined original response recovery", () => {
  it("P3/P5: the native file entry preserves history and the original Haiku allocation", function* () {
    const fixture = yield* recoveryFixture();
    const success = yield* accepted(fixture);
    expect(success.state.checkpoint.gate).toBe("planner-review");
    expect(success.state.manifest.roles.implementor.model).toBe("haiku");
  });
  it("P9: an actual Node CLI loads the composed entry and TypeScript forwarding module", function* () {
    yield* accepted(yield* recoveryFixture(), "node");
  });
  it("P3: a current-shaped matching owner uses the same direct native component", function* () {
    const fixture = yield* recoveryFixture({ historical: false });
    const returned = yield* directRecovery(fixture);
    expect(returned).toMatchObject({ status: "paused", publication: "confirmed" });
  });
  for (const route of ["absent", "predicted", "actual"] satisfies (
    | "absent"
    | "predicted"
    | "actual"
  )[]) {
    it("P3: actual Architect-first policy accepts the " + route + " routing form", function* () {
      const fixture = yield* recoveryFixture({ architecture: true, route });
      const success = yield* accepted(fixture);
      expect(success.state.checkpoint.gate).toBe("architect-review");
      expect(success.state.checkpoint.reviewPolicy.reviewers).toEqual(["architect", "planner"]);
    });
  }
  it("P6: a confirmed repeat uses snapshots after origins disappear, while the old hold stays held", function* () {
    const fixture = yield* recoveryFixture();
    const success = yield* accepted(fixture);
    const before = yield* originalFiles(fixture.ticket);
    const proof = JSON.parse(yield* readTextFile(fixture.proof));
    for (const path of [
      fixture.proof,
      proof.amendment.path,
      proof.provenance.path,
      proof.join.path,
      fixture.note,
    ]) {
      yield* rm(path);
    }
    const repeated = yield* reconcile(fixture, "deno", success.recordPath);
    expect(JSON.parse(repeated.stdout)).toEqual(success.returned);
    yield* unchanged(before);
    const old = yield* reconcile(fixture);
    expect(JSON.parse(old.stdout)).toMatchObject({
      publication: "held",
      continuation: fixture.record.continuation,
    });
    yield* unchanged(before);
  });
  for (const architectFirst of [false, true]) {
    it(
      "P3: ordinary original " +
        (architectFirst ? "Architect/Sol" : "Sol") +
        " feedback preserves Haiku correction",
      function* () {
        const fixture = yield* recoveryFixture({ architecture: architectFirst });
        const success = yield* accepted(fixture);
        const feedback = yield* originalFeedback(fixture, success.returned, architectFirst);
        expect(feedback.solReceivedNote).toBe(true);
        expect(feedback.sourceRound).toBe(1);
        expect(feedback.prompts.at(-1)?.configuration?.model).toBe("haiku");
      },
    );
  }
});

interface Refusal {
  name: string;
  options?: Parameters<typeof recoveryFixture>[0];
  mutate?(fixture: RecoveryFixture): import("effection").Operation<void>;
  reservation: boolean;
}

function* changeJoin(f: RecoveryFixture, kind: string) {
  const p = JSON.parse(yield* readTextFile(f.proof));
  const report = JSON.parse(yield* readTextFile(p.join.path));
  const lines = (yield* readTextFile(report.journal.path)).trimEnd().split("\n");
  const event = JSON.parse(lines[report.journal.line - 1]);
  if (kind === "failed" || kind === "cancelled" || kind === "started") {
    event.result.value.status = kind;
  }
  if (kind === "withheld") {
    event.result.value.text = "";
    event.result.value.withheld = true;
  }
  if (kind === "request") {
    event.description.input += "changed";
  }
  if (kind === "source") {
    event.description["executablemd.source-owner"].index = 999999;
  }
  if (kind === "session-key") {
    event.result.value.sessionKey = "foreign";
  }
  lines[report.journal.line - 1] = JSON.stringify(event);
  yield* writeTextFile(report.journal.path, lines.join("\n") + "\n");
  yield* writeTextFile(report.retainedEvent, lines[report.journal.line - 1]);
  const d = descriptor(report.journal.path, lines[report.journal.line - 1] + "\n");
  report.journal.lineDescriptor = { utf8Bytes: d.utf8Bytes, sha256: d.sha256 };
  if (kind === "unjoined" || kind === "execution") {
    const native = (yield* readTextFile(report.nativeFinishedSource.path)).trimEnd().split("\n");
    const finished = JSON.parse(native[report.nativeFinishedSource.line - 1]);
    if (kind === "unjoined") {
      finished.joined = false;
    } else {
      finished.submission.execution = "foreign";
    }
    native[report.nativeFinishedSource.line - 1] = JSON.stringify(finished);
    yield* writeTextFile(report.nativeFinishedSource.path, native.join("\n") + "\n");
    report.nativeFinishedSource = {
      ...descriptor(
        report.nativeFinishedSource.path,
        yield* readTextFile(report.nativeFinishedSource.path),
      ),
      line: report.nativeFinishedSource.line,
    };
  }
  yield* writeTextFile(p.join.path, JSON.stringify(report));
  p.join = descriptor(p.join.path, yield* readTextFile(p.join.path));
  yield* writeTextFile(f.proof, JSON.stringify(p));
}

const refusals: Refusal[] = [
  {
    name: "changed whole native log bytes",
    reservation: true,
    *mutate(f) {
      const proof = JSON.parse(yield* readTextFile(f.proof));
      const report = JSON.parse(yield* readTextFile(proof.join.path));
      yield* writeTextFile(
        report.nativeFinishedSource.path,
        (yield* readTextFile(report.nativeFinishedSource.path)) + "changed\n",
      );
    },
  },
  {
    name: "changed framed prompt descriptor",
    reservation: true,
    *mutate(f) {
      const proof = JSON.parse(yield* readTextFile(f.proof));
      const report = JSON.parse(yield* readTextFile(proof.join.path));
      report.journal.lineDescriptor.sha256 = "0".repeat(64);
      yield* writeTextFile(proof.join.path, JSON.stringify(report));
      proof.join = descriptor(proof.join.path, yield* readTextFile(proof.join.path));
      yield* writeTextFile(f.proof, JSON.stringify(proof));
    },
  },
  ...[
    "failed",
    "cancelled",
    "started",
    "withheld",
    "request",
    "source",
    "session-key",
    "unjoined",
    "execution",
  ].map((kind) => ({
    name: "native proof " + kind,
    reservation: true,
    *mutate(f: RecoveryFixture) {
      yield* changeJoin(f, kind);
    },
  })),
  {
    name: "metadata capacity",
    reservation: true,
    options: {
      reply: (r) => {
        const entry = Array.isArray(r.evidence) ? r.evidence[0] : null;
        return (
          'Names ["title","body"].\n' +
          JSON.stringify({ ...r, evidence: Array.from({ length: 7000 }, () => entry) })
        );
      },
    },
  },
  {
    name: "unconfirmed envelope",
    reservation: false,
    *mutate(f) {
      yield* writeTextFile(f.recordPath, JSON.stringify({ ...f.record, publication: "held" }));
    },
  },
  {
    name: "foreign work",
    reservation: false,
    *mutate(f) {
      yield* writeTextFile(f.recordPath, JSON.stringify({ ...f.record, work: "foreign" }));
    },
  },
  {
    name: "changed continuation digest",
    reservation: false,
    *mutate(f) {
      const r = JSON.parse(yield* readTextFile(f.recordPath));
      r.continuation.sha256 = "0".repeat(64);
      yield* writeTextFile(f.recordPath, JSON.stringify(r));
    },
  },
  {
    name: "missing assignment",
    reservation: true,
    *mutate(f) {
      yield* rm(join(f.ticket, "attempts/0000/assignment.json"));
    },
  },
  ...["attempts", "preparations"].map((part) => ({
    name: "occupied later " + part,
    reservation: true,
    *mutate(f: RecoveryFixture) {
      yield* ensureDir(join(f.ticket, part, "0001"));
    },
  })),
  {
    name: "wrong selected owning schema",
    reservation: false,
    *mutate(f) {
      const original = yield* readTextFile(
        "examples/adversarial-implementation/components/Ticket/Schema.md",
      );
      yield* writeTextFile(join(f.ownerComponents, "Ticket/Schema.md"), original);
    },
  },
  {
    name: "changed final call",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "calls/0000/call.json");
      const call = JSON.parse(yield* readTextFile(p));
      call.initialize = !call.initialize;
      yield* writeTextFile(p, JSON.stringify(call));
    },
  },
  {
    name: "occupied later call",
    reservation: true,
    *mutate(f) {
      yield* ensureDir(join(f.ticket, "calls/0001"));
    },
  },
  {
    name: "changed owning definition",
    reservation: false,
    *mutate(f) {
      const p = join(f.ownerComponents, "Ticket/LoadState.ts");
      yield* writeTextFile(p, (yield* readTextFile(p)) + "\n");
    },
  },
  {
    name: "changed frozen guide",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "attempts/0000/submission-guide.md");
      yield* writeTextFile(p, (yield* readTextFile(p)) + "changed");
    },
  },
  {
    name: "changed selected snapshot",
    reservation: true,
    *mutate(f) {
      const s = JSON.parse(yield* readTextFile(envelope.parse(f.record).continuation.path));
      yield* writeTextFile(s.calls[0].inputs[0].snapshot, "changed");
    },
  },
  {
    name: "wrong delivery model",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "attempts/0000/delivery.json");
      const d = JSON.parse(yield* readTextFile(p));
      d.profile.model = "opus";
      yield* writeTextFile(p, JSON.stringify(d));
    },
  },
  {
    name: "wrong native identity",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "sessions/original-haiku.json");
      const d = JSON.parse(yield* readTextFile(p));
      d.identity.value = "foreign";
      yield* writeTextFile(p, JSON.stringify(d));
    },
  },
  {
    name: "wrong native identity kind",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "sessions/original-haiku.json");
      const d = JSON.parse(yield* readTextFile(p));
      d.identity.kind = "foreign";
      d.started.identity.kind = "foreign";
      yield* writeTextFile(p, JSON.stringify(d));
    },
  },
  {
    name: "corrupt mandatory unproved-acceptance note",
    reservation: false,
    *mutate(f) {
      yield* writeTextFile(f.note, "changed");
    },
  },
  {
    name: "failure outside extraction",
    reservation: true,
    *mutate(f) {
      const p = join(f.ticket, "attempts/0000/response-disposition.json");
      const d = JSON.parse(yield* readTextFile(p));
      d.lastRejection.code = "schema";
      yield* writeTextFile(p, JSON.stringify(d));
    },
  },
  {
    name: "existing canonical result",
    reservation: true,
    *mutate(f) {
      yield* writeTextFile(join(f.ticket, "attempts/0000/result.json"), JSON.stringify(f.result));
    },
  },
  {
    name: "competing result objects",
    reservation: true,
    options: {
      reply: (r) =>
        "Progress.\n" + JSON.stringify(r) + "\n" + JSON.stringify({ ...r, work: "wrong" }),
    },
  },
  {
    name: "wrong explicit work",
    reservation: true,
    options: {
      reply: (r) => 'Names ["title","body"].\n' + JSON.stringify({ ...r, work: "wrong" }),
    },
  },
  { name: "unrelated explicit route", reservation: true, options: { route: "wrong" } },
  {
    name: "missing role-guide required arrays",
    reservation: true,
    options: {
      reply: (r) => {
        const { discoveryRequests, discoveryGaps, ...rest } = r;
        return 'Names ["title","body"].\n' + JSON.stringify(rest);
      },
    },
  },
  {
    name: "dirty source",
    reservation: true,
    *mutate(f) {
      yield* writeTextFile(join(f.repository, "tracked"), "dirty");
    },
  },
  {
    name: "wrong resulting HEAD",
    reservation: true,
    *mutate(f) {
      git(["reset", "--hard", f.launch], f.repository, f.directory);
    },
  },
  { name: "signed non-descendant", reservation: true, options: { source: "unrelated" } },
  { name: "invalid signature", reservation: true, options: { source: "unsigned" } },
  { name: "changed migration-owned path", reservation: true, options: { apiOwned: true } },
  {
    name: "unreadable proof",
    reservation: false,
    *mutate(f) {
      yield* rm(f.proof);
    },
  },
  {
    name: "descriptor mismatch",
    reservation: false,
    *mutate(f) {
      const p = JSON.parse(yield* readTextFile(f.proof));
      p.amendment.sha256 = "0".repeat(64);
      yield* writeTextFile(f.proof, JSON.stringify(p));
    },
  },
  {
    name: "over-bound handoff references",
    reservation: false,
    *mutate(f) {
      const p = JSON.parse(yield* readTextFile(f.proof));
      p.handoffInputs = Array.from({ length: 13 }, () => p.handoffInputs[0]);
      yield* writeTextFile(f.proof, JSON.stringify(p));
    },
  },
  {
    name: "duplicate handoff references",
    reservation: false,
    *mutate(f) {
      const p = JSON.parse(yield* readTextFile(f.proof));
      p.handoffInputs.push(p.handoffInputs[0]);
      yield* writeTextFile(f.proof, JSON.stringify(p));
    },
  },
  {
    name: "missing mandatory unproved-acceptance note",
    reservation: false,
    *mutate(f) {
      const p = JSON.parse(yield* readTextFile(f.proof));
      p.handoffInputs = [];
      yield* writeTextFile(f.proof, JSON.stringify(p));
    },
  },
];

describe("joined recovery conjunctive refusals", () => {
  for (const row of refusals) {
    it("P4/P5: " + row.name, function* () {
      const fixture = yield* recoveryFixture(row.options);
      if (row.mutate !== undefined) {
        yield* row.mutate(fixture);
      }
      const before = yield* originalFiles(fixture.ticket);
      const prompts = fixture.native.host.fake.prompts.length;
      const run = yield* reconcile(fixture);
      let value: unknown = null;
      try {
        value = JSON.parse(run.stdout);
      } catch {
        /* A root prop refusal need not return JSON. */
      }
      const returned = envelope.safeParse(value);
      expect(returned.success && returned.data.publication === "confirmed").toBe(false);
      expect(run.stderr + run.stdout).not.toContain("ForbiddenReconciliation");
      expect(fixture.native.host.fake.prompts.length).toBe(prompts);
      yield* unchanged(before);
      const reservation = join(
        fixture.ticket,
        "reconciliations",
        z.object({ continuation: z.object({ sha256: z.string() }) }).parse(fixture.record)
          .continuation.sha256,
      );
      expect((yield* API.Fs.operations.stat(reservation)).exists).toBe(row.reservation);
      if (row.reservation) {
        expect(
          JSON.parse(yield* readTextFile(join(reservation, "disposition.json"))),
        ).toMatchObject({ status: "refused" });
        const saved = yield* originalFiles(fixture.ticket);
        const again = yield* reconcile(fixture);
        expect(envelope.parse(JSON.parse(again.stdout)).publication).toBe("held");
        yield* unchanged(saved);
      }
    });
  }
});

describe("joined recovery publication boundaries", () => {
  for (const cut of cuts) {
    it("P6: " + cut + " never adopts matching files or repeats publication", function* () {
      const fixture = yield* recoveryFixture();
      const before = yield* originalFiles(fixture.ticket);
      const prompts = fixture.native.host.fake.prompts.length;
      const interrupted = yield* interruptedRecovery(fixture, cut);
      expect(interrupted.injected).toBe(true);
      expect(interrupted.laterWrites).toEqual([]);
      if (interrupted.returned !== undefined) {
        expect(interrupted.returned).not.toMatchObject({ publication: "confirmed" });
      } else {
        expect(interrupted.failure).not.toBe(null);
      }
      yield* unchanged(before);
      const retained = yield* originalFiles(fixture.ticket);
      const old = yield* directRecovery(fixture);
      expect(old).toMatchObject({ publication: "held", continuation: fixture.record.continuation });
      yield* unchanged(retained);
      expect(fixture.native.host.fake.prompts.length).toBe(prompts);
    });
  }
  it("P6: one real exclusive reservation wins against a concurrent contender", function* () {
    const fixture = yield* recoveryFixture();
    const result = yield* contenders(fixture);
    expect(result.requests).toBe(1);
    expect(result.winner).toMatchObject({ publication: "confirmed", status: "paused" });
    expect(result.second).toMatchObject({
      publication: "held",
      continuation: fixture.record.continuation,
    });
  });
});

describe("joined recovery missing call member", () => {
  it("P4: a removed original receipt member refuses against the complete retained call", function* () {
    const fixture = yield* recoveryFixture();
    const path = join(fixture.ticket, "calls/0000/call.json");
    const call = JSON.parse(yield* readTextFile(path));
    delete call.initialize;
    yield* writeTextFile(path, JSON.stringify(call));
    const before = yield* originalFiles(fixture.ticket);
    const prompts = fixture.native.host.fake.prompts.length;
    const run = yield* reconcile(fixture);
    expect(JSON.parse(run.stdout)).toMatchObject({
      publication: "held",
      continuation: fixture.record.continuation,
    });
    expect(run.stdout).toContain("original final call receipt changed");
    expect(fixture.native.host.fake.prompts.length).toBe(prompts);
    yield* unchanged(before);
  });
});
