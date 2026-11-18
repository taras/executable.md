import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, readTextFile, writeTextFile, rm } from "@effectionx/fs";
import { API } from "@executablemd/runtime";
import { Ok, scoped, spawn, withResolvers } from "effection";
import { publicRoots } from "../support/public-root.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { z } from "zod";
import { join, resolve } from "node:path";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { git } from "../support/git.ts";
import { originalFeedback } from "../support/joined-response-feedback.ts";
import { cuts, interruptedRecovery, contenders } from "../support/joined-response-interruption.ts";
import { recoveryFixture, reconcile, directRecovery } from "../support/joined-response-recovery.ts";
import type { RecoveryFixture } from "../support/joined-response-recovery.ts";
import { describe as descriptor } from "../../components/Ticket/text-storage.ts";

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
function* accepted(fixture: RecoveryFixture, runtime?: "deno" | "node") {
  const before = yield* originalFiles(fixture.ticket);
  const oldState = JSON.parse(
    yield* readTextFile(envelope.parse(fixture.record).continuation.path),
  );
  const calls = fixture.native.prompts.length;
  const run = yield* reconcile(fixture, runtime);
  if (run.exitCode !== 0) {
    throw new Error(run.stderr || run.stdout);
  }
  const recovered = envelope.parse(JSON.parse(run.stdout));
  expect(recovered).toMatchObject({ status: "paused", publication: "confirmed", hold: null });
  yield* unchanged(before);
  expect(fixture.native.prompts.length).toBe(calls);
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
    const success = yield* accepted(fixture, "deno");
    expect(success.state.checkpoint.gate).toBe("planner-review");
    expect(success.state.manifest.roles.implementor.model).toBe("haiku");
  });
  it("P9: a real Node CLI loads the composed entry and TypeScript forwarding module", function* () {
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
  const settlement = JSON.parse(yield* readTextFile(report.publicRunSource.path));
  settlement.journal = descriptor(report.journal.path, yield* readTextFile(report.journal.path));
  if (kind === "unjoined") {
    settlement.outcome = { kind: "suspended" };
  }
  if (kind === "execution") {
    settlement.root.path += "foreign";
  }
  yield* writeTextFile(report.publicRunSource.path, JSON.stringify(settlement));
  report.publicRunSource = descriptor(
    report.publicRunSource.path,
    yield* readTextFile(report.publicRunSource.path),
  );
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
        report.publicRunSource.path,
        (yield* readTextFile(report.publicRunSource.path)) + "changed\n",
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
      yield* git(["reset", "--hard", f.launch], f.repository, f.directory);
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
      const prompts = fixture.native.prompts.length;
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
      expect(fixture.native.prompts.length).toBe(prompts);
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
      const prompts = fixture.native.prompts.length;
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
      expect(fixture.native.prompts.length).toBe(prompts);
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
    const prompts = fixture.native.prompts.length;
    const run = yield* reconcile(fixture);
    expect(JSON.parse(run.stdout)).toMatchObject({
      publication: "held",
      continuation: fixture.record.continuation,
    });
    expect(run.stdout).toContain("original final call receipt changed");
    expect(fixture.native.prompts.length).toBe(prompts);
    yield* unchanged(before);
  });
});

