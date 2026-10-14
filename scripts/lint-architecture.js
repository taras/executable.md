import { readTextFile } from "@effectionx/fs";
import { exit, main } from "effection";
import { bannedProseWords } from "./lib/banned-words.js";

main(function* () {
  const file = process.argv[2] ?? new URL("../architecture.md", import.meta.url);
  const source = yield* readTextFile(file);
  const findings = bannedProseWords(source);
  for (const { word, offset } of findings) {
    const before = source.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    console.error(
      `${file}:${line}:${column}: forbidden prose word "${word}" (scripts/banned-words.js)`,
    );
  }
  if (findings.length > 0) {
    yield* exit(1);
  }
});
