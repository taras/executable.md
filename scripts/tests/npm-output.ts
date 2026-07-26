/**
 * Shared cleanup for suites that run `scripts/build-npm.ts`. A local-sibling
 * build writes an `npm` directory per workspace member, and one left behind is
 * both a lint subject and something a later build could mistake for current.
 */
import { readdir, rm } from "@effectionx/fs";
import type { Operation } from "effection";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function* removeNpmOutput(): Operation<void> {
  for (const member of yield* readdir(path.join(ROOT, "packages"))) {
    yield* rm(path.join(ROOT, "packages", member, "npm"), { recursive: true, force: true });
  }
}
