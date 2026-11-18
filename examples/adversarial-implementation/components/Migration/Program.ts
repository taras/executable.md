import { realpath } from "@executablemd/runtime";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { describe, read } from "../Ticket/text-storage.ts";

const text = z.string().regex(/\S/).max(4_000);
const count = z.number().int().min(0).max(1_000_000_000);
const absolute = z.string().startsWith("/");
const request = z.strictObject({
  path: absolute,
  repository: absolute,
  repositoryId: text,
  directory: absolute,
});
const program = z.strictObject({
  schema: z.literal("migration-program.v1"),
  parent: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#[1-9][0-9]*$/),
  unit: text,
  estimatedSites: count,
  plannedBatches: count.min(1),
  inventory: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/),
  uncertainty: z.strictObject({
    additionalSites: count.nullable(),
    additionalBatches: count.nullable(),
    reason: text,
  }),
  assumptions: text,
});

const sites = 20;
const batches = 3;

export const props = z.toJSONSchema(request, { target: "draft-7" });
export const returns = { type: "object" };

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}

export default function* Program(value: unknown) {
  const input = request.parse(value);
  const path = yield* realpath(input.path);
  const repository = yield* realpath(input.repository);
  const directory = yield* realpath(dirname(input.directory));
  if (
    path === undefined ||
    repository === undefined ||
    directory === undefined ||
    inside(repository, path) ||
    inside(resolve(directory, basename(input.directory)), path)
  ) {
    throw new Error(
      "Keep the shared parent migration program outside the checkout and batch directory.",
    );
  }

  const content = yield* read(input.repository, path, 64_000);
  const recorded = program.parse(JSON.parse(content));
  if (recorded.parent.split("#")[0]?.toLowerCase() !== input.repositoryId.toLowerCase()) {
    throw new Error("The parent migration issue must belong to the delivery repository.");
  }

  const inventoryPath = resolve(dirname(path), recorded.inventory);
  if (inventoryPath === path || (yield* realpath(inventoryPath)) !== inventoryPath) {
    throw new Error(
      "Supply the parent migration inventory as a separate regular document beside the program.",
    );
  }
  const inventory = yield* read(input.repository, inventoryPath, 64_000);
  if (inventory.trim().length === 0) {
    throw new Error("Record the query or inventory supporting the parent migration estimate.");
  }

  const inputs = [
    { path, content },
    { path: inventoryPath, content: inventory },
  ];
  const fingerprint = describe(
    path,
    JSON.stringify(inputs.map((entry) => describe(entry.path, entry.content).sha256)),
  ).sha256;
  const { additionalSites, additionalBatches } = recorded.uncertainty;
  const required =
    additionalSites === null ||
    additionalBatches === null ||
    recorded.estimatedSites + additionalSites >= sites ||
    recorded.plannedBatches + additionalBatches >= batches;
  return {
    required,
    parent: recorded.parent,
    fingerprint,
    inputs,
    attempt: path + ".design-" + fingerprint,
    session: "migration-design",
    question:
      "How can this parent migration deliver reliable results with fewer repeated implementation and review rounds?",
    constraints: [
      "Use the shared parent program and inventory. Account for completed and planned work and the stated uncertainty.",
      "Group comparable units into mechanical edits, known patterns a cheaper model can handle in batches, and cases that need individual judgment.",
      "Compare a codemod or shared helper, a cheaper model such as Codex Terra for routine work, a narrower rollout, and where higher judgment is needed.",
      "Consider a hybrid XMD program with deterministic inventory and preview, model classification against approved recipes, and TypeScript edits guarded by AST preconditions and focused validation.",
      "Recommend a small representative dry run before bulk rollout. Fill in dryRun.procedure, dryRun.pass and dryRun.fail with a measurable check and distinct outcomes.",
      "Treat costs without measured token data as estimates. Identify the assumptions that would invalidate the recommendation.",
    ],
  };
}
