/**
 * What the proof establishes, as it establishes it.
 *
 * A check records claims — each a named boolean with the observation behind
 * it — rather than throwing on the first miss, so one run reports everything
 * it saw. The summary is written for the report; the JSON is the evidence.
 */

import { writeTextFile } from "@effectionx/fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { until } from "effection";
import type { Operation } from "effection";

export interface Claim {
  claim: string;
  ok: boolean;
  observed?: unknown;
}

export interface CheckRecord {
  name: string;
  ok: boolean;
  claims: Claim[];
  facts: Record<string, unknown>;
  notes: string[];
  error?: string;
  durationMs: number;
}

export class Check {
  readonly claims: Claim[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly notes: string[] = [];
  constructor(readonly name: string) {}

  expect(claim: string, ok: boolean, observed?: unknown): boolean {
    this.claims.push(observed === undefined ? { claim, ok } : { claim, ok, observed });
    return ok;
  }

  fact(name: string, value: unknown): void {
    this.facts[name] = value;
  }

  note(text: string): void {
    this.notes.push(text);
  }
}

export interface Logger {
  (line: string): Operation<void>;
}

/** Progress goes to stderr and to a file the outer wrapper tails. */
export function logger(directory: string): Logger {
  const path = join(directory, "progress.log");
  return function* (line) {
    const stamped = `${new Date().toISOString().slice(11, 23)} ${line}\n`;
    process.stderr.write(stamped);
    yield* until(appendFile(path, stamped));
  };
}

export class Evidence {
  readonly checks: CheckRecord[] = [];
  readonly environment: Record<string, unknown> = {};

  *run(name: string, body: (check: Check) => Operation<void>, log: Logger): Operation<CheckRecord> {
    const check = new Check(name);
    const started = Date.now();
    let error: string | undefined;
    yield* log(`▶ ${name}`);
    try {
      yield* body(check);
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    }
    const record: CheckRecord = {
      name,
      ok: error === undefined && check.claims.every((claim) => claim.ok),
      claims: check.claims,
      facts: check.facts,
      notes: check.notes,
      durationMs: Date.now() - started,
    };
    if (error !== undefined) {
      record.error = error;
    }
    this.checks.push(record);
    const failed = check.claims.filter((claim) => !claim.ok);
    yield* log(
      `${record.ok ? "✔" : "✘"} ${name} (${record.durationMs} ms)` +
        (error ? ` — ${error}` : "") +
        (failed.length > 0 ? ` — ${failed.map((claim) => claim.claim).join("; ")}` : ""),
    );
    return record;
  }

  *write(directory: string): Operation<void> {
    yield* writeTextFile(
      join(directory, "evidence.json"),
      JSON.stringify({ environment: this.environment, checks: this.checks }, null, 2) + "\n",
    );
    yield* writeTextFile(join(directory, "summary.md"), this.summary());
  }

  summary(): string {
    const lines: string[] = ["| check | result | claims | notes |", "|---|---|---|---|"];
    for (const check of this.checks) {
      const failed = check.claims.filter((claim) => !claim.ok).map((claim) => claim.claim);
      lines.push(
        `| ${check.name} | ${check.ok ? "PASS" : "FAIL"} | ${check.claims.length - failed.length}/${check.claims.length}` +
          ` | ${[...(check.error ? [check.error] : []), ...failed, ...check.notes].join("; ")} |`,
      );
    }
    return lines.join("\n") + "\n";
  }
}
