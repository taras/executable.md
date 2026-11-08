import process from "node:process";
import { main, exit, ensure, until, spawn, sleep, scoped } from "effection";
import { exec } from "@effectionx/process";
import type { Operation } from "effection";
import { ensureDir, readTextFile, writeTextFile, lstat, readdir } from "@effectionx/fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { join } from "node:path";

const product = "35749f4267d42449f26b6a18c4911a0ab7222923";
const fixture = "examples/adversarial-implementation/tests/components/Fixture/Fallback.md";
const allowed = [
  fixture,
  ...["CaptureCase.ts", "TraceAssertion.ts", "capture-state.ts"].map(
    (name) => "examples/adversarial-implementation/tests/components/Fixture/" + name,
  ),
];
const command = [
  "timeout",
  "--signal=TERM",
  "--kill-after=20s",
  "300s",
  "bun",
  "test",
  "--timeout=300000",
  "packages/cli/tests/adversarial-delivery.test.ts",
];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function* output(argv: string[], cwd?: string): Operation<string> {
  return (yield* exec(argv[0], { arguments: argv.slice(1), cwd }).expect()).stdout.trimEnd();
}
function* inventory(root: string): Operation<unknown[]> {
  const files: unknown[] = [];
  for (const name of (yield* readdir(root)).sort()) {
    const path = join(root, name);
    const info = yield* lstat(path);
    if (info.isSymbolicLink()) {
      files.push({ path, state: "skipped", reason: "symbolic link" });
    } else if (info.isDirectory()) {
      files.push(...(yield* inventory(path)));
    } else if (info.isFile()) {
      const bytes = yield* until(readFile(path));
      files.push({
        path,
        state: "present",
        bytes: bytes.length,
        sha256: hash(bytes),
        incomplete: name.endsWith(".json") && !validJson(bytes),
      });
    }
  }
  return files;
}
function validJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

