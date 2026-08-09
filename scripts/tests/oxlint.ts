/**
 * Runs the repository's own oxlint configuration over a file, so rule tests
 * cover both the rule in `scripts/oxlint-rules/` and the config wiring that
 * enables it.
 */
import { scoped } from "effection";
import type { Operation } from "effection";
import { exec } from "@effectionx/process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FIXTURES = path.join(ROOT, "scripts", "tests", "fixtures");

interface Diagnostic {
  code: string;
  labels: { span: { line: number } }[];
}

export interface OxlintRun {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

/** One oxlint invocation against `config`, with its report captured rather than printed. */
export function* runOxlint(config: string, args: string[]): Operation<OxlintRun> {
  return yield* scoped(function* () {
    const proc = yield* exec("npx", {
      arguments: ["--yes", "oxlint", "-c", config, ...args],
      cwd: ROOT,
    });

    // A streaming decoder holds the bytes of a split multi-byte character until
    // the next chunk, so the two pipes cannot share one.
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();
    const out: string[] = [];
    const err: string[] = [];
    yield* proc.around({
      *stdout([bytes]) {
        out.push(outDecoder.decode(bytes, { stream: true }));
      },
      *stderr([bytes]) {
        err.push(errDecoder.decode(bytes, { stream: true }));
      },
    });

    const status = yield* proc.join();
    out.push(outDecoder.decode());
    err.push(errDecoder.decode());

    return { code: status.code, stdout: out.join(""), stderr: err.join("") };
  });
}

export function* oxlint(args: string[]): Operation<string> {
  const run = yield* runOxlint(".oxlintrc.json", args);
  return run.stdout;
}

/** Lines carrying a violation of `rule`, in source order. */
export function* violations(file: string, rule: string): Operation<number[]> {
  const output = yield* oxlint(["--format=json", file]);
  const report: { diagnostics: Diagnostic[] } = JSON.parse(output);

  return report.diagnostics
    .filter((diagnostic) => diagnostic.code === `local(${rule})`)
    .map((diagnostic) => diagnostic.labels[0].span.line);
}

/**
 * The fixture as oxlint rewrites it, run to a fixed point in a temp copy.
 * `as` names that copy, because the repository config enables some rules only
 * for files whose name marks them as tests.
 */
export function* fixed(fixture: string, as: string): Operation<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxlint-fix-"));
  const copy = path.join(dir, as);

  try {
    fs.copyFileSync(path.join(FIXTURES, fixture), copy);

    let previous = "";
    let current = fs.readFileSync(copy, "utf8");

    while (current !== previous) {
      yield* oxlint(["--fix", copy]);
      previous = current;
      current = fs.readFileSync(copy, "utf8");
    }

    return current;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
