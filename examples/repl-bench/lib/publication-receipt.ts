import type { Yielded } from "effection";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { readRegular, png } from "./publication-files-deno.ts";
import { compareTypingRuns, WORKLOADS } from "./typing-latency-report.ts";

const text = z.string().min(1).max(512);
const revisionPin = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const branch = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/);
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const facts = {
  fixture: text,
  viewport: z.object({
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  action: text,
};
const checkpoint = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  ...facts,
});
const receiptSchema = z.object({
  version: z.literal(1),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
    .max(160)
    .refine((name) => !/\/\.{1,2}$/.test(name)),
  baseBranch: branch,
  headBranch: branch,
  base: revisionPin,
  head: revisionPin,
  acceptance: z
    .array(
      z.object({
        name: text,
        kind: z.enum(["test", "acceptance"]),
        status: z.literal("passed"),
        revision: revisionPin,
        source: filePath,
      }),
    )
    .min(2)
    .max(50),
  checkpoints: z.array(checkpoint).min(1).max(25),
  captures: z
    .array(
      z.object({
        checkpoint: checkpoint.shape.id,
        role: z.enum(["before", "after"]),
        ...facts,
        revision: revisionPin,
        synthetic: z.literal(true),
        approved: z.literal(true),
        path: filePath,
        sha256: digest,
      }),
    )
    .min(2)
    .max(50),
  timingReport: filePath,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("numbered"), number: z.number().int().positive() }),
    z.object({
      kind: z.literal("create"),
      title: text,
      body: z.string().max(65536),
      draftRecord: filePath,
    }),
  ]),
  previewBody: filePath.optional(),
});

const workload = z.object({
  name: z.string(),
  rounds: z.number(),
  linesPerRound: z.number(),
});
const timingRun = z.looseObject({
  count: z.number(),
  medianMs: z.number().finite(),
  p95Ms: z.number().finite(),
  runtime: z.object({
    deno: text,
    v8: text,
    typescript: text,
  }),
  host: z.object({ os: text, arch: text }),
});
const reportSchema = z.object({
  measurement: z.string(),
  viewport: z.object({ columns: z.number(), rows: z.number() }),
  warmup: z.number(),
  workloads: z
    .array(
      z.object({
        workload,
        baseline: timingRun,
        candidate: timingRun,
        deltaMs: z.object({ median: z.number().finite(), p95: z.number().finite() }),
      }),
    )
    .length(WORKLOADS.length),
});

function compareReport(input: unknown, base: string, head: string) {
  const report = reportSchema.parse(input);
  const stdout = (side: "baseline" | "candidate") =>
    report.workloads.map((pair) => `XMD_TYPING_SAMPLE ${JSON.stringify(pair[side])}`).join("\n");
  const recomputed = compareTypingRuns(
    { revision: base, stdout: stdout("baseline") },
    { revision: head, stdout: stdout("candidate") },
  );
  if (
    report.measurement !== recomputed.measurement ||
    JSON.stringify(report.viewport) !== JSON.stringify(recomputed.viewport) ||
    report.warmup !== recomputed.warmup
  ) {
    throw new Error("Typing report does not describe the producer measurement and viewport.");
  }
  for (const [index, pair] of recomputed.workloads.entries()) {
    const observed = report.workloads[index];
    if (
      JSON.stringify(observed.workload) !== JSON.stringify(pair.workload) ||
      observed.deltaMs.median !== pair.deltaMs.median ||
      observed.deltaMs.p95 !== pair.deltaMs.p95 ||
      (["baseline", "candidate"] as const).some(
        (side) =>
          observed[side].count !== pair[side].count ||
          observed[side].medianMs !== pair[side].medianMs ||
          observed[side].p95Ms !== pair[side].p95Ms,
      )
    ) {
      throw new Error(`Typing report contradicts the raw samples for ${pair.workload.name}.`);
    }
  }
  return recomputed;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const BODY_LIMIT = 65536;

function readJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function* loadEvidence(receiptPath: string) {
  const receiptBytes = yield* readRegular(receiptPath, 256 * 1024);
  const receipt = receiptSchema.parse(readJson(receiptBytes));
  const directory = dirname(receiptPath);
  if (
    receipt.base === receipt.head ||
    receipt.baseBranch === receipt.headBranch ||
    receipt.acceptance.some((result) => result.revision !== receipt.head) ||
    new Set(receipt.acceptance.map((result) => result.kind)).size !== 2
  ) {
    throw new Error(
      "Supply distinct base/head pins and passing test and acceptance evidence for the exact head.",
    );
  }
  if (
    new Set(receipt.checkpoints.map(({ id }) => id)).size !== receipt.checkpoints.length ||
    receipt.captures.length !== receipt.checkpoints.length * 2
  ) {
    throw new Error(
      "Supply unique checkpoints and exactly one approved Before and After per checkpoint.",
    );
  }
  const slots = [];
  for (const check of receipt.checkpoints) {
    for (const role of ["before", "after"] as const) {
      const matches = receipt.captures.filter(
        (item) => item.checkpoint === check.id && item.role === role,
      );
      const [capture] = matches;
      const id = `${check.id}-${role}`;
      if (
        matches.length !== 1 ||
        capture.fixture !== check.fixture ||
        capture.action !== check.action ||
        capture.viewport.columns !== check.viewport.columns ||
        capture.viewport.rows !== check.viewport.rows ||
        capture.revision !== (role === "before" ? receipt.base : receipt.head)
      ) {
        throw new Error(`Screenshot provenance does not match required slot ${id}.`);
      }
      const path = resolve(directory, capture.path);
      const bytes = yield* readRegular(path, IMAGE_LIMIT);
      if (!png(bytes) || sha256(bytes) !== capture.sha256) {
        throw new Error(`Screenshot ${id} must be a PNG matching its approved SHA-256.`);
      }
      slots.push({
        id,
        role,
        checkpoint: check.id,
        sha256: capture.sha256,
        revision: capture.revision,
        filename: `repl-ui-${id}.png`,
        bytes,
        path,
      });
    }
  }

  const timingPath = resolve(directory, receipt.timingReport);
  const timingBytes = yield* readRegular(timingPath, 1024 * 1024);
  const timingDigest = sha256(timingBytes);
  const timing = compareReport(readJson(timingBytes), receipt.base, receipt.head);
  const { repository, baseBranch, headBranch, base, head } = receipt;
  const pins = { repository, baseBranch, headBranch, base, head };
  const identity = sha256(
    JSON.stringify({
      version: 1,
      ...pins,
      acceptance: receipt.acceptance.map(({ name, kind, status, revision }) => ({
        name,
        kind,
        status,
        revision,
      })),
      checkpoints: receipt.checkpoints,
      slots: slots.map((slot) => ({ id: slot.id, revision: slot.revision, sha256: slot.sha256 })),
      timingDigest,
    }),
  );
  return {
    identity,
    pins,
    slots,
    timing,
    checkpoints: receipt.checkpoints,
    directory,
    target: receipt.target,
    previewBody: receipt.previewBody,
    sources: {
      receipt: receiptPath,
      receiptSha256: sha256(receiptBytes),
      acceptance: receipt.acceptance.map(({ source }) => resolve(directory, source)),
      timing: { path: timingPath, sha256: timingDigest },
    },
  };
}

export type Evidence = Yielded<ReturnType<typeof loadEvidence>>;