export function* captureProgram(mode: string, childArgv = command): Operation<number> {
  let selected = 0;
  let reason = "success";
  let returned = false;
  let failed = false;
  yield* scoped(function* () {
    const root = join(Deno.env.get("RUNNER_TEMP") ?? "/missing-runner-temp", "fallback-capture");
    const evidence = join(root, "evidence");
    const channels = join(evidence, "channels");
    const capture = join(evidence, "journals");
    const checkout = join(root, "checkout");
    const envelope = Deno.env.get("GITHUB_WORKSPACE") ?? "";
    yield* ensureDir(evidence);
    const manifest: Record<string, unknown> = {
      schema: "fallback-capture-manifest.v1",
      product,
      envelope: Deno.env.get("GITHUB_SHA"),
      phase: "initial",
      consumerExecutions: 0,
      started: new Date().toISOString(),
      qualification:
        "Instrumentation changes timing; preceding measurement files are not replayed. No original-run flake or cause claim.",
      channels: "absent",
      journals: [],
      snapshots: "not produced",
      cleanup: "not started",
    };
    function save(): Operation<void> {
      return writeTextFile(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
    yield* ensureDir(capture);
    yield* ensureDir(channels);
    if (mode === "consume" || mode === "prepare") {
      Object.assign(
        manifest,
        z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(yield* readTextFile(join(evidence, "manifest.json")))),
      );
    } else {
      yield* save();
    }
    yield* ensure(function* () {
      manifest.ended = new Date().toISOString();
      try {
        const files = yield* inventory(evidence);
        manifest.files = files;
        manifest.channels = yield* inventory(channels);
        const captured = yield* inventory(capture);
        manifest.snapshots = captured.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "path" in item &&
            typeof item.path === "string" &&
            item.path.includes("/fallback/cases/") &&
            !item.path.includes("/objects/"),
        );
        const captureErrors = captured.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "path" in item &&
            typeof item.path === "string" &&
            item.path.endsWith("capture-error.json"),
        );
        manifest.captureErrors = captureErrors;
        if (captureErrors.length) {
          if (selected === 0) {
            selected = 1;
            reason = "capture-fault";
          }
        }
        manifest.cleanup =
          "launcher finalizer reached; inventories describe present or incomplete files";
        manifest.journals = captured.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "path" in item &&
            typeof item.path === "string" &&
            item.path.endsWith(".jsonl"),
        );
      } catch (error) {
        manifest.inventoryFailure = String(error);
        if (selected === 0) {
          selected = 1;
          reason = "inventory-fault";
        }
      }
      manifest.operationalStatus = !returned && !failed ? null : selected;
      manifest.operationalReason =
        !returned && !failed ? "owner-cancelled; signal status belongs to Effection main" : reason;
      yield* save();
    });
    try {
      if (mode === "consume") {
        if (manifest.phase !== "prelaunch" || manifest.consumerExecutions !== 0) {
          throw new Error("Missing admitted prelaunch or execution already reserved; no retry");
        }
        if (childArgv === command && manifest.preflights !== "passed") {
          throw new Error("Linux preflights required before full consumer reservation");
        }
        manifest.consumerExecutions = 1;
        manifest.phase = "consumer-running";
        yield* save();
        const consumer = yield* retainedProcess(
          childArgv,
          checkout,
          evidence,
          channels,
          "consumer",
          {
            TMPDIR: join(root, "tmp"),
            XMD_TEST_ARTIFACTS: capture,
          },
        );
        manifest.consumer = consumer;
        selected = consumer.code;
        reason = consumer.code === 0 ? "consumer-success" : "consumer-nonzero";
        manifest.phase = "stopped";
        manifest.stop = "Return evidence once; no retry, source fix, flake claim or measurement";
        yield* save();
        returned = true;
        return;
      }
      if (mode !== "prepare" && mode !== "preflight") {
        throw new Error("Expected prepare or consume");
      }
      if (mode === "prepare" && manifest.operationalStatus !== 0) {
        throw new Error(
          "Successful outer preflight finalization required before product preparation",
        );
      }
      const facts: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        image: Deno.env.get("ImageVersion"),
        runnerVersion: Deno.env.get("CAPTURE_RUNNER_VERSION"),
        runner: Deno.env.get("RUNNER_NAME"),
        runnerOS: Deno.env.get("RUNNER_OS"),
        run: Deno.env.get("GITHUB_RUN_ID"),
        attempt: Deno.env.get("GITHUB_RUN_ATTEMPT"),
      };
      const probes: [string, string[]][] = [
        ["uname", ["uname", "-a"]],
        ["architecture", ["uname", "-m"]],
        ["bun", ["bun", "--version"]],
        ["bunBuild", ["bun", "--revision"]],
        ["deno", ["deno", "--version"]],
        ["node", ["node", "--version"]],
        ["paths", ["bash", "-c", "command -v bun deno node pnpm timeout setsid"]],
        ["envelope", ["git", "rev-parse", "HEAD"]],
      ];
      facts.osRelease = yield* readTextFile("/etc/os-release");
      for (const [name, argv] of probes) {
        try {
          facts[name] = yield* output(argv, envelope);
        } catch (error) {
          facts[name] = { error: String(error) };
        }
        yield* writeTextFile(join(evidence, "provenance.json"), JSON.stringify(facts, null, 2));
      }
      const refusals = [];
      if (facts.attempt !== "1") {
        refusals.push("run attempt must be first; no retry");
      }
      if (facts.architecture !== "x86_64") {
        refusals.push("architecture");
      }
      if (!String(facts.osRelease).includes('PRETTY_NAME="Ubuntu 26.04.1 LTS"')) {
        refusals.push("OS");
      }
      if (facts.image !== "20261101.186.1") {
        refusals.push("ImageVersion");
      }
      if (facts.runnerVersion !== "2.338.2") {
        refusals.push("runner agent");
      }
      if (facts.bun !== "1.4.0" || facts.bunBuild !== "1.4.0+34cbb9a40") {
        refusals.push("Bun version/build");
      }
      if (!String(facts.deno).startsWith("deno 2.9.5 ")) {
        refusals.push("Deno");
      }
      if (facts.node !== "v22.23.4") {
        refusals.push("Node");
      }
      if (facts.envelope !== Deno.env.get("GITHUB_SHA")) {
        refusals.push("diagnostic envelope SHA");
      }
      manifest.admission = { accepted: refusals.length === 0, refusals };
      manifest.phase = "admission";
      yield* save();
      if (refusals.length) {
        throw new Error("Admission refused: " + refusals.join(", "));
      }
      if (mode === "preflight") {
        yield* ensureDir(channels);
        manifest.phase = "diagnostic-setup";
        yield* save();
        const setup = yield* retainedProcess(
          ["deno", "task", "setup"],
          envelope,
          evidence,
          channels,
          "diagnostic-setup",
        );
        manifest.diagnosticSetup = setup;
        if (setup.code !== 0) {
          throw new Error("Diagnostic setup failed; no retry");
        }
        for (const [name, argv] of [
          [
            "preflight-deno",
            [
              "timeout",
              "--signal=TERM",
              "--kill-after=5s",
              "90s",
              "deno",
              "task",
              "test",
              "scripts/tests/fallback-capture-preflight.test.ts",
            ],
          ],
          [
            "preflight-bun",
            [
              "timeout",
              "--signal=TERM",
              "--kill-after=5s",
              "90s",
              "bun",
              "test",
              "--timeout=90000",
              "scripts/tests/fallback-capture-preflight.test.ts",
            ],
          ],
        ] satisfies [string, string[]][]) {
          const result = yield* retainedProcess(argv, envelope, evidence, channels, name, {
            XMD_TEST_ARTIFACTS: join(evidence, name + "-artifacts"),
          });
          manifest[name] = result;
          yield* save();
          if (result.code !== 0) {
            throw new Error(name + " failed; consumer remains unreserved");
          }
        }
        manifest.preflights = "passed";
        manifest.phase = "preflights-passed-consumer-not-authorized";
        returned = true;
        yield* save();
        return;
      }
      if (manifest.preflights !== "passed") {
        throw new Error("Preflight proof required before product preparation");
      }
      yield* output(["git", "clone", "--no-hardlinks", "--no-checkout", envelope, checkout]);
      yield* output(["git", "checkout", "--detach", product], checkout);
      const source = {
        head: yield* output(["git", "rev-parse", "HEAD"], checkout),
        tree: yield* output(["git", "rev-parse", "HEAD^{tree}"], checkout),
        status: yield* output(["git", "status", "--porcelain=v1"], checkout),
      };
      if (source.head !== product || source.status !== "") {
        throw new Error("Product checkout mismatch");
      }
      yield* writeTextFile(join(evidence, "product.json"), JSON.stringify(source, null, 2));
      const tracked = (yield* output(["git", "ls-files"], checkout)).split("\n");
      const original: Record<string, string> = {};
      for (const path of tracked) {
        original[path] = hash(yield* until(readFile(join(checkout, path))));
      }
      yield* writeTextFile(
        join(evidence, "original-hashes.json"),
        JSON.stringify(original, null, 2),
      );
      const exampleFiles = tracked.filter((path) =>
        path.startsWith("examples/adversarial-implementation/"),
      );
      yield* writeTextFile(
        join(evidence, "example-hashes.json"),
        JSON.stringify(
          exampleFiles.map((path) => ({ path, sha256: original[path] })),
          null,
          2,
        ),
      );
      if (exampleFiles.length !== 171) {
        throw new Error("Original example file count mismatch: " + exampleFiles.length);
      }
      yield* writeTextFile(
        join(evidence, "Fallback.original.md"),
        yield* readTextFile(join(checkout, fixture)),
      );
      yield* ensureDir(channels);
      manifest.phase = "setup";
      manifest.setup = { command: ["deno", "task", "setup"], count: 1, status: "started" };
      yield* save();
      const setup = yield* retainedProcess(
        ["deno", "task", "setup"],
        checkout,
        evidence,
        channels,
        "setup",
      );
      manifest.setup = setup;
      yield* save();
      if (setup.code !== 0) {
        throw new Error("Setup failed; no retry");
      }
      for (const path of tracked) {
        if (hash(yield* until(readFile(join(checkout, path)))) !== original[path]) {
          throw new Error("Setup changed source: " + path);
        }
      }
      const patch = yield* output(["git", "diff", product, "HEAD", "--", ...allowed], envelope);
      yield* writeTextFile(join(evidence, "instrumentation.patch"), patch + "\n");
      const instrumented: Record<string, string> = {};
      for (const path of allowed) {
        const bytes = yield* until(readFile(join(envelope, path)));
        yield* until(writeFile(join(checkout, path), bytes));
        instrumented[path] = hash(bytes);
        yield* until(writeFile(join(evidence, path.split("/").at(-1) ?? "missing"), bytes));
      }
      const actual = (yield* output(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        checkout,
      ))
        .split("\n")
        .map((line) => line.slice(3));
      if (actual.some((path) => !allowed.includes(path))) {
        throw new Error("Unexpected instrumentation path");
      }
      for (const path of tracked.filter((path) => !allowed.includes(path))) {
        if (hash(yield* until(readFile(join(checkout, path)))) !== original[path]) {
          throw new Error("Unexpected source mismatch: " + path);
        }
      }
      yield* writeTextFile(
        join(evidence, "instrumented-hashes.json"),
        JSON.stringify(instrumented, null, 2),
      );
      manifest.dependencies = [];
      const dependencyHashes: Record<string, string> = {};
      for (const path of [
        "deno.lock",
        "package.json",
        "pnpm-lock.yaml",
        "node_modules/@rjsf/validator-ajv8/package.json",
      ]) {
        dependencyHashes[path] = hash(yield* until(readFile(join(checkout, path))));
      }
      manifest.dependencies = dependencyHashes;
      yield* ensureDir(join(root, "tmp"));
      yield* ensureDir(capture);
      manifest.phase = "prelaunch";
      manifest.launch = {
        argv: command,
        cwd: checkout,
        env: { TMPDIR: join(root, "tmp"), XMD_TEST_ARTIFACTS: capture },
        deadlineSeconds: 300,
        terminationJoinSeconds: 20,
        wrapperMs: 300000,
        bunMs: 300000,
        authoredAH: "420s",
      };
      returned = true;
      yield* save();
    } catch (error) {
      selected = 1;
      failed = true;
      reason = "setup-admission-or-launch-failure";
      manifest.failure = String(error);
      manifest.phase = "stopped-with-failure";
      yield* save();
      throw error;
    }
  });
  return selected;
}

