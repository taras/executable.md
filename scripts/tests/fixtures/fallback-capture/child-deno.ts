import { main, ensure, exit, suspend, sleep, until } from "effection";
import { ensureDir, writeTextFile, exists } from "@effectionx/fs";
import { join } from "node:path";

main(function* () {
  const root = join(Deno.env.get("RUNNER_TEMP") ?? "/missing", "fallback-capture");
  const variant = Deno.args[0];
  yield* ensure(function* () {
    if (variant === "hold") {
      yield* writeTextFile(join(root, "cleanup-started"), "ready");
      while (!(yield* exists(join(root, "cleanup-release")))) { yield* sleep(5); }
    }
    yield* writeTextFile(join(root, "child-cleaned"), "joined");
  });
  yield* until(Deno.stdout.write(new TextEncoder().encode("synthetic-out\n")));
  yield* until(Deno.stderr.write(new TextEncoder().encode("synthetic-err\n")));
  if (variant === "fault") {
    yield* ensureDir(join(root, "evidence/journals/fault"));
    yield* writeTextFile(join(root, "evidence/journals/fault/capture-error.json"), "{}");
  }
  if (variant === "hold") {
    yield* writeTextFile(join(root, "child-ready"), "ready");
    yield* suspend();
  }
  if (variant === "seven") { yield* exit(7); }
});
