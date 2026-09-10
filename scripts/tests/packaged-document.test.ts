/**
 * Every packaged asset reaches the compile that ships it.
 *
 * A compiled `xmd` carries what `--include` named and nothing else, and neither
 * `deno compile` nor a release reports an omission: the binary compiles, runs,
 * and fails at the moment a person asks it for the thing that was left out.
 *
 * Two of the three kinds are discoverable, and they are named differently. A
 * package's `src/documents/` is embedded whole, so a document added beside its
 * module needs no build change and only a package shipping its *first* one is
 * new information. Each `components.md` is named individually, because the
 * directories those sit in are package source and embedding them whole would
 * carry the TypeScript into the binary twice. The third kind — a whole package
 * the binary executes Markdown out of — is a decision rather than a layout, so
 * nothing here discovers it.
 *
 * What no build can discover for itself is which of the first two exist. So
 * this walks the repository for both and holds `scripts/lib/compile.ts` — the
 * one list all three compile sites build their argv from — to what it finds.
 * While those sites each kept a copy of the list, the release's copy named no
 * `components.md` at all and shipped binaries that could document no component.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";
import { readdir } from "node:fs/promises";
import { until } from "effection";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileArguments,
  EMBEDDED_ASSETS,
  PACKAGED_DOCUMENTATION,
  PACKAGED_DOCUMENTS,
} from "../lib/compile.ts";
import { RELEASE_TARGET } from "../lib/release-targets.ts";
import { phases } from "../verify-clean.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every package that ships documents, and every document in it. */
interface PackagedDocuments {
  /** The repository-relative `src/documents/` directory a compile has to name. */
  readonly directory: string;
  /** What is in it, repository-relative — for the emptiness check below. */
  readonly documents: readonly string[];
}

function* members(): Operation<string[]> {
  return (yield* until(readdir(path.join(ROOT, "packages")))).sort();
}

/** Repository-relative paths beneath `directory`, or none when it does not exist. */
function* beneath(directory: string): Operation<string[]> {
  try {
    const entries = yield* until(readdir(path.join(ROOT, directory), { recursive: true }));
    return entries.map((entry) => `${directory}/${entry.split(path.sep).join("/")}`);
  } catch {
    return [];
  }
}

function* packagedDocuments(): Operation<PackagedDocuments[]> {
  const found: PackagedDocuments[] = [];
  for (const member of yield* members()) {
    const directory = `packages/${member}/src/documents`;
    const documents = yield* beneath(directory);
    if (documents.length === 0) {
      continue;
    }
    found.push({ directory, documents: documents.sort() });
  }
  return found;
}

/**
 * Every `components.md` under a package's `src/`, at whatever depth it sits.
 *
 * Depth is the reason this is a walk rather than a per-package guess: core
 * ships two, one beneath `src/components/` and one beneath `src/agent/`,
 * because documentation lives beside the registration boundary it documents
 * rather than at a fixed path.
 */
function* packagedDocumentation(): Operation<string[]> {
  const found: string[] = [];
  for (const member of yield* members()) {
    for (const entry of yield* beneath(`packages/${member}/src`)) {
      if (entry.endsWith("/components.md")) {
        found.push(entry);
      }
    }
  }
  return found.sort();
}

describe("the canonical compile inputs", () => {
  it("name every packaged document directory that exists, and no other", function* () {
    const shipped = yield* packagedDocuments();
    // The sweep is only meaningful while at least one exists; an empty one
    // would pass while proving nothing.
    expect(shipped.length).toBeGreaterThan(0);

    for (const directory of shipped) {
      // A directory nobody put anything in is not one a build has to carry, and
      // naming it would embed nothing while reading as coverage — which is why
      // an empty one is not discovered above.
      expect(directory.documents.length).toBeGreaterThan(0);
    }
    // Both directions: a missing entry ships a binary without its program, and
    // a stale one embeds nothing while reading as coverage. `deno compile`
    // reports neither.
    expect([...PACKAGED_DOCUMENTS].sort()).toEqual(shipped.map((one) => one.directory).sort());
  });

  it("name every components.md that exists, and no other", function* () {
    const documentation = yield* packagedDocumentation();
    expect(documentation.length).toBeGreaterThan(0);
    expect([...PACKAGED_DOCUMENTATION].sort()).toEqual(documentation);
  });

  it("embed exactly those, and nothing else", function* () {
    const argv = compileArguments({ output: "dist/xmd" });
    const included = argv.flatMap((token, index) =>
      argv[index - 1] === "--include" ? [token] : [],
    );

    expect(included.sort()).toEqual([...EMBEDDED_ASSETS].sort());
    // Every `--include` was answered: a trailing one would swallow the
    // entrypoint and compile something else.
    expect(included.length).toBe(argv.filter((token) => token === "--include").length);
  });
});

/**
 * One list, three compiles. Each site is checked for the way it reaches the
 * list rather than for a copy of it — a site that went back to spelling out
 * `deno compile` would be a fourth answer to what a binary contains.
 */
describe("every compile site", () => {
  it("builds the local binary through the shared command", function* () {
    const denoJson = JSON.parse(yield* readTextFile(path.join(ROOT, "deno.json")));
    const build = denoJson.tasks.build;

    expect(build).toContain("scripts/compile.ts");
    expect(build).toContain("--output dist/xmd");
    expect(build).not.toContain("deno compile");
  });

  it("compiles the release matrix through the shared command", function* () {
    // Executable lines only: the comment beside the step names the flags it
    // replaced, and a comment compiles nothing.
    const commands = (yield* readTextFile(path.join(ROOT, ".github/workflows/release.yml")))
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(commands).toContain("scripts/compile.ts");
    expect(commands).toContain("--target ${{ matrix.target }}");
    expect(commands).toContain("--output dist/${{ matrix.artifact }}");
    expect(commands).not.toContain("deno compile");
  });

  it("proves the release argv in verify:clean, whole", function* () {
    const release = phases("xmd-release").find((phase) => phase.label === "release compile");

    // Equality rather than containment: this phase's claim is that what a
    // release does fetches nothing, and a compile embedding fewer assets walks
    // fewer module graphs than the one it stands for.
    expect(release?.arguments).toEqual(
      compileArguments({ target: RELEASE_TARGET, output: "dist/xmd-release" }),
    );
  });
});
