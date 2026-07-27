/**
 * Runs the repository's own oxlint configuration over a file, so rule tests
 * cover both the rule in `scripts/oxlint-rules/` and the config wiring that
 * enables it.
 */
import { each, spawn } from "effection";
import type { Operation } from "effection";
import { exec, Stdio } from "@effectionx/process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface Diagnostic {
  code: string;
  labels: { span: { line: number } }[];
}

export function* oxlint(args: string[]): Operation<string> {
  // The report is an assertion subject, not test output.
  yield* Stdio.around({
    *stdout() {},
    *stderr() {},
  });

  const proc = yield* exec("npx", {
    arguments: ["--yes", "oxlint", "-c", ".oxlintrc.json", ...args],
    cwd: ROOT,
  });

  const chunks: string[] = [];
  const reading = yield* spawn(function* () {
    for (const chunk of yield* each(proc.stdout)) {
      chunks.push(new TextDecoder().decode(chunk));
      yield* each.next();
    }
  });
  const drainStderr = yield* spawn(function* () {
    for (const _ of yield* each(proc.stderr)) {
      yield* each.next();
    }
  });

  yield* proc.join();
  yield* reading;
  yield* drainStderr;

  return chunks.join("");
}

/** Lines carrying a violation of `rule`, in source order. */
export function* violations(file: string, rule: string): Operation<number[]> {
  const output = yield* oxlint(["--format=json", file]);
  const report: { diagnostics: Diagnostic[] } = JSON.parse(output);

  return report.diagnostics
    .filter((diagnostic) => diagnostic.code === `local(${rule})`)
    .map((diagnostic) => diagnostic.labels[0].span.line);
}
