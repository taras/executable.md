import {
  ensureDir,
  exists,
  readdir,
  readTextFile,
  writeTextFile,
} from "@effectionx/fs";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { all, ensure, run, scoped, until } from "effection";
import type { Operation } from "effection";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { root } from "../lib/run.ts";
import {
  channelBytes,
  ChildRecord,
  Double,
  omittedReason,
} from "./fixtures/teardown-child.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/teardown-child.ts", import.meta.url),
);
const outerTest = "examples/repl-bench/tests/teardown.test.ts";
const journey = "examples/repl-bench/journeys/timeout-controls.md";
const cached = ["--cached-only", "--frozen", "--node-modules-dir=none"];
const decoder = new TextDecoder();

const Digest = z.object({ path: z.string(), sha256: z.string() });
const Manifest = z.object({
  id: z.string(),
  test: z.object({ name: z.string(), source: Digest }),
  journey: Digest,
  command: z.array(z.string()),
  childPid: z.number(),
  outcome: z.enum(["failed", "cancelled"]),
  error: z.object({ message: z.string() }),
  stdout: z.object({ file: z.literal("stdout.bin") }),
  stderr: z.object({ file: z.literal("stderr.bin") }),
});
const Window = z.object({
  sample: z.number(),
  startedMs: z.number(),
  endedMs: z.number(),
});
const Observations = z.object({
  sampleIntervalMs: z.literal(200),
  samples: z.array(z.object({ ordinal: z.number(), code: z.number() })),
  sightings: z.array(
    z.object({
      ppid: z.number(),
      pid: z.number(),
      firstSeen: Window,
      lastSeen: Window,
    }),
  ),
});

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs the unchanged outer test with `deno` and `ps` resolved to this invocation's doubles. */
function outer(
  scratch: string,
  artifacts: string,
  mode: z.input<typeof Double>["mode"],
): Operation<OuterRun> {
  return scoped(function* () {
    const token = randomUUID();
    // Gate sockets live beneath this directory, and socket paths are limited to about 100 bytes.
    const directory = join(scratch, token.slice(0, 8));
    const bin = join(directory, "bin");
    yield* ensureDir(bin);
    yield* ensureDir(join(directory, "gate"));
    const config = join(root, "deno.json");
    const launch = [
      "run",
      "--allow-all",
      ...cached,
      "--config",
      config,
      fixture,
    ];
    // The nested `deno test` arguments would read as misplaced permission flags.
    for (
      const [name, role] of [
        ["deno", "child"],
        ["ps", 'ps "$@"'],
      ]
    ) {
      const shim = join(bin, name);
      const command = [Deno.execPath(), ...launch].map(quote).join(" ");
      yield* writeTextFile(shim, `#!/bin/sh\nexec ${command} ${role}\n`);
      yield* until(chmod(shim, 0o755));
    }
    const path = Deno.env.get("PATH") ?? "";
    const entry = join(root, "packages/cli/src/deno.ts");
    const double = Double.parse({
      mode,
      token,
      directory,
      launch,
      entry,
      path,
    });
    let process: Deno.ChildProcess | undefined;
    let exited = false;
    yield* ensure(function* () {
      if (process !== undefined && !exited) {
        process.kill();
        yield* until(process.status);
      }
    });
    process = new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--allow-all",
        ...cached,
        "--no-check",
        ...(mode === "output-rejection" || mode === "held-sample"
          ? ["--preload", fixture]
          : []),
        outerTest,
      ],
      cwd: root,
      env: {
        PATH: `${bin}:${path}`,
        XMD_TEST_ARTIFACTS: artifacts,
        TEARDOWN_DOUBLE: JSON.stringify(double),
        TEARDOWN_COLLECTION_GATE:
          mode === "output-rejection" || mode === "held-sample" ? "1" : "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = yield* until(process.output());
    exited = true;
    const report = decoder.decode(output.stdout) +
      decoder.decode(output.stderr);
    assert.ok(yield* exists(join(directory, "record.json")), report);
    const record = ChildRecord.parse(
      JSON.parse(yield* readTextFile(join(directory, "record.json"))),
    );
    return { token, directory, record, code: output.code, report };
  });
}

interface OuterRun {
  token: string;
  directory: string;
  record: z.infer<typeof ChildRecord>;
  code: number;
  report: string;
}

