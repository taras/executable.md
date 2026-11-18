import { ensureDir, readTextFile, writeTextFile } from "@effectionx/fs";
import { until } from "effection";
import { symlink, mkdtemp } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { z } from "zod";
import { Agent } from "@executablemd/agent/api";
import type { Json } from "@executablemd/core";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { API, realpath, env, Permissions } from "@executablemd/runtime";
import { git } from "./git.ts";
import { cliRuntime, cliCommand } from "@executablemd/test-support/launch";
import { publicRoots } from "./public-root.ts";

import { describe } from "../../components/Ticket/text-storage.ts";

const root = resolve(".");
const overlay = join(root, "examples/adversarial-implementation/recovery/components");
const entry = join(root, "examples/adversarial-implementation/reconcile-response.md");
const manifestPath = join(
  root,
  "examples/adversarial-implementation/tests/fixtures/joined-response-owner/manifest.json",
);
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
    yield* git(["init", "-q"], selected, directory);
    for (const [key, value] of Object.entries({
      "user.name": "Fixture",
      "user.email": "fixture@example.test",
      "commit.gpgsign": "true",
      "gpg.format": "ssh",
      "gpg.ssh.program": "ssh-keygen",
      "user.signingkey": join(directory, "signer"),
      "gpg.ssh.allowedSignersFile": join(directory, "allowed-signers"),
    })) {
      yield* git(["config", key, value], selected, directory);
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
    yield* git(["add", "."], selected, directory);
    yield* git(["commit", "-qm", "fixture launch"], selected, directory);
  }
  const launch = (yield* git(["rev-parse", "HEAD"], repository, directory)).trim();
  yield* writeTextFile(join(repository, "tracked"), "implementation\n");
  yield* git(["add", "tracked"], repository, directory);
  yield* git(
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
      ? (yield* git(
          [
            "commit-tree",
            (yield* git(["rev-parse", "HEAD^{tree}"], repository, directory)).trim(),
            "-S",
            "-m",
            "unrelated fixture",
          ],
          repository,
          directory,
        )).trim()
      : (yield* git(["rev-parse", "HEAD"], repository, directory)).trim();
  yield* git(["reset", "--hard", launch], repository, directory);
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
        yield* git(["reset", "--hard", revision], repository, directory);
      }
      return yield* next(...args);
    },
  });
  const native = yield* publicRoots(directory, [ownerComponents]);
  yield* native.script(
    options.reply?.(result) ?? 'The selection names ["title","body"].\n' + JSON.stringify(result),
  );
  const source =
    "---\nreturns: {type: object}\n---\n<Ticket.Run manifest=" +
    JSON.stringify(manifestFile) +
    ' maxSteps={1} as="original" /><Return value={original} />';
  const original = yield* native.run(source);
  const record = object.parse(original.value);
  const recordPath = join(directory, "original-return.json");
  yield* writeTextFile(recordPath, JSON.stringify(record));
  const journal = original.journal;
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
    throw new Error(
      "No original prompt event: " +
        (yield* readTextFile(
          z.object({ continuation: z.object({ path: z.string() }) }).parse(record).continuation
            .path,
        )),
    );
  }
  const retainedEvent = join(directory, "original-event.json");
  yield* writeTextFile(retainedEvent, lines[promptIndex]);
  const joinFile = join(directory, "join.json");
  const promptDescriptor = describe(journal, lines[promptIndex] + "\n");
  yield* writeTextFile(
    joinFile,
    JSON.stringify({
      schema: "joined-response-run-proof.v1",
      journal: {
        path: journal,
        line: promptIndex + 1,
        lineDescriptor: { utf8Bytes: promptDescriptor.utf8Bytes, sha256: promptDescriptor.sha256 },
      },
      retainedEvent,
      publicRunSource: describe(original.settlement, yield* readTextFile(original.settlement)),
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
  runtime?: "deno" | "node",
  recordPath = fixture.recordPath,
  extra: string[] = [],
) {
  if (runtime === undefined && extra.length === 0) {
    const record = object.parse(JSON.parse(yield* readTextFile(recordPath)));
    const execution = yield* recoveryRoot(fixture, record);
    return {
      command: [],
      exitCode: 0,
      stdout: JSON.stringify(execution.value),
      stderr: "",
      journal: execution.journal,
    };
  }
  const cli = cliCommand([]);
  if (cliRuntime() === "deno") {
    if (cli.arguments[0] !== "run") {
      throw new Error("Unsupported Deno entry prefix");
    }
    cli.arguments.splice(1, 0, "--node-modules-dir=manual", "--cached-only", "--frozen");
  }
  const foreignNode = runtime === "node" && cliRuntime() !== "node";
  const command = foreignNode
    ? [
        "node",
        join(root, "node_modules/tsx/dist/cli.mjs"),
        "--tsconfig",
        join(root, "tsconfig.node.json"),
        join(root, "examples/adversarial-implementation/tests/runtime/node-entry.ts"),
      ]
    : [cli.command, ...cli.arguments];
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
      "--include",
      join(
        root,
        "examples/adversarial-implementation/tests/fixtures/joined-response-owner/boundary",
      ),
      "--plugin",
      join(
        root,
        "examples/adversarial-implementation/tests/fixtures/joined-response-owner/no-dispatch.ts",
      ),
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

function recoveryRoot(
  fixture: RecoveryFixture,
  record: Record<string, Json>,
  extra: Record<string, Json> = {},
) {
  const source =
    "---\nreturns: {type: object}\n---\n<Ticket.ReconcileResponse record={" +
    JSON.stringify(record) +
    "} proof=" +
    JSON.stringify(fixture.proof) +
    Object.entries(extra)
      .map(([key, value]) => " " + key + "={" + JSON.stringify(value) + "}")
      .join("") +
    ' as="recovered" /><Return value={recovered} />';
  return fixture.native.run(source, "original-haiku", [overlay, fixture.ownerComponents]);
}
export function* directRecovery(
  fixture: RecoveryFixture,
  record: Record<string, Json> = fixture.record,
  extra: Record<string, Json> = {},
) {
  return object.parse((yield* recoveryRoot(fixture, record, extra)).value);
}
