import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { until, Ok, suspend, scoped } from "effection";
import { symlink, mkdtemp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { useComponentModuleLoader } from "@executablemd/test-support/host";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { z } from "zod";
import { Agent } from "@executablemd/agent/api";
import type { Json } from "@executablemd/core";
import { collect, useNormalizedOutput } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { useHostFiles } from "@executablemd/runtime";
import { InMemoryStream, parseDurableEvent } from "@executablemd/durable-streams";
import { API, realpath, env, Permissions } from "@executablemd/runtime";
import { git } from "../../../git/tests/support/git-remotes.ts";
import { runReplSubmit } from "../../src/sidekick-acp/submit.ts";
import { SubmitRecord } from "../../src/sidekick-acp/protocol.ts";
import { useHeadlessFixture } from "./headless-repl.ts";
import { describe } from "../../../../examples/adversarial-implementation/components/Ticket/text-storage.ts";
import sourceBoundary from "../fixtures/joined-response-owner/git-boundary.ts";

const root = resolve(".");
const overlay = join(root, "examples/adversarial-implementation/recovery/components");
const entry = join(root, "examples/adversarial-implementation/reconcile-response.md");
const manifestPath = join(root, "packages/cli/tests/fixtures/joined-response-owner/manifest.json");
const manifestSchema = z.object({
  files: z.array(z.object({ originalPath: z.string(), source: z.string(), sha256: z.string() })),
});
const object = z.record(z.string(), z.json());

export function* recoveryFixture(
  options: {
    architecture?: boolean;
    route?: "absent" | "predicted" | "actual" | "wrong";
    source?: "unsigned" | "unrelated";
    apiOwned?: boolean;
    historical?: boolean;
    reply?: (result: Record<string, Json>) => string;
  } = {},
) {
  const evidenceDirectory = yield* env("XMD_RECOVERY_EVIDENCE_DIRECTORY");
  if (evidenceDirectory !== undefined) {
    yield* ensureDir(evidenceDirectory);
  }
  const temporary =
    evidenceDirectory === undefined
      ? yield* useTempDirectory("joined-response-")
      : yield* until(mkdtemp(join(evidenceDirectory, "fixture-")));
  const directory = (yield* realpath(temporary)) ?? temporary;
  const repository = join(directory, "source");
  const owner = join(directory, "owner");
  yield* ensureDir(repository);
  yield* ensureDir(owner);
  const manifest = manifestSchema.parse(JSON.parse(yield* readTextFile(manifestPath)));
  for (const file of manifest.files) {
    if (options.historical === false && file.originalPath.endsWith("Ticket/SelectModel.md")) {
      continue;
    }
    const sourcePath =
      options.historical === false && !file.originalPath.endsWith("Phase/Extract.ts")
        ? file.originalPath
        : file.source;
    const text = yield* readTextFile(join(root, sourcePath));
    if (sourcePath === file.source && describe(file.source, text).sha256 !== file.sha256) {
      throw new Error("Changed fixture source: " + file.source);
    }
    const target = join(owner, file.originalPath);
    yield* ensureDir(dirname(target));
    yield* writeTextFile(target, text);
  }
  yield* until(symlink(join(root, "node_modules"), join(owner, "node_modules")));
  yield* writeTextFile(join(owner, ".gitignore"), "node_modules\n");
  const signing = yield* API.Process.operations.exec({
    command: ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(directory, "signer")],
  });
  if (signing.exitCode !== 0) {
    throw new Error(signing.stderr);
  }
  yield* writeTextFile(
    join(directory, "allowed-signers"),
    "fixture " + (yield* readTextFile(join(directory, "signer.pub"))),
  );
  for (const selected of [repository, owner]) {
    git(["init", "-q"], selected, directory);
    for (const [key, value] of Object.entries({
      "user.name": "Fixture",
      "user.email": "fixture@example.test",
      "commit.gpgsign": "true",
      "gpg.format": "ssh",
      "user.signingkey": join(directory, "signer"),
      "gpg.ssh.allowedSignersFile": join(directory, "allowed-signers"),
    })) {
      git(["config", key, value], selected, directory);
    }
  }
  yield* writeTextFile(join(repository, "AGENTS.md"), "Use only controlled fixture evidence.\n");
  yield* ensureDir(join(repository, ".agents"));
  for (const role of ["implementor", "planner", "architect"]) {
    yield* writeTextFile(
      join(repository, ".agents", role + ".md"),
      "Return the controlled " + role + " fixture result.\n",
    );
  }
  yield* writeTextFile(join(repository, "tracked"), "launch\n");
  for (const selected of [repository, owner]) {
    git(["add", "."], selected, directory);
    git(["commit", "-qm", "fixture launch"], selected, directory);
  }
  const launch = git(["rev-parse", "HEAD"], repository, directory).trim();
  yield* writeTextFile(join(repository, "tracked"), "implementation\n");
  git(["add", "tracked"], repository, directory);
  git(
    [
      ...(options.source === "unsigned" ? ["-c", "commit.gpgsign=false"] : []),
      "commit",
      "-qm",
      "fixture implementation",
    ],
    repository,
    directory,
  );
  const revision =
    options.source === "unrelated"
      ? git(
          [
            "commit-tree",
            git(["rev-parse", "HEAD^{tree}"], repository, directory).trim(),
            "-S",
            "-m",
            "unrelated fixture",
          ],
          repository,
          directory,
        ).trim()
      : git(["rev-parse", "HEAD"], repository, directory).trim();
  git(["reset", "--hard", launch], repository, directory);
  const evidence = join(directory, "focused.txt");
  yield* writeTextFile(evidence, "Controlled focused evidence.\n");
  const note = join(directory, "known-unmet-acceptance.md");
  yield* writeTextFile(
    note,
    "A6/A4/A8/A2/A7 and unfinished-root replay remain unproved. Original Sol must reconcile every frozen row; original Haiku owns corrections.\n",
  );
  const assessment = {
    mechanical: false,
    architecture: false,
    acceptance: true,
    risk: null,
    reason: "Controlled accepted behavior.",
    evidence: [evidence],
  };
  const result: Record<string, Json> = {
    schema: "phase-result.v2",
    outcome: "complete",
    revision,
    summary: "Controlled implementation.",
    handoff: "Planner: reconcile A6/A4/A8/A2/A7 and unfinished-root replay.",
    artifacts: [evidence],
    evidence: [
      { revision, command: "controlled focused check", outcome: "passed", artifact: evidence },
    ],
    findings: ["A6/A4/A8/A2/A7 and unfinished-root replay remain unproved."],
    assessment: { ...assessment, architecture: options.architecture ?? false },
    next:
      options.route === "wrong"
        ? { phase: "hold", role: null }
        : options.route === "actual" && options.architecture
          ? { phase: "review", role: "architect" }
          : { phase: "review", role: "planner" },
    discoveryRequests: [],
    discoveryGaps: [],
  };
  if (options.route === "absent") {
    delete result.next;
  }
  const ticket = join(directory, "ticket");
  const ownerComponents = join(owner, "examples/adversarial-implementation/components");
  const manifestFile = join(directory, "manifest.json");
  yield* writeTextFile(
    manifestFile,
    JSON.stringify({
      schema: "ticket-workflow.v2",
      work: "controlled-recovery",
      directory: ticket,
      assignment: {
        phase: "implementation",
        work: "controlled-recovery",
        repository,
        revision: launch,
        priorRevision: null,
        request: "Implement the controlled accepted plan.",
        changedPaths: [],
        artifacts: [evidence],
        evidence: [],
        findings: [],
        issue: null,
        contract: null,
        assessment,
        reviewKind: "feature",
        recipient: "implementor",
        continuation: { phase: "review", role: "planner" },
      },
      roles: {
        implementor: {
          session: "original-haiku",
          provider: "claude",
          initialized: false,
          ...(options.historical === false ? {} : { model: "haiku" }),
        },
        planner: { session: "original-sol", provider: "codex", initialized: false },
        architect: { session: "original-architect", provider: "codex", initialized: false },
      },
      acceptedInputs: [{ path: evidence, content: "Controlled focused evidence.\n" }],
      maxCorrections: 3,
      maxApiRepairs: 3,
      maxResponseCorrections: 2,
      ...(options.apiOwned ? { api: { ownedPaths: ["tracked"] } } : {}),
    }),
  );
  yield* API.Env.around(
    {
      *cwd() {
        return directory;
      },
    },
    { at: "min" },
  );
  yield* Permissions.around({ files: () => true }, { at: "min" });
  let moved = false;
  yield* Agent.around({
    *prompt(args, next) {
      if (!moved) {
        moved = true;
        git(["reset", "--hard", revision], repository, directory);
      }
      return yield* next(...args);
    },
  });
  yield* useComponentModuleLoader();
  const native = yield* useHeadlessFixture(
    undefined,
    undefined,
    join(directory, "native"),
    { advertiseNativeLaunch: [], advertiseClientNativeAttachment: [] },
    { includes: [ownerComponents] },
    [sourceBoundary],
  );
  native.host.fake.configuration({
    model: { selected: "haiku", choices: ["haiku", "gpt-6.1-sol", "opus"].map((id) => ({ id })) },
    effort: Object.fromEntries(
      ["haiku", "gpt-6.1-sol", "opus"].map((model) => [
        model,
        { selected: "high", choices: ["high", "medium"].map((id) => ({ id })) },
      ]),
    ),
  });
  native.host.fake.script({
    reply:
      options.reply?.(result) ?? 'The selection names ["title","body"].\n' + JSON.stringify(result),
  });
  const nativeRecords: SubmitRecord[] = [];
  const source =
    "---\nreturns: {type: object}\n---\n<Ticket.Run manifest=" +
    JSON.stringify(manifestFile) +
    ' maxSteps={1} as="original" /><Return value={original} />';
  const status = yield* runReplSubmit(
    ["repl", "submit", "--attach", native.reference.sessionId, "-"],
    function* () {
      return Ok(source);
    },
    suspend(),
    function* (record) {
      nativeRecords.push(record);
    },
    (message) => {
      throw new Error(message);
    },
  );
  if (status !== 0) {
    console.error("Native fixture failure retained at " + directory);
    const child = native.children[0];
    if (child !== undefined) {
      const failed = yield* child.session.join();
      if (!failed.ok) {
        console.error(failed.error);
      }
    }
    throw new Error(
      "The original native entry did not join: " + JSON.stringify(nativeRecords.at(-1)),
    );
  }
  const finished = nativeRecords.at(-1);
  if (finished?.kind !== "finished" || finished.result === null || finished.submission === null) {
    throw new Error("Missing actual native completed return.");
  }
  const record = object.parse(finished.result.value);
  const recordPath = join(directory, "original-return.json");
  yield* writeTextFile(recordPath, JSON.stringify(record));
  const journal = join(native.host.root, "v1", finished.submission.execution, "entries.jsonl");
  const journalText = yield* readTextFile(journal);
  const lines = journalText.trimEnd().split("\n");
  for (const line of lines) {
    const event = parseDurableEvent(line);
    if (
      event.ok &&
      event.value.type === "yield" &&
      event.value.description.type === "import_component" &&
      ["Fixture.Owner", "Ticket.Advance"].includes(event.value.description.name)
    ) {
      throw new Error("The natural extraction-failed entry preloaded an unentered recovery owner.");
    }
  }
  const promptIndex = lines.findIndex((line) => {
    const event = parseDurableEvent(line);
    return (
      event.ok && event.value.type === "yield" && event.value.description.type === "agent_prompt"
    );
  });
  if (promptIndex < 0) {
    throw new Error("No original prompt event.");
  }
  const retainedEvent = join(directory, "original-event.json");
  yield* writeTextFile(retainedEvent, lines[promptIndex]);
  const nativeFile = join(directory, "original-native.jsonl");
  yield* writeTextFile(
    nativeFile,
    nativeRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const joinFile = join(directory, "join.json");
  const promptDescriptor = describe(journal, lines[promptIndex] + "\n");
  const nativeDescriptor = describe(nativeFile, yield* readTextFile(nativeFile));
  yield* writeTextFile(
    joinFile,
    JSON.stringify({
      journal: {
        path: journal,
        line: promptIndex + 1,
        lineDescriptor: { utf8Bytes: promptDescriptor.utf8Bytes, sha256: promptDescriptor.sha256 },
      },
      retainedEvent,
      nativeFinishedSource: { ...nativeDescriptor, line: nativeRecords.length },
    }),
  );
  const amendment = join(directory, "amendment.md");
  const provenance = join(directory, "provenance.md");
  yield* writeTextFile(
    amendment,
    "Controlled fixture for the approved no-provider joined-response amendment.\n",
  );
  yield* writeTextFile(provenance, "Controlled fixture; no human authority is created.\n");
  const references: ReturnType<typeof describe>[] = [];
  for (const path of [amendment, provenance, joinFile, note]) {
    references.push(describe(path, yield* readTextFile(path)));
  }
  const proof = join(directory, "proof.json");
  yield* writeTextFile(
    proof,
    JSON.stringify({
      schema: "joined-response-proof.v1",
      amendment: references[0],
      provenance: references[1],
      join: references[2],
      handoffInputs: [references[3]],
    }),
  );
  return {
    directory,
    repository,
    owner,
    ownerComponents,
    revision,
    launch,
    ticket,
    record,
    recordPath,
    proof,
    native,
    note,
    result,
    runs: 0,
  };
}

export type RecoveryFixture =
  ReturnType<typeof recoveryFixture> extends import("effection").Operation<infer T> ? T : never;
export function* reconcile(
  fixture: RecoveryFixture,
  runtime: "deno" | "node" = "deno",
  recordPath = fixture.recordPath,
  extra: string[] = [],
) {
  const command =
    runtime === "node"
      ? [
          "node",
          join(root, "node_modules/tsx/dist/cli.mjs"),
          "--tsconfig",
          join(root, "tsconfig.node.json"),
          join(root, "packages/cli/src/node.ts"),
        ]
      : [
          "deno",
          "run",
          "--allow-all",
          "--node-modules-dir=manual",
          "--cached-only",
          "--frozen",
          join(root, "packages/cli/src/deno.ts"),
        ];
  const ordinal = fixture.runs++;
  const journal = join(fixture.directory, "recovery-" + runtime + "-" + ordinal + ".jsonl");
  const result = yield* API.Process.operations.exec({
    command: [
      ...command,
      "run",
      "--allow-absolute",
      entry,
      "--props-record",
      recordPath,
      "--props-proof",
      fixture.proof,
      "--include",
      overlay,
      "--include",
      fixture.ownerComponents,
      ...(runtime === "node"
        ? ["--include", join(root, "packages/cli/tests/fixtures/joined-response-owner/boundary")]
        : []),
      "--plugin",
      join(root, "packages/cli/tests/fixtures/joined-response-owner/no-dispatch.ts"),
      "--journal",
      journal,
      "--raw",
      ...extra,
    ],
    cwd: fixture.repository,
  });
  const captured = {
    command: [...command, "run", entry],
    exitCode: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    journal,
  };
  yield* writeTextFile(
    join(fixture.directory, "recovery-" + runtime + "-" + ordinal + "-receipt.json"),
    JSON.stringify(captured),
  );
  return captured;
}

export function directRecovery(
  fixture: RecoveryFixture,
  record: Record<string, Json> = fixture.record,
  extra: Record<string, Json> = {},
) {
  return scoped(function* () {
    yield* useHostFiles();
    yield* Permissions.around({ files: () => true }, { at: "min" });
    yield* useComponentModuleLoader();
    yield* useNormalizedOutput();
    const install = sourceBoundary.install;
    if (install !== undefined) {
      yield* install({ command: "run", args: [] });
    }
    const path = join(fixture.directory, "direct-recovery.md");
    yield* writeTextFile(
      path,
      "<Ticket.ReconcileResponse record={" +
        JSON.stringify(record) +
        "} proof=" +
        JSON.stringify(fixture.proof) +
        Object.entries(extra)
          .map(([name, value]) => " " + name + "={" + JSON.stringify(value) + "}")
          .join("") +
        ' as="recovered" /><Output><Json value={recovered} /></Output>',
    );
    const execution = yield* executeInstalled(
      { path, includes: [overlay, fixture.ownerComponents], stream: new InMemoryStream() },
      [],
    );
    return object.parse(JSON.parse(z.string().parse(yield* collect(execution))));
  });
}