describe("public run settlement proof", () => {
  for (const kind of [
    "missing",
    "err",
    "suspended",
    "root-source",
    "journal-hash",
    "returned-envelope",
    "document-result",
    "two-roots",
    "mixed",
  ]) {
    it("P4: public run refuses " + kind, function* () {
      const f = yield* recoveryFixture();
      const p = JSON.parse(yield* readTextFile(f.proof));
      const report = JSON.parse(yield* readTextFile(p.join.path));
      const receipt = JSON.parse(yield* readTextFile(report.publicRunSource.path));
      if (kind === "missing") {
        delete receipt.outcome;
      }
      if (kind === "err") {
        receipt.outcome.result = { ok: false, error: { name: "Error", message: "failed" } };
      }
      if (kind === "suspended") {
        receipt.outcome = { kind: "suspended" };
      }
      if (kind === "root-source") {
        receipt.root.sha256 = "0".repeat(64);
      }
      if (kind === "journal-hash") {
        receipt.journal.sha256 = "0".repeat(64);
      }
      if (kind === "returned-envelope") {
        receipt.outcome.result.value.work = "foreign";
      }
      if (kind === "mixed") {
        report.nativeFinishedSource = { ...report.publicRunSource, line: 1 };
      }
      if (kind === "document-result" || kind === "two-roots") {
        let text = yield* readTextFile(report.journal.path);
        if (kind === "two-roots") {
          text += text;
        } else {
          const lines = text.trimEnd().split("\n");
          const close = JSON.parse(z.string().parse(lines.at(-1)));
          close.result.value.status = "error";
          lines[lines.length - 1] = JSON.stringify(close);
          text = lines.join("\n") + "\n";
        }
        yield* writeTextFile(report.journal.path, text);
        receipt.journal = descriptor(report.journal.path, text);
      }
      yield* writeTextFile(report.publicRunSource.path, JSON.stringify(receipt));
      report.publicRunSource = descriptor(
        report.publicRunSource.path,
        yield* readTextFile(report.publicRunSource.path),
      );
      yield* writeTextFile(p.join.path, JSON.stringify(report));
      p.join = descriptor(p.join.path, yield* readTextFile(p.join.path));
      yield* writeTextFile(f.proof, JSON.stringify(p));
      const before = yield* originalFiles(f.ticket);
      const calls = f.native.prompts.length;
      expect(yield* directRecovery(f)).toMatchObject({ status: "hold", publication: "held" });
      yield* unchanged(before);
      expect(f.native.prompts.length).toBe(calls);
    });
  }
  it("P3/P4: settlement is unavailable until cleanup joins", function* () {
    const f = yield* recoveryFixture();
    const entered = withResolvers<void>();
    const release = withResolvers<void>();
    f.native.hooks.cleanup = function* () {
      entered.resolve();
      yield* release.operation;
    };
    const ordinal = f.native.journals.length;
    const task = yield* spawn(() =>
      f.native.run("---\nreturns: {type: object}\n---\n<Return value={{held:true}} />"),
    );
    yield* entered.operation;
    expect(
      (yield* API.Fs.operations.stat(join(f.directory, "root-" + ordinal + "-settlement.json")))
        .exists,
    ).toBe(false);
    release.resolve();
    yield* task;
    expect(
      (yield* API.Fs.operations.stat(join(f.directory, "root-" + ordinal + "-settlement.json")))
        .exists,
    ).toBe(true);
  });
  it("P3: reads the authentic historical Submit proof without rewriting it", function* () {
    const directory = join("examples/adversarial-implementation/tests/fixtures/historical-submit");
    const index = JSON.parse(yield* readTextFile(join(directory, "index.json")));
    const texts = new Map<string, string>();
    const seen = new Set<string>();
    for (const [path, entry] of Object.entries(index.files)) {
      const file = z.object({ file: z.string(), sha256: z.string() }).parse(entry);
      const text = yield* readTextFile(join(directory, file.file));
      expect(descriptor(path, text).sha256).toBe(file.sha256);
      texts.set(path, text);
    }
    yield* scoped(function* () {
      yield* API.Files.around(
        {
          *readTextFile([request], next) {
            const path = join(request.cwd, request.path);
            const text = texts.get(path);
            if (text === undefined) {
              throw new Error("Unmapped historical read: " + path);
            }
            seen.add(path);
            return Ok(text);
          },
        },
        { at: "max" },
      );
      const native = yield* publicRoots(yield* useTempDirectory("legacy-proof-"), [
        join("examples/adversarial-implementation/recovery/components"),
      ]);
      const originals = new Map(texts);
      for (const variant of ["original", "changed-log", "malformed-entry", "wrong-source"]) {
        texts.clear();
        for (const [path, text] of originals) {
          texts.set(path, text);
        }
        const proof = JSON.parse(z.string().parse(texts.get(index.input.path)));
        const report = JSON.parse(z.string().parse(texts.get(proof.join.path)));
        if (variant === "changed-log") {
          texts.set(
            report.nativeFinishedSource.path,
            z.string().parse(texts.get(report.nativeFinishedSource.path)) + "changed\n",
          );
        }
        if (variant === "malformed-entry") {
          const path = report.nativeFinishedSource.path;
          const lines = z.string().parse(texts.get(path)).trimEnd().split("\n");
          const finished = JSON.parse(
            z.string().parse(lines[report.nativeFinishedSource.line - 1]),
          );
          finished.submission.entry = "xxxxxx1";
          lines[report.nativeFinishedSource.line - 1] = JSON.stringify(finished);
          const text = lines.join("\n") + "\n";
          texts.set(path, text);
          report.nativeFinishedSource = {
            ...descriptor(path, text),
            line: report.nativeFinishedSource.line,
          };
        }
        if (variant === "wrong-source") {
          const path = report.journal.path;
          const lines = z.string().parse(texts.get(path)).trimEnd().split("\n");
          const event = JSON.parse(z.string().parse(lines[report.journal.line - 1]));
          event.description["executablemd.source-owner"].index = 999999;
          lines[report.journal.line - 1] = JSON.stringify(event);
          texts.set(path, lines.join("\n") + "\n");
          texts.set(report.retainedEvent, lines[report.journal.line - 1]);
          const d = descriptor(path, lines[report.journal.line - 1] + "\n");
          report.journal.lineDescriptor = { utf8Bytes: d.utf8Bytes, sha256: d.sha256 };
        }
        if (variant === "malformed-entry" || variant === "wrong-source") {
          const text = JSON.stringify(report);
          texts.set(proof.join.path, text);
          proof.join = descriptor(proof.join.path, text);
          texts.set(index.input.path, JSON.stringify(proof));
        }
        const props = Object.entries(index.input)
          .map(([key, value]) => key + "={" + JSON.stringify(value) + "}")
          .join(" ");
        let refused = false;
        try {
          const result = yield* native.run(
            "---\nreturns: {type: object}\n---\n<Ticket.JoinedProof " +
              props +
              ' as="proof" /><Return value={proof} />',
          );
          expect(
            z.object({ prompt: z.object({ configuration: z.json() }) }).parse(result.value).prompt
              .configuration,
          ).toEqual({ model: "haiku", effort: "high" });
        } catch (error) {
          if (variant === "original") {
            throw error;
          }
          refused = true;
        }
        expect(refused).toBe(variant !== "original");
      }
      expect(seen.size).toBe(texts.size);
    });
  });
});

