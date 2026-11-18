import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensureDir, readTextFile, writeTextFile, rm } from "@effectionx/fs";
import { API, Permissions } from "@executablemd/runtime";
import { Ok, Err, scoped, spawn, withResolvers, ensure } from "effection";
import { publicRoots } from "../support/public-root.ts";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { z } from "zod";
import { join, resolve } from "node:path";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { git } from "../support/git.ts";
import { originalFeedback } from "../support/joined-response-feedback.ts";
import { interruptedRecovery } from "../support/joined-response-interruption.ts";
import {
  recoveryFixture,
  reconcile,
  directRecovery,
  recoveryRoot,
} from "../support/joined-response-recovery.ts";
import { cliRuntime, cliCommand } from "@executablemd/test-support/launch";
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
function* accepted(fixture: RecoveryFixture, fileEntry = false) {
  const before = yield* originalFiles(fixture.ticket);
  const oldState = JSON.parse(
    yield* readTextFile(envelope.parse(fixture.record).continuation.path),
  );
  const calls = fixture.native.prompts.length;
  const run = yield* reconcile(fixture, fileEntry);
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
  const returned = JSON.parse(run.stdout);
  const recordPath = join(fixture.directory, "confirmed-return.json");
  yield* writeTextFile(recordPath, JSON.stringify(returned));
  return { returned, state, recordPath, resultPath };
}

