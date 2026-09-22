import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { z } from "zod";

import { parseBunLockfile } from "./bun-lockfile.ts";
import { listWorkspacePaths } from "./workspace.ts";

const SCOPE = "@executablemd/";

const RootSchema = z.object({ workspace: z.array(z.string()) });
const IdentitySchema = z.object({ name: z.string(), private: z.boolean().optional() });
const VersionSchema = z.object({ version: z.string() });

/** One manifest of a publishable member, and the version it declares. */
export interface ManifestVersion {
  /** Root-relative, e.g. `packages/git/deno.json`. */
  path: string;
  /** `undefined` when the file is absent or declares no version. */
  version: string | undefined;
}

/** A workspace member that a tagged release publishes. */
export interface PublishableMember {
  /** Root-relative directory, e.g. `packages/git`. */
  dir: string;
  name: string;
  manifests: ManifestVersion[];
}

function* declaredVersion(url: URL): Operation<string | undefined> {
  let text: string;
  try {
    text = yield* readTextFile(url);
  } catch {
    return undefined;
  }
  const parsed = VersionSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data.version : undefined;
}

/**
 * Every `@executablemd` workspace member a tagged release publishes, walked
 * from the root `workspace` globs rather than a list, so this and
 * `bumpManifests` cannot come to disagree about who is in the release.
 *
 * Identity and exclusion both come from `package.json`: a private member omits
 * `deno.json`'s `name` and `exports` so `deno publish` finds no entry, which
 * leaves `package.json` as the only manifest every member fills in.
 */
export function* publishableMembers(repoRoot: URL): Operation<PublishableMember[]> {
  const root = RootSchema.parse(JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))));
  const found: PublishableMember[] = [];

  for (const dir of yield* listWorkspacePaths(root.workspace, repoRoot)) {
    let identity: string;
    try {
      identity = yield* readTextFile(new URL(`${dir}/package.json`, repoRoot));
    } catch {
      continue;
    }
    const parsed = IdentitySchema.safeParse(JSON.parse(identity));
    if (!parsed.success || !parsed.data.name.startsWith(SCOPE) || parsed.data.private === true) {
      continue;
    }

    const manifests: ManifestVersion[] = [];
    for (const manifest of ["deno.json", "package.json"]) {
      manifests.push({
        path: `${dir}/${manifest}`,
        version: yield* declaredVersion(new URL(`${dir}/${manifest}`, repoRoot)),
      });
    }
    found.push({ dir, name: parsed.data.name, manifests });
  }

  return found;
}

/**
 * Everything that breaks version lockstep in the workspace at `repoRoot`, as
 * messages naming the manifest at fault. An empty list is the whole claim: the
 * release publishes one version, and every manifest and the lockfile declare
 * it.
 *
 * Both tag-time gates make this assertion after the tag has been pushed, which
 * is after the binaries have published. Reading it here moves the answer to
 * the moment the drift is introduced.
 */
export function* versionLockstepFindings(repoRoot: URL): Operation<string[]> {
  const members = yield* publishableMembers(repoRoot);
  const findings: string[] = [];
  const declared = new Map<string, string[]>();

  for (const member of members) {
    for (const manifest of member.manifests) {
      if (manifest.version === undefined) {
        findings.push(`${manifest.path} declares no version`);
        continue;
      }
      declared.set(manifest.version, [...(declared.get(manifest.version) ?? []), manifest.path]);
    }
  }

  if (declared.size > 1) {
    // Insertion order, which is the workspace walk's own sorted order, so the
    // message reads the same way twice.
    const groups = [...declared].map(([version, paths]) => `${version} (${paths.join(", ")})`);
    findings.push(`the workspace declares more than one version: ${groups.join("; ")}`);
  }

  const locked = parseBunLockfile(yield* readTextFile(new URL("bun.lock", repoRoot)));
  // The lockfile is compared against the version only once the manifests agree
  // on one. Against a workspace that does not, every entry would be reported
  // for a mismatch the finding above already names.
  const [expected] = declared.size === 1 ? [...declared.keys()] : [undefined];

  for (const member of members) {
    const entry = locked[member.dir];
    if (entry === undefined) {
      findings.push(`bun.lock has no workspace entry for ${member.dir}`);
      continue;
    }
    if (expected !== undefined && entry.version !== expected) {
      findings.push(
        `bun.lock records ${member.dir} at ${entry.version ?? "no version"}, not ${expected}`,
      );
    }
  }

  return findings;
}
