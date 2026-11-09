import { z } from "zod";

const snapshot = z.object({
  provider: z.string(),
  package: z.string(),
  version: z.string(),
  sha256: z.string(),
  byteLength: z.number().int().positive(),
  files: z.array(z.string()),
  upstreamBase: z.string(),
  patchedCommit: z.string(),
  license: z.string(),
  buildCommand: z.string(),
  contract: z.string(),
  materializationContract: z.string(),
  identityContract: z.string().optional(),
});
export const AdapterManifest = z.object({
  format: z.literal(1),
  snapshots: z.array(
    z.union([
      snapshot.extend({
        tarball: z.string(),
        patch: z.string(),
        patchSha256: z.string(),
        lockSha256: z.string(),
        executableSha256: z.string(),
      }),
      snapshot.extend({ recipe: z.string(), module: z.string() }),
    ]),
  ),
});