if (import.meta.main) {
  main(function* () {
    yield* exit(yield* captureProgram(Deno.args[0]));
  });
}

function retainedProcess(
  argv: string[],
  cwd: string,
  evidence: string,
  channels: string,
  name: string,
  env?: Record<string, string>,
) {
  return scoped(function* () {
    const started = new Date().toISOString();
    let stdout: Deno.FsFile | undefined;
    let stderr: Deno.FsFile | undefined;
    yield* ensure(() => {
      try {
        stdout?.close();
      } catch {
        /* pipeTo closes the file. */
      }
    });
    yield* ensure(() => {
      try {
        stderr?.close();
      } catch {
        /* pipeTo closes the file. */
      }
    });
    stdout = yield* until(
      Deno.open(join(channels, name + ".stdout"), { createNew: true, write: true }),
    );
    stderr = yield* until(
      Deno.open(join(channels, name + ".stderr"), { createNew: true, write: true }),
    );
    let child: Deno.ChildProcess | undefined;
    let joined = false;
    function receipt(status: Deno.CommandStatus, cancelled: boolean) {
      return {
        argv,
        cwd,
        env,
        started,
        ended: new Date().toISOString(),
        code: status.code,
        signal: status.signal,
        timeout: status.code === 124 || status.code === 137,
        cancelled,
        termination: "GNU timeout group TERM/20s KILL; owner cancellation joins group",
      };
    }
    yield* ensure(function* () {
      if (child && !joined) {
        const pid = child.pid;
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* The group may have already exited. */
        }
        const end = Date.now() + 20000;
        while (Date.now() < end) {
          let alive = true;
          try {
            process.kill(-pid, 0);
          } catch {
            alive = false;
          }
          if (!alive) {
            break;
          }
          yield* sleep(Math.min(100, end - Date.now()));
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
        const status = yield* until(child.status);
        yield* writeTextFile(
          join(evidence, name + "-status.json"),
          JSON.stringify(receipt(status, true), null, 2),
        );
      }
    });
    const running = new Deno.Command("setsid", {
      args: argv,
      cwd,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    child = running;
    const outputFile = stdout;
    const errorFile = stderr;
    const out = yield* spawn(() => until(running.stdout.pipeTo(outputFile.writable)));
    const err = yield* spawn(() => until(running.stderr.pipeTo(errorFile.writable)));
    const status = yield* until(running.status);
    yield* out;
    yield* err;
    joined = true;
    const result = receipt(status, false);
    yield* writeTextFile(join(evidence, name + "-status.json"), JSON.stringify(result, null, 2));
    return result;
  });
}
