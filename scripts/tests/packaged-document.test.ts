/**
 * Every packaged Markdown document reaches every build that ships it.
 *
 * The npm build discovers these documents, so it needs no list. `deno compile`
 * is told once per *directory* — in `deno task build` and in the release matrix
 * — so adding a document beside its module needs no build change, and what has
 * to stay true is that the directory holding it is named at both sites. A
 * package that grew a `src/documents/` nobody added produces a binary that runs
 * until the moment it looks for its own program, which is the failure this
 * refuses to let reach a release.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { readdir } from "node:fs/promises";
import { until } from "effection";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every package that ships documents, and every document in it. */
interface PackagedDocuments {
  /** The repository-relative `src/documents/` directory a compile has to name. */
  readonly directory: string;
  /** What is in it, repository-relative — for the emptiness check below. */
  readonly documents: readonly string[];
}

function* packagedDocuments(): Operation<PackagedDocuments[]> {
  const found: PackagedDocuments[] = [];
  for (const member of yield* until(readdir(path.join(ROOT, "packages")))) {
    const directory = `packages/${member}/src/documents`;
    let entries: string[];
    try {
      entries = yield* until(readdir(path.join(ROOT, directory), { recursive: true }));
    } catch {
      continue;
    }
    found.push({
      directory,
      documents: entries.map((entry) => `${directory}/${entry.split(path.sep).join("/")}`).sort(),
    });
  }
  return found.sort((left, right) => (left.directory < right.directory ? -1 : 1));
}

describe("packaged documents reach every build", () => {
  it("is embedded by both compile sites", function* () {
    const packages = yield* packagedDocuments();
    // The suite is only meaningful while at least one exists; an empty sweep
    // would pass while proving nothing.
    expect(packages.length).toBeGreaterThan(0);

    const denoJson = yield* readTextFile(path.join(ROOT, "deno.json"));
    const release = yield* readTextFile(path.join(ROOT, ".github/workflows/release.yml"));
    const [buildTask = ""] = denoJson.split("\n").filter((line) => line.includes('"build":'));

    for (const shipped of packages) {
      // A directory nobody put anything in is not a directory a build has to
      // carry, and naming it would embed nothing while reading as coverage.
      expect(shipped.documents.length).toBeGreaterThan(0);
      expect(buildTask).toContain(`--include ${shipped.directory}`);
      expect(release).toContain(`--include ${shipped.directory}`);
    }
  });
});
