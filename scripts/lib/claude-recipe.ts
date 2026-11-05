import { z } from "zod";
import { sha256 } from "./claude-snapshot-module.ts";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const input = z.object({ url: z.url(), sha256: hash, bytes: z.number().int().positive() });
export const ClaudeRecipe = z.object({
  format: z.literal(1),
  inputsSha256: hash,
  metadata: z.record(z.string(), z.json()),
  source: input,
  upstreamCommit: z.string(),
  upstreamTree: z.string(),
  reviewedProducer: z.string(),
  sdk: input.extend({ integrity: z.string() }),
  sourceLockSha256: hash,
  compiler: z.object({ version: z.literal("6.0.3"), resolved: z.url(), integrity: z.string() }),
  patchSha256: hash,
  transformSha256: hash,
  preimages: z.record(z.string(), hash.nullable()),
  postimages: z.record(z.string(), hash),
  runtime: z.record(z.string(), hash),
  sdkModuleSha256: hash,
  sdkDeclarationsSha256: hash,
  noticeSha256: hash,
  files: z.array(z.string()),
  expected: z.object({ sha256: hash, byteLength: z.number().int().positive(), moduleSha256: hash }),
});
export type ClaudeRecipe = z.infer<typeof ClaudeRecipe>;

export function recipeInputsSha256(recipe: ClaudeRecipe): string {
  const { expected: _expected, inputsSha256: _hash, ...inputs } = recipe;
  return sha256(JSON.stringify(inputs));
}