describe("public joined-response journeys", () => {
  it("file recovery retains original Planner and Haiku continuity and acknowledged repeat", function* () {
    const f = yield* recoveryFixture({ historical: true });
    const success = yield* accepted(f, true);
    expect(success.state.checkpoint.gate).toBe("planner-review");
    const feedback = yield* originalFeedback(f, success.returned, false);
    expect(feedback.solReceivedNote).toBe(true);
    expect(feedback.prompts.length).toBe(3);
    const saved = yield* originalFiles(f.ticket);
    const proof = JSON.parse(yield* readTextFile(f.proof));
    for (const path of [
      f.proof,
      proof.amendment.path,
      proof.provenance.path,
      proof.join.path,
      f.note,
    ]) {
      yield* rm(path);
    }
    const prompts = f.native.prompts.length;
    let writes = 0;
    let commands = 0;
    yield* API.Files.around({
      *writeTextFile([request], next) {
        if (join(request.cwd, request.path).startsWith(f.ticket + "/")) {
          writes++;
        }
        return yield* next(request);
      },
    });
    yield* API.Process.around({
      *exec([request], next) {
        if (request.command[0] === "git") {
          commands++;
        }
        return yield* next(request);
      },
    });
    const repeated = yield* reconcile(f, false, success.recordPath);
    expect(JSON.parse(repeated.stdout)).toEqual(success.returned);
    const old = yield* directRecovery(f);
    expect(old).toMatchObject({ publication: "held", continuation: f.record.continuation });
    expect(writes).toBe(0);
    expect(commands).toBe(0);
    expect(f.native.prompts.length).toBe(prompts);
    yield* unchanged(saved);
    console.log(
      JSON.stringify({
        nativeEntryRuntime: cliRuntime(),
        originalPrompts: 1,
        continuityPrompts: feedback.prompts.length,
        nativeChildren: 1,
      }),
    );
  });
  it("Architect then Planner receives qualifications before original Haiku correction", function* () {
    const f = yield* recoveryFixture({ historical: true, architecture: true });
    const success = yield* accepted(f);
    expect(success.state.checkpoint.gate).toBe("architect-review");
    const feedback = yield* originalFeedback(f, success.returned, true);
    expect(feedback.prompts.length).toBe(4);
    expect(feedback.prompts.at(-1)?.configuration).toMatchObject({
      model: "haiku",
      effort: "high",
    });
  });

  for (const kind of [
    "guide",
    "identity",
    "owner",
    "source",
    "competing",
    "settlement",
    "permission",
    "late-proof",
  ]) {
    it(
      "public recovery holds on " + kind + " without prompting or rewriting originals",
      function* () {
        const f = yield* recoveryFixture({
          historical: false,
          ...(kind === "competing"
            ? { reply: (result) => JSON.stringify(result) + "\n" + JSON.stringify(result) }
            : {}),
        });
        if (kind === "guide") {
          const path = join(f.ticket, "attempts/0000/submission-guide.md");
          yield* writeTextFile(path, (yield* readTextFile(path)) + "changed");
        }
        if (kind === "identity") {
          const path = join(f.ticket, "sessions/original-haiku.json");
          const identity = JSON.parse(yield* readTextFile(path));
          identity.identity.value = "foreign";
          yield* writeTextFile(path, JSON.stringify(identity));
        }
        if (kind === "owner") {
          const path = join(f.ownerComponents, "Ticket/Schema.md");
          yield* writeTextFile(path, (yield* readTextFile(path)) + "\n<!-- different owner -->\n");
        }
        if (kind === "source") {
          yield* writeTextFile(join(f.repository, "tracked"), "dirty source\n");
        }
        const before = yield* originalFiles(f.ticket);
        const prompts = f.native.prompts.length;
        const proofText = yield* readTextFile(f.proof);
        const proof = JSON.parse(proofText);
        const report = JSON.parse(yield* readTextFile(proof.join.path));
        let denied = false;
        let changed = false;
        yield* API.Files.around({
          *readTextFile([request], next) {
            const path = join(request.cwd, request.path);
            if (kind === "settlement" && path === report.publicRunSource.path) {
              denied = true;
              return Err(new Error("Controlled unavailable completed execution"));
            }
            if (kind === "permission" && path === f.proof) {
              return yield* scoped(function* () {
                denied = true;
                yield* Permissions.around({
                  files: ([verb], pass) => (verb === "read" ? false : pass(verb)),
                });
                return yield* next(request);
              });
            }
            return yield* next(request);
          },
          *writeTextFile([request], next) {
            const result = yield* next(request);
            if (kind === "late-proof" && !changed && request.path.endsWith("disposition.json")) {
              changed = true;
              yield* writeTextFile(proof.amendment.path, "Evidence changed after validation\n");
            }
            return result;
          },
        });
        const returned = yield* directRecovery(f);
        expect(returned).toMatchObject({
          publication: "held",
          continuation: f.record.continuation,
        });
        expect(f.native.prompts.length).toBe(prompts);
        yield* unchanged(before);
        if (kind === "permission" || kind === "settlement") {
          expect(denied).toBe(true);
        }
        if (kind === "permission") {
          expect(JSON.stringify(returned)).not.toContain(proofText);
        }
        if (kind === "late-proof") {
          expect(changed).toBe(true);
        }
      },
    );
  }
  for (const mode of ["before-commit", "unknown"] as const) {
    it("filesystem " + mode + " cannot authorize a second publication", function* () {
      const f = yield* recoveryFixture({ historical: false });
      const before = yield* originalFiles(f.ticket);
      const prompts = f.native.prompts.length;
      const interrupted = yield* interruptedRecovery(f, mode);
      expect(interrupted.injected).toBe(true);
      if (interrupted.returned !== undefined) {
        expect(interrupted.returned).not.toMatchObject({ publication: "confirmed" });
      } else {
        expect(interrupted.failure).not.toBe(null);
      }
      yield* unchanged(before);
      const saved = yield* originalFiles(f.ticket);
      let repeatWrites = 0;
      yield* API.Files.around({
        *writeTextFile([request], next) {
          if (join(request.cwd, request.path).startsWith(f.ticket + "/")) {
            repeatWrites++;
          }
          return yield* next(request);
        },
      });
      const old = yield* directRecovery(f);
      expect(repeatWrites).toBe(0);
      expect(old).toMatchObject({ publication: "held", continuation: f.record.continuation });
      yield* unchanged(saved);
      expect(f.native.prompts.length).toBe(prompts);
      console.log(
        JSON.stringify({ mode, failure: interrupted.failure, returned: interrupted.returned }),
      );
    });
  }

  it("concurrent public recovery preserves exclusive publication and both joined roots", function* () {
    const f = yield* recoveryFixture({ historical: false });
    const before = yield* originalFiles(f.ticket);
    const prompts = f.native.prompts.length;
    const reached = withResolvers<void>();
    const release = withResolvers<void>();
    yield* ensure(() => release.resolve());
    let firstCleanup = true;
    f.native.hooks.cleanup = function* () {
      if (firstCleanup) {
        firstCleanup = false;
        reached.resolve();
        yield* release.operation;
      }
    };
    const settlements = (yield* API.Fs.operations.readDirectory(f.directory))
      .filter((x) => x.name.endsWith("-settlement.json"))
      .map((x) => x.name)
      .sort();
    const first = yield* spawn(() => recoveryRoot(f));
    let second;
    let journal = "";
    let settlement = "";
    try {
      yield* reached.operation;
      expect(
        (yield* API.Fs.operations.readDirectory(f.directory))
          .filter((x) => x.name.endsWith("-settlement.json"))
          .map((x) => x.name)
          .sort(),
      ).toEqual(settlements);
      second = yield* recoveryRoot(f);
      journal = yield* readTextFile(second.journal);
      settlement = yield* readTextFile(second.settlement);
    } finally {
      release.resolve();
    }
    const one = yield* first;
    expect(one.value).toMatchObject({ publication: "confirmed", status: "paused" });
    expect(second.value).toMatchObject({
      publication: "held",
      continuation: f.record.continuation,
    });
    expect(one.journal).not.toBe(second.journal);
    expect(one.settlement).not.toBe(second.settlement);
    const sources: string[] = [];
    for (const result of [one, second]) {
      const receipt = JSON.parse(yield* readTextFile(result.settlement));
      sources.push(receipt.root.path);
      expect(receipt.root).toEqual(
        descriptor(receipt.root.path, yield* readTextFile(receipt.root.path)),
      );
      const text = yield* readTextFile(result.journal);
      expect(receipt.journal).toEqual(descriptor(result.journal, text));
      expect(receipt.outcome).toEqual({
        kind: "settled",
        result: { ok: true, value: result.value },
      });
      const events = text
        .trimEnd()
        .split("\n")
        .map((line) => {
          const event = parseDurableEvent(line);
          if (!event.ok) {
            throw event.error;
          }
          return event.value;
        });
      const roots = events.filter(
        (event) =>
          event.type === "yield" &&
          event.description.type === "import_component" &&
          event.description.name === "__root__",
      );
      expect(roots.length).toBe(1);
      expect(roots[0]).toMatchObject({
        result: {
          status: "ok",
          value: { path: receipt.root.path, content: yield* readTextFile(receipt.root.path) },
        },
      });
      const closes = events.filter(
        (event) => event.type === "close" && event.coroutineId === "root",
      );
      expect(closes.length).toBe(1);
      expect(closes[0]).toMatchObject({
        result: { status: "ok", value: { status: "ok", value: result.value } },
      });
    }
    expect(sources[0]).not.toBe(sources[1]);
    expect(yield* readTextFile(second.journal)).toBe(journal);
    expect(yield* readTextFile(second.settlement)).toBe(settlement);
    expect(f.native.prompts.length).toBe(prompts);
    yield* unchanged(before);
  });
});

