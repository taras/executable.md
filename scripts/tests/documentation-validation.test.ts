/**
 * Tier SYN — the build gate for first-party documentation.
 *
 * `scripts/validate-documentation.ts` is what stands between a drifted
 * documentation set and a published distribution. A gate nobody has watched
 * fail is a gate nobody knows is connected, so each case here plants one class
 * of drift in a real shipped asset, runs the real entrypoint, and puts the file
 * back.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure } from "effection";
import type { Operation } from "effection";
import { readTextFile, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";

/** A shipped asset, restored however the case ends. */
function* planted(relative: string, change: (text: string) => string): Operation<void> {
  const url = new URL(`../../${relative}`, import.meta.url);
  const original = yield* readTextFile(url);
  yield* ensure(() => writeTextFile(url, original));
  yield* writeTextFile(url, change(original));
}

/** The real gate, as the build runs it. */
function* validate(): Operation<{ ok: boolean; stderr: string }> {
  const run = yield* exec("deno", {
    arguments: ["run", "--allow-all", "scripts/validate-documentation.ts"],
  }).join();
  return { ok: run.code === 0, stderr: run.stderr };
}

const CORE = "packages/core/src/components/components.md";
const COMPOSITION = "packages/workflow/src/composition/components.md";

describe("Tier SYN — the documentation build gate", () => {
  it("SYN41: passes on the shipped set", function* () {
    const clean = yield* validate();
    expect(clean.ok).toBe(true);
    expect(clean.stderr).toContain("complete");
  });

  it("SYN42: refuses a deleted section", function* () {
    // `## Fetch` and its body, gone — the drift that happens when a component
    // is documented and the section is later lost to a bad merge.
    yield* planted(CORE, (text) => {
      const start = text.indexOf("## Fetch");
      const end = text.indexOf("## Glob");
      return text.slice(0, start) + text.slice(end);
    });
    const refused = yield* validate();
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("Fetch");
    expect(refused.stderr).toContain("no documentation");
  });

  it("SYN43: refuses an unknown section", function* () {
    // Documentation for something the package does not supply — a rename that
    // updated the code and not the file.
    yield* planted(CORE, (text) => `${text}\n## Nonexistent\n\nAbout nothing.\n`);
    const refused = yield* validate();
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("Nonexistent");
  });

  it("SYN44: refuses a duplicated section", function* () {
    yield* planted(CORE, (text) => `${text}\n## Fetch\n\nA second Fetch.\n`);
    const refused = yield* validate();
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("Fetch");
  });

  it("SYN45: refuses drift in a package outside core", function* () {
    // The same gate covers every boundary, not only the first one wired.
    yield* planted(COMPOSITION, (text) => {
      const start = text.indexOf("## Git.Push");
      const end = text.indexOf("## PullRequest\n");
      return text.slice(0, start) + text.slice(end);
    });
    const refused = yield* validate();
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toContain("Git.Push");
  });
});
