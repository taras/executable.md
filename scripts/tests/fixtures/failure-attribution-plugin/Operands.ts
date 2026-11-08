import { retain } from "@executablemd/core";
import { ensure } from "effection";
import { writeTextFile } from "@effectionx/fs";
import process from "node:process";

export default function* Operands() {
  return yield* retain(function* () {
    const counts = { actual: 0, expected: 0, references: 0 };
    const reference = { retained: true };
    yield* ensure(function* () {
      const path = process.env.XMD_COUNTER_PATH;
      if (path) {
        yield* writeTextFile(path, JSON.stringify(counts));
      }
    });
    return {
      actual() { counts.actual++; return 2; },
      expected() { counts.expected++; return 1; },
      reference() { counts.references++; return reference; },
    };
  });
}
