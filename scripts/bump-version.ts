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
import { bumpManifests } from "./lib/bump-version.ts";

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

  for (const manifest of yield* bumpManifests(version, new URL("../", import.meta.url))) {
    console.log(`bumped ${manifest} -> ${version}`);
  }

  console.log(`done — commit, merge, then publish the draft release as v${version}`);
});
