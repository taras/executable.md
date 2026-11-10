import { z } from "zod";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const input = z.object({ url: z.url(), sha256: hash, bytes: z.number().int().positive() });
const output = z.object({ sha256: hash, bytes: z.number().int().positive() });

export const TtyRecipe = z.object({
  format: z.literal(1),
  source: input.extend({ commit }),
  clay: input.extend({ commit, header: z.literal("clay.h"), headerSha256: hash }),
  npm: input.extend({ gitHead: commit, integrity: z.string().startsWith("sha512-") }),
  upstreamPatch: z.object({ path: z.string(), directory: z.string(), sha256: hash }),
  patchSha256: hash,
  noticeSha256: hash,
  preimages: z.record(z.string(), hash),
  postimages: z.record(z.string(), hash),
  compiler: z.object({
    release: z.url(),
    version: z.string(),
    archives: z.record(z.string(), input.extend({ root: z.string() })),
    arguments: z.array(z.string()),
  }),
  generator: z.object({ path: z.string(), sha256: hash }),
  expected: z.object({ wasm: output, wasmSource: output, runtime: z.record(z.string(), hash) }),
});
export type TtyRecipe = z.infer<typeof TtyRecipe>;
