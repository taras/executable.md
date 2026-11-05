import { useArtifactReturnHost } from "./artifact-return-deno.ts";
import { collect, execute, inlineSource } from "@executablemd/core";
import { InMemoryStream } from "@executablemd/durable-streams";
import { API, env, Permissions } from "@executablemd/runtime";
import { ensureDir, exists, readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { Stdio } from "@effectionx/process";
import { ensure, scoped, sleep, spawn, until, withResolvers } from "effection";
import type { Operation } from "effection";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { envelope, state } from "../../../components/Ticket/control.ts";
import { describe, write } from "../../../components/Ticket/text-storage.ts";
import { readFinite } from "../../../components/Ticket/native-node.ts";

export const props = {
  type: "object",
  properties: { recovery: { type: "boolean", default: false }, fixture: { type: "object" } },
  required: ["fixture"],
  additionalProperties: false,
};
const example = fileURLToPath(new URL("../../../", import.meta.url));
const encode = new TextEncoder();
const documentMap = z.record(
  z.string(),
  z
    .object({
      path: z.string(),
      snapshot: z.string(),
      utf8Bytes: z.number(),
      sha256: z.string(),
      observation: z.enum(["file", "supplied"]),
    })
    .strict(),
);
const roleCall = z
  .object({
    session: z.string(),
    role: z.string(),
    initialize: z.boolean(),
    inputs: z.array(z.object({ path: z.string(), content: z.string() })),
    assignment: z
      .object({
        phase: z.string(),
        work: z.string(),
        revision: z.string(),
        repository: z.string(),
        artifactDirectory: z.string(),
        assessment: z.record(z.string(), z.json()),
        continuation: z.record(z.string(), z.json()),
      })
      .passthrough(),
  })
  .passthrough();
function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(
  source: string,
  entry?: { name: "return" | "continue"; record: string },
  failurePath?: string,
) {
  return scoped(function* () {
    const stream = new InMemoryStream();
    let value;
    try {
      value = yield* collect(
        yield* execute({
          ...(entry === undefined
            ? inlineSource(source)
            : { path: example + "/" + entry.name + ".md", props: { record: entry.record } }),
          includes: [
            example + "/tests/artifact-components",
            example + "/tests/components",
            example + "/components",
          ],
          stream,
        }),
      );
    } catch (error) {
      if (failurePath !== undefined) {
        yield* write("/", failurePath, JSON.stringify(stream.snapshot().at(-1)));
      }
      throw error;
    }
    const close = stream.snapshot().at(-1);
    return {
      value: JSON.parse(String(value)),
      closeBytes: encode.encode(JSON.stringify(close)).length + encode.encode(String(value)).length,
    };
  });
}
function* refused(source: string): Operation<boolean> {
  try {
    yield* run(source);
    return false;
  } catch {
    return true;
  }
}
const quoted = (value: unknown) => JSON.stringify(value);
const sourceText = "\ufeffSYNTHETIC-SOURCE-TEXT café 😀\r\nlast\t  \n";

export default function* ArtifactReturn(value: unknown) {
  const { recovery, fixture } = z
    .object({
      recovery: z.boolean(),
      fixture: z.object({ root: z.string(), repository: z.string(), directory: z.string() }),
    })
    .strict()
    .parse(value);
  const retained = yield* env("XMD_ARTIFACT_RETURN_EVIDENCE");
  const root =
    retained === undefined ? fixture.root : retained + (recovery ? "/recovery" : "/growth");
  if (retained !== undefined) {
    check(!(yield* exists(root)), "Retained synthetic evidence requires a fresh directory.");
    yield* ensureDir(root);
  }
  const reports: Array<Record<string, unknown>> = [];
  yield* useArtifactReturnHost(root, fixture.repository);
  if (recovery) {
    const refusalPath = root + "/refused-continuation.json";
    yield* writeTextFile(
      refusalPath,
      JSON.stringify({
        schema: "ticket-return.v1",
        work: "w".repeat(30_000),
        source: null,
        revision: null,
        status: "paused",
        publication: "confirmed",
        continuation: null,
        pending: null,
        hold: null,
      }),
    );
    const refusal = yield* run("", { name: "continue", record: refusalPath });
    check(refusal.value.status === "hold", "continuation refusal did not hold");
    check(
      refusal.closeBytes <= 65_536,
      "continuation refusal exceeded full outward capacity",
    );
    reports.push({
      case: "continuation-refusal",
      outwardBytes: refusal.closeBytes,
    });
  }
  const checkout = yield* run(
    "<Ticket.Checkout repository=" +
      quoted(fixture.repository) +
      ' as="checkout" /><Output><Json value={checkout} /></Output>',
  );
  const head = z.object({ head: z.string() }).parse(checkout.value).head;
  const sourcePath = root + "/source.txt";
  const files = [sourcePath, root + "/large-a.txt", root + "/large-b.txt", root + "/equal.txt"];
  yield* writeTextFile(sourcePath, sourceText);
  for (const path of files.slice(1)) {
    yield* writeTextFile(path, "x".repeat(3_500_000));
  }
  for (let index = 4; index < 14; index++) {
    const path = root + "/artifact-" + index + ".txt";
    files.push(path);
    yield* writeTextFile(path, "synthetic " + index);
  }
  let calls = 0;
  let references = files.slice(0, 1);
  let overage = false;
  let received: Array<z.infer<typeof roleCall>> = [];
  const roles = {
    architect: { session: "original-architect", provider: "codex", initialized: false },
    planner: { session: "original-planner", provider: "codex", initialized: false },
    implementor: { session: "original-implementor", provider: "codex", initialized: false },
  };
  function* launch(name: string, failOuter = false) {
    const directory = root + "/" + name;
    const config = root + "/" + name + "-case.json";
    yield* writeTextFile(config, JSON.stringify({ root, references, overage }));
    const assessment = {
      mechanical: false,
      architecture: false,
      acceptance: true,
      risk: null,
      reason: "Synthetic acceptance evidence.",
      evidence: [sourcePath],
    };
    const manifest = {
      schema: "ticket-workflow.v2",
      work: name,
      directory,
      maxCorrections: 0,
      maxApiRepairs: 0,
      maxResponseCorrections: 0,
      roles,
      acceptedInputs: [{ path: root + "/seed.md", content: "Accepted synthetic scope." }],
      roleInputs: {},
      assignment: {
        phase: "discovery",
        work: name,
        repository: fixture.repository,
        revision: head,
        priorRevision: null,
        request: "artifact-return:" + config,
        assessment,
        changedPaths: [],
        artifacts: [],
        evidence: [],
        findings: [],
        recipient: "planner",
        continuation: { phase: "implementation", role: "implementor" },
      },
    };
    const path = root + "/" + name + ".json";
    yield* writeTextFile(path, JSON.stringify(manifest));
    const body =
      "<Ticket.Run manifest=" +
      quoted(path) +
      ' maxSteps={1} as="work" /><Dir path=' +
      quoted(root) +
      "><File path=" +
      quoted(name + "-return.json") +
      "><Json value={work} /></File></Dir>" +
      (failOuter
        ? '<Fail message="synthetic outer failure" />'
        : "<Output><Json value={work} /></Output>");
    let joinedFailure = false;
    let originalFailure: unknown;
    let closeBytes = 0;
    try {
      const result = yield* run(
        body,
        undefined,
        failOuter ? root + "/" + name + "-outer-close.json" : undefined,
      );
      closeBytes = result.closeBytes;
    } catch (error) {
      joinedFailure = true;
      originalFailure = error;
    }
    if (
      originalFailure !== undefined &&
      (!failOuter || !(yield* exists(root + "/" + name + "-return.json")))
    ) {
      throw originalFailure;
    }
    check(joinedFailure === failOuter, "outer outcome mismatch");
    calls = (yield* exists(root + "/effect-counter.txt"))
      ? Number(yield* readTextFile(root + "/effect-counter.txt"))
      : 0;
    const returned = envelope.parse(
      JSON.parse(yield* readTextFile(root + "/" + name + "-return.json")),
    );
    check(returned.continuation !== null, "missing prior confirmed state");
    const savedPath = returned.continuation?.path ?? "";
    const savedText = yield* readTextFile(savedPath);
    check(encode.encode(savedText).length <= 1_048_576, "continuation exceeded capacity");
    const saved = state.parse(JSON.parse(savedText));
    if (!failOuter) {
      check(closeBytes <= 65_536, "full outward root exceeded capacity");
    }
    reports.push({
      work: name,
      returned,
      continuationBytes: encode.encode(savedText).length,
      outwardBytes: failOuter ? null : closeBytes,
      roleEffects: calls,
      joinedOuter: joinedFailure ? "failed" : "completed",
      outerClose: failOuter ? root + "/" + name + "-outer-close.json" : null,
      documents: saved.documents,
    });
    return {
      returned,
      saved,
      savedPath,
      savedText,
      envelopePath: root + "/" + name + "-return.json",
      joinedFailure,
    };
  }
  if (!recovery) {
    for (const count of [1, 4, 14]) {
      references = files.slice(0, count);
      const before = calls;
      const result = yield* launch("growth-" + count);
      check(
        calls === before + 1,
        "growth calls=" +
          calls +
          " expected=" +
          (before + 1) +
          " hold=" +
          JSON.stringify(result.saved.checkpoint.hold),
      );
      check(result.returned.publication === "confirmed", "growth did not publish");
      check(
        JSON.stringify(result.saved.manifest.roles) === JSON.stringify(roles),
        "role identity changed",
      );
      check(
        result.saved.calls[0].id === "0000" && result.saved.calls[0].session === "original-planner",
        "call identity changed",
      );
      check(
        !JSON.stringify(result.saved.calls).includes("Accepted synthetic scope."),
        "call retained input bodies",
      );
      check(
        !JSON.stringify(result.saved).includes("x".repeat(100)),
        "continuation retained artifact text",
      );
      for (const path of references) {
        const document = result.saved.documents[path];
        check(document !== undefined, "unselected reference not captured");
        const text = yield* readTextFile(document.snapshot);
        check(describe(path, text).sha256 === document.sha256, "snapshot digest changed");
      }
      if (count >= 4) {
        check(
          result.saved.documents[files[1]].snapshot !== result.saved.documents[files[2]].snapshot,
          "distinct provenance collapsed",
        );
      }
    }
    const exact = root + "/exact.txt";
    yield* writeTextFile(exact, "e".repeat(8_388_608));
    const captured = yield* run(
      "<Ticket.Documents repository=" +
        quoted(root) +
        " directory=" +
        quoted(root + "/exact") +
        " paths={" +
        quoted([exact]) +
        '} as="documents" /><Output><Json value={documents} /></Output>',
    );
    check(
      documentMap.parse(captured.value)[exact].utf8Bytes === 8_388_608,
      "inclusive text ceiling refused",
    );
    yield* writeTextFile(exact, "e".repeat(8_388_609));
    check(
      yield* refused(
        "<Ticket.Documents repository=" +
          quoted(root) +
          " directory=" +
          quoted(root + "/oversize") +
          " paths={" +
          quoted([exact]) +
          '} as="documents" /><Output><Json value={documents} /></Output>',
      ),
      "sentinel did not refuse",
    );
    check(!(yield* exists(root + "/oversize/snapshots")), "oversize snapshot persisted");
    overage = true;
    const before = calls;
    const held = yield* launch("escaped-overage");
    check(
      held.returned.publication === "held" && calls === before + 1 && held.saved.calls.length === 0,
      "overage advanced or repeated work",
    );
    check(
      yield* exists(root + "/escaped-overage/attempts/0000/result.json"),
      "overage lost canonical result",
    );
  } else {
    references = files.slice(0, 4);
    yield* Stdio.around({
      *stdout([bytes], next) {
        return yield* next(
          encode.encode(
            new TextDecoder()
              .decode(bytes)
              .replaceAll("SYNTHETIC-SOURCE-TEXT", "SYNTHETIC-OBSERVED-TEXT"),
          ),
        );
      },
    });
    const first = yield* launch("recovery", true);
    check(
      first.returned.publication === "confirmed" && first.joinedFailure && calls === 1,
      "recovery calls=" +
        calls +
        " publication=" +
        first.returned.publication +
        " hold=" +
        JSON.stringify(first.saved.checkpoint.hold),
    );
    const canonical = yield* readTextFile(root + "/recovery/attempts/0000/result.json");
    const firstHash = describe("result", canonical).sha256;
    const receiptHashes: Record<string, string> = {};
    for (const path of [
      root + "/recovery/attempts/0000/raw.txt",
      root + "/recovery/attempts/0000/result.json",
      root + "/recovery/calls/0000/source.json",
    ]) {
      receiptHashes[path] = describe(path, yield* readTextFile(path)).sha256;
    }
    check(
      first.saved.checkpoint.round === 0 &&
        first.saved.manifest.maxCorrections === 0 &&
        first.saved.manifest.maxApiRepairs === 0 &&
        first.saved.manifest.maxResponseCorrections === 0,
      "correction standing changed",
    );

    let commands = 0;
    yield* scoped(function* () {
      yield* API.Process.around({
        *exec([options], next) {
          commands++;
          return yield* next(options);
        },
      });
      const result = yield* run("", { name: "return", record: first.envelopePath });
      check(
        envelope.parse(result.value).status === first.returned.status,
        "read-only return changed saved status",
      );
    });
    check(calls === 1 && commands === 0, "return repeated effects or validation commands");
    for (const [path, hash] of Object.entries(receiptHashes)) {
      check(
        describe(path, yield* readTextFile(path)).sha256 === hash,
        "read-only return changed an original receipt",
      );
    }
    for (const mode of ["missing", "unknown"]) {
      let attempts = 0;
      let target = "";
      const before = calls;
      yield* scoped(function* () {
        yield* API.Fs.around({
          *rename([from, to], next) {
            if (
              String(to).includes("/publication-" + mode + "/continuations/") &&
              Number(yield* readTextFile(root + "/effect-counter.txt")) > before
            ) {
              attempts++;
              target = String(to);
              if (mode === "unknown") {
                yield* next(from, to);
              }
              throw new Error("synthetic publication failure");
            }
            return yield* next(from, to);
          },
        });
        const failed = yield* launch("publication-" + mode);
        const held = failed.returned;
        check(
          held.publication === "held" && failed.saved.calls.length === 0 && calls === before + 1,
          "uncertain publication adopted replacement or repeated role",
        );
        check(
          JSON.parse(yield* readTextFile(held.pending?.result ?? "")).outcome === "complete",
          "publication lost canonical completion",
        );
        check(
          (yield* exists(target)) === (mode === "unknown"),
          "publication cut was not exercised",
        );
        check(held.failure !== undefined, "publication lost its first failure");
        reports.push({
          publicationCut: mode,
          attemptedPath: target,
          exists: yield* exists(target),
          pending: held.pending,
          failure: held.failure,
        });
        const returned = yield* run("", { name: "return", record: failed.envelopePath });
        const continued = yield* run("", { name: "continue", record: failed.envelopePath });
        check(
          envelope.parse(returned.value).publication === "held" &&
            envelope.parse(continued.value).publication === "held" &&
            attempts === 1,
          "return rewrote or adopted uncertain publication",
        );
        const stalePath = root + "/" + mode + "-stale.json";
        yield* writeTextFile(
          stalePath,
          JSON.stringify({
            ...held,
            publication: "confirmed",
            status: failed.saved.checkpoint.status,
            pending: null,
            hold: null,
          }),
        );
        const stale = yield* run("", { name: "continue", record: stalePath });
        check(
          envelope.parse(stale.value).publication === "held" &&
            Number(yield* readTextFile(root + "/effect-counter.txt")) === before + 1,
          "stale prior continuation repeated completed effects",
        );
        check(
          (yield* readTextFile(failed.savedPath)) === failed.savedText,
          "publication changed prior confirmed state",
        );
      });
    }

    const proofDirectory = root + "/exact-review";
    const reviewPath = proofDirectory + "/review.json";
    const implementationPath = proofDirectory + "/implementation.json";
    const observationPath = proofDirectory + "/observation.json";
    const offer = {
      baseRevision: head,
      targetTree: "a".repeat(40),
      checks: [{ name: "synthetic", argv: ["synthetic"] }],
    };
    const proof = {
      status: "verified",
      revision: head,
      approval: { role: "planner", result: reviewPath, offer },
      after: { clean: true, head },
      signature: { exitCode: 0 },
      source: { exitCode: 0, stdout: head + " " + offer.targetTree + " " + head },
      checks: [{ revision: head, exitCode: 0, name: "synthetic", argv: ["synthetic"] }],
    };
    yield* ensureDir(proofDirectory);
    yield* writeTextFile(
      reviewPath,
      JSON.stringify({ outcome: "changes_required", revision: head, exactCorrection: offer }),
    );
    yield* writeTextFile(
      implementationPath,
      JSON.stringify({ outcome: "complete", revision: head }),
    );
    yield* writeTextFile(observationPath, JSON.stringify({ exactReceipt: proof }));
    const capturedProof = yield* run(
      "<Ticket.Documents repository=" +
        quoted(root) +
        " directory=" +
        quoted(proofDirectory) +
        " paths={" +
        quoted([reviewPath, implementationPath, observationPath]) +
        '} as="documents" /><Output><Json value={documents} /></Output>',
    );
    const proofRecord = {
      manifest: first.saved.manifest,
      checkpoint: { ...first.saved.checkpoint, revision: head, exactReview: proof },
      documents: capturedProof.value,
      calls: [
        { role: "planner", status: "accepted", session: "original-planner", result: reviewPath },
        {
          role: "implementor",
          status: "accepted",
          assignment: { revision: head },
          result: implementationPath,
          observation: observationPath,
        },
      ],
    };
    yield* writeTextFile(reviewPath, "changed mutable review receipt");
    yield* rm(observationPath);
    const covered = yield* run(
      "<ExactCorrection.Covers record={" +
        quoted(proofRecord) +
        '} role="planner" as="covered" /><Output><Json value={covered} /></Output>',
    );
    check(
      covered.value === true,
      "metadata calls lost exact-correction coverage or refreshed original receipts",
    );
    const notCovered = yield* run(
      "<ExactCorrection.Covers record={" +
        quoted({
          ...proofRecord,
          calls: [{ ...proofRecord.calls[0], session: "foreign-planner" }, proofRecord.calls[1]],
        }) +
        '} role="planner" as="covered" /><Output><Json value={covered} /></Output>',
    );
    check(notCovered.value === false, "exact-correction coverage lost original role identity");
    const reviewed = yield* run(
      "<Ticket.Reviewed record={" +
        quoted(first.returned) +
        '} as="reviewed" /><Output><Json value={reviewed} /></Output>',
    );
    check(reviewed.value === false, "paused ticket acquired a fabricated review");
    reports.push({
      exactReviewDocuments: capturedProof.value,
      covered: covered.value,
      foreignIdentityCovered: notCovered.value,
    });
    check(
      first.saved.deliveredInputs["original-planner"].every((path) => path !== sourcePath),
      "unselected snapshot became delivery",
    );
    yield* writeTextFile(sourcePath, "changed original");
    yield* rm(sourcePath);
    const beforeContinue = calls;
    const next = yield* run("", { name: "continue", record: first.envelopePath });
    calls = Number(yield* readTextFile(root + "/effect-counter.txt"));
    received = z.array(roleCall).parse(JSON.parse(yield* readTextFile(root + "/received.json")));
    check(
      envelope.parse(next.value).publication === "confirmed" && calls === beforeContinue + 1,
      "explicit continue did not advance saved successor",
    );
    const successor = received.find(
      (call) => call.assignment.work === "recovery" && call.role === "implementor",
    );
    check(successor?.session === "original-implementor", "successor identity changed");
    check(
      successor?.inputs.find((input) => input.path === sourcePath)?.content === sourceText,
      "first File text was not delivered exactly",
    );
    check(
      describe("result", yield* readTextFile(root + "/recovery/attempts/0000/result.json"))
        .sha256 === firstHash,
      "canonical receipt changed",
    );
    const probe = root + "/tamper-source.txt";
    yield* writeTextFile(probe, sourceText);
    const captured = yield* run(
      "<Ticket.Documents repository=" +
        quoted(root) +
        " directory=" +
        quoted(root + "/tamper-case") +
        " paths={" +
        quoted([probe]) +
        '} as="documents" /><Output><Json value={documents} /></Output>',
    );
    const retained = documentMap.parse(captured.value)[probe];
    const inputState = {
      ...first.saved,
      documents: { ...first.saved.documents, [probe]: retained },
    };
    const selectedCall = {
      ...first.saved.calls[0],
      session: "original-implementor",
      role: "implementor",
      assignment: { ...first.saved.calls[0].assignment, handoffInputs: [probe] },
    };
    const inputRead =
      "<Ticket.Inputs record={" +
      quoted(inputState) +
      "} call={" +
      quoted(selectedCall) +
      '} as="prepared" />';
    yield* writeTextFile(retained.snapshot, "altered retained text");
    check(yield* refused(inputRead), "altered retained text accepted");
    yield* rm(retained.snapshot);
    check(yield* refused(inputRead), "missing retained text fell back");
    let nativeReads = 0;
    yield* scoped(function* () {
      yield* Permissions.around({
        files: ([verb], next) => (verb === "read" ? false : next(verb)),
      });
      yield* API.Fs.around({
        *readTextFile([path], next) {
          if (path === retained.snapshot) {
            nativeReads++;
          }
          return yield* next(path);
        },
      });
      check(yield* refused(inputRead), "current read denial ignored");
    });
    check(
      nativeReads === 0 && calls === beforeContinue + 1,
      "denial opened reader or dispatched role",
    );
    const secret = [
      "ghp",
      "_",
      "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 36),
    ].join("");
    yield* writeTextFile(root + "/synthetic-secret.txt", secret);
    check(
      yield* refused(
        "<Ticket.Documents repository=" +
          quoted(root) +
          " directory=" +
          quoted(root + "/rejected") +
          ' paths={["synthetic-secret.txt"]} as="documents" />',
      ),
      "real scanner did not reject",
    );
    check(!(yield* exists(root + "/rejected/snapshots")), "rejected text was copied");
    check(
      yield* refused(
        "<PrintErrors><Ticket.Documents repository=" +
          quoted(root) +
          " directory=" +
          quoted(root + "/missing") +
          ' paths={["absent.txt"]} as="documents" /></PrintErrors>',
      ),
      "printed refusal accepted as text",
    );
    check(!(yield* exists(root + "/missing/snapshots")), "printed refusal produced snapshot");
    yield* scoped(function* () {
      let opening: Promise<FileHandle> | undefined;
      let writing: Promise<unknown> | undefined;
      yield* ensure(function* () {
        if (writing !== undefined) {
          yield* until(
            writing.then(
              () => undefined,
              () => undefined,
            ),
          );
        }
        if (opening !== undefined) {
          const handle = yield* until(
            opening.then(
              (value) => value,
              () => undefined,
            ),
          );
          if (handle !== undefined) {
            yield* until(handle.close());
          }
        }
      });
      opening = open(root + "/invalid.txt", "w");
      const handle = yield* until(opening);
      writing = handle.write(new Uint8Array([0xc3, 0x28]));
      yield* until(writing);
    });
    check(
      yield* refused(
        "<Ticket.Documents repository=" +
          quoted(root) +
          " directory=" +
          quoted(root + "/invalid") +
          ' paths={["invalid.txt"]} as="documents" />',
      ),
      "invalid UTF-8 accepted",
    );
    const reached = withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let opened = 0;
    let closed = 0;
    let afterRead = false;
    const reader = yield* spawn(function* () {
      yield* readFinite(root + "/large-a.txt", 8_388_608, (path) =>
        open(path, "r").then((handle) => {
          opened++;
          return {
            read(buffer, offset, length, position) {
              const issued = handle.read(buffer, offset, length, position);
              reached.resolve();
              return issued.then((result) => release.promise.then(() => result));
            },
            close() {
              closed++;
              return handle.close();
            },
          };
        }),
      );
      afterRead = true;
    });
    yield* reached.operation;
    let halted = false;
    const joining = yield* spawn(function* () {
      yield* reader.halt();
      halted = true;
    });
    yield* sleep(5);
    check(!halted && closed === 0, "teardown did not join issued native read");
    release.resolve();
    yield* joining;
    check(opened === 1 && closed === 1 && !afterRead, "reader cancellation ownership failed");
  }
  return JSON.stringify({ message: "Artifact return assertions passed.", cases: reports });
}
