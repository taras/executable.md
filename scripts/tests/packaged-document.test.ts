/**
 * Every packaged Markdown document reaches every build that ships it.
 *
 * The npm build discovers these documents, so it needs no list. `deno compile`
 * names files one at a time, and it is named twice — in `deno task build` and in
 * the release matrix. A document added beside its module and forgotten in either
 * place produces a binary that runs until the moment it looks for its own
 * program, which is the failure this refuses to let reach a release.
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

/** Every document a package ships, repository-relative. */
function* packagedDocuments(): Operation<string[]> {
  const found: string[] = [];
  for (const member of yield* until(readdir(path.join(ROOT, "packages")))) {
    const documents = path.join(ROOT, "packages", member, "src/documents");
    let entries: string[];
    try {
      entries = yield* until(readdir(documents, { recursive: true }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      found.push(`packages/${member}/src/documents/${entry.split(path.sep).join("/")}`);
    }
  }
  return found.sort();
}

describe("packaged documents reach every build", () => {
  it("is embedded by both compile sites", function* () {
    const documents = yield* packagedDocuments();
    // The suite is only meaningful while at least one exists; an empty sweep
    // would pass while proving nothing.
    expect(documents.length).toBeGreaterThan(0);

    const denoJson = yield* readTextFile(path.join(ROOT, "deno.json"));
    const release = yield* readTextFile(path.join(ROOT, ".github/workflows/release.yml"));
    const [buildTask = ""] = denoJson.split("\n").filter((line) => line.includes('"build":'));

    for (const document of documents) {
      expect(buildTask).toContain(`--include ${document}`);
      expect(release).toContain(`--include ${document}`);
    }
  });
});
