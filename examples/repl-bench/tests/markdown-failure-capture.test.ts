import { ensureDir, exists, readdir, readTextFile, writeTextFile } from "@effectionx/fs";
import { timebox } from "@effectionx/timebox";
import { all, ensure, main, run, scoped, spawn, until } from "effection";
import type { Operation } from "effection";
import assert from "node:assert/strict";
import { appendFile, chmod, symlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { platformDataRoot } from "../../../packages/cli/src/repl-assembly.ts";
import { usePosixSidekickTransport } from "../../../packages/cli/src/sidekick-acp/posix.ts";
import { SidekickTransport } from "../../../packages/cli/src/sidekick-acp/protocol.ts";
import { useTempDirectory } from "../../../scripts/lib/temp-directory.ts";
import { command, launch, privateDataEnvironment } from "../lib/protocol.ts";
import { denoCommand } from "../lib/run.ts";

const source = "capture.test.md";
const scenario = "synthetic.md";
const caseName = "same named case";
const reason = "late assertion after successful child exit";
const plugin = fileURLToPath(new URL("../plugin.ts", import.meta.url));
const self = fileURLToPath(import.meta.url);
const receipt = z.object({ home: z.string(), directory: z.string() });
const sidecar = z.object({
  name: z.string(),
  location: z.string(),
  scenario: z.string(),
  launchId: z.string(),
  outcome: z.enum(["failed", "cancelled"]),
  files: z.array(z.string()),
});

function records(home: string): [string, string, string] {
  const data = platformDataRoot(
    Deno.build.os === "darwin" ? "darwin" : "linux",
    home,
    privateDataEnvironment(home),
    sep,
  );
  const execution = join(data, "xmd", "repl", "v1", "execution-fixture");
  return [
    join(execution, "sidekick.jsonl"),
    join(execution, "entries.jsonl"),
    join(home, ".xmd-scripted-sidekick", "sessions", "session%3Afixture.json"),
  ];
}

function* double(options: z.infer<typeof launch>) {
  const { home, directory, attachment, cwd } = options;
  assert.ok(attachment);
  const witness = Deno.env.get("CAPTURE_WITNESS");
  const marker = Deno.env.get("CAPTURE_MARKER");
  assert.ok(witness && marker);
  assert.equal(Deno.env.get("XMD_CAPTURE_DOUBLED"), "1");
  yield* writeTextFile(join(witness, basename(directory)), JSON.stringify({ home, directory }));
  const [sidekick, entries, session] = records(home);
  for (const path of [sidekick, entries, session]) {
    yield* ensureDir(dirname(path));
    yield* writeTextFile(path, JSON.stringify({ marker, path: basename(path) }) + "\n");
  }
  yield* writeTextFile(join(home, "unrelated.json"), "private sentinel");
  yield* writeTextFile(join(dirname(entries), "extra.jsonl"), "execution sentinel");
  yield* writeTextFile(join(dirname(session), "not-finalized.json.tmp"), "temporary sentinel");
  yield* until(symlink(join(home, "unrelated.json"), join(dirname(session), "linked.json")));

  yield* ensure(function* () {
    yield* until(appendFile(sidekick, JSON.stringify({ marker, phase: "teardown" }) + "\n{"));
    yield* until(appendFile(entries, JSON.stringify({ marker, phase: "teardown" }) + "\n"));
    yield* writeTextFile(
      session,
      JSON.stringify({ marker, phase: "teardown", id: "session:fixture" }),
    );
    yield* writeTextFile(
      join(directory, "closed.json"),
      JSON.stringify({ joined: true, providerQuiescent: true }),
    );
  });

  yield* usePosixSidekickTransport(Deno.build.os === "darwin" ? "darwin" : "linux");
  const transport = yield* SidekickTransport.expect();
  const listening = yield* transport.publish(attachment, {
    owner: marker,
    execution: "execution-fixture",
    conversation: "sidekick",
    cwd,
  });
  yield* spawn(function* () {
    for (const attach of [false, true]) {
      const connect = yield* listening.accept();
      yield* scoped(function* () {
        const wire = yield* connect;
        yield* wire.receive();
        yield* wire.send({ id: 0, kind: "value", value: null });
        if (attach) {
          yield* wire.receive();
          yield* wire.send({ id: 1, kind: "value", value: { attachment: marker } });
        }
      });
    }
  });

  const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
  yield* ensure(() => until(reader.cancel()));
  let pending = "";
  while (true) {
    const chunk = yield* until(reader.read());
    if (chunk.done) {
      throw new Error("Driver input ended without joined stop");
    }
    const lines = (pending + chunk.value).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const input = command.parse(JSON.parse(line));
      if (input.action === "stop") {
        return;
      }
      if (input.action === "wait") {
        const port = Number(Deno.env.get("CAPTURE_GATE"));
        yield* spawn(function* () {
          const gate = yield* until(Deno.connect({ hostname: "127.0.0.1", port }));
          yield* ensure(() => gate.close());
          if ((yield* until(gate.read(new Uint8Array(1)))) === 1) {
            console.log(JSON.stringify({ value: null }));
          }
        });
      } else {
        console.log(
          JSON.stringify({
            value: input.action === "exit" ? { exitCode: 0, location: null } : null,
          }),
        );
      }
    }
  }
}

