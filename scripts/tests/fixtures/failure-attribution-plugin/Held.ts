import { retain } from "@executablemd/core";
import { ensure, sleep, race } from "effection";
import { exists, writeTextFile } from "@effectionx/fs";
import process from "node:process";
import { join } from "node:path";

export default function* Held() {
  const directory = process.env.XMD_GATE_PATH;
  if (!directory) {
    throw new Error("Missing owned gate directory");
  }
  return yield* retain(function* () {
    yield* ensure(function* () {
      yield* writeTextFile(join(directory, "cleanup-started"), "ready");
      yield* race([
        (function* () { while (!(yield* exists(join(directory, "release")))) { yield* sleep(5); } })(),
        (function* () { yield* sleep(5000); throw new Error("Held cleanup exceeded 5s"); })(),
      ]);
      yield* writeTextFile(join(directory, "cleaned"), "joined");
    });
    yield* writeTextFile(join(directory, "ready"), "acquired");
    return "";
  });
}