describe("workflow-owned diagnosis consumer", () => {
  for (const kind of ["incidental-array", "ambiguous", "revision", "evidence", "session"]) {
    it("P8: diagnosis " + kind, function* () {
      const f = yield* recoveryFixture();
      const attempt = join(f.directory, "diagnosis-" + kind);
      const result =
        kind === "evidence"
          ? {
              outcome: "cause",
              revision: f.revision,
              cause: "Controlled cause.",
              evidence: ["foreign.log"],
              regression: { command: "controlled", expected: "pass", observed: "fail" },
              handoff: "Supply the witness.",
            }
          : {
              outcome: "missing_witness",
              revision: kind === "revision" ? "0".repeat(40) : f.revision,
              witness: "Original journal",
              howToObtain: "Capture the controlled journal.",
            };
      let reply = 'Recording ["title","body"].\n' + JSON.stringify(result);
      if (kind === "ambiguous") {
        reply += "\n" + JSON.stringify(result);
      }
      yield* f.native.script(reply);
      let identityRefused = false;
      if (kind === "session") {
        yield* API.Files.around(
          {
            *readTextFile([request], next) {
              const result = yield* next(request);
              if (
                result.ok &&
                request.cwd.includes("diagnosis") &&
                request.cwd.endsWith("sessions")
              ) {
                const identity = JSON.parse(result.value);
                identity.name = "foreign";
                identityRefused = true;
                return Ok(JSON.stringify(identity));
              }
              return result;
            },
          },
          { at: "max" },
        );
      }
      const request = {
        role: "problem-solver",
        session: "controlled-diagnosis",
        attempt,
        inputPaths: [f.note],
        assignment: {
          repository: f.repository,
          revision: f.revision,
          work: "controlled-recovery",
          request: "Identify the controlled missing witness.",
        },
      };
      const solvers = {
        primary: { key: "controlled", provider: "claude", models: ["haiku"], effort: "high" },
      };
      const source =
        "---\nreturns: {type: object}\n---\n<Diagnosis.Run request={" +
        JSON.stringify(request) +
        "} solvers={" +
        JSON.stringify(solvers) +
        '} as="diagnosis" /><Return value={diagnosis} />';
      const returned = z
        .object({ status: z.string() })
        .passthrough()
        .parse(
          (yield* f.native.run(source, "controlled-diagnosis", [
            resolve("examples/adversarial-implementation/components"),
          ])).value,
        );
      if (kind === "incidental-array" && returned.status !== "missing_witness") {
        throw new Error(JSON.stringify(returned));
      }
      if (kind === "session") {
        expect(identityRefused).toBe(true);
      }
      expect(returned.status).toBe(kind === "incidental-array" ? "missing_witness" : "hold");
    });
  }
});