function markdown(outcome: "pass" | "fail", gated = false) {
  return (
    [
      `<Test name="${caseName}" timeout="40s">`,
      `  <ReplBench scenario="${scenario}" expectExit={true} as="closed">`,
      ...(gated ? ['    <ReplBench.WaitForText text="release gate" />'] : []),
      "  </ReplBench>",
      "  <AssertEquals actual={closed.exitCode} expected={0} />",
      ...(outcome === "fail" ? [`  <AssertEquals actual="joined" expected="${reason}" />`] : []),
      "</Test>",
    ].join("\n") + "\n"
  );
}

function* project() {
  const directory = yield* useTempDirectory("xmd-1417-");
  const bin = join(directory, "bin");
  yield* ensureDir(bin);
  const bun = join(bin, "bun");
  const quoted = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const command = denoCommand([]).slice(0, -1);
  yield* writeTextFile(
    bun,
    `#!/bin/sh\nexport XMD_CAPTURE_DOUBLED=1\nexec ${[...command, self].map(quoted).join(" ")} "$3"\n`,
  );
  yield* until(chmod(bun, 0o755));
  yield* writeTextFile(
    join(directory, "xmd.json"),
    JSON.stringify({ test: { plugins: [plugin] } }),
  );
  yield* writeTextFile(join(directory, scenario), "");
  return { directory, bin };
}

function* invocation(
  project: { directory: string; bin: string },
  artifacts: string,
  marker: string,
  port?: number,
) {
  const witness = join(project.directory, marker);
  yield* ensureDir(witness);
  const [deno, ...args] = denoCommand(["test", source, "--reporter=failures"]);
  assert.ok(deno);
  let child: Deno.ChildProcess | undefined;
  let exited = false;
  yield* ensure(function* () {
    if (child !== undefined && !exited) {
      child.kill("SIGTERM");
      yield* until(child.status);
    }
  });
  child = new Deno.Command(deno, {
    cwd: project.directory,
    args,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      PATH: project.bin + ":" + Deno.env.get("PATH"),
      XMD_TEST_ARTIFACTS: artifacts,
      CAPTURE_WITNESS: witness,
      CAPTURE_MARKER: marker,
      ...(port === undefined ? {} : { CAPTURE_GATE: String(port) }),
    },
  }).spawn();
  const { pid } = child;
  const output = child.output().then((status) => {
    exited = true;
    return status;
  });
  return {
    pid,
    *join() {
      const result = yield* until(output);
      const decoder = new TextDecoder();
      return { code: result.code, stderr: decoder.decode(result.stderr) };
    },
    *launches() {
      const launched = [];
      for (const name of yield* readdir(witness)) {
        const seen = receipt.parse(JSON.parse(yield* readTextFile(join(witness, name))));
        assert.equal(yield* exists(seen.home), false, seen.home);
        launched.push(seen);
      }
      return launched;
    },
  };
}

function* saved(artifacts: string) {
  const captures = [];
  for (const invocation of yield* readdir(artifacts)) {
    const base = join(artifacts, invocation);
    const names = (yield* readdir(base)).filter((name) => name.startsWith("child-")).sort();
    const [child, metadata] = names;
    assert.ok(child);
    assert.deepEqual(names, [child, `${child}.case.json`]);
    const info = sidecar.parse(JSON.parse(yield* readTextFile(join(base, metadata))));
    captures.push({ info, directory: join(base, child) });
  }
  return captures;
}

