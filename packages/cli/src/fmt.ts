import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { until, type Operation, type Result } from "effection";
import { formatSource } from "@executablemd/core";
import { glob, lstat, writeTextFile } from "@executablemd/runtime";
import { STANDARD_INPUT_PATH, type StandardInputReader } from "./standard-input.ts";

const USAGE = "Usage: xmd fmt <path> | xmd fmt --check | xmd fmt -";
const HELP =
  [
    USAGE,
    "",
    "  <file>     Format one UTF-8 file in place, regardless of its extension.",
    "  <dir>      Format regular .md files recursively. Skip .git and node_modules",
    "             directories and symbolic links. Does not apply Git ignore rules.",
    "  --check    List paths relative to the current directory, one per line,",
    "             without writing. Uses the same selection as xmd fmt .",
    "  -          Read UTF-8 from stdin and write only formatted source to stdout.",
    "  -h, --help Show this usage.",
    "",
    "Writes are silent. Directory runs visit every selected file and report",
    "each error on stderr. Check mode also lists differences when a file fails.",
    "Exit 0 for success, 1 for check differences, or 2 for errors.",
  ].join("\n") + "\n";
const UTF8 = { fatal: true, ignoreBOM: true };

export function* runFmt(
  args: string[],
  readInput: StandardInputReader,
  stdout: (text: string) => Operation<Result<void>>,
  stderr: (text: string) => void,
): Operation<number> {
  let label = "";
  try {
    const [arg] = args;
    if (args.length === 0 || (args.length === 1 && (arg === "--help" || arg === "-h"))) {
      yield* send(stdout, HELP);
      return 0;
    }
    if (args.length !== 1 || (arg.startsWith("-") && arg !== "-" && arg !== "--check")) {
      throw new Error(`expected one path, --check, or -\n${USAGE}`);
    }
    if (arg === "-") {
      label = STANDARD_INPUT_PATH;
      const input = yield* readInput(UTF8);
      if (!input.ok) {
        throw input.error;
      }
      yield* send(stdout, formatted(input.value));
      return 0;
    }

    const check = arg === "--check";
    const path = check ? "." : arg;
    label = path;
    const info = yield* lstat(path);
    if (!info.isDirectory && !info.isFile) {
      throw new Error("expected a regular file or directory");
    }
    const paths = info.isDirectory
      ? (yield* glob({
          root: path,
          patterns: ["**/*.md"],
          exclude: ["**/.git/**", "**/node_modules/**"],
        }))
          .filter(({ isFile }) => isFile)
          .map((match) => match.path)
          .toSorted()
      : [path];
    const changed: string[] = [];
    let failed = false;
    for (const relative of paths) {
      const file = info.isDirectory ? join(path, relative) : relative;
      try {
        if (yield* formatFile(file, check)) {
          changed.push(relative);
        }
      } catch (error) {
        reportError(stderr, file, error);
        failed = true;
      }
    }
    if (changed.length > 0) {
      label = "";
      yield* send(stdout, changed.join("\n") + "\n");
    }
    return failed ? 2 : changed.length > 0 ? 1 : 0;
  } catch (error) {
    reportError(stderr, label, error);
    return 2;
  }
}

function reportError(stderr: (text: string) => void, label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  stderr(`xmd fmt: ${label === "" ? "" : label + ": "}${message}`);
}

function* formatFile(file: string, check: boolean): Operation<boolean> {
  const bytes = yield* until(readFile(file));
  let source: string;
  try {
    source = new TextDecoder("utf-8", UTF8).decode(bytes);
  } catch {
    throw new Error("expected UTF-8 text");
  }
  const result = formatted(source);
  if (result === source) {
    return false;
  }
  if (!check) {
    yield* writeTextFile(file, result);
  }
  return check;
}

function formatted(source: string): string {
  const result = formatSource(source);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function* send(stdout: (text: string) => Operation<Result<void>>, text: string): Operation<void> {
  const written = yield* stdout(text);
  if (!written.ok) {
    throw written.error;
  }
}
