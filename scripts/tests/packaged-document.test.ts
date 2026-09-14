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
 *
 * The third kind still decides the other two. An embedded package carries
 * everything inside it, so a `src/documents/` or a `components.md` beneath one
 * is already in the binary and must *not* be named again: the code-review
 * package ships both, and naming either individually would compile the same
 * bytes twice while reading as the coverage the whole-package entry already
 * provides. Each discovered asset is therefore required in exactly one place —
 * the individual list when nothing covers it, the whole-package entry when
 * something does.
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
  EMBEDDED_PACKAGES,
  PACKAGED_DOCUMENTATION,
  PACKAGED_DOCUMENTS,
} from "../lib/compile.ts";

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

/**
 * Whether an embedded package already carries `asset`.
 *
 * A package the binary executes Markdown out of is embedded whole, so every
 * document and every `components.md` inside it is already in the binary. Naming
 * one of those individually as well would compile the same bytes twice and read
 * as coverage the whole-package entry was already providing — so the two checks
 * below ask for one answer or the other, never both.
 */
function embeddedWhole(asset: string): boolean {
  return EMBEDDED_PACKAGES.some((pkg) => asset === pkg || asset.startsWith(`${pkg}/`));
}

/**
 * Both directions for one discovered asset, given the list that should name it.
 *
 * A missing entry ships a binary without part of its program; a redundant one
 * embeds the same bytes twice. `deno compile` reports neither, so both are
 * failures here.
 */
function coverage(found: readonly string[], named: readonly string[]): void {
  expect(named.toSorted()).toEqual(found.filter((asset) => !embeddedWhole(asset)).toSorted());
  for (const asset of found.filter(embeddedWhole)) {
    expect(named).not.toContain(asset);
  }
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
    coverage(
      shipped.map((one) => one.directory),
      PACKAGED_DOCUMENTS,
    );
  });

  it("name every components.md that exists, and no other", function* () {
    const documentation = yield* packagedDocumentation();
    expect(documentation.length).toBeGreaterThan(0);
    coverage(documentation, PACKAGED_DOCUMENTATION);
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

  // The third site, `verify:clean`'s release phase, is asserted in
  // `scripts/tests/verify-clean.test.ts`. This suite runs under all three
  // runtimes, and the module carrying that phase list reaches for `Deno.env`
  // and `Deno.execPath` at import time — so the claim lives with the other
  // phase assertions, in the suite already scoped to Deno for that reason.
});