describe("authentic historical Submit compatibility", () => {
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
      for (const variant of ["original", "changed-log"]) {
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

describe("public diagnosis consumer", () => {
  it("accepts one incidental-array missing-witness diagnosis through ACP", function* () {
    const directory = yield* useTempDirectory("diagnosis-consumer-");
    const repository = join(directory, "source");
    yield* ensureDir(repository);
    yield* git(["init", "-q"], repository, directory);
    yield* writeTextFile(join(repository, "tracked"), "Controlled source\n");
    yield* git(["add", "."], repository, directory);
    yield* git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "diagnosis source",
      ],
      repository,
      directory,
    );
    const revision = (yield* git(["rev-parse", "HEAD"], repository, directory)).trim();
    const note = join(directory, "witness.txt");
    yield* writeTextFile(note, "Controlled diagnostic witness\n");
    const native = yield* publicRoots(directory, [
      resolve("examples/adversarial-implementation/components"),
    ]);
    yield* native.script(
      'Recording ["title","body"].\n' +
        JSON.stringify({
          outcome: "missing_witness",
          revision,
          witness: "Original journal",
          howToObtain: "Capture the controlled journal.",
        }),
    );
    const request = {
      role: "problem-solver",
      session: "controlled-diagnosis",
      attempt: join(directory, "attempt"),
      inputPaths: [note],
      assignment: {
        repository,
        revision,
        work: "controlled-diagnosis",
        request: "Identify the controlled missing witness.",
      },
    };
    const solvers = {
      primary: { key: "controlled", provider: "claude", models: ["haiku"], effort: "high" },
    };
    const result = yield* native.run(
      "---\nreturns: {type: object}\n---\n<Diagnosis.Run request={" +
        JSON.stringify(request) +
        "} solvers={" +
        JSON.stringify(solvers) +
        '} as="diagnosis" /><Return value={diagnosis} />',
      "controlled-diagnosis",
    );
    expect(result.value).toMatchObject({ status: "missing_witness" });
    expect(native.prompts.length).toBe(1);
  });
});

describe("explicit unpublished reservation resumption", () => {
  for (const variant of ["resume", "changed-request", "publication-uncertain"]) {
    it("preserves the first failed request: " + variant, function* () {
      const f = yield* recoveryFixture({ historical: true });
      const originals = yield* originalFiles(f.ticket);
      const prompts = f.native.prompts.length;
      const launch = cliCommand([]);
      if (cliRuntime() === "deno") {
        launch.arguments.splice(1, 0, "--node-modules-dir=manual", "--cached-only", "--frozen");
      }
      const stoppedEntry = join(f.directory, "stopped-recovery.md");
      yield* writeTextFile(
        stoppedEntry,
        "---\nreturns: {type: object}\n---\n<Ticket.ReconcileResponse record={" +
          JSON.stringify(f.record) +
          "} proof=" +
          JSON.stringify(f.proof) +
          ' as="held" /><Fail message="Controlled joined prepublication stop" /><Return value={held} />',
      );
      const first = yield* API.Process.operations.exec({
        command: [
          launch.command,
          ...launch.arguments,
          "run",
          "--allow-absolute",
          stoppedEntry,
          "--plugin",
          resolve(
            "examples/adversarial-implementation/tests/fixtures/joined-response-owner/request-failure.ts",
          ),
          "--include",
          resolve("examples/adversarial-implementation/recovery/components"),
          "--include",
          f.ownerComponents,
          "--plugin",
          resolve(
            "examples/adversarial-implementation/tests/fixtures/joined-response-owner/no-dispatch.ts",
          ),
        ],
        cwd: resolve("."),
      });
      yield* writeTextFile(join(f.directory, "first-native-receipt.json"), JSON.stringify(first));
      expect(first.exitCode).toBe(1);
      yield* unchanged(originals);
      const reservation = join(
        f.ticket,
        "reconciliations",
        z.object({ continuation: z.object({ sha256: z.string() }) }).parse(f.record).continuation
          .sha256,
      );
      expect((yield* API.Fs.operations.readDirectory(reservation)).map((x) => x.name)).toEqual([
        "request.json",
      ]);
      const requestPath = join(reservation, "request.json");
      const request = yield* readTextFile(requestPath);
      const failure = join(f.directory, "first-failure.json");
      yield* writeTextFile(join(f.directory, "first-error.txt"), first.stderr ?? "");
      yield* writeTextFile(
        failure,
        JSON.stringify({
          holdDigest: z.object({ continuation: z.object({ sha256: z.string() }) }).parse(f.record)
            .continuation.sha256,
          recoveryExitCode: first.exitCode,
          recoveryProviderPrompts: f.native.prompts.length - prompts,
          allOriginalsUnchanged: true,
          returnedConfirmedSuccessor: false,
          nextWorkflowStepStarted: false,
          outcome: "RECOVERY_BLOCKED_BEFORE_PUBLICATION",
          reservationFiles: ["request.json"],
        }),
      );
      const authority = join(f.directory, "resume-authority.md");
      yield* writeTextFile(
        authority,
        "Controlled explicit approval for " +
          descriptor(requestPath, request).sha256 +
          "; no consumer allowance is changed.\n",
      );
      const resumePath = join(f.directory, "resume.json");
      yield* writeTextFile(
        resumePath,
        JSON.stringify({
          schema: "joined-response-resume.v1",
          request: descriptor(requestPath, request),
          authority: descriptor(authority, yield* readTextFile(authority)),
          failure: descriptor(failure, yield* readTextFile(failure)),
        }),
      );
      if (variant === "changed-request") {
        yield* writeTextFile(requestPath, request + "\n");
      }
      if (variant === "publication-uncertain") {
        yield* writeTextFile(join(reservation, "result.json"), "{}\n");
      }
      const before = yield* originalFiles(f.ticket);
      let returned;
      if (variant === "resume") {
        const resumed = yield* reconcile(f, true, f.recordPath, resumePath);
        expect(resumed.exitCode).toBe(0);
        returned = z.record(z.string(), z.json()).parse(JSON.parse(resumed.stdout));
      } else {
        returned = yield* directRecovery(f, f.record, resumePath);
      }
      yield* unchanged(before);
      expect(f.native.prompts.length).toBe(prompts);
      if (variant === "resume") {
        expect(returned).toMatchObject({ publication: "confirmed", status: "paused" });
        expect(yield* readTextFile(requestPath)).toBe(request);
        const state = JSON.parse(
          yield* readTextFile(
            z.object({ continuation: z.object({ path: z.string() }) }).parse(returned).continuation
              .path,
          ),
        );
        const old = JSON.parse(
          yield* readTextFile(
            z.object({ continuation: z.object({ path: z.string() }) }).parse(f.record).continuation
              .path,
          ),
        );
        expect(state.calls).toEqual(old.calls);
        expect(state.manifest).toEqual(old.manifest);
        expect(
          (yield* API.Fs.operations.stat(join(reservation, "resume/request.json"))).exists,
        ).toBe(true);
        const repeated = yield* directRecovery(f, f.record, resumePath);
        expect(repeated).toMatchObject({
          publication: "held",
          continuation: f.record.continuation,
        });
        const confirmed = yield* directRecovery(f, z.record(z.string(), z.json()).parse(returned));
        expect(confirmed).toEqual(returned);
      } else {
        expect(returned).toMatchObject({
          publication: "held",
          continuation: f.record.continuation,
        });
        expect((yield* API.Fs.operations.stat(join(reservation, "resume"))).exists).toBe(false);
      }
    });
  }
});