function* bundles(artifacts: string) {
  if (!(yield* exists(artifacts))) {
    return [];
  }
  const names = yield* readdir(artifacts);
  return names.filter((name) => name.startsWith("teardown-")).map((name) =>
    join(artifacts, name)
  );
}

function* sha256(path: string) {
  return createHash("sha256")
    .update(yield* until(readFile(join(root, path))))
    .digest("hex");
}

/** Checks one bundle against what its own child double wrote and which worker pairs it ran. */
function* inspect(bundle: string, run: OuterRun) {
  const manifest = Manifest.parse(
    JSON.parse(yield* readTextFile(join(bundle, "manifest.json"))),
  );
  assert.equal(manifest.childPid, run.record.childPid);
  assert.equal(
    manifest.test.name,
    "failed journeys keep evidence and reap the REPL and scripted Sidekick",
  );
  assert.deepEqual(manifest.test.source, {
    path: outerTest,
    sha256: yield* sha256(outerTest),
  });
  assert.deepEqual(manifest.journey, {
    path: journey,
    sha256: yield* sha256(journey),
  });
  assert.ok(manifest.command.includes(journey));
  for (const channel of ["stdout", "stderr"]) {
    const saved = yield* until(readFile(join(bundle, `${channel}.bin`)));
    const emitted = yield* until(
      readFile(join(run.directory, `emitted-${channel}.bin`)),
    );
    assert.deepEqual(new Uint8Array(saved), new Uint8Array(emitted));
    assert.ok(
      saved.includes(0xff),
      `${channel} must keep its invalid UTF-8 bytes`,
    );
  }
  const observations = Observations.parse(
    JSON.parse(yield* readTextFile(join(bundle, "observations.json"))),
  );
  for (const { ppid, pid } of run.record.pairs) {
    const sighting = observations.sightings.find((seen) =>
      seen.ppid === ppid && seen.pid === pid
    );
    assert.ok(
      sighting,
      `No sighting of worker ${pid} under ${ppid} in ${bundle}`,
    );
    assert.ok(sighting.firstSeen.sample <= sighting.lastSeen.sample);
    assert.ok(sighting.firstSeen.startedMs <= sighting.lastSeen.endedMs);
  }
  assert.ok(run.report.includes(`Teardown failure diagnostics: ${bundle}`));
  return { manifest, observations };
}

function* assertMissingReason(run: OuterRun, bundle: string) {
  assert.notEqual(run.code, 0);
  assert.ok(
    run.report.includes(
      `AssertionError: Missing test failure: ${omittedReason}`,
    ),
  );
  assert.ok(run.record.pairs.length > 0);
  const { manifest } = yield* inspect(bundle, run);
  assert.equal(manifest.outcome, "failed");
  assert.equal(
    manifest.error.message,
    `Missing test failure: ${omittedReason}`,
  );
}

function* assertPassed(run: OuterRun) {
  assert.equal(run.code, 0, run.report);
  assert.equal(run.record.evidence.length, 4);
  for (const evidence of run.record.evidence) {
    assert.ok(
      yield* exists(join(evidence, "closed.json")),
      `${evidence} must remain`,
    );
  }
}

Deno.test("an outer teardown failure saves the child's exact channels and sampled workers", () =>
  run(function* () {
    const scratch = yield* useTempDirectory("xmd-td-");
    const artifacts = join(scratch, "artifacts");
    const failed = yield* outer(scratch, artifacts, "missing-reason");
    const saved = yield* bundles(artifacts);
    assert.equal(saved.length, 1, failed.report);
    yield* assertMissingReason(failed, saved[0] ?? "");
  }));

Deno.test("an outer teardown pass saves no bundle and keeps the child's evidence", () =>
  run(function* () {
    const scratch = yield* useTempDirectory("xmd-td-");
    const artifacts = join(scratch, "artifacts");
    yield* assertPassed(yield* outer(scratch, artifacts, "pass"));
    assert.deepEqual(yield* bundles(artifacts), []);
  }));

