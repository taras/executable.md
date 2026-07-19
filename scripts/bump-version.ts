/**
 * Bump every @executablemd workspace manifest to a new version.
 *
 * Usage:
 *   deno task bump <version>
 *
 * Stamps the `version` field of each member's deno.json and package.json —
 * the manifests are the single version source (release spec §2). Commit,
 * merge, then publish the draft release as v<version>.
 */

import { exit, main } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { z } from "npm:zod@^4";

const SCOPE = "@executablemd/";

const RootSchema = z.object({ workspace: z.array(z.string()) });
const NamedSchema = z.object({ name: z.string() });

await main(function* (args) {
  const raw = args[0];
  if (!raw) {
    console.error("usage: deno task bump <version>");
    yield* exit(1);
    return;
  }
  const version = raw.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`"${raw}" is not a semver version`);
    yield* exit(1);
    return;
  }

  const repoRoot = new URL("../", import.meta.url);
  const root = RootSchema.parse(JSON.parse(yield* readTextFile(new URL("deno.json", repoRoot))));

  for (const dir of root.workspace) {
    let denoText: string;
    try {
      denoText = yield* readTextFile(new URL(`${dir}/deno.json`, repoRoot));
    } catch {
      continue;
    }
    const named = NamedSchema.safeParse(JSON.parse(denoText));
    if (!named.success || !named.data.name.startsWith(SCOPE)) {
      continue;
    }
    for (const manifest of ["deno.json", "package.json"]) {
      const url = new URL(`${dir}/${manifest}`, repoRoot);
      const text = yield* readTextFile(url);
      const updated = text.replace(/"version": "[^"]+"/, `"version": "${version}"`);
      if (updated === text) {
        console.error(`no version field found in ${dir}/${manifest}`);
        yield* exit(1);
        return;
      }
      yield* writeTextFile(url, updated);
      console.log(`bumped ${dir}/${manifest} -> ${version}`);
    }
  }

  // CI installs the released binary by pinned version; the pins move in
  // lockstep with the manifests so reviews run the release being cut.
  for (const workflow of [".github/workflows/review.yml", ".github/workflows/repo-analysis.yml"]) {
    const url = new URL(workflow, repoRoot);
    const text = yield* readTextFile(url);
    const updated = text.replace(/XMD_VERSION=v\S+/, `XMD_VERSION=v${version}`);
    if (updated === text) {
      console.error(`no XMD_VERSION pin found in ${workflow}`);
      yield* exit(1);
      return;
    }
    yield* writeTextFile(url, updated);
    console.log(`pinned ${workflow} -> v${version}`);
  }

  console.log(`done — commit, merge, then publish the draft release as v${version}`);
});
