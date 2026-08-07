import { main, until } from "effection";
import { exec } from "@effectionx/process";
// @ts-types="./types/computerd-shim.d.ts"
import { mountShim } from "@xmd-spike/computerd-shim";
import { createFileBackedVfs } from "./vfs-wiring.ts";

function usage(): never {
  console.error(
    [
      "usage: proof-shim <db-path> <mount-dir> exec <shell-command>",
      "       proof-shim <db-path> <mount-dir> materialize",
      "",
      "The mount directory is part of the workspace namespace: the same",
      "database must always be mounted at the same absolute path.",
    ].join("\n"),
  );
  Deno.exit(2);
}

main(function* () {
  const [dbPath, mountDir, command, ...rest] = Deno.args;
  if (dbPath === undefined || mountDir === undefined) {
    usage();
  }
  if (command !== "exec" && command !== "materialize") {
    usage();
  }

  const started = performance.now();
  const wired = createFileBackedVfs(dbPath);
  wired.vfs.mkdirSync(mountDir, { recursive: true });
  Deno.mkdirSync(mountDir, { recursive: true });

  const shim = yield* until(
    mountShim({ vfs: wired.vfs, mountPoint: mountDir }),
  );
  const mountedMs = Math.round(performance.now() - started);

  let payload: Record<string, unknown> = {};
  if (command === "exec") {
    const shellCommand = rest.join(" ");
    if (shellCommand === "") {
      usage();
    }
    yield* until(shim.flush());
    // cwd stays outside the mount: upstream computerd prefixes `cd` instead
    // of passing cwd because fork+chdir into a mount served by the same
    // process deadlocks under FUSE; the shim keeps the same shape.
    const result = yield* exec("/bin/sh", {
      arguments: ["-c", `cd ${mountDir} && (${shellCommand})`],
    }).join();
    yield* until(shim.reconcileNow());
    payload = {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  yield* until(shim.unmount());
  wired.storage.close();
  console.log(JSON.stringify({ command, mountedMs, ...payload }));
});
