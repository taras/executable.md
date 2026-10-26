import { expect } from "@executablemd/test-support/expect";
import { shellQuote } from "@executablemd/test-support/launch";
import { useTempDirectory } from "@executablemd/test-support/temp";
import { ensureDir, exists, readTextFile, writeTextFile } from "@effectionx/fs";
import { scoped, sleep, until } from "effection";
import type { Operation } from "effection";
import { join, parse, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { allocate, showing } from "./pty.ts";
import { reach, click, holding, ended, printedLocation } from "./repl-files-journey.ts";
import type { ReplCommand } from "./repl-files-journey.ts";

export function replMountsJourney(repl: ReplCommand): Operation<void> {
  return scoped(function* () {
    const root = yield* until(realpath(yield* useTempDirectory("xmd-mounts-pty-")));
    for (const mode of ["unchanged", "reassigned", "omitted"]) {
      const home = join(root, mode);
      const project = join(home, "project");
      const old = join(home, "old");
      const next = join(home, "new");
      const ordinary = join(home, "reference");
      const fixtures = join(home, "fixtures");
      for (const directory of [project, old, next, ordinary, fixtures]) {
        yield* ensureDir(directory);
      }
      const target = "/" + relative(parse(ordinary).root, ordinary).split(sep).join("/");
      const fixtureTarget = "/" + relative(parse(fixtures).root, fixtures).split(sep).join("/");
      for (const directory of [old, next, ordinary]) {
        yield* writeTextFile(
          join(directory, "read.md"),
          directory === old ? "historical" : "current",
        );
        yield* writeTextFile(join(directory, "next.md"), "frontier");
      }
      const args = (source?: string) =>
        source === undefined
          ? []
          : ["--mount", `${source}:${target}`, `--mount=${fixtures}:${fixtureTarget}`];
      const line = (flags: readonly string[]) =>
        `cd ${shellQuote(project)} && ${repl(["repl", "--deny-all", ...flags])}`;
      const first = yield* allocate(line(args(old)), home);
      yield* showing(first, "Ready for Entry 1", 180_000);
      const source = [
        `<Dir path=${JSON.stringify(target)}>`,
        '<File path="read.md" as="saved" />',
        "```bash exec",
        'printf %s "$PWD" > process-cwd.txt',
        "```",
        '<Elicit schema={{ type: "object", properties: { decision: { type: "string", enum: ["continue"] } }, required: ["decision"], additionalProperties: false }} as="answer">Saved {saved}. Continue?</Elicit>',
        '<File path="next.md" as="current" />',
        '<File path="result.md">{saved}|{current}</File>',
        "</Dir>",
      ].join("\n");
      yield* first.type(source);
      yield* sleep(500);
      yield* first.type("\r");
      yield* showing(first, "waiting for an answer", 30_000);
      expect(yield* readTextFile(join(old, "process-cwd.txt"))).toBe(old);
      yield* reach(first, "[exit]");
      yield* first.type("\r");
      expect(yield* ended(first)).toBe(0);
      const location = printedLocation((yield* first.shows()).join("\n"));
      yield* writeTextFile(join(old, "read.md"), "changed");
      const selected = mode === "unchanged" ? old : mode === "reassigned" ? next : ordinary;
      const flags = mode === "omitted" ? [] : args(selected);
      const second = yield* allocate(line([location, ...flags]), home);
      yield* showing(second, "waiting for an answer", 180_000);
      yield* reach(second, "[answer]");
      yield* second.type("\r");
      yield* showing(second, "Saved historical.", 30_000);
      yield* click(second, "( ) continue");
      yield* holding(join(selected, "result.md"), "historical|frontier");
      expect(yield* readTextFile(join(old, "read.md"))).toBe("changed");
      if (selected !== old) {
        expect(yield* exists(join(selected, "process-cwd.txt"))).toBe(false);
      }
      yield* showing(second, "Ready for Entry 2", 30_000);
      yield* reach(second, "[exit]");
      yield* second.type("\r");
      expect(yield* ended(second)).toBe(0);
      const nextLocation = printedLocation((yield* second.shows()).join("\n"));
      const third = yield* allocate(line([nextLocation, ...flags]), home);
      yield* showing(third, "Ready for Entry 2", 180_000);
      yield* third.type(
        `<Dir path=${JSON.stringify(target)}><File path="read.md" as="fresh" /><File path="fresh.md">{fresh}</File>fresh is {fresh}</Dir>`,
      );
      yield* sleep(500);
      yield* third.type("\r");
      yield* showing(third, "Ready for Entry 3", 30_000);
      yield* holding(join(selected, "fresh.md"), selected === old ? "changed" : "current");
      yield* click(third, "2. [ok]");
      yield* showing(third, selected === old ? "fresh is changed" : "fresh is current", 30_000);
      yield* reach(third, "[exit]");
      yield* third.type("\r");
      expect(yield* ended(third)).toBe(0);
    }
  });
}
