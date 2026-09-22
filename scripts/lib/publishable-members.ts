import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { z } from "zod";

import { listWorkspacePaths } from "./workspace.ts";

export const SCOPE = "@executablemd/";

const RootSchema = z.object({ workspace: z.array(z.string()) });
const IdentitySchema = z.object({ name: z.string() });
const PublicationSchema = z.object({ private: z.boolean().optional() });

/** A workspace member a tagged release publishes. */
export interface PublishableMember {
  /** Root-relative directory, e.g. `packages/git`. */
  dir: string;
  /** The name it publishes under, from `deno.json`. */
  name: string;
}

/**
 * The name a member publishes under, or `undefined` when it publishes nothing.
 *
 * Identity is `deno.json`'s `name` and the exclusion is `package.json`'s
 * `private`, which is the pair `scripts/gen-publish-workflow.md` selects the
 * publish jobs on and `bumpManifests` stamps on. Nothing requires the two
 * manifests to agree about a member's name, so a gate that read
 * `package.json`'s would admit a different set than the one that actually
 * publishes — and a set the binary gate and the package gate disagree about is
 * how a tag comes to publish one half of a release.
 *
 * A member missing either manifest publishes nothing: no `deno.json` is no JSR
 * entry, and no `package.json` is no npm package.
 */
export function publishedName(denoJson: unknown, packageJson: unknown): string | undefined {
  const identity = IdentitySchema.safeParse(denoJson);
  if (!identity.success || !identity.data.name.startsWith(SCOPE)) {
    return undefined;
  }
  const publication = PublicationSchema.safeParse(packageJson);
  if (publication.success && publication.data.private === true) {
    return undefined;
  }
  return identity.data.name;
}

/**
 * Every member a tagged release publishes, walked from the root `workspace`
 * globs rather than a list, so a new package joins by existing.
 */
export function* publishableMembers(repoRoot: URL): Operation<PublishableMember[]> {
  const root = RootSchema.parse(JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))));
  const found: PublishableMember[] = [];

  for (const dir of yield* listWorkspacePaths(root.workspace, repoRoot)) {
    let denoJson: unknown;
    let packageJson: unknown;
    try {
      denoJson = JSON.parse(yield* readTextFile(new URL(`${dir}/deno.json`, repoRoot)));
      packageJson = JSON.parse(yield* readTextFile(new URL(`${dir}/package.json`, repoRoot)));
    } catch {
      continue;
    }

    const name = publishedName(denoJson, packageJson);
    if (name !== undefined) {
      found.push({ dir, name });
    }
  }

  return found;
}