function* inspect(
  captured: { info: z.infer<typeof sidecar>; directory: string },
  launches: z.infer<typeof receipt>[],
  marker: string,
  outcome: "failed" | "cancelled",
  line: number,
) {
  const { info, directory } = captured;
  const launch = launches.find(({ directory }) => basename(directory) === info.launchId);
  assert.ok(launch);
  const paths = records("").map((path) => path.replace(/^\//u, ""));
  assert.deepEqual(info, {
    name: caseName,
    location: `${source}:${line}:1`,
    scenario,
    launchId: basename(launch.directory),
    outcome,
    files: paths,
  });
  const persisted = yield* readdir(directory);
  assert.deepEqual(persisted.sort(), [...new Set(paths.map((path) => path.split(sep)[0]))].sort());
  for (const path of paths) {
    const leaf = basename(path);
    const original = JSON.stringify({ marker, path: leaf }) + "\n";
    const teardown = JSON.stringify({ marker, phase: "teardown" });
    const expected = leaf.endsWith(".json")
      ? JSON.stringify({ marker, phase: "teardown", id: "session:fixture" })
      : original + teardown + "\n" + (leaf === "sidekick.jsonl" ? "{" : "");
    assert.equal(yield* readTextFile(join(directory, path)), expected);
  }
  assert.deepEqual((yield* readdir(dirname(join(directory, paths[0])))).sort(), [
    "entries.jsonl",
    "sidekick.jsonl",
  ]);
  assert.deepEqual(yield* readdir(dirname(join(directory, paths[2]))), ["session%3Afixture.json"]);
}

function* bounded(test: () => Operation<void>) {
  const result = yield* timebox(60_000, test);
  assert.equal(result.timeout, false, "Markdown diagnostic fixture timed out");
}

if (import.meta.main) {
  main(([options]) => double(launch.parse(JSON.parse(options))));
} else {
  Deno.test("only the failed Markdown twin retains the records from joined teardown", () =>
    run(() =>
      bounded(function* () {
        const fixture = yield* project();
        const document = join(fixture.directory, source);
        const artifacts = join(fixture.directory, "artifacts");
        const pass = markdown("pass");
        yield* writeTextFile(document, pass + "\n" + markdown("fail"));
        const twin = yield* invocation(fixture, artifacts, "twins");
        const failed = yield* twin.join();
        assert.equal(failed.code, 1, failed.stderr);
        assert.match(failed.stderr, new RegExp(reason));
        assert.match(failed.stderr, /1 passed \| 1 failed/u);
        const launches = yield* twin.launches();
        assert.equal(launches.length, 2);
        const captures = yield* saved(artifacts);
        assert.equal(captures.length, 1);
        yield* inspect(captures[0], launches, "twins", "failed", pass.split("\n").length + 1);

        yield* writeTextFile(document, pass);
        const clean = join(fixture.directory, "clean");
        const lone = yield* invocation(fixture, clean, "passing");
        const passed = yield* lone.join();
        assert.equal(passed.code, 0, passed.stderr);
        assert.match(passed.stderr, /1 passed \| 0 failed/u);
        assert.equal((yield* lone.launches()).length, 1);
        assert.equal(yield* exists(clean), false);
      }),
    ));

  Deno.test("overlapping Markdown commands retain only their own failed or cancelled launch", () =>
    run(() =>
      bounded(function* () {
        const fixture = yield* project();
        const artifacts = join(fixture.directory, "shared");
        const pass = markdown("pass");
        yield* writeTextFile(join(fixture.directory, source), pass + "\n" + markdown("fail", true));

        const failureGate = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        yield* ensure(() => failureGate.close());
        const cancelGate = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        yield* ensure(() => cancelGate.close());
        const failed = yield* invocation(fixture, artifacts, "failure", failureGate.addr.port);
        const cancelled = yield* invocation(
          fixture,
          artifacts,
          "cancellation",
          cancelGate.addr.port,
        );
        const release = yield* until(failureGate.accept());
        yield* ensure(() => release.close());
        const held = yield* until(cancelGate.accept());
        yield* ensure(() => held.close());
        Deno.kill(cancelled.pid, "SIGTERM");
        yield* until(release.write(Uint8Array.of(1)));
        const [failure, cancellation] = yield* all([failed.join(), cancelled.join()]);
        assert.equal(failure.code, 1, failure.stderr);
        assert.match(failure.stderr, new RegExp(reason));
        assert.match(failure.stderr, /1 passed \| 1 failed/u);
        assert.equal(cancellation.code, 143, cancellation.stderr);
        assert.match(cancellation.stderr, /cancelled test "same named case"/u);
        assert.doesNotMatch(cancellation.stderr, /fail test "same named case"/u);

        const captures = yield* saved(artifacts);
        assert.equal(captures.length, 2);
        const [failedCapture, cancelledCapture] = captures.sort((a, b) =>
          b.info.outcome.localeCompare(a.info.outcome),
        );
        const failureLaunches = yield* failed.launches();
        const cancelledLaunches = yield* cancelled.launches();
        assert.equal(failureLaunches.length, 2);
        assert.equal(cancelledLaunches.length, 2);
        assert.equal(
          new Set([...failureLaunches, ...cancelledLaunches].map(({ home }) => home)).size,
          4,
        );
        const line = pass.split("\n").length + 1;
        yield* inspect(failedCapture, failureLaunches, "failure", "failed", line);
        yield* inspect(cancelledCapture, cancelledLaunches, "cancellation", "cancelled", line);
      }),
    ));
}