Deno.test("concurrent outer teardown invocations keep separate bundles", () =>
  run(function* () {
    const scratch = yield* useTempDirectory("xmd-td-");
    const artifacts = join(scratch, "artifacts");
    yield* ensureDir(artifacts);
    yield* writeTextFile(join(artifacts, "sentinel"), "kept\n");
    const [first, second, passed] = yield* all([
      outer(scratch, artifacts, "missing-reason"),
      outer(scratch, artifacts, "missing-reason"),
      outer(scratch, artifacts, "pass"),
    ]);
    yield* assertPassed(passed);
    const saved = yield* bundles(artifacts);
    assert.equal(saved.length, 2);
    for (const failed of [first, second]) {
      const owned = [];
      for (const bundle of saved) {
        const manifest = Manifest.parse(
          JSON.parse(yield* readTextFile(join(bundle, "manifest.json"))),
        );
        if (manifest.childPid === failed.record.childPid) {
          owned.push(bundle);
        }
      }
      assert.equal(owned.length, 1);
      yield* assertMissingReason(failed, owned[0] ?? "");
    }
    assert.equal(yield* readTextFile(join(artifacts, "sentinel")), "kept\n");
  }));

Deno.test("a failed ps sample and an unwritable artifact root keep the original failure", () =>
  run(function* () {
    const scratch = yield* useTempDirectory("xmd-td-");
    const artifacts = join(scratch, "artifacts");
    const refused = yield* outer(scratch, artifacts, "ps-failure");
    assert.notEqual(refused.code, 0);
    assert.ok(
      refused.report.includes(`ps double refused ${refused.token}`),
      refused.report,
    );
    const saved = yield* bundles(artifacts);
    assert.equal(saved.length, 1, refused.report);
    const { manifest, observations } = yield* inspect(saved[0] ?? "", refused);
    assert.ok(
      manifest.error.message.includes(`ps double refused ${refused.token}`),
    );
    assert.ok(observations.samples.some((sample) => sample.code === 0));
    assert.notEqual(observations.samples.at(-1)?.code, 0);
    const stdout = yield* until(readFile(join(saved[0] ?? "", "stdout.bin")));
    const tail = channelBytes(refused.token, "stdout", "tail");
    assert.deepEqual(
      new Uint8Array(stdout.subarray(stdout.length - tail.length)),
      tail,
    );
    const runs = yield* readdir(join(refused.directory, "ps"));
    for (const started of runs.filter((name) => name.endsWith(".started"))) {
      assert.ok(
        runs.includes(started.replace(/started$/, "ended")),
        `ps ${started} was not joined`,
      );
    }

    const occupied = join(scratch, "occupied");
    yield* writeTextFile(occupied, "");
    const unsaved = yield* outer(scratch, occupied, "missing-reason");
    assert.notEqual(unsaved.code, 0);
    assert.ok(
      unsaved.report.includes(
        `AssertionError: Missing test failure: ${omittedReason}`,
      ),
    );
    assert.ok(
      unsaved.report.includes(
        `Teardown failure diagnostics were not saved to ${occupied}/teardown-`,
      ),
      unsaved.report,
    );
  }));

for (const name of ["output-rejection", "held-sample"]) {
  const mode = Double.shape.mode.parse(name);
  Deno.test(`collection settlement: ${mode}`, () =>
    run(function* () {
      const scratch = yield* useTempDirectory("xmd-td-");
      const artifacts = join(scratch, "artifacts");
      const failed = yield* outer(scratch, artifacts, mode);
      assert.notEqual(failed.code, 0, failed.report);
      const saved = yield* bundles(artifacts);
      assert.equal(saved.length, 1, failed.report);
      const manifest = JSON.parse(
        yield* readTextFile(join(saved[0] ?? "", "manifest.json")),
      );
      assert.equal(
        manifest.error.message,
        `controlled output rejection ${failed.token}`,
      );
      const status = JSON.parse(
        yield* readTextFile(join(failed.directory, "status-joined")),
      );
      assert.deepEqual(manifest.exit, status);
      assert.equal(typeof manifest.exitObservedMs, "number");
      assert.ok(manifest.cleanupErrors.some((error: { message: string }) =>
        error.message === manifest.error.message
      ));
      const pair = JSON.parse(
        yield* readTextFile(join(failed.directory, "held-pair.json")),
      );
      const observations = JSON.parse(
        yield* readTextFile(join(saved[0] ?? "", "observations.json")),
      );
      const matching = observations.samples.flatMap((
        sample: { rows: { pid: number; ppid: number }[] },
      ) =>
        sample.rows
      ).filter((row: { pid: number; ppid: number }) =>
        row.pid === pair.pid && row.ppid === pair.ppid
      );
      assert.equal(matching.length, 1);
    }));
}
