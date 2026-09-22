import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { z } from "zod";

import { parseBunLockfile } from "./bun-lockfile.ts";
import { publishableMembers } from "./publishable-members.ts";

const VersionSchema = z.object({ version: z.string() });

/** The two manifests a publishable member declares its version in. */
const MANIFESTS = ["deno.json", "package.json"];

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
 * Everything that breaks version lockstep in the workspace at `repoRoot`, as
 * messages naming the manifest at fault. An empty list is the whole claim: the
 * release publishes one version, and every manifest and the lockfile declare
 * it.
 *
 * Membership comes from `publishableMembers`, so this reads the same set the
 * publish workflow generates jobs for. Both tag-time gates make the same
 * assertion, but only after the tag has been pushed — which is after the
 * binaries have published. Reading it here moves the answer to the moment the
 * drift is introduced.
 */
export function* versionLockstepFindings(repoRoot: URL): Operation<string[]> {
  const members = yield* publishableMembers(repoRoot);
  const findings: string[] = [];
  const declared = new Map<string, string[]>();

  for (const member of members) {
    for (const manifest of MANIFESTS) {
      const path = `${member.dir}/${manifest}`;
      const version = yield* declaredVersion(new URL(path, repoRoot));
      if (version === undefined) {
        findings.push(`${path} declares no version`);
        continue;
      }
      declared.set(version, [...(declared.get(version) ?? []), path]);
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
